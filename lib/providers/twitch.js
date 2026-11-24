// lib/providers/twitch.js — Twitch LIVE provider (GQL + Usher HLS + IRC WebSocket chat).

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const accounts = require('../accounts');
const { getProxyAgent } = require('../proxy-config');
const { stripControlChars } = require('../utils');

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TWITCH_IRC_WS_URL = 'wss://irc-ws.chat.twitch.tv:443';
const API_TIMEOUT_MS = 15_000;
const API_CACHE_TTL_MS = Number(process.env.TWITCH_API_CACHE_MS) || 5000;
const API_CACHE_MAX = 200;

const apiCache = new Map();
const apiInflight = new Map();

const GQL_QUERY = `query($login: String!) {
  user(login: $login) {
    id
    login
    displayName
    profileImageURL(width: 300)
    roles { isPartner }
    followers { totalCount }
    stream {
      id
      title
      type
      viewersCount
      createdAt
      previewImageURL(width: 640, height: 360)
      game { name }
    }
  }
  streamPlaybackAccessToken(
    channelName: $login,
    params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }
  ) {
    value
    signature
  }
}`;

function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.)?twitch\.tv\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const host = url.hostname.toLowerCase();
      if (host !== 'twitch.tv' && !host.endsWith('.twitch.tv')) return '';
      const seg = url.pathname.replace(/^\/+/, '').split('/')[0] || '';
      s = seg;
    } catch {
      return '';
    }
  }

  const login = s.replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(login)) return '';
  // Reject non-channel Twitch top-level path words
  if (new Set(['directory', 'downloads', 'jobs', 'turbo', 'settings', 'videos', 'login', 'signup']).has(login)) {
    return '';
  }
  return login;
}

function defaultHttpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = API_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const agent = getProxyAgent();
    const req = https.request(
      parsed,
      {
        method,
        agent: agent || undefined,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        const maxBytes = 2 * 1024 * 1024;
        res.on('data', (c) => {
          total += c.length;
          if (total <= maxBytes) chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Twitch API timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseAttrList(raw) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return attrs;
}

function resolvePlaylistUri(uri, baseUrl) {
  const trimmed = String(uri || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!baseUrl) return trimmed;
  try { return new URL(trimmed, baseUrl).toString(); } catch { return trimmed; }
}

function classifyTwitchVariant({ videoGroup, name, height, fps }) {
  const vg = String(videoGroup || name || '').toLowerCase();
  if (vg === 'audio_only' || vg === 'audio only') return { sdkKey: 'ao', level: 1, label: 'Audio Only' };
  if (vg === 'chunked' || vg.includes('source')) {
    const lbl = height ? `${height}p${fps >= 50 ? Math.round(fps) : ''} (source)` : 'source';
    return { sdkKey: 'origin', level: 100, label: lbl };
  }
  if (height >= 1080) {
    const key = fps >= 50 ? 'uhd_60' : 'uhd';
    return { sdkKey: key, level: fps >= 50 ? 90 : 80, label: `${height}p${fps >= 50 ? Math.round(fps) : ''}` };
  }
  if (height >= 720) {
    const key = fps >= 50 ? 'hd_60' : 'hd';
    return { sdkKey: key, level: fps >= 50 ? 70 : 60, label: `${height}p${fps >= 50 ? Math.round(fps) : ''}` };
  }
  if (height >= 480) return { sdkKey: 'sd', level: 40, label: `${height}p` };
  if (height >= 360) return { sdkKey: 'ld', level: 30, label: `${height}p` };
  if (height >= 160) return { sdkKey: 'md', level: 20, label: `${height}p` };
  return { sdkKey: 'sd', level: 35, label: name || vg || 'auto' };
}

function parseTwitchMasterM3u8(m3u8Text, baseUrl = '') {
  const out = {
    hls: null,
    hlsByQuality: {},
    flv: {},
    cmaf: {},
    hevc: { hls: {}, flv: {}, cmaf: {} },
    qualities: [],
    hevcQualities: [],
  };
  if (typeof m3u8Text !== 'string' || !m3u8Text.trim()) return out;

  const mediaNames = new Map(); // groupId -> name
  const variants = [];
  const lines = m3u8Text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrList(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs['GROUP-ID'] && attrs.NAME) {
        mediaNames.set(attrs['GROUP-ID'], attrs.NAME);
      }
      if (attrs.TYPE === 'AUDIO' && (attrs['GROUP-ID'] === 'audio_only' || /audio/i.test(attrs.NAME || '')) && attrs.URI) {
        const url = resolvePlaylistUri(attrs.URI, baseUrl);
        if (url) {
          variants.push({ sdkKey: 'ao', level: 1, name: 'ao', bandwidth: 0, url });
        }
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttrList(line.slice('#EXT-X-STREAM-INF:'.length));
      let nextUrl = '';
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (!candidate.startsWith('#')) {
          nextUrl = resolvePlaylistUri(candidate, baseUrl);
          i = j;
        }
        break;
      }
      if (!nextUrl) continue;

      const resM = String(attrs.RESOLUTION || '').match(/(\d+)x(\d+)/);
      const height = resM ? Number(resM[2]) : 0;
      const fps = Number(attrs['FRAME-RATE']) || 30;
      const bandwidth = Number(attrs.BANDWIDTH) || 0;
      const videoGroup = attrs.VIDEO || '';
      const mediaName = mediaNames.get(videoGroup) || '';
      const info = classifyTwitchVariant({ videoGroup, name: mediaName, height, fps });
      variants.push({
        sdkKey: info.sdkKey,
        level: info.level,
        name: info.label,
        bandwidth,
        url: nextUrl,
      });
    }
  }

  variants.sort((a, b) => b.level - a.level || b.bandwidth - a.bandwidth);
  const seenKeys = new Set();
  for (const v of variants) {
    if (seenKeys.has(v.sdkKey)) continue;
    seenKeys.add(v.sdkKey);
    out.hlsByQuality[v.sdkKey] = v.url;
    out.qualities.push({ name: v.name, sdkKey: v.sdkKey, level: v.level });
  }

  const priority = ['origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'ld', 'md'];
  for (const q of priority) {
    if (out.hlsByQuality[q]) {
      out.hls = out.hlsByQuality[q];
      break;
    }
  }
  if (!out.hls) {
    out.hls = Object.values(out.hlsByQuality).find(Boolean) || baseUrl || null;
  }

  return out;
}

function invalidateCache(login) {
  if (!login) {
    apiCache.clear();
    apiInflight.clear();
    return;
  }
  const key = String(login).toLowerCase();
  apiCache.delete(key);
  apiInflight.delete(key);
}

async function fetchLiveStatus(rawLogin, { noCache = false, fetchImpl } = {}) {
  const login = normalizeUsername(rawLogin);
  if (!login) throw new Error('invalid twitch username');

  const now = Date.now();
  if (!noCache && !fetchImpl) {
    const hit = apiCache.get(login);
    if (hit && now - hit.ts < API_CACHE_TTL_MS) return hit.data;
    const inflight = apiInflight.get(login);
    if (inflight) return inflight;
  }

  const requester = typeof fetchImpl === 'function' ? fetchImpl : defaultHttpRequest;
  const run = async () => {
    const headers = {
      'Client-ID': process.env.TWITCH_CLIENT_ID || TWITCH_WEB_CLIENT_ID,
      'Content-Type': 'application/json',
    };
    const oauthToken = accounts.getActivePlatformCredential('twitch');
    if (oauthToken) {
      headers.Authorization = `OAuth ${oauthToken.replace(/^OAuth\s+/i, '')}`;
    }

    const gqlRes = await requester(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: GQL_QUERY, variables: { login } }),
    });
    if (!gqlRes?.ok) {
      throw new Error(`Twitch GQL HTTP ${gqlRes?.status || 0}`);
    }
    let parsed;
    try { parsed = JSON.parse(gqlRes.text); } catch {
      throw new Error('Twitch GQL returned invalid JSON');
    }

    const user = parsed?.data?.user || null;
    const stream = user?.stream || null;
    const token = parsed?.data?.streamPlaybackAccessToken || null;

    let streams = null;
    let masterHlsUrl = null;
    if (stream && token?.value && token?.signature) {
      const p = Math.floor(100000 + Math.random() * 899999);
      const sessionId = crypto.randomBytes(16).toString('hex');
      masterHlsUrl =
        `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8` +
        `?allow_source=true&allow_audio_only=true&allow_spectre=true&fast_bread=true` +
        `&p=${p}&play_session_id=${sessionId}&player_backend=mediaplayer` +
        `&playlist_include_framerate=true&reassignments_supported=true` +
        `&sig=${encodeURIComponent(token.signature)}&supported_codecs=h264` +
        `&token=${encodeURIComponent(token.value)}&transcode_mode=cbr_v1`;

      try {
        const m3u8Res = await requester(masterHlsUrl, { method: 'GET' });
        if (m3u8Res?.ok && m3u8Res.text) {
          streams = parseTwitchMasterM3u8(m3u8Res.text, masterHlsUrl);
        }
      } catch {
        // Fallback: surface master URL even if variant parsing fails
        streams = {
          hls: masterHlsUrl,
          hlsByQuality: { origin: masterHlsUrl },
          flv: {},
          cmaf: {},
          hevc: { hls: {}, flv: {}, cmaf: {} },
          qualities: [{ name: 'source', sdkKey: 'origin', level: 100 }],
          hevcQualities: [],
        };
      }
    }

    return { user, stream, streams, masterHlsUrl };
  };

  if (noCache || fetchImpl) {
    return run();
  }

  const p = run()
    .then((data) => {
      if (!apiCache.has(login) && apiCache.size >= API_CACHE_MAX) {
        apiCache.delete(apiCache.keys().next().value);
      }
      apiCache.set(login, { ts: Date.now(), data });
      return data;
    })
    .finally(() => {
      if (apiInflight.get(login) === p) apiInflight.delete(login);
    });
  apiInflight.set(login, p);
  return p;
}

