// lib/providers/kick.js — Kick LIVE provider (Channels API + Pusher WebSocket chat + optional yt-dlp fallback).

const { execFile } = require('child_process');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const accounts = require('../accounts');
const { getProxyAgent, getProxyList, rotateProxy, getActiveProxyUrl } = require('../proxy-config');
const { stripControlChars } = require('../utils');
const { parseYouTubeMasterM3u8, resolveYtDlp } = require('./youtube');

const KICK_PUSHER_URL =
  process.env.KICK_PUSHER_URL ||
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';
const API_TIMEOUT_MS = 15_000;
const YTDLP_TIMEOUT_MS = 15_000;
const API_CACHE_TTL_MS = Number(process.env.KICK_API_CACHE_MS) || 5000;
const API_CACHE_MAX = 200;

const RESERVED_KICK_PATHS = new Set([
  'categories', 'browse', 'following', 'dashboard', 'terms', 'privacy',
  'community-guidelines', 'login', 'register', 'auth', 'search', 'api',
  'video', 'videos', 'clips',
]);

const apiCache = new Map();
const apiInflight = new Map();

function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.)?kick\.com\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const host = url.hostname.toLowerCase();
      if (host !== 'kick.com' && !host.endsWith('.kick.com')) return '';
      const seg = url.pathname.replace(/^\/+/, '').split('/')[0] || '';
      s = seg;
    } catch {
      return '';
    }
  }

  const slug = s.replace(/^@/, '').replace(/[/?#].*$/, '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(slug)) return '';
  if (RESERVED_KICK_PATHS.has(slug)) return '';
  return slug;
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
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://kick.com/',
          'Origin': 'https://kick.com',
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
    req.on('timeout', () => req.destroy(new Error(`Kick API timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseKickMasterM3u8(m3u8Text, baseUrl = '') {
  return parseYouTubeMasterM3u8(m3u8Text, baseUrl);
}

function defaultYtDlpExec(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function fetchViaYtDlp(channelUrl, { ytDlpExec } = {}) {
  if (!channelUrl) return null;
  let parsedUrl;
  try { parsedUrl = new URL(channelUrl); } catch { return null; }
  const host = parsedUrl.hostname.toLowerCase();
  if (parsedUrl.protocol !== 'https:' || (host !== 'kick.com' && !host.endsWith('.kick.com'))) return null;

  const runner = typeof ytDlpExec === 'function' ? ytDlpExec : defaultYtDlpExec;
  const bin = typeof ytDlpExec === 'function' ? 'yt-dlp' : resolveYtDlp();
  if (!bin) return null;

  const args = ['--no-warnings', '--no-playlist', '-j'];
  const proxyUrl = getActiveProxyUrl();
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push(channelUrl);

  const stdout = await runner(bin, args);
  const info = JSON.parse(String(stdout || '').trim().split(/\r?\n/)[0] || '{}');
  let hlsUrl = typeof info.manifest_url === 'string' && /\.m3u8/i.test(info.manifest_url)
    ? info.manifest_url
    : null;
  if (!hlsUrl && Array.isArray(info.formats)) {
    const hlsFormats = info.formats.filter(
      (f) => typeof f?.url === 'string' && /m3u8/i.test(String(f.protocol || '') + ' ' + f.url),
    );
    const best = hlsFormats.sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0))[0];
    if (best) hlsUrl = best.url;
  }

  return {
    isLive: Boolean(info.is_live && hlsUrl),
    playbackUrl: hlsUrl,
    id: info.id || null,
    title: info.title || null,
    uploader: info.uploader || info.channel || null,
    viewerCount: Number.isFinite(Number(info.concurrent_view_count)) ? Number(info.concurrent_view_count) : null,
    thumbnail: info.thumbnail || null,
    startedAtUnix: Number.isFinite(Number(info.release_timestamp)) ? Number(info.release_timestamp) : null,
  };
}

function invalidateCache(slug) {
  if (!slug) {
    apiCache.clear();
    apiInflight.clear();
    return;
  }
  const key = normalizeUsername(slug);
  if (!key) return;
  apiCache.delete(key);
  apiInflight.delete(key);
}

async function fetchKickChannelJson(slug, requester, headers) {
  const urls = [
    `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(slug)}`,
  ];
  let lastStatus = 0;
  for (const url of urls) {
    const res = await requester(url, { method: 'GET', headers });
    lastStatus = Number(res?.status || 0);
    if (res?.ok && res.text) {
      try {
        const json = JSON.parse(res.text);
        if (json && typeof json === 'object') return { json, status: lastStatus };
      } catch {
        // Cloudflare HTML challenge page or malformed JSON
      }
    }
    if (lastStatus === 403 && !headers.__retriedProxy && getProxyList().length > 1) {
      rotateProxy();
      return fetchKickChannelJson(slug, requester, { ...headers, __retriedProxy: '1' });
    }
  }
  return { json: null, status: lastStatus };
}

async function fetchLiveStatus(rawSlug, { noCache = false, fetchImpl, ytDlpExec, useYtDlpFallback = true } = {}) {
  const slug = normalizeUsername(rawSlug);
  if (!slug) throw new Error('invalid kick username');

  const now = Date.now();
  if (!noCache && !fetchImpl && !ytDlpExec) {
    const hit = apiCache.get(slug);
    if (hit && now - hit.ts < API_CACHE_TTL_MS) return hit.data;
    const inflight = apiInflight.get(slug);
    if (inflight) return inflight;
  }

  const requester = typeof fetchImpl === 'function' ? fetchImpl : defaultHttpRequest;
  const run = async () => {
    const token = accounts.getActivePlatformCredential('kick');
    const headers = {};
    if (token) {
      headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }

    let channel = null;
    try {
      const apiRes = await fetchKickChannelJson(slug, requester, headers);
      channel = apiRes.json;
    } catch {
      channel = null;
    }

    let livestream = channel?.livestream || null;
    let playbackUrl = channel?.playback_url || livestream?.playback_url || null;
    let isLiveFlag = Boolean(livestream && livestream.is_live !== false && playbackUrl);
    const chatroomId = channel?.chatroom?.id ? String(channel.chatroom.id) : null;

    if ((!isLiveFlag || !playbackUrl) && useYtDlpFallback) {
      try {
        const ytd = await fetchViaYtDlp(`https://kick.com/${encodeURIComponent(slug)}`, { ytDlpExec });
        if (ytd && ytd.isLive && ytd.playbackUrl) {
          isLiveFlag = true;
          playbackUrl = ytd.playbackUrl;
          if (!livestream) {
            livestream = {
              id: ytd.id,
              session_title: ytd.title,
              viewer_count: ytd.viewerCount,
              is_live: true,
              thumbnail: ytd.thumbnail ? { url: ytd.thumbnail } : null,
              created_at: ytd.startedAtUnix ? new Date(ytd.startedAtUnix * 1000).toISOString() : null,
            };
          }
          if (!channel) {
            channel = {
              id: ytd.id,
              slug,
              user: { username: ytd.uploader || slug },
            };
          }
        }
      } catch {
        // Optional fallback failed
      }
    }

    let streams = null;
    if (isLiveFlag && playbackUrl) {
      try {
        const m3u8Res = await requester(playbackUrl, { method: 'GET' });
        if (m3u8Res?.ok && m3u8Res.text) {
          streams = parseKickMasterM3u8(m3u8Res.text, playbackUrl);
        }
      } catch {
        // Surface master URL if variant fetch fails
      }
      if (!streams || !hasStreamUrls(streams)) {
        streams = {
          hls: playbackUrl,
          hlsByQuality: { origin: playbackUrl },
          flv: {},
          cmaf: {},
          hevc: { hls: {}, flv: {}, cmaf: {} },
          qualities: [{ name: 'source', sdkKey: 'origin', level: 100 }],
          hevcQualities: [],
        };
      }
    }

    return {
      slug,
      channel,
      livestream,
      chatroomId,
      playbackUrl,
      isLive: isLiveFlag,
      streams,
    };
  };

  if (noCache || fetchImpl || ytDlpExec) {
    return run();
  }

  const p = run()
    .then((data) => {
      if (!apiCache.has(slug) && apiCache.size >= API_CACHE_MAX) {
        apiCache.delete(apiCache.keys().next().value);
      }
      apiCache.set(slug, { ts: Date.now(), data });
      return data;
    })
    .finally(() => {
      if (apiInflight.get(slug) === p) apiInflight.delete(slug);
    });
  apiInflight.set(slug, p);
  return p;
}

