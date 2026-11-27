// lib/providers/youtube.js — YouTube Live provider (HTML/InnerTube HLS + Live Chat/Super Chat + optional yt-dlp fallback).

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('node:events');
const accounts = require('../accounts');
const { isPlatformStealth, shouldUseAnonymous, getStealthUserAgent, getStealthYtDlpArgs } = require('../stealth');
const { getProxyAgent, getActiveProxyUrl } = require('../proxy-config');
const { stripControlChars, withTempCookieFile, safeError } = require('../utils');

const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const API_TIMEOUT_MS = 15_000;
const YTDLP_TIMEOUT_MS = 15_000;
const API_CACHE_TTL_MS = Number(process.env.YOUTUBE_API_CACHE_MS) || 5000;
const API_CACHE_MAX = 200;

const RESERVED_YT_PATHS = new Set([
  'watch', 'live', 'results', 'feed', 'shorts', 'playlist',
  'channel', 'gaming', 'account', 'premium', 'about', 'embed',
]);

const DEFAULT_CLIENT_VERSION = '2.20250101.01.00';
const ANDROID_CLIENT_VERSION = '20.10.38';
const ANDROID_USER_AGENT = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';
const IOS_CLIENT_VERSION = '20.10.4';
const IOS_USER_AGENT = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';

const apiCache = new Map();
const apiInflight = new Map();
let cacheEpoch = 0;

function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  if (/^https?:\/\//i.test(s) || /^(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be)\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const host = url.hostname.toLowerCase();
      if (
        host !== 'youtube.com' &&
        !host.endsWith('.youtube.com') &&
        host !== 'youtu.be'
      ) {
        return '';
      }

      if (host === 'youtu.be') {
        const seg = url.pathname.replace(/^\/+/, '').split('/')[0] || '';
        return /^[A-Za-z0-9_-]{11}$/.test(seg) ? `v_${seg}` : '';
      }

      const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      const first = parts[0] || '';
      if (first === 'watch') {
        const vid = url.searchParams.get('v') || '';
        return /^[A-Za-z0-9_-]{11}$/.test(vid) ? `v_${vid}` : '';
      }
      if ((first === 'live' || first === 'embed' || first === 'shorts') && /^[A-Za-z0-9_-]{11}$/.test(parts[1] || '')) {
        return `v_${parts[1]}`;
      }
      if (first === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || '')) {
        return parts[1];
      }
      if ((first === 'c' || first === 'user') && parts[1]) {
        s = parts[1];
      } else {
        s = first;
      }
    } catch {
      return '';
    }
  }

  s = s.replace(/\/(?:live|streams|featured|videos|about)(?:[/?#].*)?$/i, '').replace(/[?#].*$/, '').trim();
  if (/^v_[A-Za-z0-9_-]{11}$/.test(s)) return s;
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return s;

  const handle = s.replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,60}$/.test(handle)) return '';
  if (handle.startsWith('.') || /^\.+$/.test(handle) || handle.includes('..')) return '';
  if (RESERVED_YT_PATHS.has(handle)) return '';
  return handle;
}

function buildChannelUrl(rawUsername) {
  const username = normalizeUsername(rawUsername);
  if (!username) return '';
  const vidMatch = username.match(/^v_([A-Za-z0-9_-]{11})$/);
  if (vidMatch) return `${YOUTUBE_ORIGIN}/watch?v=${vidMatch[1]}`;
  if (/^UC[A-Za-z0-9_-]{22}$/.test(username)) {
    return `${YOUTUBE_ORIGIN}/channel/${username}/live`;
  }
  return `${YOUTUBE_ORIGIN}/@${username}/live`;
}

function isAllowedYouTubeHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtu.be' ||
    h === 'googlevideo.com' ||
    h.endsWith('.googlevideo.com')
  );
}

function isYouTubeCookieHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'youtube.com' || h.endsWith('.youtube.com');
}

function stripCrossHostAuthHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' || lk === 'authorization') continue;
    out[k] = v;
  }
  return out;
}

function getSafeYouTubeCookie({ accountId = null, forceAnon = false } = {}) {
  if (shouldUseAnonymous('youtube', { accountId, forceAnon })) return '';
  const raw = accountId
    ? accounts.getCredentialsById(accountId, 'youtube')?.sessionId
    : accounts.getActivePlatformCredential('youtube');
  return String(raw || '').replace(/[\r\n]/g, '').trim();
}

function buildYouTubeHeaders(extra = {}, hostname = 'www.youtube.com', authOpts = {}) {
  const anon = shouldUseAnonymous('youtube', authOpts);
  const out = {
    'User-Agent': getStealthUserAgent(anon),
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (isYouTubeCookieHost(hostname)) {
    const extraCookie = getSafeYouTubeCookie(authOpts);
    out.Cookie = extraCookie ? `CONSENT=YES+cb; ${extraCookie}` : 'CONSENT=YES+cb';
  }
  return { ...out, ...extra };
}

function defaultHttpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = API_TIMEOUT_MS, maxRedirects = 3, signal, accountId = null, forceAnon = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('YouTube request aborted'));
      return;
    }

    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !isAllowedYouTubeHost(parsed.hostname)) {
      reject(new Error('disallowed youtube request host'));
      return;
    }

    const agent = getProxyAgent();
    const req = https.request(
      parsed,
      {
        method,
        agent: agent || undefined,
        timeout: timeoutMs,
        headers: buildYouTubeHeaders(headers, parsed.hostname, { accountId, forceAnon }),
      },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && maxRedirects > 0) {
          res.on('error', () => {});
          res.resume();
          let nextParsed;
          try { nextParsed = new URL(loc, parsed); } catch {
            reject(new Error('invalid youtube redirect URL'));
            return;
          }
          const sameHost = nextParsed.hostname.toLowerCase() === parsed.hostname.toLowerCase();
          const nextHeaders = sameHost ? headers : stripCrossHostAuthHeaders(headers);
          defaultHttpRequest(nextParsed.toString(), { method: 'GET', headers: nextHeaders, timeoutMs, maxRedirects: maxRedirects - 1, signal, accountId, forceAnon })
            .then(resolve, reject);
          return;
        }

        const chunks = [];
        let total = 0;
        const maxBytes = 5 * 1024 * 1024;
        let overflowed = false;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            overflowed = true;
            try { res.destroy(); } catch {}
            try { req.destroy(new Error('YouTube response exceeded size limit')); } catch {}
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (overflowed) return;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => req.destroy(new Error(`YouTube request timeout after ${timeoutMs}ms`)));
    req.on('error', reject);

    const onAbort = () => req.destroy(new Error('YouTube request aborted'));
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => signal.removeEventListener('abort', onAbort));
    }

    if (body) req.write(body);
    req.end();
  });
}