function isLive(data) {
  return !!(data?.stream && data.stream.type === 'live');
}

function extractStreamUrls(data) {
  if (!data?.streams) {
    return {
      hls: null,
      hlsByQuality: {},
      flv: {},
      cmaf: {},
      hevc: { hls: {}, flv: {}, cmaf: {} },
      qualities: [],
      hevcQualities: [],
    };
  }
  return data.streams;
}

function pickPreferredStream(streams) {
  if (!streams) return null;
  const priority = ['origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'ld', 'md'];
  for (const q of priority) {
    if (streams.hlsByQuality?.[q]) return { url: streams.hlsByQuality[q], kind: 'hls', quality: q };
  }
  if (streams.hls) return { url: streams.hls, kind: 'hls', quality: 'origin' };
  const entries = Object.entries(streams.hlsByQuality || {});
  if (entries.length) return { url: entries[0][1], kind: 'hls', quality: entries[0][0] };
  return null;
}

function hasStreamUrls(streams) {
  return !!(streams?.hls || Object.keys(streams?.hlsByQuality || {}).length > 0);
}

function buildSummary(username, data, streams) {
  const u = data?.user || null;
  const s = data?.stream || null;
  const startedAtUnix = s?.createdAt ? Math.floor(Date.parse(s.createdAt) / 1000) : null;
  const coverUrl = typeof s?.previewImageURL === 'string'
    ? s.previewImageURL.replace('{width}', '640').replace('{height}', '360')
    : null;

  return {
    platform: 'twitch',
    username,
    live: isLive(data),
    authenticated: !!accounts.getActivePlatformCredential('twitch'),
    stealth: !accounts.getActivePlatformCredential('twitch'),
    roomId: s?.id || u?.id || null,
    liveRoomMode: s?.game?.name || null,
    title: s?.title || null,
    coverUrl,
    startedAtUnix: Number.isFinite(startedAtUnix) ? startedAtUnix : null,
    viewerCount: s?.viewersCount ?? null,
    totalEntered: null,
    owner: u
      ? {
          nickname: u.displayName || u.login,
          uniqueId: u.login,
          verified: !!u.roles?.isPartner,
          followers: u.followers?.totalCount ?? null,
          avatarThumb: u.profileImageURL || undefined,
        }
      : null,
    streams: streams
      ? {
          hls: streams.hls,
          hlsByQuality: streams.hlsByQuality,
          flv: streams.flv || {},
          cmaf: streams.cmaf || {},
          qualities: streams.qualities || [],
          hevc: streams.hevc || { hls: {}, flv: {}, cmaf: {} },
          hevcQualities: streams.hevcQualities || [],
        }
      : undefined,
  };
}

// ── Twitch IRC WebSocket Chat ──

function unescapeIrcTag(val) {
  return String(val || '')
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\\\/g, '\\')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n');
}