function isLive(data) {
  return Boolean(data?.isLive);
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
  const ch = data?.channel || null;
  const ls = data?.livestream || ch?.livestream || null;
  const userObj = ch?.user || null;
  const rawStart = ls?.created_at || ls?.start_time || null;
  const startedAtUnix = rawStart ? Math.floor(Date.parse(rawStart) / 1000) : null;
  const coverUrl =
    ls?.thumbnail?.url ||
    ls?.thumbnail?.src ||
    (typeof ls?.thumbnail === 'string' ? ls.thumbnail : null) ||
    ch?.banner_image?.url ||
    null;
  const categoryName = ls?.categories?.[0]?.name || ls?.category?.name || null;

  return {
    platform: 'kick',
    username,
    live: isLive(data),
    authenticated: !!accounts.getActivePlatformCredential('kick'),
    stealth: !accounts.getActivePlatformCredential('kick'),
    roomId: data?.chatroomId || (ls?.id ? String(ls.id) : null),
    liveRoomMode: categoryName,
    title: ls?.session_title || ls?.title || null,
    coverUrl,
    startedAtUnix: Number.isFinite(startedAtUnix) ? startedAtUnix : null,
    viewerCount: ls?.viewer_count ?? ls?.viewers ?? null,
    totalEntered: null,
    owner: ch
      ? {
          nickname: userObj?.username || ch.slug || username,
          uniqueId: ch.slug || username,
          verified: !!ch.verified,
          followers: ch.followers_count ?? ch.followersCount ?? null,
          avatarThumb: userObj?.profile_pic || undefined,
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

// ── Kick Pusher WebSocket Chat ──

function formatKickEmotes(text) {
  return String(text || '').replace(/\[emote:\d+:([A-Za-z0-9_+-]+)\]/g, ':$1:');
}

function extractKickUser(sender) {
  const nick = stripControlChars(sender?.username || sender?.slug || '?', 80) || '?';
  return {
    uniqueId: String(sender?.slug || sender?.username || nick).toLowerCase(),
    nickname: nick,
    userId: sender?.id ? String(sender.id) : undefined,
  };
}

function parseKickPusherMessage(raw) {
  let frame;
  try {
    frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || !frame.event) return null;

  const eventName = String(frame.event);
  if (eventName === 'pusher:ping') {
    return { command: 'PING', events: [] };
  }

  let data = frame.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return { command: eventName, events: [] }; }
  }
  if (!data || typeof data !== 'object') {
    return { command: eventName, events: [] };
  }

  const events = [];
  if (eventName === 'App\\Events\\ChatMessageEvent' || eventName.endsWith('\\ChatMessageEvent')) {
    const comment = stripControlChars(formatKickEmotes(data.content || ''), 500);
    if (comment) {
      events.push({
        type: 'chat',
        user: extractKickUser(data.sender),
        comment,
      });
    }
  } else if (eventName === 'App\\Events\\SubscriptionEvent' || eventName.endsWith('\\SubscriptionEvent')) {
    const months = Number(data.months) || 1;
    const uname = stripControlChars(data.username || 'Subscriber', 80);
    events.push({
      type: 'subscribe',
      user: { uniqueId: uname.toLowerCase(), nickname: uname },
      label: months > 1 ? `Subscribed (${months} months)` : 'Subscribed',
    });
  } else if (eventName === 'App\\Events\\GiftedSubscriptionsEvent' || eventName.endsWith('\\GiftedSubscriptionsEvent')) {
    const count = Math.max(1, Array.isArray(data.gifted_usernames) ? data.gifted_usernames.length : (Number(data.quantity) || 1));
    const gifter = stripControlChars(data.gifter_username || 'Anonymous', 80);
    events.push({
      type: 'gift',
      user: { uniqueId: gifter.toLowerCase(), nickname: gifter },
      giftName: 'Gifted Subs',
      repeatCount: count,
      diamondCount: count * 500,
      comment: Array.isArray(data.gifted_usernames) && data.gifted_usernames.length
        ? `Gifted to ${data.gifted_usernames.slice(0, 3).join(', ')}${data.gifted_usernames.length > 3 ? '…' : ''}`
        : '',
    });
  } else if (eventName === 'App\\Events\\PinnedMessageCreatedEvent' || eventName.endsWith('\\PinnedMessageCreatedEvent')) {
    const msg = data.message || {};
    const pinnedText = stripControlChars(formatKickEmotes(msg.content || ''), 300);
    if (pinnedText) {
      events.push({
        type: 'roomPin',
        action: 'pin',
        pinnedText,
        pinnedUser: extractKickUser(msg.sender),
      });
    }
  }

  return { command: eventName, events };
}

const RING_BUFFER_SIZE = 500;
const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];
const MAX_RECONNECT_ATTEMPTS = 12;