function extractJsonObjectAfter(html, marker) {
  if (typeof html !== 'string' || !html) return null;
  let startPos = -1;
  if (marker instanceof RegExp) {
    const m = html.match(marker);
    if (!m || m.index === undefined) return null;
    startPos = m.index + m[0].length;
  } else {
    const idx = html.indexOf(String(marker));
    if (idx < 0) return null;
    startPos = idx + String(marker).length;
  }

  let openBrace = startPos;
  while (openBrace < html.length && /\s/.test(html[openBrace])) openBrace++;
  if (openBrace >= html.length || html[openBrace] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBrace; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const rawJson = html.slice(openBrace, i + 1);
        try {
          return JSON.parse(rawJson);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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

function classifyYouTubeVariant({ height, fps }) {
  const f = Number(fps) || 30;
  const fLabel = f >= 50 ? String(Math.round(f)) : '';
  if (height >= 2160) return { sdkKey: f >= 50 ? 'uhd4k_60' : 'uhd4k', level: f >= 50 ? 120 : 115, label: `${height}p${fLabel} (4K)` };
  if (height >= 1440) return { sdkKey: f >= 50 ? 'qhd_60' : 'qhd', level: f >= 50 ? 105 : 100, label: `${height}p${fLabel} (2K)` };
  if (height >= 1080) {
    const key = f >= 50 ? 'uhd_60' : 'uhd';
    return { sdkKey: key, level: f >= 50 ? 90 : 80, label: `${height}p${fLabel}` };
  }
  if (height >= 720) {
    const key = f >= 50 ? 'hd_60' : 'hd';
    return { sdkKey: key, level: f >= 50 ? 70 : 60, label: `${height}p${fLabel}` };
  }
  if (height >= 480) return { sdkKey: 'sd', level: 40, label: `${height}p` };
  if (height >= 360) return { sdkKey: 'ld', level: 30, label: `${height}p` };
  if (height > 0) return { sdkKey: 'md', level: 20, label: `${height}p` };
  return { sdkKey: 'sd', level: 35, label: 'auto' };
}

function isSafeHttpsUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

function pickBestAdaptiveAudio(adaptiveFormats) {
  const audioList = (adaptiveFormats || []).filter(
    (f) => isSafeHttpsUrl(f?.url) && /^audio\//i.test(String(f?.mimeType || '')),
  );
  if (audioList.length === 0) return null;
  audioList.sort((a, b) => {
    const aMp4 = /^audio\/mp4/i.test(String(a.mimeType || '')) ? 1 : 0;
    const bMp4 = /^audio\/mp4/i.test(String(b.mimeType || '')) ? 1 : 0;
    if (bMp4 !== aMp4) return bMp4 - aMp4;
    const a140 = Number(a.itag) === 140 ? 1 : 0;
    const b140 = Number(b.itag) === 140 ? 1 : 0;
    if (b140 !== a140) return b140 - a140;
    return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
  });
  return audioList[0];
}

function mergeAdaptiveFormats(streams, adaptiveFormats) {
  if (!streams || !Array.isArray(adaptiveFormats) || adaptiveFormats.length === 0) return streams;
  if (!streams.adaptive) streams.adaptive = {};
  if (!streams.cmaf) streams.cmaf = {};
  if (!Array.isArray(streams.qualities)) streams.qualities = [];

  const bestAudio = pickBestAdaptiveAudio(adaptiveFormats);
  const videoList = adaptiveFormats.filter(
    (f) =>
      isSafeHttpsUrl(f?.url) &&
      /^video\//i.test(String(f?.mimeType || '')) &&
      Number(f?.height) >= 1440,
  );
  if (videoList.length === 0) return streams;

  const codecRank = (mime) => {
    const m = String(mime || '').toLowerCase();
    if (m.includes('avc1')) return 3;
    if (m.includes('vp9') || m.includes('vp09')) return 2;
    return 1; // av01 etc.
  };

  videoList.sort((a, b) => {
    const ka = classifyYouTubeVariant({ height: Number(a.height), fps: Number(a.fps) });
    const kb = classifyYouTubeVariant({ height: Number(b.height), fps: Number(b.fps) });
    if (kb.level !== ka.level) return kb.level - ka.level;
    const rc = codecRank(b.mimeType) - codecRank(a.mimeType);
    if (rc !== 0) return rc;
    return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
  });

  const existingKeys = new Set(streams.qualities.map((q) => q.sdkKey));
  for (const f of videoList) {
    const info = classifyYouTubeVariant({ height: Number(f.height), fps: Number(f.fps) });
    if (streams.adaptive[info.sdkKey]) continue;
    streams.adaptive[info.sdkKey] = {
      url: f.url,
      audioUrl: bestAudio?.url || null,
      mimeType: String(f.mimeType || 'video/webm'),
      audioMimeType: String(bestAudio?.mimeType || 'audio/mp4'),
      width: Number(f.width) || null,
      height: Number(f.height) || null,
      fps: Number(f.fps) || 30,
      targetDurationSec: Number(f.targetDurationSec) || 5,
      itag: f.itag ?? null,
      audioItag: bestAudio?.itag ?? null,
    };
    streams.cmaf[info.sdkKey] = f.url;
    if (!existingKeys.has(info.sdkKey)) {
      existingKeys.add(info.sdkKey);
      streams.qualities.push({ name: info.label, sdkKey: info.sdkKey, level: info.level });
    }
  }
  streams.qualities.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  return streams;
}

function parseYouTubeMasterM3u8(m3u8Text, baseUrl = '') {
  const out = {
    hls: null,
    hlsByQuality: {},
    audioByQuality: {},
    flv: {},
    cmaf: {},
    adaptive: {},
    hevc: { hls: {}, flv: {}, cmaf: {} },
    qualities: [],
    hevcQualities: [],
  };
  if (typeof m3u8Text !== 'string' || !m3u8Text.trim()) return out;

  const variants = [];
  const audioGroups = new Map();
  const audioGroupRanks = new Map();
  let hasExternalAudio = false;
  const lines = m3u8Text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrList(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO' && attrs.URI) {
        const url = resolvePlaylistUri(attrs.URI, baseUrl);
        if (url) {
          const gid = attrs['GROUP-ID'];
          if (gid) {
            const rank = String(attrs.DEFAULT || '').toUpperCase() === 'YES'
              ? 2
              : (String(attrs.AUTOSELECT || '').toUpperCase() === 'YES' ? 1 : 0);
            if (!audioGroups.has(gid) || rank > (audioGroupRanks.get(gid) ?? -1)) {
              audioGroups.set(gid, url);
              audioGroupRanks.set(gid, rank);
            }
          }
          if (!variants.some((v) => v.sdkKey === 'ao')) {
            variants.push({ sdkKey: 'ao', level: 1, name: 'Audio Only', bandwidth: 0, url, audioGroup: '' });
          }
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
      const info = classifyYouTubeVariant({ height, fps });
      variants.push({
        sdkKey: info.sdkKey,
        level: info.level,
        name: info.label,
        bandwidth,
        url: nextUrl,
        audioGroup: attrs.AUDIO || '',
      });
    }
  }

  variants.sort((a, b) => b.level - a.level || b.bandwidth - a.bandwidth);
  const seenKeys = new Set();
  for (const v of variants) {
    if (seenKeys.has(v.sdkKey)) continue;
    seenKeys.add(v.sdkKey);
    out.hlsByQuality[v.sdkKey] = v.url;
    if (v.audioGroup && audioGroups.has(v.audioGroup)) {
      out.audioByQuality[v.sdkKey] = audioGroups.get(v.audioGroup);
      hasExternalAudio = true;
    }
    out.qualities.push({ name: v.name, sdkKey: v.sdkKey, level: v.level });
  }

  if (hasExternalAudio && baseUrl) {
    out.hls = baseUrl;
  } else {
    const priority = ['uhd4k_60', 'uhd4k', 'qhd_60', 'qhd', 'origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'ld', 'md'];
    for (const q of priority) {
      if (out.hlsByQuality[q]) {
        out.hls = out.hlsByQuality[q];
        break;
      }
    }
    if (!out.hls) {
      out.hls = Object.values(out.hlsByQuality).find(Boolean) || baseUrl || null;
    }
  }

  return out;
}

function extractChatContinuation(initialData) {
  if (!initialData || typeof initialData !== 'object') return null;
  const conts =
    initialData?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer?.continuations;
  if (Array.isArray(conts)) {
    for (const c of conts) {
      const token =
        c?.reloadContinuationData?.continuation ||
        c?.invalidationContinuationData?.continuation ||
        c?.timedContinuationData?.continuation;
      if (token) return token;
    }
  }

  const subMenuItems =
    initialData?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer?.header
      ?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems;
  if (Array.isArray(subMenuItems)) {
    const liveChatItem = subMenuItems.find((s) => s?.continuation?.reloadContinuationData?.continuation);
    if (liveChatItem) return liveChatItem.continuation.reloadContinuationData.continuation;
  }
  return null;
}

function extractViewerCountFromInitialData(initialData) {
  const contents = initialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
  if (!Array.isArray(contents)) return null;
  for (const c of contents) {
    const vcRenderer = c?.videoPrimaryInfoRenderer?.viewCount?.videoViewCountRenderer;
    if (!vcRenderer) continue;
    const raw = vcRenderer.originalViewCount || vcRenderer.viewCount?.runs?.[0]?.text || vcRenderer.viewCount?.simpleText || '';
    const s = String(raw || '').trim();
    if (!s) continue;
    const compact = s.match(/([\d.,]+)\s*([KMB])\b/i);
    if (compact) {
      const num = Number(compact[1].replace(/,/g, ''));
      if (Number.isFinite(num)) {
        const suffix = compact[2].toUpperCase();
        const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : 1e9;
        return Math.round(num * mult);
      }
    }
    const digits = s.replace(/[^\d]/g, '');
    if (digits) return Number(digits);
  }
  return null;
}

let cachedYtDlpPath;
function resolveYtDlp() {
  if (process.env.YTDLP_PATH) {
    const p = process.env.YTDLP_PATH.trim();
    return p && fs.existsSync(p) ? p : null;
  }
  if (cachedYtDlpPath !== undefined) return cachedYtDlpPath;
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
    cachedYtDlpPath = bin;
  } catch {
    cachedYtDlpPath = null;
  }
  return cachedYtDlpPath;
}

function defaultYtDlpExec(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(safeError(err)));
      resolve(stdout);
    });
  });
}