function parseTwitchIrcLine(raw) {
  const line = String(raw || '').replace(/\r?\n$/, '');
  if (!line) return null;

  let idx = 0;
  const tags = {};
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    if (sp < 0) return null;
    const rawTags = line.slice(1, sp);
    for (const part of rawTags.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) tags[part] = '';
      else tags[part.slice(0, eq)] = unescapeIrcTag(part.slice(eq + 1));
    }
    idx = sp + 1;
    while (line[idx] === ' ') idx++;
  }

  let prefix = '';
  if (line[idx] === ':') {
    const sp = line.indexOf(' ', idx);
    if (sp < 0) return null;
    prefix = line.slice(idx + 1, sp);
    idx = sp + 1;
    while (line[idx] === ' ') idx++;
  }

  let trailing = '';
  const trIdx = line.indexOf(' :', idx);
  let head = trIdx >= 0 ? line.slice(idx, trIdx) : line.slice(idx);
  if (trIdx >= 0) trailing = line.slice(trIdx + 2);

  const parts = head.trim().split(/\s+/).filter(Boolean);
  const command = (parts[0] || '').toUpperCase();
  const params = parts.slice(1);
  if (!command) return null;

  const nickFromPrefix = prefix.split('!')[0] || undefined;
  const displayName = tags['display-name'] || nickFromPrefix;
  const uniqueId = (nickFromPrefix || tags['display-name'] || '').toLowerCase() || undefined;
  const user = {
    uniqueId,
    nickname: displayName || uniqueId,
    userId: tags['user-id'] ? String(tags['user-id']) : undefined,
  };

  if (command === 'PING') {
    return { command: 'PING', trailing, events: [] };
  }

  if (command === 'PRIVMSG') {
    const comment = stripControlChars(trailing, 500);
    const events = [];
    if (comment) {
      events.push({ type: 'chat', user, comment });
    }
    const bits = Number(tags.bits) || 0;
    if (bits > 0) {
      events.push({
        type: 'gift',
        user,
        giftName: 'Bits',
        diamondCount: bits,
        repeatCount: 1,
      });
    }
    return { command, params, tags, events };
  }

  if (command === 'USERNOTICE') {
    const msgId = String(tags['msg-id'] || '').toLowerCase();
    const events = [];
    if (['sub', 'resub', 'subgift', 'submysterygift', 'anonsubgift'].includes(msgId)) {
      const label = stripControlChars(tags['system-msg'] || msgId, 200);
      const comment = stripControlChars(trailing, 500);
      events.push({
        type: 'subscribe',
        user,
        label,
        ...(comment ? { comment } : {}),
      });
    }
    return { command, params, tags, events };
  }

  return { command, params, tags, events: [] };
}

const RING_BUFFER_SIZE = 500;
const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];
const MAX_RECONNECT_ATTEMPTS = 12;

