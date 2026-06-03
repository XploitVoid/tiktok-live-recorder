// lib/room.js — Shared helpers built on tiktok-live-connector.
// Uses webClient.fetchRoomInfoFromApiLive which returns full live + stream data
// (the higher-level fetchRoomInfo() requires a signed webcast call that
// currently fails with "Request params error").

const { WebcastPushConnection } = require('tiktok-live-connector');

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function normalizeUsername(raw) {
  const u = (raw || '').replace(/^@/, '').trim().slice(0, 50);
  // TikTok usernames: letters, digits, underscores, periods
  if (u && !/^[\w.]+$/.test(u)) return '';
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

// Stealth mode — when true, all connections are forced anonymous.
let stealthMode = false;
function getStealthMode() { return stealthMode; }
function setStealthMode(v) {
  stealthMode = !!v;
  // Stealth toggle changes auth context — invalidate cache to avoid serving
  // results from the wrong identity.
  apiCache.clear();
}

// ── In-memory TTL cache for apiLive responses ──
// Multiple subsystems hit the same /apiLive endpoint within a few seconds
// (watcher poller, dashboard, /api/check, grid view, /api/stream). Caching
// for a few seconds collapses these into one upstream call, which in turn
// drops CPU spent on protobuf parsing, WebcastPushConnection construction,
// and TikTok rate-limit pressure.
const API_CACHE_TTL_MS = Number(process.env.TIKTOK_API_CACHE_MS) || 5000;
const apiCache = new Map(); // key -> { ts, data }
const apiInflight = new Map(); // key -> Promise

function cacheKey(username, anon) {
  return `${anon ? 'a' : 'u'}:${username}`;
}

// Allow callers to invalidate when an account switch happens etc.
function invalidateApiCache(username) {
  if (!username) {
    apiCache.clear();
    return;
  }
  apiCache.delete(cacheKey(username, true));
  apiCache.delete(cacheKey(username, false));
}

async function fetchApiLive(username, { forceAnon, noCache } = {}) {
  const anon = forceAnon || stealthMode;
  const key = cacheKey(username, anon);
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

  const p = _fetchApiLiveInner(username, anon).then((data) => {
    apiCache.set(key, { ts: Date.now(), data });
    return data;
  }).finally(() => {
    apiInflight.delete(key);
  });
  if (!noCache) apiInflight.set(key, p);
  return p;
}

async function _fetchApiLiveInner(username, anon) {
  // Snapshot credentials synchronously here to avoid stale reads after a
  // concurrent account switch during this async call.
  const { getActiveCredentials } = require('./accounts');
  const creds = getActiveCredentials();
  const sessionId = anon ? undefined : creds.sessionId;
  const ttTargetIdc = anon ? undefined : creds.ttTargetIdc;
  const eulerKey = process.env.EULER_API_KEY;

  const connOpts = {};
  if (sessionId && ttTargetIdc) {
    connOpts.sessionId = sessionId;
    connOpts.ttTargetIdc = ttTargetIdc;
  } else if (sessionId && !ttTargetIdc) {
    console.warn(
      '[room] TIKTOK_SESSIONID is set but TIKTOK_TT_TARGET_IDC is missing. ' +
      'Ignoring cookies. Set both env vars to use authenticated mode.'
    );
  }
  if (eulerKey) connOpts.signApiKey = eulerKey;

  const hasAuth = !!connOpts.sessionId;
  const conn = new WebcastPushConnection(username, connOpts);

  // Always start with apiLive — it's required for status/roomId/user info.
  let apiData = null;
  try {
    const res = await withTimeout(
      conn.webClient.fetchRoomInfoFromApiLive({ uniqueId: username }),
      API_TIMEOUT_MS
    );
    apiData = res?.data || {};
  } catch (e) {
    if (hasAuth) {
      console.warn('[room] authenticated apiLive failed, retrying anonymous:', e?.message);
      const anonConn = new WebcastPushConnection(username, eulerKey ? { signApiKey: eulerKey } : {});
      const res = await withTimeout(
        anonConn.webClient.fetchRoomInfoFromApiLive({ uniqueId: username }),
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
  const mode = hasAuth ? 'AUTH' : 'ANON';
  const h264 = apiData?.liveRoom?.streamData?.pull_data?.options?.qualities;
  const hevc = apiData?.liveRoom?.hevcStreamData?.pull_data?.options?.qualities;
  logQualities(username, `${mode}/h264`, h264);
  if (hevc?.length) logQualities(username, `${mode}/hevc`, hevc);
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
  const priority = ['origin', 'uhd', 'hd', 'sd', 'ld'];
  for (const q of priority) {
    if (out.hlsByQuality[q] && !out.hls) out.hls = out.hlsByQuality[q];
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
  const priority = ['origin', 'uhd', 'hd', 'sd', 'ld'];
  for (const q of priority) {
    if (streams.flv[q]) return { url: streams.flv[q], kind: 'flv', quality: q };
  }
  for (const q of priority) {
    if (streams.cmaf[q]) return { url: streams.cmaf[q], kind: 'cmaf', quality: q };
  }
  if (streams.hls) return { url: streams.hls, kind: 'hls', quality: 'default' };

  const flvEntries = Object.entries(streams.flv);
  if (flvEntries.length) return { url: flvEntries[0][1], kind: 'flv', quality: flvEntries[0][0] };

  return null;
}

function hasStreamUrls(streams) {
  if (!streams) return false;
  return !!(streams.hls || Object.keys(streams.flv || {}).length || Object.keys(streams.cmaf || {}).length);
}

function buildSummary(username, apiData, streams) {
  const { getActiveCredentials } = require('./accounts');
  const hasSession = !!getActiveCredentials().sessionId;
  return {
    username,
    live: isLiveFromApi(apiData),
    authenticated: hasSession && !stealthMode,
    stealth: stealthMode,
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