async function fetchViaYtDlp(channelUrl, { ytDlpExec, isAnon = true, cookie = '' } = {}) {
  if (!channelUrl) return null;
  let parsedUrl;
  try { parsedUrl = new URL(channelUrl); } catch { return null; }
  if (parsedUrl.protocol !== 'https:' || !isAllowedYouTubeHost(parsedUrl.hostname)) return null;

  const runner = typeof ytDlpExec === 'function' ? ytDlpExec : defaultYtDlpExec;
  const bin = typeof ytDlpExec === 'function' ? 'yt-dlp' : resolveYtDlp();
  if (!bin) return null;

  const useAnon = Boolean(isAnon || !cookie);
  const runWithCookies = (cookieFile) => {
    const args = ['--no-warnings', '--no-playlist', '-j'];
    const proxyUrl = getActiveProxyUrl();
    if (proxyUrl) args.push('--proxy', proxyUrl);
    if (cookieFile) {
      args.push('--cookies', cookieFile);
    } else if (useAnon) {
      args.push(...getStealthYtDlpArgs(true));
    }
    args.push(channelUrl);
    return runner(bin, args);
  };

  const stdout = !useAnon && cookie
    ? await withTempCookieFile(cookie, '.youtube.com', runWithCookies)
    : await runWithCookies(null);
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
    hlsManifestUrl: hlsUrl,
    videoId: info.id || null,
    title: info.title || null,
    author: info.uploader || info.channel || null,
    channelId: info.channel_id || null,
    viewerCount: (info.concurrent_view_count != null && info.concurrent_view_count !== '' && Number.isFinite(Number(info.concurrent_view_count)))
      ? Number(info.concurrent_view_count)
      : null,
    coverUrl: info.thumbnail || null,
    startedAtUnix: (info.release_timestamp != null && info.release_timestamp !== '' && Number.isFinite(Number(info.release_timestamp)) && Number(info.release_timestamp) > 0)
      ? Number(info.release_timestamp)
      : null,
  };
}

