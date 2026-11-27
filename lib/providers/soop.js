// lib/providers/soop.js — SOOP Live provider (Global sooplive.com + Korea sooplive.co.kr/afreecatv.com + WS chat + yt-dlp fallback).

const { execFile } = require('child_process');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const accounts = require('../accounts');
const { isPlatformStealth, shouldUseAnonymous, getStealthUserAgent, getStealthYtDlpArgs } = require('../stealth');
const { getProxyAgent, getActiveProxyUrl } = require('../proxy-config');
const { stripControlChars, withTempCookieFile, isCookieHeaderString, safeError } = require('../utils');
const { parseYouTubeMasterM3u8, resolveYtDlp } = require('./youtube');

const API_TIMEOUT_MS = 15_000;
const YTDLP_TIMEOUT_MS = 15_000;
const API_CACHE_TTL_MS = Number(process.env.SOOP_API_CACHE_MS) || 5000;
const API_CACHE_MAX = 200;

const RESERVED_SOOP_PATHS = new Set([
  'browse', 'categories', 'following', 'login', 'signup', 'search',
  'settings', 'terms', 'privacy', 'vod', 'clip', 'clips', 'api',
  'live', 'station', 'catch', 'afreeca',
]);

const apiCache = new Map();
const apiInflight = new Map();
let cacheEpoch = 0;

function isKoreaHost(host) {
  return (
    host === 'sooplive.co.kr' ||
    host.endsWith('.sooplive.co.kr') ||
    host === 'afreecatv.com' ||
    host.endsWith('.afreecatv.com') ||
    host === 'afreeca.tv' ||
    host.endsWith('.afreeca.tv')
  );
}

function isGlobalHost(host) {
  return (
    host === 'sooplive.com' ||
    host.endsWith('.sooplive.com') ||
    host === 'sooplive-cdn.com' ||
    host.endsWith('.sooplive-cdn.com')
  );
}

function isAllowedSoopHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return isKoreaHost(h) || isGlobalHost(h);
}

function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  let forceKorea = false;

  if (/^https?:\/\//i.test(s) || /^(?:[a-z0-9-]+\.)*(?:sooplive\.co\.kr|sooplive\.com|afreecatv\.com|afreeca\.tv)\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const host = url.hostname.toLowerCase();
      if (!isAllowedSoopHost(host)) return '';
      const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      if (isKoreaHost(host)) {
        forceKorea = true;
        const idx = parts.findIndex((p) => !['station', 'catch', 'live', 'player'].includes(p.toLowerCase()));
        s = idx >= 0 ? parts[idx] : (parts[0] || '');
      } else {
        s = parts[0] || '';
      }
    } catch {
      return '';
    }
  }

  s = s.replace(/^@/, '').replace(/[/?#].*$/, '').trim().toLowerCase();
  if (!s) return '';

  if (s.startsWith('kr_')) {
    const bj = s.slice(3);
    if (!/^[a-z0-9_-]{2,32}$/.test(bj)) return '';
    return `kr_${bj}`;
  }

  if (forceKorea) {
    if (!/^[a-z0-9_-]{2,32}$/.test(s) || RESERVED_SOOP_PATHS.has(s)) return '';
    return `kr_${s}`;
  }

  if (!/^[a-z0-9_.-]{2,40}$/.test(s)) return '';
  if (s.startsWith('.') || /^\.+$/.test(s) || s.includes('..')) return '';
  if (RESERVED_SOOP_PATHS.has(s)) return '';
  return s;
}

function stripCrossHostAuthHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'cookie') continue;
    out[k] = v;
  }
  return out;
}

function formatSoopCookie(raw) {
  const cleaned = typeof raw === 'string' ? raw.replace(/[\r\n\x00-\x1f\x7f]/g, '').trim() : '';
  if (!cleaned) return '';
  return isCookieHeaderString(cleaned) ? cleaned : `AuthTicket=${cleaned}`;
}

function defaultHttpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = API_TIMEOUT_MS, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('invalid soop request URL'));
      return;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !isAllowedSoopHost(parsed.hostname)) {
      reject(new Error('disallowed soop request host'));
      return;
    }
    const agent = getProxyAgent();
    const req = https.request(
      parsed,
      {
        method,
        agent: agent || undefined,
        timeout: timeoutMs,
        headers: {
          'User-Agent': getStealthUserAgent(!headers.Cookie && !headers.cookie),
          'Accept': 'application/json, text/plain, */*',
          'Referer': isKoreaHost(parsed.hostname.toLowerCase()) ? 'https://play.sooplive.co.kr/' : 'https://play.sooplive.com/',
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && maxRedirects > 0) {
          res.on('error', () => {});
          res.resume();
          let nextParsed;
          try { nextParsed = new URL(loc, parsed); } catch {
            reject(new Error('invalid soop redirect URL'));
            return;
          }
          if (nextParsed.protocol !== 'https:' || nextParsed.username || nextParsed.password || !isAllowedSoopHost(nextParsed.hostname)) {
            reject(new Error('disallowed soop redirect host'));
            return;
          }
          const sameHost = nextParsed.hostname.toLowerCase() === parsed.hostname.toLowerCase();
          const nextHeaders = sameHost ? headers : stripCrossHostAuthHeaders(headers);
          defaultHttpRequest(nextParsed.toString(), { method: 'GET', headers: nextHeaders, timeoutMs, maxRedirects: maxRedirects - 1 })
            .then(resolve, reject);
          return;
        }
        const chunks = [];
        let total = 0;
        const maxBytes = 2 * 1024 * 1024;
        let overflowed = false;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            overflowed = true;
            try { res.destroy(); } catch {}
            try { req.destroy(new Error('SOOP response exceeded size limit')); } catch {}
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
    req.on('timeout', () => req.destroy(new Error(`SOOP API timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function defaultYtDlpExec(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(safeError(err)));
      resolve(stdout);
    });
  });
}

async function fetchViaYtDlp(channelUrl, { ytDlpExec, cookie = '', cookieDomain = '.sooplive.com' } = {}) {
  if (!channelUrl) return null;
  let parsedUrl;
  try { parsedUrl = new URL(channelUrl); } catch { return null; }
  if (parsedUrl.protocol !== 'https:' || !isAllowedSoopHost(parsedUrl.hostname)) return null;

  const runner = typeof ytDlpExec === 'function' ? ytDlpExec : defaultYtDlpExec;
  const bin = typeof ytDlpExec === 'function' ? 'yt-dlp' : resolveYtDlp();
  if (!bin) return null;

  const runWithCookies = (cookieFile) => {
    const args = ['--no-warnings', '--no-playlist', '-j'];
    const proxyUrl = getActiveProxyUrl();
    if (proxyUrl) args.push('--proxy', proxyUrl);
    if (cookieFile) args.push('--cookies', cookieFile);
    else args.push(...getStealthYtDlpArgs(true));
    args.push(channelUrl);
    return runner(bin, args);
  };

  const stdout = cookie
    ? await withTempCookieFile(cookie, cookieDomain, runWithCookies)
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
    playbackUrl: hlsUrl,
    id: info.id || null,
    title: info.title || null,
    uploader: info.uploader || info.channel || null,
    viewerCount: (info.concurrent_view_count != null && info.concurrent_view_count !== '' && Number.isFinite(Number(info.concurrent_view_count)))
      ? Number(info.concurrent_view_count)
      : null,
    thumbnail: info.thumbnail || null,
    startedAtUnix: (info.release_timestamp != null && info.release_timestamp !== '' && Number.isFinite(Number(info.release_timestamp)) && Number(info.release_timestamp) > 0)
      ? Number(info.release_timestamp)
      : null,
  };
}

function buildBasicHlsStreams(hlsUrl) {
  return {
    hls: hlsUrl,
    hlsByQuality: { origin: hlsUrl },
    flv: {},
    cmaf: {},
    hevc: { hls: {}, flv: {}, cmaf: {} },
    qualities: [{ name: 'source', sdkKey: 'origin', level: 100 }],
    hevcQualities: [],
  };
}

async function resolveHlsPlaylist(hlsUrl, requester) {
  if (!hlsUrl) return null;
  try {
    const m3u8Res = await requester(hlsUrl, { method: 'GET' });
    if (m3u8Res?.ok && m3u8Res.text && /#EXTM3U/i.test(m3u8Res.text)) {
      const parsed = parseYouTubeMasterM3u8(m3u8Res.text, hlsUrl);
      if (Object.keys(parsed.hlsByQuality || {}).length > 0) return parsed;
    }
  } catch {
    // Surface master URL directly if variant fetch fails
  }
  return buildBasicHlsStreams(hlsUrl);
}

function normalizeSoopAvatarUrl(raw) {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  if (s.startsWith('//')) s = `https:${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || !isAllowedSoopHost(u.hostname)) {
      return undefined;
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

function parseKstTimestampToUnix(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return null;
  const ms = Date.parse(`${trimmed.replace(' ', 'T')}+09:00`);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
}

async function fetchSoopStation(bjId, requester) {
  try {
    const res = await requester(`https://chapi.sooplive.com/api/${encodeURIComponent(bjId)}/station`, {
      method: 'GET',
      headers: { Referer: 'https://www.sooplive.com/' },
    });
    if (!res?.ok || !res.text) return null;
    const json = JSON.parse(res.text);
    if (!json || typeof json !== 'object') return null;

    const rawViewers = json?.broad?.current_sum_viewer;
    const viewerCount = rawViewers != null && rawViewers !== '' && Number.isFinite(Number(rawViewers)) && Number(rawViewers) >= 0
      ? Number(rawViewers)
      : null;

    const rawFans = json?.station?.upd?.fan_cnt;
    const followers = rawFans != null && rawFans !== '' && Number.isFinite(Number(rawFans)) && Number(rawFans) >= 0
      ? Number(rawFans)
      : null;

    const nickname = typeof json?.station?.user_nick === 'string' && json.station.user_nick.trim()
      ? json.station.user_nick.trim()
      : null;
    const title = typeof json?.broad?.broad_title === 'string' && json.broad.broad_title.trim()
      ? json.broad.broad_title.trim()
      : null;
    const avatarThumb = normalizeSoopAvatarUrl(json?.profile_image);
    const startedAtUnix = json?.broad ? parseKstTimestampToUnix(json?.station?.broad_start) : null;

    return { viewerCount, followers, nickname, title, avatarThumb, startedAtUnix };
  } catch {
    return null;
  }
}

async function fetchKoreaLiveStatus(bjId, requester, headers, { isExplicitKr = false } = {}) {
  const comApiUrl = `https://live.sooplive.com/afreeca/player_live_api.php?bjid=${encodeURIComponent(bjId)}`;
  const krApiUrl = `https://live.sooplive.co.kr/afreeca/player_live_api.php?bjid=${encodeURIComponent(bjId)}`;
  const liveBody = new URLSearchParams({
    bid: bjId,
    bno: '',
    type: 'live',
    confirm_adult: 'true',
    player_type: 'html5',
    mode: 'landing',
    from_api: '0',
    pwd: '',
    stream_type: 'common',
    quality: 'HD',
  }).toString();

  let activeApiUrl = comApiUrl;
  let usedKrFallback = false;
  let liveRes;
  let comErr = null;
  try {
    liveRes = await requester(comApiUrl, {
      method: 'POST',
      headers: { ...headers, Referer: 'https://play.sooplive.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: liveBody,
    });
  } catch (e) {
    comErr = e;
  }
  if (!liveRes?.ok || !liveRes.text) {
    try {
      const krRes = await requester(krApiUrl, {
        method: 'POST',
        headers: { ...headers, Referer: 'https://play.sooplive.co.kr/', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: liveBody,
      });
      if (krRes?.ok && krRes.text) {
        liveRes = krRes;
        activeApiUrl = krApiUrl;
        usedKrFallback = true;
      } else if (!liveRes) {
        liveRes = krRes;
      }
    } catch (krErr) {
      if (!liveRes && comErr) throw comErr;
      if (!liveRes) throw krErr;
    }
  }

  if (!liveRes?.ok || !liveRes.text) {
    throw new Error(`SOOP API HTTP ${liveRes?.status || 0}`);
  }
  let liveJson;
  try { liveJson = JSON.parse(liveRes.text); } catch {
    throw new Error('SOOP API returned invalid JSON');
  }

  const ch = liveJson?.CHANNEL || null;
  const region = isExplicitKr ? 'kr' : 'global';
  if (!ch || Number(ch.RESULT) !== 1 || !ch.BNO) {
    const station = ch ? await fetchSoopStation(bjId, requester) : null;
    return {
      region,
      found: Boolean(ch),
      isLive: false,
      bjId,
      nickname: ch?.BJNICK || station?.nickname || bjId,
      title: ch?.TITLE || null,
      bno: null,
      avatarThumb: station?.avatarThumb,
      viewerCount: null,
      followers: station?.followers ?? null,
      startedAtUnix: null,
      chatMeta: null,
      streams: null,
    };
  }

  const bno = String(ch.BNO);
  const defaultRmd = usedKrFallback ? 'https://livestream-manager.sooplive.co.kr' : 'https://livestream-manager.sooplive.com';
  let rmd = defaultRmd;
  if (typeof ch.RMD === 'string' && ch.RMD.startsWith('https://')) {
    try {
      const rmdUrl = new URL(ch.RMD);
      if (!rmdUrl.username && !rmdUrl.password && isAllowedSoopHost(rmdUrl.hostname)) {
        rmd = rmdUrl.origin;
      }
    } catch {}
  }

  const formHeaders = {
    ...headers,
    Referer: usedKrFallback ? 'https://play.sooplive.co.kr/' : 'https://play.sooplive.com/',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const aidBody = new URLSearchParams({
    bid: bjId,
    bno,
    type: 'aid',
    quality: 'original',
    stream_type: 'common',
    player_type: 'html5',
    mode: 'landing',
    from_api: '0',
    pwd: '',
  }).toString();

  let aidToken = '';
  const stationPromise = fetchSoopStation(bjId, requester);
  try {
    const aidRes = await requester(activeApiUrl, { method: 'POST', headers: formHeaders, body: aidBody });
    if (aidRes?.ok && aidRes.text) {
      const aidJson = JSON.parse(aidRes.text);
      aidToken = aidJson?.CHANNEL?.AID || '';
    }
  } catch {}

  let playbackUrl = null;
  const corsOrigin = isKoreaHost(new URL(rmd).hostname.toLowerCase()) ? 'play.sooplive.co.kr' : 'play.sooplive.com';
  const assignUrl = `${rmd}/broad_stream_assign.html?return_type=gcp_cdn&use_cors=true&cors_origin_url=${corsOrigin}&broad_key=${encodeURIComponent(`${bno}-common-original-hls`)}`;
  try {
    const assignRes = await requester(assignUrl, { method: 'GET' });
    if (assignRes?.ok && assignRes.text) {
      const assignJson = JSON.parse(assignRes.text);
      const rawViewUrl = assignJson?.view_url || '';
      if (rawViewUrl) {
        playbackUrl = aidToken
          ? `${rawViewUrl}${rawViewUrl.includes('?') ? '&' : '?'}aid=${encodeURIComponent(aidToken)}`
          : rawViewUrl;
      }
    }
  } catch {}

  const [streams, station] = await Promise.all([
    playbackUrl ? resolveHlsPlaylist(playbackUrl, requester) : Promise.resolve(null),
    stationPromise,
  ]);
  const chatMeta = ch.CHDOMAIN && ch.CHPT
    ? {
        chdomain: String(ch.CHDOMAIN),
        chpt: Number(ch.CHPT),
        chatno: ch.CHATNO ? String(ch.CHATNO) : bno,
        ftk: ch.FTK ? String(ch.FTK) : '',
        bjId: ch.BJID ? String(ch.BJID) : bjId,
      }
    : null;

  const rawViewers =
    ch.VIEW_CNT ??
    ch.TOTAL_VIEW_CNT ??
    ch.CURRENT_SUM_VIEWER ??
    (!Array.isArray(ch.VIEWPRESET) ? ch.VIEWPRESET?.total_cnt : undefined);
  const chViewerCount = rawViewers != null && rawViewers !== '' && Number.isFinite(Number(rawViewers))
    ? Number(rawViewers)
    : null;
  const viewerCount = chViewerCount ?? station?.viewerCount ?? null;

  return {
    region,
    found: true,
    isLive: true,
    bjId: ch.BJID || bjId,
    nickname: ch.BJNICK || station?.nickname || bjId,
    title: ch.TITLE || station?.title || null,
    bno,
    category: ch.CATE ? String(ch.CATE) : null,
    coverUrl: `https://${usedKrFallback ? 'liveimg.sooplive.co.kr' : 'liveimg.sooplive.com'}/m/${encodeURIComponent(bno)}`,
    avatarThumb: station?.avatarThumb,
    viewerCount,
    followers: station?.followers ?? null,
    startedAtUnix: station?.startedAtUnix ?? null,
    chatMeta,
    playbackUrl,
    streams,
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
  if (!username) throw new Error('invalid soop username');

  const anon = shouldUseAnonymous('soop', { accountId, forceAnon });
  const cacheKey = `${anon ? 'a' : (accountId ? `u:${accountId}` : 'u')}:${username}`;

  const now = Date.now();
  if (!noCache && !fetchImpl && !ytDlpExec) {
    const hit = apiCache.get(cacheKey);
    if (hit && now - hit.ts < API_CACHE_TTL_MS) return hit.data;
    const inflight = apiInflight.get(cacheKey);
    if (inflight) return inflight;
  }

  const requester = typeof fetchImpl === 'function' ? fetchImpl : defaultHttpRequest;
  const run = async () => {
    const rawCred = anon
      ? ''
      : (accountId ? accounts.getCredentialsById(accountId, 'soop')?.sessionId : accounts.getActivePlatformCredential('soop'));
    const cookie = formatSoopCookie(rawCred);
    const reqHeaders = cookie ? { Cookie: cookie } : {};

    const isExplicitKr = username.startsWith('kr_');
    const cleanId = isExplicitKr ? username.slice(3) : username;

    let result = null;
    let primaryErr = null;

    try {
      result = await fetchKoreaLiveStatus(cleanId, requester, reqHeaders, { isExplicitKr });
    } catch (e) {
      primaryErr = e;
    }

    const needYtDlp = (!result && primaryErr) || (result?.isLive && !hasStreamUrls(result?.streams));
    if (needYtDlp && useYtDlpFallback) {
      const targetUrl = isExplicitKr
        ? `https://play.sooplive.co.kr/${encodeURIComponent(cleanId)}`
        : `https://play.sooplive.com/${encodeURIComponent(cleanId)}`;
      const cookieDomain = targetUrl.includes('sooplive.co.kr') ? '.sooplive.co.kr' : '.sooplive.com';
      try {
        const ytd = await fetchViaYtDlp(targetUrl, { ytDlpExec, cookie, cookieDomain });
        if (ytd && ytd.isLive && ytd.playbackUrl) {
          const streams = await resolveHlsPlaylist(ytd.playbackUrl, requester);
          result = {
            ...(result || {}),
            region: result?.region || (isExplicitKr ? 'kr' : 'global'),
            found: true,
            isLive: true,
            bjId: cleanId,
            nickname: ytd.uploader || result?.nickname || cleanId,
            title: ytd.title || result?.title || null,
            bno: ytd.id ? String(ytd.id) : (result?.bno || null),
            coverUrl: ytd.thumbnail || result?.coverUrl || null,
            viewerCount: ytd.viewerCount ?? result?.viewerCount ?? null,
            startedAtUnix: ytd.startedAtUnix ?? result?.startedAtUnix ?? null,
            playbackUrl: ytd.playbackUrl,
            streams,
          };
        }
      } catch (e) {
        if (!primaryErr) primaryErr = e;
      }
    }

    if (!result && primaryErr) {
      throw primaryErr;
    }

    return {
      username,
      region: result?.region || (isExplicitKr ? 'kr' : 'global'),
      isLive: Boolean(result?.isLive),
      authenticated: !anon && Boolean(cookie),
      stealth: anon || !cookie,
      bjId: result?.bjId || cleanId,
      nickname: result?.nickname || cleanId,
      title: result?.title || null,
      bno: result?.bno || null,
      category: result?.category || null,
      coverUrl: result?.coverUrl || null,
      avatarThumb: result?.avatarThumb || undefined,
      viewerCount: result?.viewerCount ?? null,
      followers: result?.followers ?? null,
      startedAtUnix: result?.startedAtUnix ?? null,
      chatMeta: result?.chatMeta || null,
      playbackUrl: result?.playbackUrl || null,
      streams: result?.streams || null,
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
  const priority = ['uhd4k_60', 'uhd4k', 'qhd_60', 'qhd', 'origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'ld', 'md'];
  for (const q of priority) {
    if (streams.hlsByQuality?.[q]) {
      const audioUrl = streams.audioByQuality?.[q];
      return audioUrl
        ? { url: streams.hlsByQuality[q], audioUrl, kind: 'hls', quality: q }
        : { url: streams.hlsByQuality[q], kind: 'hls', quality: q };
    }
  }
  if (streams.hls) return { url: streams.hls, kind: 'hls', quality: 'origin' };
  const entries = Object.entries(streams.hlsByQuality || {});
  if (entries.length) {
    const [q, url] = entries[0];
    const audioUrl = streams.audioByQuality?.[q];
    return audioUrl ? { url, audioUrl, kind: 'hls', quality: q } : { url, kind: 'hls', quality: q };
  }
  return null;
}

function hasStreamUrls(streams) {
  return !!(streams?.hls || Object.keys(streams?.hlsByQuality || {}).length > 0);
}

function buildSummary(username, data, streams) {
  const fallbackAuthed = !isPlatformStealth('soop') && !!accounts.getActivePlatformCredential('soop');
  const authenticated = typeof data?.authenticated === 'boolean' ? data.authenticated : fallbackAuthed;
  const stealth = typeof data?.stealth === 'boolean' ? data.stealth : !authenticated;
  const cat = data?.category && !/^\d+$/.test(String(data.category)) ? String(data.category) : null;
  return {
    platform: 'soop',
    username,
    live: isLive(data),
    authenticated,
    stealth,
    roomId: data?.bno || null,
    liveRoomMode: cat || (data?.region === 'kr' ? 'SOOP KR' : null),
    title: data?.title || null,
    coverUrl: data?.coverUrl || null,
    startedAtUnix: data?.startedAtUnix ?? null,
    viewerCount: data?.viewerCount ?? null,
    totalEntered: null,
    owner: data
      ? {
          nickname: data.nickname || data.bjId || username,
          uniqueId: data.bjId || username,
          verified: false,
          followers: data.followers ?? null,
          avatarThumb: data.avatarThumb || undefined,
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

// ── SOOP Korea WebSocket Chat ──

const SOOP_ESC = '\x1b\t';
const SOOP_SEP = '\x0c';

function buildSoopPacket(serviceCode, payload = '') {
  const body = String(payload || '');
  const byteLen = Buffer.byteLength(body, 'utf8');
  const lenStr = String(byteLen).padStart(6, '0');
  return Buffer.from(`${SOOP_ESC}${serviceCode}${lenStr}00${body}`, 'utf8');
}

function toBuffer(rawData) {
  if (Buffer.isBuffer(rawData)) return rawData;
  if (Array.isArray(rawData)) return Buffer.concat(rawData.map((c) => toBuffer(c)));
  if (rawData instanceof ArrayBuffer) return Buffer.from(rawData);
  if (ArrayBuffer.isView(rawData)) return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength);
  return Buffer.from(String(rawData || ''), 'utf8');
}

function parseSoopKoreaPacket(rawData) {
  const buf = toBuffer(rawData);
  if (buf.length < 14 || buf[0] !== 0x1b || buf[1] !== 0x09) return null;

  const packets = [];
  const allEvents = [];
  let offset = 0;

  while (offset + 14 <= buf.length && buf[offset] === 0x1b && buf[offset + 1] === 0x09) {
    const serviceCode = buf.toString('ascii', offset + 2, offset + 6);
    const lenRaw = buf.toString('ascii', offset + 6, offset + 12);
    const parsedLen = /^\d{6}$/.test(lenRaw) ? parseInt(lenRaw, 10) : -1;
    const bodyStart = offset + 14;
    const bodyEnd = parsedLen >= 0 && bodyStart + parsedLen <= buf.length
      ? bodyStart + parsedLen
      : buf.length;

    const body = buf.subarray(bodyStart, bodyEnd).toString('utf8');
    const rawParts = body.startsWith(SOOP_SEP) ? body.slice(1).split(SOOP_SEP) : body.split(SOOP_SEP);
    const events = [];

    if (serviceCode === '0005') {
      const comment = stripControlChars(rawParts[0] || '', 500);
      const uid = stripControlChars(rawParts[1] || '', 80).toLowerCase();
      const nickname = stripControlChars(rawParts[5] || rawParts[1] || '?', 80) || '?';
      if (comment) {
        events.push({
          type: 'chat',
          user: {
            uniqueId: uid || undefined,
            nickname,
          },
          comment,
        });
      }
    } else if (serviceCode === '0018' || serviceCode === '0033') {
      // Star Balloon gift: [bjId, senderId, senderNick, count, ...]
      const uid = stripControlChars(rawParts[1] || rawParts[0] || '', 80).toLowerCase();
      const nickname = stripControlChars(rawParts[2] || rawParts[1] || 'Fan', 80) || 'Fan';
      const count = Math.max(1, Number(rawParts[3]) || 1);
      events.push({
        type: 'gift',
        user: {
          uniqueId: uid || undefined,
          nickname,
        },
        giftName: 'Star Balloon',
        repeatCount: count,
        diamondCount: 10,
      });
    }

    packets.push({ serviceCode, parts: rawParts, events });
    allEvents.push(...events);
    if (bodyEnd <= offset) break;
    offset = bodyEnd;
  }

  if (packets.length === 0) return null;
  return {
    serviceCode: packets[0].serviceCode,
    parts: packets[0].parts,
    events: allEvents,
    packets,
  };
}

const RING_BUFFER_SIZE = 500;
const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];
const MAX_RECONNECT_ATTEMPTS = 12;

class SoopChatSession extends EventEmitter {
  constructor(username, { chatEvents, wsFactory, fetchImpl, chatMeta } = {}) {
    super();
    this.platform = 'soop';
    this.username = normalizeUsername(username) || String(username || '').trim().toLowerCase();
    this.chatEvents = chatEvents || null;
    this.wsFactory = wsFactory || null;
    this.fetchImpl = fetchImpl || null;
    this.chatMeta = chatMeta || null;
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
    this._pingTimer = null;
    this._joinFallbackTimer = null;
    this._joined = false;
    this._reconnecting = false;
    this._connectTimer = null;
    this._connectReject = null;
    this._connectPromise = null;
    this._connectSeq = 0;
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
      platform: 'soop',
      username: this.username,
      session: this.info(),
    });
  }

  _cleanupWs() {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._joinFallbackTimer) {
      clearTimeout(this._joinFallbackTimer);
      this._joinFallbackTimer = null;
    }
    this._joined = false;
    if (!this.ws) return;
    try { this.ws.removeAllListeners?.(); } catch {}
    try { this.ws.on?.('error', () => {}); } catch {}
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
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
      this._reconnecting = true;
      this.state = 'reconnecting';
      this.connect().catch(() => {
        if (this.manualClose || !this.hasConsumers() || this.state === 'connected') return;
        this.state = 'reconnecting';
        this._emitState();
        this._scheduleReconnect();
      }).finally(() => {
        this._reconnecting = false;
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
      platform: 'soop',
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

    const seq = (this._connectSeq = (this._connectSeq || 0) + 1);
    this.manualClose = false;
    if (!this._reconnecting) {
      this.state = 'connecting';
      this.error = null;
      this._emitState();
    }

    const p = (async () => {
      let meta = this.chatMeta;
      if (!meta) {
        const status = await fetchLiveStatus(this.username, {
          noCache: true,
          fetchImpl: this.fetchImpl || undefined,
          useYtDlpFallback: false,
          accountId: this.accountId || null,
        });
        if (this.manualClose || this._connectSeq !== seq) throw new Error('connection closed');
        if (!status.isLive) {
          throw new Error('SOOP stream is offline');
        }
        if (status.bno) this.roomId = status.bno;
        if (status.viewerCount != null) this.viewerCount = status.viewerCount;
        meta = status.chatMeta;
        this.chatMeta = meta;
      }

      if (!meta || !meta.chdomain || !meta.chpt) {
        throw new Error('SOOP live chat is not available for this channel');
      }

      const wsPort = Number(meta.chpt) + 1;
      const rawHost = String(meta.chdomain || '').trim();
      const validHostnameRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
      if (!Number.isInteger(wsPort) || wsPort <= 0 || wsPort > 65535 || !validHostnameRe.test(rawHost) || !isAllowedSoopHost(rawHost)) {
        throw new Error('invalid SOOP chat server host');
      }
      const wsUrl = `wss://${rawHost}:${wsPort}/Websocket/${encodeURIComponent(meta.bjId || this.username.replace(/^kr_/, ''))}`;
      let parsedWs;
      try { parsedWs = new URL(wsUrl); } catch {
        throw new Error('invalid SOOP chat server host');
      }
      if (
        parsedWs.protocol !== 'wss:' ||
        parsedWs.username ||
        parsedWs.password ||
        !isAllowedSoopHost(parsedWs.hostname) ||
        parsedWs.port !== String(wsPort)
      ) {
        throw new Error('invalid SOOP chat server host');
      }
      const wsOrigin = isKoreaHost(parsedWs.hostname.toLowerCase())
        ? 'https://play.sooplive.co.kr'
        : 'https://play.sooplive.com';

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
          ? this.wsFactory(wsUrl)
          : new WebSocket(wsUrl, ['chat'], {
              agent: agent || undefined,
              headers: { Origin: wsOrigin },
            });
        this.ws = ws;

        this._connectTimer = setTimeout(() => {
          this._connectTimer = null;
          if (settled || this.manualClose || this._connectSeq !== seq || this.ws !== ws) return;
          this._cleanupWs();
          const err = new Error('SOOP chat connection timed out');
          this.state = 'error';
          this.error = err.message;
          this.health.errorsCount++;
          this.health.lastError = { message: err.message, at: Date.now() };
          this._emitState();
          settleReject(err);
        }, 15_000);
        this._connectTimer.unref?.();

        const sendJoin = () => {
          if (this._joined || this.manualClose || this._connectSeq !== seq || this.ws !== ws) return;
          this._joined = true;
          if (this._joinFallbackTimer) {
            clearTimeout(this._joinFallbackTimer);
            this._joinFallbackTimer = null;
          }
          try {
            ws.send(buildSoopPacket('0002', `${SOOP_SEP}${meta.chatno || ''}${SOOP_SEP}${meta.ftk || ''}${SOOP_SEP}0${SOOP_SEP}${SOOP_SEP}log${SOOP_SEP}`));
          } catch {}
        };

        ws.on('open', () => {
          if (this.manualClose || this._connectSeq !== seq || this.ws !== ws) {
            try { ws.removeAllListeners?.(); ws.on?.('error', () => {}); ws.terminate?.(); } catch {}
            settleReject(new Error('connection closed'));
            return;
          }
          try {
            // Handshake 0001 first; send 0002 on 0001 ACK (or short fallback for mock/legacy servers)
            this._joined = false;
            ws.send(buildSoopPacket('0001', `${SOOP_SEP}${SOOP_SEP}${SOOP_SEP}16${SOOP_SEP}`));
            this._joinFallbackTimer = setTimeout(sendJoin, 150);
            this._joinFallbackTimer.unref?.();
          } catch (err) {
            this._cleanupWs();
            this.error = safeError(err) || 'SOOP chat handshake error';
            if (!this._reconnecting) {
              this.state = 'error';
              this._emitState();
            }
            settleReject(err);
            return;
          }

          if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
          }
          this._connectReject = null;
          this._reconnecting = false;
          this.state = 'connected';
          this.startedAt = this.startedAt || Date.now();
          if (this.reconnectAttempts > 0) this.health.reconnectCount++;
          this.health.lastConnectedAt = Date.now();
          if (this._stabilityTimer) clearTimeout(this._stabilityTimer);
          this._stabilityTimer = setTimeout(() => {
            this._stabilityTimer = null;
            if (!this.manualClose && this.state === 'connected' && this.ws === ws) {
              this.reconnectAttempts = 0;
            }
          }, 30_000);
          this._stabilityTimer.unref?.();
          if (this._pingTimer) clearInterval(this._pingTimer);
          this._pingTimer = setInterval(() => {
            if (ws.readyState === 1) {
              try { ws.send(buildSoopPacket('0000', SOOP_SEP)); } catch {}
            }
          }, 60_000);
          this._pingTimer.unref?.();
          this._emitState();
          this.push('connected', { roomId: this.roomId || meta.chatno || null });
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        ws.on('message', (rawData) => {
          if (this._connectSeq !== seq || this.ws !== ws) return;
          const parsed = parseSoopKoreaPacket(rawData);
          if (!parsed) return;
          if (!this._joined && parsed.packets?.some((pkt) => pkt.serviceCode === '0001')) {
            sendJoin();
          }
          for (const ev of parsed.events) {
            const { type, ...rest } = ev;
            this.push(type, rest);
          }
        });

        ws.on('error', (err) => {
          if (this._connectSeq !== seq || this.ws !== ws) return;
          const msg = safeError(err) || 'SOOP chat error';
          this.error = msg;
          this.health.errorsCount++;
          this.health.lastError = { message: msg, at: Date.now() };
          if (!settled) {
            this._cleanupWs();
            if (!this._reconnecting) {
              this.state = 'error';
              this._emitState();
            }
            settleReject(err);
          }
        });

        ws.on('close', () => {
          if (this._connectSeq !== seq || (this.ws && this.ws !== ws)) {
            settleReject(new Error('connection closed'));
            return;
          }
          if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
          }
          if (this.manualClose) {
            if (this.ws === ws) this._cleanupWs();
            settleReject(new Error('connection closed'));
            return;
          }
          this.health.lastDisconnectedAt = Date.now();
          this.chatMeta = null;
          this._cleanupWs();
          if (!settled) {
            if (!this._reconnecting) {
              this.state = 'error';
              this._emitState();
            }
            settleReject(new Error('SOOP chat closed'));
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
    })()
      .catch((err) => {
        if (!this.manualClose && !this._reconnecting && this.state !== 'error') {
          this.state = 'error';
          this.error = safeError(err) || 'SOOP chat connection failed';
          this.health.errorsCount++;
          this.health.lastError = { message: this.error, at: Date.now() };
          this._emitState();
        }
        throw err;
      })
      .finally(() => {
        if (this._connectPromise === p) {
          if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
          }
          this._connectReject = null;
          this._connectPromise = null;
        }
      });

    this._connectPromise = p;
    return p;
  }

  attachFile(filePath) {
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', (e) => {
      console.warn(`[chat] writer error for soop:${this.username}:`, safeError(e));
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
    this._connectSeq = (this._connectSeq || 0) + 1;
    this.manualClose = true;
    this._reconnecting = false;
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
    this._connectPromise = null;
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
      platform: 'soop',
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
  id: 'soop',
  label: 'SOOP Live',
  referer: 'https://play.sooplive.com/',
  normalizeUsername,
  formatSoopCookie,
  buildSoopPacket,
  parseSoopKoreaPacket,
  fetchViaYtDlp,
  fetchSoopStation,
  fetchLiveStatus,
  isLive,
  extractStreamUrls,
  pickPreferredStream,
  hasStreamUrls,
  buildSummary,
  invalidateCache,
  SoopChatSession,
};