class TwitchChatSession {
  constructor(username, { chatEvents = null, wsFactory = null } = {}) {
    this.platform = 'twitch';
    this.username = normalizeUsername(username) || String(username || '').replace(/[\r\n\s#]/g, '').toLowerCase();
    this.chatEvents = chatEvents;
    this.wsFactory = wsFactory;
    this.events = [];
    this.nextId = 1;
    this.viewerCount = null;
    this.startedAt = null;
    this.state = 'idle';
    this.error = null;
    this.writers = new Set();
    this.listeners = new Set();
    this.ws = null;
    this.manualClose = false;
    this.uiActive = false;
    this.recorderRefs = 0;
    this.accountId = null;
    this.roomId = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this._connectTimer = null;
    this._connectReject = null;
    this._connectPromise = null;
    this.health = {
      reconnectCount: 0,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      totalEventsReceived: 0,
      errorsCount: 0,
      lastError: null,
      lastEventAt: null,
    };
  }

  _emitState() {
    this.chatEvents?.emit('state', {
      platform: 'twitch',
      username: this.username,
      session: this.info(),
    });
  }

  _cleanupWs() {
    if (!this.ws) return;
    try { this.ws.removeAllListeners?.(); } catch {}
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      } else {
        this.ws.terminate?.();
      }
    } catch {}
    this.ws = null;
  }

