// lib/room.js — Shared helpers built on tiktok-live-connector.
// Uses RouteConfig.fetchRoomInfoFromApiLive which returns full live + stream data
// (the higher-level fetchRoomInfo() requires a signed webcast call that
// can fail without paid Euler plans).

const { TikTokLiveConnection, RouteConfig } = require('tiktok-live-connector');
const { getTikTokClientProxyOptions, getProxyList, getActiveProxyUrl, rotateProxy } = require('./proxy-config');
const { safeError } = require('./utils');
const stealth = require('./stealth');

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  // Support pasting full TikTok URLs (e.g. https://www.tiktok.com/@user/live)
  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.)?tiktok\.com\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const host = url.hostname.toLowerCase();
      if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return '';
      const m = url.pathname.match(/^\/@?([^/]+)/);
      s = m ? m[1] : '';
    } catch {
      return '';
    }
  } else {
    // Support pasting "user/live" or "@user/live"
    s = s.replace(/^@/, '').replace(/\/live(?:[/?#].*)?$/i, '');
  }

  const u = s.replace(/^@/, '').trim().slice(0, 50);
  // TikTok usernames: letters, digits, underscores, periods (never dot-only like "." or "..")
  if (!u || !/^(?!\.+$)[\w.]+$/.test(u)) return '';
  return u;
}

function logQualities(username, mode, qs) {
  if (process.env.QUIET_LOGS) return;
  const sdkeys = qs?.length ? qs.map((q) => `${q.name}:${q.sdk_key}(L${q.level})`).join(', ') : '(none)';
  console.log(`[room] @${username} ${mode} → qualities: ${sdkeys}`);
}

const API_TIMEOUT_MS = 15000; // 15s timeout for TikTok API calls

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TikTok API timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Stealth mode — delegated to lib/stealth.js (unified across all 7 platforms).
function getStealthMode() { return stealth.getStealthMode(); }
function setStealthMode(v, opts) {
  const res = stealth.setStealthMode(v, opts);
  // Stealth toggle changes auth context — invalidate cache to avoid serving
  // results from the wrong identity.
  invalidateApiCache();
  return res;
}

// ── In-memory TTL cache for apiLive responses ──
// Multiple subsystems hit the same /apiLive endpoint within a few seconds
// (watcher poller, dashboard, /api/check, grid view, /api/stream). Caching
// for a few seconds collapses these into one upstream call, which in turn
// drops CPU spent on protobuf parsing, TikTokLiveConnection construction,
// and TikTok rate-limit pressure.
const API_CACHE_TTL_MS = Number(process.env.TIKTOK_API_CACHE_MS) || 5000;
const API_CACHE_MAX = 200;
const apiCache = new Map(); // key -> { ts, data }
const apiInflight = new Map(); // key -> Promise
let cacheEpoch = 0;

function cacheKey(username, anon, accountId = null) {
  const ctx = anon ? 'a' : (accountId ? `u:${accountId}` : 'u');
  return `${ctx}:${username}`;
}

// Allow callers to invalidate when an account switch happens etc.
function invalidateApiCache(username) {
  cacheEpoch++;
  if (!username) {
    apiCache.clear();
    apiInflight.clear();
    return;
  }
  for (const k of apiCache.keys()) {
    if (k.endsWith(`:${username}`)) apiCache.delete(k);
  }
  for (const k of apiInflight.keys()) {
    if (k.endsWith(`:${username}`)) apiInflight.delete(k);
  }
}

async function fetchApiLive(username, { forceAnon, noCache, accountId } = {}) {
  const anon = stealth.shouldUseAnonymous('tiktok', { accountId, forceAnon });
  const key = cacheKey(username, anon, accountId);
  const now = Date.now();

  // Serve cached result if still fresh.
  if (!noCache) {
    const hit = apiCache.get(key);
    if (hit && now - hit.ts < API_CACHE_TTL_MS) return hit.data;

    // Coalesce concurrent in-flight requests for the same key so 10 callers
    // arriving in the same tick share one upstream fetch.
    const inflight = apiInflight.get(key);
    if (inflight) return inflight;
  }

  const epoch = cacheEpoch;
  const p = _fetchApiLiveWithProxyFailover(username, anon, accountId).then((data) => {
    if (epoch === cacheEpoch) {
      if (!apiCache.has(key) && apiCache.size >= API_CACHE_MAX) {
        const oldestKey = apiCache.keys().next().value;
        apiCache.delete(oldestKey);
      }
      apiCache.set(key, { ts: Date.now(), data });
    }
    return data;
  }).finally(() => {
    if (apiInflight.get(key) === p) {
      apiInflight.delete(key);
    }
  });
  if (!noCache) apiInflight.set(key, p);
  return p;
}

async function _fetchApiLiveWithProxyFailover(username, anon, accountId) {
  const usedProxy = getActiveProxyUrl();
  try {
    return await _fetchApiLiveInner(username, anon, accountId);
  } catch (e) {
    if (getProxyList().length > 1) {
      rotateProxy(usedProxy);
      return _fetchApiLiveInner(username, anon, accountId);
    }
    throw e;
  }
}

function buildConnOpts({ sessionId, ttTargetIdc, eulerKey } = {}) {
  const opts = { ...getTikTokClientProxyOptions() };
  if (sessionId) {
    opts.session = {
      cookie: {
        type: 'cookie',
        value: { sessionId, ttTargetIdc: ttTargetIdc || '' },
      },
    };
    opts.authenticateWs = false;
  }
  if (eulerKey) opts.signApiKey = eulerKey;
  return opts;
}

async function _fetchApiLiveInner(username, anon, accountId) {
  // Snapshot credentials synchronously here to avoid stale reads after a
  // concurrent account switch during this async call.
  const { getActiveCredentials, getCredentialsById } = require('./accounts');
  const creds = accountId ? getCredentialsById(accountId) : getActiveCredentials();
  const sessionId = anon ? undefined : creds.sessionId;
  const ttTargetIdc = anon ? undefined : creds.ttTargetIdc;
  const eulerKey = process.env.EULER_API_KEY;

  const connOpts = buildConnOpts({ sessionId, ttTargetIdc, eulerKey });
  let usedAuth = !!connOpts.session;
  const conn = new TikTokLiveConnection(username, connOpts);

  // Always start with apiLive — it's required for status/roomId/user info.
  let apiData = null;
  try {
    const res = await withTimeout(
      RouteConfig.fetchRoomInfoFromApiLive({ uniqueId: username, webClient: conn.webClient }),
      API_TIMEOUT_MS
    );
    apiData = res?.data || {};
  } catch (e) {
    if (usedAuth) {
      console.warn('[room] authenticated apiLive failed, retrying anonymous:', safeError(e));
      usedAuth = false;
      const anonConn = new TikTokLiveConnection(username, buildConnOpts({ eulerKey }));
      const res = await withTimeout(
        RouteConfig.fetchRoomInfoFromApiLive({ uniqueId: username, webClient: anonConn.webClient }),
        API_TIMEOUT_MS
      );
      apiData = res?.data || {};
    } else {
      throw e;
    }
  }

  // Note: webcast endpoint via Euler (fetchRoomInfoFromEuler) is a premium-only
  // route on Euler Stream and returns richer data only with paid plans.
  // We rely on apiLive's hevcStreamData for the full quality list instead — it
  // includes 1080p/origin etc. via HEVC codec, which is accessible for free.
  const mode = usedAuth ? 'AUTH' : 'ANON';
  const h264 = apiData?.liveRoom?.streamData?.pull_data?.options?.qualities;
  const hevc = apiData?.liveRoom?.hevcStreamData?.pull_data?.options?.qualities;
  logQualities(username, `${mode}/h264`, h264);
  if (hevc?.length) logQualities(username, `${mode}/hevc`, hevc);
  if (apiData && typeof apiData === 'object') {
    Object.defineProperty(apiData, '__tlrAuth', {
      value: { authenticated: usedAuth, stealth: anon || !usedAuth },
      enumerable: false,
      configurable: true,
    });
  }
  return apiData;
}

// status === 2 → live, status === 4 → offline (per connector source)
function isLiveFromApi(apiData) {
  const s = apiData?.liveRoom?.status ?? apiData?.user?.status;
  return s === 2;
}

function extractStreamUrls(apiData) {
  const out = {
    hls: null,
    hlsByQuality: {},
    flv: {},
    cmaf: {},
    qualities: [],
    // HEVC (H.265) variants — usually have higher resolutions (1080p+) but
    // limited browser playback support. Recording via ffmpeg works fine.
    hevc: { hls: {}, flv: {}, cmaf: {} },
    hevcQualities: [],
    rawStreamData: null,
  };

  const processBlock = (pull, target) => {
    if (!pull) return [];
    const opts = pull.options || {};
    const qualities = (opts.qualities || []).map((q) => ({
      name: q.name,
      sdkKey: q.sdk_key,
      level: q.level,
    }));
    const sd = typeof pull.stream_data === 'string'
      ? safeJsonParse(pull.stream_data)
      : pull.stream_data;
    if (sd?.data) {
      for (const [q, v] of Object.entries(sd.data)) {
        const main = v?.main || {};
        if (main.hls) target.hls[q] = main.hls;
        if (main.flv) target.flv[q] = main.flv;
        if (main.cmaf) target.cmaf[q] = main.cmaf;
      }
    }
    return qualities;
  };

  // H.264 (default codec, broad browser support)
  const h264Pull = apiData?.liveRoom?.streamData?.pull_data;
  out.qualities = processBlock(h264Pull, { hls: out.hlsByQuality, flv: out.flv, cmaf: out.cmaf });
  out.defaultQuality = h264Pull?.options?.default_quality?.sdk_key || null;

  // Pick highest-quality H.264 HLS as the "primary" hls field.
  const priority = ['origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'md', 'ld'];
  for (const q of priority) {
    if (out.hlsByQuality[q] && !out.hls) out.hls = out.hlsByQuality[q];
  }
  if (!out.hls) {
    const firstHls = Object.values(out.hlsByQuality).find(Boolean);
    if (firstHls) out.hls = firstHls;
  }

  // H.265/HEVC (richer quality list including 1080p when available)
  const hevcPull = apiData?.liveRoom?.hevcStreamData?.pull_data;
  out.hevcQualities = processBlock(hevcPull, out.hevc);

  // Keep raw H.264 data for backward compat
  out.rawStreamData = typeof h264Pull?.stream_data === 'string'
    ? safeJsonParse(h264Pull.stream_data)
    : h264Pull?.stream_data || null;

  return out;
}

function pickPreferredStream(streams) {
  if (!streams || typeof streams !== 'object') return null;
  const priority = ['origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'md', 'ld'];
  const withAudio = (q, obj) => {
    const audioUrl = streams.audioByQuality?.[q];
    return audioUrl ? { ...obj, audioUrl } : obj;
  };
  for (const q of priority) {
    if (streams.flv?.[q]) return { url: streams.flv[q], kind: 'flv', quality: q };
  }
  for (const q of priority) {
    if (streams.cmaf?.[q]) return { url: streams.cmaf[q], kind: 'cmaf', quality: q };
  }
  for (const q of priority) {
    if (streams.hlsByQuality?.[q]) return withAudio(q, { url: streams.hlsByQuality[q], kind: 'hls', quality: q });
  }

  // Other non-'ao' entries in H.264 before falling back to HEVC or audio-only
  const flvEntries = Object.entries(streams.flv || {}).filter(([k, v]) => k !== 'ao' && Boolean(v));
  if (flvEntries.length) return { url: flvEntries[0][1], kind: 'flv', quality: flvEntries[0][0] };

  const cmafEntries = Object.entries(streams.cmaf || {}).filter(([k, v]) => k !== 'ao' && Boolean(v));
  if (cmafEntries.length) return { url: cmafEntries[0][1], kind: 'cmaf', quality: cmafEntries[0][0] };

  const hlsEntries = Object.entries(streams.hlsByQuality || {}).filter(([k, v]) => k !== 'ao' && Boolean(v));
  if (hlsEntries.length) return withAudio(hlsEntries[0][0], { url: hlsEntries[0][1], kind: 'hls', quality: hlsEntries[0][0] });

  if (streams.hls) return { url: streams.hls, kind: 'hls', quality: 'default' };

  // HEVC video fallback (priority order + arbitrary non-'ao' sdkKeys) before audio-only 'ao'
  for (const q of priority) {
    if (streams.hevc?.flv?.[q]) return { url: streams.hevc.flv[q], kind: 'flv', quality: `hevc:${q}` };
  }
  for (const q of priority) {
    if (streams.hevc?.hls?.[q]) return { url: streams.hevc.hls[q], kind: 'hls', quality: `hevc:${q}` };
  }
  for (const q of priority) {
    if (streams.hevc?.cmaf?.[q]) return { url: streams.hevc.cmaf[q], kind: 'cmaf', quality: `hevc:${q}` };
  }
  for (const [kind, map] of [['flv', streams.hevc?.flv], ['hls', streams.hevc?.hls], ['cmaf', streams.hevc?.cmaf]]) {
    const entry = Object.entries(map || {}).find(([k, v]) => k !== 'ao' && Boolean(v));
    if (entry) return { url: entry[1], kind, quality: `hevc:${entry[0]}` };
  }

  // Last resort: audio-only ('ao')
  if (streams.flv?.ao) return { url: streams.flv.ao, kind: 'flv', quality: 'ao' };
  if (streams.cmaf?.ao) return { url: streams.cmaf.ao, kind: 'cmaf', quality: 'ao' };
  if (streams.hlsByQuality?.ao) return { url: streams.hlsByQuality.ao, kind: 'hls', quality: 'ao' };
  if (streams.hevc?.flv?.ao) return { url: streams.hevc.flv.ao, kind: 'flv', quality: 'hevc:ao' };
  if (streams.hevc?.hls?.ao) return { url: streams.hevc.hls.ao, kind: 'hls', quality: 'hevc:ao' };
  if (streams.hevc?.cmaf?.ao) return { url: streams.hevc.cmaf.ao, kind: 'cmaf', quality: 'hevc:ao' };

  return null;
}

function hasStreamUrls(streams) {
  if (!streams) return false;
  return !!(
    streams.hls ||
    Object.keys(streams.flv || {}).length ||
    Object.keys(streams.cmaf || {}).length ||
    Object.keys(streams.hlsByQuality || {}).length ||
    Object.keys(streams.hevc?.flv || {}).length ||
    Object.keys(streams.hevc?.hls || {}).length ||
    Object.keys(streams.hevc?.cmaf || {}).length
  );
}

function buildSummary(username, apiData, streams) {
  const { getActiveCredentials } = require('./accounts');
  const hasSession = !!getActiveCredentials().sessionId;
  const stealthActive = stealth.isPlatformStealth('tiktok');
  const authMeta = apiData?.__tlrAuth;
  const authenticated = typeof authMeta?.authenticated === 'boolean'
    ? authMeta.authenticated
    : (hasSession && !stealthActive);
  const effectiveStealth = typeof authMeta?.stealth === 'boolean'
    ? authMeta.stealth
    : (stealthActive || !hasSession);
  return {
    username,
    live: isLiveFromApi(apiData),
    authenticated,
    stealth: effectiveStealth,
    roomId: apiData?.user?.roomId || null,
    liveRoomMode: apiData?.liveRoom?.liveRoomMode ?? null,
    title: apiData?.liveRoom?.title || null,
    coverUrl: apiData?.liveRoom?.coverUrl || null,
    startedAtUnix: apiData?.liveRoom?.startTime || null,
    viewerCount: apiData?.liveRoom?.liveRoomStats?.userCount ?? null,
    totalEntered: apiData?.liveRoom?.liveRoomStats?.enterCount ?? null,
    owner: apiData?.user
      ? {
          nickname: apiData.user.nickname,
          uniqueId: apiData.user.uniqueId,
          verified: !!apiData.user.verified,
          followers: apiData?.stats?.followerCount ?? null,
        }
      : null,
    streams: streams
      ? {
          hls: streams.hls,
          hlsByQuality: streams.hlsByQuality,
          flv: streams.flv,
          cmaf: streams.cmaf,
          qualities: streams.qualities,
          hevc: streams.hevc,
          hevcQualities: streams.hevcQualities,
        }
      : undefined,
  };
}

module.exports = {
  normalizeUsername,
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  pickPreferredStream,
  hasStreamUrls,
  buildSummary,
  getStealthMode,
  setStealthMode,
  invalidateApiCache,
};