class KickChatSession extends EventEmitter {
  constructor(username, { chatEvents, wsFactory, fetchImpl, chatroomId } = {}) {
    super();
    this.platform = 'kick';
    this.username = normalizeUsername(username) || String(username || '').trim().toLowerCase();
    this.chatEvents = chatEvents || null;
    this.wsFactory = wsFactory || null;
    this.fetchImpl = fetchImpl || null;
    this.chatroomId = chatroomId ? String(chatroomId) : null;
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
    this.roomId = this.chatroomId;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this._pingTimer = null;
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
      platform: 'kick',
      username: this.username,
      session: this.info(),
    });
  }

  _cleanupWs() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (!this.ws) return;
    try { this.ws.removeAllListeners?.(); } catch {}
    try {
      if (this.ws.readyState === 1 || this.ws.readyState === 0) {
        this.ws.close?.();
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
      platform: 'kick',
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

    this._connectPromise = (async () => {
      if (!this.chatroomId) {
        const status = await fetchLiveStatus(this.username, {
          noCache: true,
          fetchImpl: this.fetchImpl || undefined,
          useYtDlpFallback: false,
        });
        if (this.manualClose) throw new Error('connection closed');
        if (!status.chatroomId) {
          throw new Error('Kick chatroom unavailable');
        }
        this.chatroomId = status.chatroomId;
        this.roomId = status.chatroomId;
        if (status.livestream?.viewer_count != null) {
          this.viewerCount = status.livestream.viewer_count;
        }
      }

      if (this.manualClose) throw new Error('connection closed');

      await new Promise((resolve, reject) => {
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
          ? this.wsFactory(KICK_PUSHER_URL)
          : new WebSocket(KICK_PUSHER_URL, { agent: agent || undefined });
        this.ws = ws;

        this._connectTimer = setTimeout(() => {
          this._connectTimer = null;
          if (settled || this.manualClose) return;
          this._cleanupWs();
          const err = new Error('Kick Pusher connection timed out');
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
            ws.send(JSON.stringify({
              event: 'pusher:subscribe',
              data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` },
            }));
          } catch (err) {
            this._cleanupWs();
            this.state = 'error';
            this.error = err?.message || 'Kick Pusher subscribe error';
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
          this._pingTimer = setInterval(() => {
            if (ws.readyState === 1) {
              try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch {}
            }
          }, 60_000);
          this._pingTimer.unref?.();
          this._emitState();
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        ws.on('message', (rawData) => {
          const text = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
          const parsed = parseKickPusherMessage(text);
          if (!parsed) return;
          if (parsed.command === 'PING') {
            try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch {}
            return;
          }
          for (const ev of parsed.events) {
            const { type, ...rest } = ev;
            this.push(type, rest);
          }
        });

        ws.on('error', (err) => {
          const msg = err?.message || 'Kick Pusher error';
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
          this._cleanupWs();
          if (!settled) {
            this.state = 'error';
            this._emitState();
            settleReject(new Error('Kick Pusher closed'));
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
      });
    })().finally(() => {
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
      console.warn(`[chat] writer error for kick:${this.username}:`, e?.message || e);
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
      platform: 'kick',
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
  id: 'kick',
  label: 'Kick',
  referer: 'https://kick.com/',
  normalizeUsername,
  parseKickMasterM3u8,
  parseKickPusherMessage,
  fetchViaYtDlp,
  fetchLiveStatus,
  isLive,
  extractStreamUrls,
  pickPreferredStream,
  hasStreamUrls,
  buildSummary,
  invalidateCache,
  KickChatSession,
};