function invalidateCache(username) {
  cacheEpoch++;
  if (!username) {
    apiCache.clear();
    apiInflight.clear();
    return;
  }
  const key = normalizeUsername(username);
  if (!key) return;
  for (const k of apiCache.keys()) {
    if (k === key || k.endsWith(`:${key}`)) apiCache.delete(k);
  }
  for (const k of apiInflight.keys()) {
    if (k === key || k.endsWith(`:${key}`)) apiInflight.delete(k);
  }
}

async function fetchLiveStatus(rawUsername, { noCache = false, fetchImpl, ytDlpExec, useYtDlpFallback = true, accountId = null, forceAnon = false } = {}) {
  const username = normalizeUsername(rawUsername);
  if (!username) throw new Error('invalid youtube username');

  const anon = shouldUseAnonymous('youtube', { accountId, forceAnon });
  const cacheCtx = anon ? 'a' : (accountId ? `u:${accountId}` : 'u');
  const cacheKey = `${cacheCtx}:${username}`;

  const now = Date.now();
  if (!noCache && !fetchImpl && !ytDlpExec) {
    const hit = apiCache.get(cacheKey);
    if (hit && now - hit.ts < API_CACHE_TTL_MS) return hit.data;
    const inflight = apiInflight.get(cacheKey);
    if (inflight) return inflight;
  }

  const requester = typeof fetchImpl === 'function' ? fetchImpl : defaultHttpRequest;
  const channelUrl = buildChannelUrl(username);

  const run = async () => {
    const ytCookie = getSafeYouTubeCookie({ accountId, forceAnon });
    let apiKey = null;
    let clientVersion = DEFAULT_CLIENT_VERSION;
    let videoId = null;
    let channelId = /^UC[A-Za-z0-9_-]{22}$/.test(username) ? username : null;
    let author = null;
    let title = null;
    let coverUrl = null;
    let avatarThumb = null;
    let startedAtUnix = null;
    let viewerCount = null;
    let isLiveFlag = false;
    let hlsManifestUrl = null;
    let adaptiveFormats = [];
    let liveChatContinuation = null;

    let parsedYouTubePage = false;
    let primaryErr = null;

    try {
      const htmlRes = await requester(channelUrl, { method: 'GET', accountId, forceAnon });
      if (!htmlRes?.ok && Number(htmlRes?.status || 0) !== 404) {
        primaryErr = new Error(`YouTube HTTP ${htmlRes?.status || 0}`);
      }
      if (htmlRes?.ok && htmlRes.text) {
        const html = htmlRes.text;
        const keyM = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
        if (keyM) apiKey = keyM[1];
        const verM = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
        if (verM) clientVersion = verM[1];
        const visitorM = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);
        const visitorData = visitorM ? visitorM[1] : null;

        const player = extractJsonObjectAfter(html, /(?:var\s+ytInitialPlayerResponse\s*=|"playerResponse"\s*:)/);
        const initialData = extractJsonObjectAfter(html, /(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=)/);
        parsedYouTubePage = Boolean(player || initialData);

        const vd = player?.videoDetails || null;
        const micro = player?.microformat?.playerMicroformatRenderer || null;
        const playability = player?.playabilityStatus || null;
        const streaming = player?.streamingData || null;

        videoId = vd?.videoId || null;
        channelId = vd?.channelId || micro?.externalChannelId || channelId;
        author = vd?.author || micro?.ownerChannelName || initialData?.metadata?.channelMetadataRenderer?.title || null;
        title = vd?.title || micro?.title?.simpleText || null;

        const thumbs = vd?.thumbnail?.thumbnails || micro?.thumbnail?.thumbnails || [];
        if (Array.isArray(thumbs) && thumbs.length > 0) {
          coverUrl = thumbs[thumbs.length - 1]?.url || null;
        }
        const avatarList =
          initialData?.metadata?.channelMetadataRenderer?.avatar?.thumbnails ||
          initialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[1]
            ?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer?.thumbnail?.thumbnails ||
          [];
        if (Array.isArray(avatarList) && avatarList.length > 0) {
          avatarThumb = avatarList[avatarList.length - 1]?.url || null;
        }

        const startDateStr = micro?.liveBroadcastDetails?.startTimestamp || micro?.publishDate || null;
        if (startDateStr) {
          const parsed = Math.floor(Date.parse(startDateStr) / 1000);
          if (Number.isFinite(parsed)) startedAtUnix = parsed;
        }

        viewerCount = extractViewerCountFromInitialData(initialData);
        if (viewerCount == null && vd?.viewCount && vd?.isLive) {
          const n = Number(String(vd.viewCount).replace(/[^\d]/g, ''));
          if (Number.isFinite(n)) viewerCount = n;
        }

        hlsManifestUrl = streaming?.hlsManifestUrl || null;
        adaptiveFormats = Array.isArray(streaming?.adaptiveFormats) ? streaming.adaptiveFormats : [];
        isLiveFlag = Boolean(
          vd?.isLive === true ||
          (vd?.isLive !== false && playability?.status === 'OK' && vd?.isLiveContent && hlsManifestUrl),
        );

        liveChatContinuation = extractChatContinuation(initialData);
        if (!liveChatContinuation) {
          const contM = html.match(/"liveChatRenderer"[\s\S]{0,1200}?"continuation"\s*:\s*"([^"]+)"/);
          if (contM) liveChatContinuation = contM[1];
        }

        const hasDirectHighAdaptive = adaptiveFormats.some(
          (f) => Number(f?.height) >= 1440 && isSafeHttpsUrl(f?.url),
        );
        const hasAnyHighAdaptiveMeta = adaptiveFormats.some((f) => Number(f?.height) >= 1440);

        // Query ANDROID/IOS InnerTube player if web HTML omitted hlsManifestUrl or omitted direct 2K/4K adaptive URLs
        if (isLiveFlag && videoId && apiKey && (!hlsManifestUrl || (hasAnyHighAdaptiveMeta && !hasDirectHighAdaptive))) {
          const effectiveVisitorData = anon ? null : visitorData;
          const clientTries = [
            {
              ua: ANDROID_USER_AGENT,
              id: '3',
              ver: ANDROID_CLIENT_VERSION,
              client: {
                clientName: 'ANDROID',
                clientVersion: ANDROID_CLIENT_VERSION,
                androidSdkVersion: 34,
                hl: 'en',
                gl: 'US',
                ...(effectiveVisitorData ? { visitorData: effectiveVisitorData } : {}),
              },
            },
            {
              ua: IOS_USER_AGENT,
              id: '5',
              ver: IOS_CLIENT_VERSION,
              client: {
                clientName: 'IOS',
                clientVersion: IOS_CLIENT_VERSION,
                deviceMake: 'Apple',
                deviceModel: 'iPhone16,2',
                osName: 'iPhone',
                osVersion: '18.3.2.22D82',
                hl: 'en',
                gl: 'US',
                ...(effectiveVisitorData ? { visitorData: effectiveVisitorData } : {}),
              },
            },
          ];
          for (const ct of clientTries) {
            try {
              const playerRes = await requester(
                `${YOUTUBE_ORIGIN}/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
                {
                  method: 'POST',
                  accountId,
                  forceAnon,
                  headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': ct.ua,
                    'X-YouTube-Client-Name': ct.id,
                    'X-YouTube-Client-Version': ct.ver,
                    ...(effectiveVisitorData ? { 'X-Goog-Visitor-Id': effectiveVisitorData } : {}),
                  },
                  body: JSON.stringify({
                    videoId,
                    contentCheckOk: true,
                    racyCheckOk: true,
                    context: { client: ct.client },
                  }),
                },
              );
              if (playerRes?.ok && playerRes.text) {
                const pJson = JSON.parse(playerRes.text);
                if (!hlsManifestUrl && pJson?.streamingData?.hlsManifestUrl) {
                  hlsManifestUrl = pJson.streamingData.hlsManifestUrl;
                }
                const pAdaptive = pJson?.streamingData?.adaptiveFormats;
                if (Array.isArray(pAdaptive) && pAdaptive.some((f) => isSafeHttpsUrl(f?.url))) {
                  adaptiveFormats = pAdaptive;
                }
                const gotDirectHigh = adaptiveFormats.some(
                  (f) => Number(f?.height) >= 1440 && isSafeHttpsUrl(f?.url),
                );
                if (hlsManifestUrl && (!hasAnyHighAdaptiveMeta || gotDirectHigh)) break;
              }
            } catch {
              // Try next InnerTube client or optional yt-dlp fallback
            }
          }
        }
      }
    } catch (e) {
      primaryErr = e;
      // Allow optional yt-dlp fallback below
    }

    if ((!parsedYouTubePage || (isLiveFlag && !hlsManifestUrl)) && useYtDlpFallback) {
      try {
        const ytd = await fetchViaYtDlp(channelUrl, { ytDlpExec, isAnon: anon, cookie: ytCookie });
        if (ytd) parsedYouTubePage = true;
        if (ytd && ytd.isLive && ytd.hlsManifestUrl) {
          isLiveFlag = true;
          hlsManifestUrl = ytd.hlsManifestUrl;
          videoId = videoId || ytd.videoId;
          title = title || ytd.title;
          author = author || ytd.author;
          channelId = channelId || ytd.channelId;
          if (viewerCount == null && ytd.viewerCount != null) viewerCount = ytd.viewerCount;
          coverUrl = coverUrl || ytd.coverUrl;
          if (startedAtUnix == null && ytd.startedAtUnix != null) startedAtUnix = ytd.startedAtUnix;
        }
      } catch (e) {
        if (!primaryErr) primaryErr = e;
      }
    }

    if (!parsedYouTubePage && !isLiveFlag && primaryErr) {
      throw primaryErr;
    }

    let streams = null;
    const hasAdaptiveUrls = adaptiveFormats.some((f) => isSafeHttpsUrl(f?.url));
    if (isLiveFlag && (hlsManifestUrl || hasAdaptiveUrls)) {
      if (hlsManifestUrl) {
        try {
          const m3u8Res = await requester(hlsManifestUrl, { method: 'GET', accountId, forceAnon });
          if (m3u8Res?.ok && m3u8Res.text) {
            streams = parseYouTubeMasterM3u8(m3u8Res.text, hlsManifestUrl);
          }
        } catch {
          // Surface master URL even if variant parsing fails
        }
      }
      if (!streams || (!hasStreamUrls(streams) && hlsManifestUrl)) {
        streams = {
          hls: hlsManifestUrl,
          hlsByQuality: hlsManifestUrl ? { origin: hlsManifestUrl } : {},
          audioByQuality: {},
          flv: {},
          cmaf: {},
          adaptive: {},
          hevc: { hls: {}, flv: {}, cmaf: {} },
          qualities: hlsManifestUrl ? [{ name: 'source', sdkKey: 'origin', level: 100 }] : [],
          hevcQualities: [],
        };
      }
      mergeAdaptiveFormats(streams, adaptiveFormats);
    }

    return {
      username,
      authenticated: !anon && Boolean(ytCookie),
      stealth: anon || !ytCookie,
      videoId,
      channelId,
      author,
      title,
      coverUrl,
      avatarThumb,
      startedAtUnix,
      viewerCount,
      isLive: Boolean(isLiveFlag),
      streams,
      masterHlsUrl: hlsManifestUrl,
      apiKey,
      clientVersion,
      liveChatContinuation,
    };
  };

  if (noCache || fetchImpl || ytDlpExec) {
    return run();
  }

  const epoch = cacheEpoch;
  const p = run()
    .then((data) => {
      if (epoch === cacheEpoch) {
        if (!apiCache.has(cacheKey) && apiCache.size >= API_CACHE_MAX) {
          apiCache.delete(apiCache.keys().next().value);
        }
        apiCache.set(cacheKey, { ts: Date.now(), data });
      }
      return data;
    })
    .finally(() => {
      if (apiInflight.get(cacheKey) === p) apiInflight.delete(cacheKey);
    });
  apiInflight.set(cacheKey, p);
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
      audioByQuality: {},
      flv: {},
      cmaf: {},
      adaptive: {},
      hevc: { hls: {}, flv: {}, cmaf: {} },
      qualities: [],
      hevcQualities: [],
    };
  }
  return data.streams;
}

function pickPreferredStream(streams) {
  if (!streams) return null;
  const priority = ['uhd4k_60', 'uhd4k', 'qhd_60', 'qhd', 'origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'ld', 'md'];
  const withAudio = (q, obj) => {
    const audioUrl = streams.audioByQuality?.[q];
    return audioUrl ? { ...obj, audioUrl } : obj;
  };
  for (const q of priority) {
    if (streams.hlsByQuality?.[q]) return withAudio(q, { url: streams.hlsByQuality[q], kind: 'hls', quality: q });
    if (streams.adaptive?.[q]) return { ...streams.adaptive[q], kind: 'yt_adaptive', quality: q };
  }
  const entries = Object.entries(streams.hlsByQuality || {}).filter(([k, v]) => k !== 'ao' && Boolean(v));
  if (entries.length) return withAudio(entries[0][0], { url: entries[0][1], kind: 'hls', quality: entries[0][0] });
  if (streams.hls) return { url: streams.hls, kind: 'hls', quality: 'origin' };
  if (streams.hlsByQuality?.ao) return { url: streams.hlsByQuality.ao, kind: 'hls', quality: 'ao' };
  return null;
}

function hasStreamUrls(streams) {
  return !!(
    streams?.hls ||
    Object.keys(streams?.hlsByQuality || {}).length > 0 ||
    Object.keys(streams?.adaptive || {}).length > 0
  );
}

function buildSummary(username, data, streams) {
  const displayName = data?.author || username;
  const fallbackAuthed = !isPlatformStealth('youtube') && !!accounts.getActivePlatformCredential('youtube');
  const authenticated = typeof data?.authenticated === 'boolean' ? data.authenticated : fallbackAuthed;
  const stealth = typeof data?.stealth === 'boolean' ? data.stealth : !authenticated;
  return {
    platform: 'youtube',
    username,
    live: isLive(data),
    authenticated,
    stealth,
    roomId: data?.videoId || data?.channelId || null,
    liveRoomMode: null,
    title: data?.title || null,
    coverUrl: data?.coverUrl || null,
    startedAtUnix: Number.isFinite(data?.startedAtUnix) ? data.startedAtUnix : null,
    viewerCount: data?.viewerCount ?? null,
    totalEntered: null,
    owner: (data?.author || data?.channelId || data?.avatarThumb)
      ? {
          nickname: displayName,
          uniqueId: username,
          verified: false,
          followers: null,
          avatarThumb: data?.avatarThumb || undefined,
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

// ── YouTube Live Chat (youtubei/v1/live_chat/get_live_chat) ──

function runsToText(obj) {
  if (!obj) return '';
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  if (!Array.isArray(obj.runs)) return '';
  return obj.runs
    .map((r) => {
      if (!r) return '';
      if (typeof r.text === 'string') return r.text;
      if (r.emoji) {
        return r.emoji.shortcuts?.[0] || (r.emoji.isCustomEmoji ? `:${r.emoji.emojiId || 'emoji'}:` : r.emoji.emojiId) || '';
      }
      return '';
    })
    .join('');
}

function estimateSuperChatDiamonds(amountText) {
  const s = String(amountText || '').trim();
  if (!s) return 100;
  const isEuroDecimal = /,\d{2}(?:\s|$)/.test(s) && !/\.\d{2}(?:\s|$)/.test(s);
  const normalized = isEuroDecimal ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const numM = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!numM) return 100;
  const val = Number(numM[1]);
  if (!Number.isFinite(val) || val <= 0) return 100;

  if (/^(?:US)?\$|USD|€|£|EUR|GBP|A\$|CA\$|SGD/i.test(s)) {
    return Math.max(10, Math.round(val * 100));
  }
  if (/฿|THB|NT\$|TWD|MX\$|₱|PHP/i.test(s)) {
    return Math.max(10, Math.round(val * 3));
  }
  if (/¥|￥|JPY|₩|KRW|₫|VND/i.test(s)) {
    return Math.max(10, Math.round(val * 0.7));
  }
  return Math.max(10, Math.round(val * 10));
}

function extractYouTubeAuthor(r) {
  const nickname = stripControlChars(runsToText(r?.authorName) || '', 80) || '?';
  const channelId = r?.authorExternalChannelId ? String(r.authorExternalChannelId) : undefined;
  const photos = r?.authorPhoto?.thumbnails;
  const avatar = Array.isArray(photos) && photos.length ? photos[photos.length - 1]?.url : undefined;
  return {
    uniqueId: nickname,
    nickname,
    userId: channelId,
    profilePictureUrl: avatar,
  };
}

function uSecToMs(uSec) {
  const n = Number(uSec);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return Math.floor(n / 1000);
}

function parseYouTubeChatAction(action) {
  const item = action?.addChatItemAction?.item;
  if (!item || typeof item !== 'object') return null;

  if (item.liveChatTextMessageRenderer) {
    const r = item.liveChatTextMessageRenderer;
    const comment = stripControlChars(runsToText(r.message), 500);
    if (!comment) return null;
    return {
      msgId: r.id || null,
      ts: uSecToMs(r.timestampUsec),
      event: {
        type: 'chat',
        user: extractYouTubeAuthor(r),
        comment,
      },
    };
  }

  if (item.liveChatPaidMessageRenderer) {
    const r = item.liveChatPaidMessageRenderer;
    const amount = stripControlChars(runsToText(r.purchaseAmountText), 40);
    const comment = stripControlChars(runsToText(r.message), 500);
    return {
      msgId: r.id || null,
      ts: uSecToMs(r.timestampUsec),
      event: {
        type: 'gift',
        user: extractYouTubeAuthor(r),
        giftName: amount ? `Super Chat (${amount})` : 'Super Chat',
        repeatCount: 1,
        diamondCount: estimateSuperChatDiamonds(amount),
        comment,
      },
    };
  }

  if (item.liveChatPaidStickerRenderer) {
    const r = item.liveChatPaidStickerRenderer;
    const amount = stripControlChars(runsToText(r.purchaseAmountText), 40);
    const label = stripControlChars(r.sticker?.accessibility?.accessibilityData?.label || '', 120);
    return {
      msgId: r.id || null,
      ts: uSecToMs(r.timestampUsec),
      event: {
        type: 'gift',
        user: extractYouTubeAuthor(r),
        giftName: amount ? `Super Sticker (${amount})` : 'Super Sticker',
        repeatCount: 1,
        diamondCount: estimateSuperChatDiamonds(amount),
        comment: label,
      },
    };
  }

  if (item.liveChatMembershipItemRenderer) {
    const r = item.liveChatMembershipItemRenderer;
    const subtext = stripControlChars(
      runsToText(r.headerSubtext) || runsToText(r.headerPrimaryText) || runsToText(r.message) || 'Member',
      160,
    );
    return {
      msgId: r.id || null,
      ts: uSecToMs(r.timestampUsec),
      event: {
        type: 'subscribe',
        user: extractYouTubeAuthor(r),
        label: subtext,
      },
    };
  }

  if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
    const r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
    const hdr = r.header?.liveChatSponsorshipsHeaderRenderer || {};
    const nickname = stripControlChars(runsToText(hdr.authorName) || 'Member', 80);
    const photos = hdr.authorPhoto?.thumbnails;
    const avatar = Array.isArray(photos) && photos.length ? photos[photos.length - 1]?.url : undefined;
    const label = stripControlChars(runsToText(hdr.primaryText) || 'Gifted Memberships', 160);
    return {
      msgId: r.id || null,
      ts: uSecToMs(r.timestampUsec),
      event: {
        type: 'subscribe',
        user: {
          uniqueId: nickname,
          nickname,
          userId: r.authorExternalChannelId ? String(r.authorExternalChannelId) : undefined,
          profilePictureUrl: avatar,
        },
        label,
      },
    };
  }

  if (item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer) {
    const r = item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer;
    const label = stripControlChars(runsToText(r.message) || 'Received Gifted Membership', 160);
    return {
      msgId: r.id || null,
      ts: uSecToMs(r.timestampUsec),
      event: {
        type: 'subscribe',
        user: extractYouTubeAuthor(r),
        label,
      },
    };
  }

  if (item.giftMessageViewModel) {
    const g = item.giftMessageViewModel;
    const nickname = stripControlChars(
      g.authorName?.content || runsToText(g.authorName) || 'Viewer',
      80,
    );
    const thumbList = g.authorPhoto?.image?.sources || g.authorPhoto?.thumbnails || [];
    const avatar = Array.isArray(thumbList) && thumbList.length ? thumbList[thumbList.length - 1]?.url : undefined;
    const text = stripControlChars(
      g.text?.content || runsToText(g.text) || g.giftName?.content || 'YouTube Gift',
      80,
    );
    const jewels = Number(g.jewelsCount ?? g.amount ?? 0);
    return {
      msgId: g.id || null,
      ts: uSecToMs(g.timestampUsec),
      event: {
        type: 'gift',
        user: {
          uniqueId: nickname,
          nickname,
          userId: g.authorExternalChannelId ? String(g.authorExternalChannelId) : undefined,
          profilePictureUrl: avatar,
        },
        giftName: text || 'YouTube Gift',
        repeatCount: 1,
        diamondCount: Number.isFinite(jewels) && jewels > 0 ? jewels : 100,
      },
    };
  }

  return null;
}

const RING_BUFFER_SIZE = 500;
const SEEN_ID_MAX = 1000;
const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];
const MAX_RECONNECT_ATTEMPTS = 12;

class YouTubeChatSession extends EventEmitter {
  constructor(username, { chatEvents, fetchImpl, apiKey, continuation, clientVersion } = {}) {
    super();
    this.platform = 'youtube';
    this.username = normalizeUsername(username) || String(username || '').trim();
    this.chatEvents = chatEvents || null;
    this.fetchImpl = fetchImpl || null;
    this.apiKey = apiKey || null;
    this.continuation = continuation || null;
    this.clientVersion = clientVersion || DEFAULT_CLIENT_VERSION;
    this.events = [];
    this.nextId = 1;
    this.viewerCount = null;
    this.startedAt = null;
    this.state = 'idle';
    this.error = null;
    this.writers = new Set();
    this.listeners = new Set();
    this.manualClose = false;
    this.uiActive = false;
    this.recorderRefs = 0;
    this.accountId = null;
    this.roomId = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this._pollTimer = null;
    this._viewerTimer = null;
    this._abortCtrl = null;
    this._connectPromise = null;
    this._connectSeq = 0;
    this._consecutivePollErrors = 0;
    this._seenMsgIds = new Set();
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
      platform: 'youtube',
      username: this.username,
      session: this.info(),
    });
  }

  _clearPollTimer() {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._viewerTimer) {
      clearInterval(this._viewerTimer);
      this._viewerTimer = null;
    }
    if (this._abortCtrl) {
      try { this._abortCtrl.abort(); } catch {}
      this._abortCtrl = null;
    }
  }

  async _refreshViewerCount() {
    if (this.fetchImpl || this.manualClose || this.state !== 'connected') return;
    try {
      const data = await fetchLiveStatus(this.username, { noCache: true, useYtDlpFallback: false, accountId: this.accountId || null });
      if (this.manualClose || this.state !== 'connected') return;
      if (data?.viewerCount != null && data.viewerCount !== this.viewerCount) {
        this.viewerCount = data.viewerCount;
        this._emitState();
      }
    } catch {}
  }

  _trackSeenId(msgId) {
    if (!msgId) return true;
    if (this._seenMsgIds.has(msgId)) return false;
    if (this._seenMsgIds.size >= SEEN_ID_MAX) {
      this._seenMsgIds.delete(this._seenMsgIds.values().next().value);
    }
    this._seenMsgIds.add(msgId);
    return true;
  }

  _schedulePoll(delayMs = 3000) {
    if (this.manualClose || this.state !== 'connected' || !this.hasConsumers() || !this.continuation) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this._pollOnce().catch(() => {});
    }, Math.max(200, delayMs));
    this._pollTimer.unref?.();
  }

  async _pollOnce() {
    if (this.manualClose || this.state !== 'connected' || !this.hasConsumers()) return;
    if (!this.apiKey || !this.continuation) return;

    const seq = this._connectSeq;
    const requester = typeof this.fetchImpl === 'function' ? this.fetchImpl : defaultHttpRequest;
    const ctrl = new AbortController();
    this._abortCtrl = ctrl;

    let nextDelay = 3000;
    try {
      const res = await requester(
        `${YOUTUBE_ORIGIN}/youtubei/v1/live_chat/get_live_chat?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          accountId: this.accountId || null,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: this.clientVersion || DEFAULT_CLIENT_VERSION,
                hl: 'en',
                gl: 'US',
              },
            },
            continuation: this.continuation,
          }),
          signal: ctrl.signal,
        },
      );
      if (this._abortCtrl === ctrl) this._abortCtrl = null;
      if (this.manualClose || this._connectSeq !== seq || this.state !== 'connected') return;
      if (!res?.ok || !res.text) {
        throw new Error(`YouTube live chat HTTP ${res?.status || 0}`);
      }

      const data = JSON.parse(res.text);
      const chatCont = data?.continuationContents?.liveChatContinuation;
      if (!chatCont) {
        this.continuation = null;
        this._clearPollTimer();
        this.state = 'closed';
        this._emitState();
        return;
      }

      const actions = Array.isArray(chatCont.actions) ? chatCont.actions : [];
      for (const action of actions) {
        const parsed = parseYouTubeChatAction(action);
        if (!parsed) continue;
        if (!this._trackSeenId(parsed.msgId)) continue;
        const { type, ...rest } = parsed.event;
        this.push(type, rest, parsed.ts);
      }

      const contList = Array.isArray(chatCont.continuations) ? chatCont.continuations : [];
      let nextCont = null;
      let rawTimeoutMs = 3000;
      for (const c of contList) {
        const obj = c?.invalidationContinuationData || c?.timedContinuationData || c?.reloadContinuationData;
        if (obj?.continuation) {
          nextCont = obj.continuation;
          if (obj.timeoutMs) rawTimeoutMs = Number(obj.timeoutMs);
          break;
        }
      }

      this.continuation = nextCont;
      this._consecutivePollErrors = 0;
      if (this.reconnectAttempts > 0 && this.health.lastConnectedAt && Date.now() - this.health.lastConnectedAt >= 30_000) {
        this.reconnectAttempts = 0;
      }
      nextDelay = Math.min(15_000, Math.max(1000, Number.isFinite(rawTimeoutMs) ? rawTimeoutMs : 3000));
    } catch (err) {
      if (this._abortCtrl === ctrl) this._abortCtrl = null;
      if (this.manualClose || this._connectSeq !== seq || this.state !== 'connected') return;
      this._consecutivePollErrors++;
      this.error = safeError(err) || 'YouTube chat poll failed';
      this.health.errorsCount++;
      this.health.lastError = { message: this.error, at: Date.now() };
      if (this._consecutivePollErrors >= 5) {
        this.continuation = null;
        this._clearPollTimer();
        this.health.lastDisconnectedAt = Date.now();
        if (this.hasConsumers()) {
          this.state = 'reconnecting';
          this._emitState();
          this._scheduleReconnect();
        } else {
          this.state = 'closed';
          this._emitState();
        }
        return;
      }
      nextDelay = 5000;
    }

    if (this.manualClose || this._connectSeq !== seq || this.state !== 'connected') return;

    if (!this.continuation) {
      this._clearPollTimer();
      this.state = 'closed';
      this._emitState();
      return;
    }

    this._schedulePoll(nextDelay);
  }

  _scheduleReconnect() {
    if (this.manualClose || !this.hasConsumers()) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._clearPollTimer();
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

  push(type, payload, customTs = null) {
    const ts = Number.isFinite(customTs) && customTs > 0 ? customTs : Date.now();
    const ev = { id: this.nextId++, ts, type, ...payload };
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
      platform: 'youtube',
      username: this.username,
      event: ev,
      session: this.info(),
    });
  }

  async connect() {
    if (this.state === 'connected') return;
    if (this._connectPromise) return this._connectPromise;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const seq = ++this._connectSeq;
    this.manualClose = false;
    this.state = 'connecting';
    this.error = null;
    this._emitState();

    const p = (async () => {
      if (!this.continuation || !this.apiKey || this.reconnectAttempts > 0) {
        const status = await fetchLiveStatus(this.username, {
          noCache: true,
          fetchImpl: this.fetchImpl || undefined,
          useYtDlpFallback: false,
          accountId: this.accountId || null,
        });
        if (this.manualClose || this._connectSeq !== seq) throw new Error('connection closed');
        if (!status.isLive || !status.liveChatContinuation || !status.apiKey) {
          throw new Error('YouTube live chat unavailable or stream is offline');
        }
        this.apiKey = status.apiKey;
        this.continuation = status.liveChatContinuation;
        this.clientVersion = status.clientVersion || DEFAULT_CLIENT_VERSION;
        this.roomId = status.videoId || this.roomId;
        if (status.viewerCount != null) this.viewerCount = status.viewerCount;
      }

      if (this.manualClose || this._connectSeq !== seq) throw new Error('connection closed');

      this._consecutivePollErrors = 0;
      this.state = 'connected';
      this.startedAt = this.startedAt || Date.now();
      if (this.reconnectAttempts > 0) this.health.reconnectCount++;
      this.health.lastConnectedAt = Date.now();
      if (this._stabilityTimer) clearTimeout(this._stabilityTimer);
      this._stabilityTimer = setTimeout(() => {
        this._stabilityTimer = null;
        if (!this.manualClose && this.state === 'connected' && this._connectSeq === seq) {
          this.reconnectAttempts = 0;
        }
      }, 30_000);
      this._stabilityTimer.unref?.();
      if (!this.fetchImpl) {
        if (this._viewerTimer) clearInterval(this._viewerTimer);
        this._viewerTimer = setInterval(() => { void this._refreshViewerCount(); }, 60_000);
        this._viewerTimer.unref?.();
      }
      this._emitState();

      this._schedulePoll(50);
    })()
      .catch((err) => {
        this.error = safeError(err) || 'YouTube live chat failed';
        if (!this.manualClose) {
          this.state = 'error';
          this.health.errorsCount++;
          this.health.lastError = { message: this.error, at: Date.now() };
          this._emitState();
        }
        throw err;
      })
      .finally(() => {
        if (this._connectPromise === p) {
          this._connectPromise = null;
        }
      });

    this._connectPromise = p;
    return p;
  }

  attachFile(filePath) {
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', (e) => {
      console.warn(`[chat] writer error for youtube:${this.username}:`, safeError(e));
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
    this._connectSeq++;
    this.manualClose = true;
    this.uiActive = false;
    this.recorderRefs = 0;
    this._connectPromise = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._clearPollTimer();
    for (const w of this.writers) { try { w.end(); } catch {} }
    this.writers.clear();
    this.listeners.clear();
    this.state = 'closed';
    this._emitState();
  }

  snapshot(sinceId = 0) {
    return sinceId ? this.events.filter((e) => e.id > sinceId) : [...this.events];
  }

  info() {
    return {
      platform: 'youtube',
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
  id: 'youtube',
  label: 'YouTube',
  referer: 'https://www.youtube.com/',
  normalizeUsername,
  buildChannelUrl,
  buildYouTubeHeaders,
  defaultHttpRequest,
  extractJsonObjectAfter,
  extractViewerCountFromInitialData,
  classifyYouTubeVariant,
  mergeAdaptiveFormats,
  parseYouTubeMasterM3u8,
  parseYouTubeChatAction,
  estimateSuperChatDiamonds,
  resolveYtDlp,
  fetchViaYtDlp,
  fetchLiveStatus,
  isLive,
  extractStreamUrls,
  pickPreferredStream,
  hasStreamUrls,
  buildSummary,
  invalidateCache,
  YouTubeChatSession,
};