  _scheduleReconnect() {
    if (this.manualClose || !this.hasConsumers()) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.state = 'error';
      this._emitState();
      return;
    }
    const idx = Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[idx];
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose || !this.hasConsumers() || this.state === 'connected') return;
      this.state = 'reconnecting';
      this.connect().catch(() => {
        if (this.manualClose || !this.hasConsumers() || this.state === 'connected') return;
        this.state = 'reconnecting';
        this._emitState();
        this._scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  push(type, payload) {
    const ev = { id: this.nextId++, ts: Date.now(), type, ...payload };
    this.events.push(ev);
    while (this.events.length > RING_BUFFER_SIZE) this.events.shift();
    for (const w of this.writers) {
      try { w.write(JSON.stringify(ev) + '\n'); } catch {}
    }
    for (const fn of this.listeners) {
      try { fn(ev); } catch {}
    }
    this.health.totalEventsReceived++;
    this.health.lastEventAt = ev.ts;
    this.chatEvents?.emit('event', {
      platform: 'twitch',
      username: this.username,
      event: ev,
      session: this.info(),
    });
  }

  async connect() {
    if (this.state === 'connected') return;
    if (this._connectPromise) return this._connectPromise;

    this.manualClose = false;
    this.state = 'connecting';
    this.error = null;
    this._emitState();

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        if (this._connectTimer) {
          clearTimeout(this._connectTimer);
          this._connectTimer = null;
        }
        this._connectReject = null;
        reject(err);
      };
      this._connectReject = settleReject;

      const agent = getProxyAgent();
      const ws = this.wsFactory
        ? this.wsFactory(TWITCH_IRC_WS_URL)
        : new WebSocket(TWITCH_IRC_WS_URL, { agent: agent || undefined });
      this.ws = ws;

      this._connectTimer = setTimeout(() => {
        this._connectTimer = null;
        if (settled || this.manualClose) return;
        this._cleanupWs();
        const err = new Error('Twitch IRC connection timed out');
        this.state = 'error';
        this.error = err.message;
        this.health.errorsCount++;
        this.health.lastError = { message: err.message, at: Date.now() };
        this._emitState();
        settleReject(err);
      }, 15_000);
      this._connectTimer.unref?.();

      ws.on('open', () => {
        if (this.manualClose) {
          this._cleanupWs();
          settleReject(new Error('connection closed'));
          return;
        }
        try {
          const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
          ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
          ws.send('PASS SCHMOOPIIE');
          ws.send(`NICK ${nick}`);
          ws.send(`JOIN #${this.username}`);
        } catch (err) {
          this._cleanupWs();
          this.state = 'error';
          this.error = err?.message || 'Twitch IRC send error';
          this._emitState();
          settleReject(err);
          return;
        }

        if (this._connectTimer) {
          clearTimeout(this._connectTimer);
          this._connectTimer = null;
        }
        this._connectReject = null;
        this.state = 'connected';
        this.startedAt = this.startedAt || Date.now();
        if (this.reconnectAttempts > 0) this.health.reconnectCount++;
        this.reconnectAttempts = 0;
        this.health.lastConnectedAt = Date.now();
        this._emitState();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (data) => {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        for (const rawLine of text.split(/\r?\n/)) {
          const parsed = parseTwitchIrcLine(rawLine);
          if (!parsed) continue;
          if (parsed.command === 'PING') {
            try { ws.send(`PONG :${parsed.trailing || 'tmi.twitch.tv'}`); } catch {}
            continue;
          }
          for (const ev of parsed.events) {
            const { type, ...rest } = ev;
            this.push(type, rest);
          }
        }
      });

      ws.on('error', (err) => {
        const msg = err?.message || 'Twitch IRC error';
        this.error = msg;
        this.health.errorsCount++;
        this.health.lastError = { message: msg, at: Date.now() };
        if (!settled) {
          this.state = 'error';
          this._cleanupWs();
          this._emitState();
          settleReject(err);
        }
      });

      ws.on('close', () => {
        if (this._connectTimer) {
          clearTimeout(this._connectTimer);
          this._connectTimer = null;
        }
        if (this.manualClose) {
          settleReject(new Error('connection closed'));
          return;
        }
        this.health.lastDisconnectedAt = Date.now();
        this.ws = null;
        if (!settled) {
          this.state = 'error';
          this._emitState();
          settleReject(new Error('Twitch IRC closed'));
          return;
        }
        if (this.hasConsumers()) {
          this.state = 'reconnecting';
          this._emitState();
          this._scheduleReconnect();
        } else {
          this.state = 'closed';
          this._emitState();
        }
      });
    }).finally(() => {
      if (this._connectTimer) {
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
      }
      this._connectReject = null;
      this._connectPromise = null;
    });

    return this._connectPromise;
  }

  attachFile(filePath) {
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', (e) => {
      console.warn(`[chat] writer error for twitch:${this.username}:`, e?.message || e);
      this.writers.delete(stream);
    });
    this.writers.add(stream);
    return stream;
  }

  detachFile(stream) {
    if (!stream) return;
    this.writers.delete(stream);
    try { stream.end(); } catch {}
  }

  hasConsumers() {
    return this.uiActive || this.recorderRefs > 0 || this.writers.size > 0 || this.listeners.size > 0;
  }

  disconnect() {
    this.manualClose = true;
    this.uiActive = false;
    this.recorderRefs = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    const rejectPending = this._connectReject;
    this._connectReject = null;
    this._cleanupWs();
    for (const w of this.writers) { try { w.end(); } catch {} }
    this.writers.clear();
    this.listeners.clear();
    this.state = 'closed';
    this._emitState();
    if (rejectPending) rejectPending(new Error('connection closed'));
  }

  snapshot(sinceId = 0) {
    return sinceId ? this.events.filter((e) => e.id > sinceId) : [...this.events];
  }

  info() {
    return {
      platform: 'twitch',
      username: this.username,
      state: this.state,
      error: this.error,
      viewerCount: this.viewerCount,
      startedAt: this.startedAt,
      eventCount: this.events.length,
      lastEventId: this.nextId - 1,
      hasFileWriter: this.writers.size > 0,
      health: this.health,
    };
  }
}

module.exports = {
  id: 'twitch',
  label: 'Twitch',
  referer: 'https://www.twitch.tv/',
  normalizeUsername,
  parseTwitchMasterM3u8,
  parseTwitchIrcLine,
  fetchLiveStatus,
  isLive,
  extractStreamUrls,
  pickPreferredStream,
  hasStreamUrls,
  buildSummary,
  invalidateCache,
  TwitchChatSession,
};
