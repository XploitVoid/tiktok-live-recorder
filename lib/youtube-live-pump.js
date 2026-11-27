// lib/youtube-live-pump.js — Local loopback HTTP pump for YouTube Live 2K/4K adaptiveFormats (&sq=N).
// YouTube caps hlsManifestUrl at 1080p60 H.264; true 1440p/2160p streams are only
// exposed via adaptiveFormats (WebM VP9/AV1 video + fMP4 AAC/Opus audio).

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { getProxyAgent } = require('./proxy-config');
const { assertPublicDns } = require('./utils');

const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';
const PROBE_TIMEOUT_MS = 10_000;
const SEG_TIMEOUT_MS = 20_000;
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_CONSECUTIVE_MISSES = 25;
const MAX_HEAD_LAG_SEGS = 10;

async function assertSafeGoogleVideoUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('invalid adaptive stream URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password) {
    throw new Error('disallowed adaptive stream protocol or credentials');
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'googlevideo.com' && !host.endsWith('.googlevideo.com')) {
    throw new Error('disallowed adaptive stream host');
  }
  if (!getProxyAgent()) {
    await assertPublicDns(host);
  }
}

const WEBM_SEGMENT_ID = Buffer.from([0x18, 0x53, 0x80, 0x67]);
const WEBM_CLUSTER_ID = Buffer.from([0x1F, 0x43, 0xB6, 0x75]);

function prepareWebmSegment(buf, isFirst) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return buf;
  if (isFirst) {
    const out = Buffer.from(buf);
    const idx = out.indexOf(WEBM_SEGMENT_ID);
    if (idx !== -1 && idx + 5 <= out.length) {
      const firstByte = out[idx + 4];
      let vintLen = 1;
      let mask = 0x80;
      while (vintLen <= 8 && (firstByte & mask) === 0) {
        vintLen++;
        mask >>= 1;
      }
      if (vintLen <= 8 && idx + 4 + vintLen <= out.length) {
        out[idx + 4] = mask | (mask - 1);
        for (let k = 1; k < vintLen; k++) out[idx + 4 + k] = 0xFF;
      }
    }
    return out;
  }
  const cIdx = buf.indexOf(WEBM_CLUSTER_ID);
  return cIdx !== -1 ? buf.subarray(cIdx) : buf;
}

function prepareMp4Segment(buf, isFirst) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || isFirst) return buf;
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'moof') return buf.subarray(off);
    if (size === 1 && off + 16 <= buf.length) {
      size = Number(buf.readBigUInt64BE(off + 8));
    } else if (size === 0) {
      break;
    }
    if (!Number.isFinite(size) || size < 8) break;
    off += size;
  }
  return buf;
}

function appendSqParam(baseUrl, paramName, value) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${paramName}=${encodeURIComponent(String(value))}`;
}

function probeHeadSeq(videoUrl, userAgent, activeReqs) {
  const target = appendSqParam(videoUrl, 'headm', '3');
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const mod = parsed.protocol === 'http:' ? http : https;
    const agent = getProxyAgent();
    let settled = false;
    let wallTimer = null;
    let req = null;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
      if (req) activeReqs.delete(req);
      if (err) reject(err);
      else resolve(val);
    };
    req = mod.request(
      parsed,
      {
        method: 'GET',
        headers: { 'User-Agent': userAgent },
        ...(agent ? { agent } : {}),
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        const headSeq = Number(res.headers['x-head-seqnum']) || 0;
        res.destroy();
        if (status >= 200 && status < 400 && headSeq > 0) {
          finish(null, headSeq);
        } else {
          finish(new Error(`YouTube 4K head probe returned HTTP ${status} (seq=${headSeq})`));
        }
      },
    );
    activeReqs.add(req);
    wallTimer = setTimeout(() => {
      try { req.destroy(new Error('YouTube 4K head probe timeout')); } catch {}
      finish(new Error('YouTube 4K head probe timeout'));
    }, PROBE_TIMEOUT_MS + 2000);
    wallTimer.unref?.();
    req.on('timeout', () => req.destroy(new Error('YouTube 4K head probe timeout')));
    req.on('error', (err) => finish(err));
    req.on('close', () => finish(new Error('YouTube 4K head probe closed')));
    req.end();
  });
}

function fetchSegment(url, userAgent, activeReqs, trackReqs = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'http:' ? http : https;
    const agent = getProxyAgent();
    let settled = false;
    let wallTimer = null;
    let req = null;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
      if (req) {
        activeReqs.delete(req);
        trackReqs?.delete(req);
      }
      if (err) reject(err);
      else resolve(val);
    };
    req = mod.request(
      parsed,
      {
        method: 'GET',
        headers: { 'User-Agent': userAgent },
        ...(agent ? { agent } : {}),
        timeout: SEG_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_SEGMENT_BYTES) {
            try { res.destroy(); } catch {}
            try { req.destroy(new Error('YouTube 4K segment too large')); } catch {}
            finish(new Error('YouTube 4K segment too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          finish(null, {
            status: res.statusCode || 0,
            headSeq: Number(res.headers['x-head-seqnum']) || 0,
            buf: Buffer.concat(chunks),
          });
        });
        res.on('close', () => {
          if (!res.complete) finish(new Error('YouTube 4K segment stream closed early'));
        });
        res.on('error', (err) => finish(err));
      },
    );
    activeReqs.add(req);
    trackReqs?.add(req);
    wallTimer = setTimeout(() => {
      try { req.destroy(new Error('YouTube 4K segment timeout')); } catch {}
      finish(new Error('YouTube 4K segment timeout'));
    }, SEG_TIMEOUT_MS + 5000);
    wallTimer.unref?.();
    req.on('timeout', () => req.destroy(new Error('YouTube 4K segment timeout')));
    req.on('error', (err) => finish(err));
    req.on('close', () => finish(new Error('YouTube 4K segment request closed')));
    req.end();
  });
}

async function pumpTrack({
  trackUrl,
  isWebm,
  startSeq,
  userAgent,
  res,
  activeReqs,
  isStopped,
}) {
  const trackReqs = new Set();
  const abortTrackReqs = () => {
    for (const r of trackReqs) {
      try { r.destroy(new Error('client closed')); } catch {}
    }
    trackReqs.clear();
  };
  res.on('error', abortTrackReqs);
  res.on('close', abortTrackReqs);

  try {
    res.writeHead(200, {
      'Content-Type': isWebm ? 'video/webm' : 'audio/mp4',
      'Cache-Control': 'no-store',
    });
  } catch {
    abortTrackReqs();
    return;
  }

  let seq = startSeq;
  let first = true;
  let misses = 0;

  while (!isStopped() && !res.destroyed && !res.writableEnded) {
    try {
      const seg = await fetchSegment(appendSqParam(trackUrl, 'sq', seq), userAgent, activeReqs, trackReqs);
      if (isStopped() || res.destroyed || res.writableEnded) break;

      if (seg.status === 200 && seg.buf.length > 0) {
        misses = 0;
        const payload = isWebm ? prepareWebmSegment(seg.buf, first) : prepareMp4Segment(seg.buf, first);
        first = false;

        if (seg.headSeq > 0 && seg.headSeq - seq > MAX_HEAD_LAG_SEGS) {
          seq = Math.max(seq + 1, seg.headSeq - 2);
        } else {
          seq++;
        }

        if (payload.length > 0 && !res.write(payload)) {
          await new Promise((resolve) => {
            const onDone = () => {
              res.removeListener('drain', onDone);
              res.removeListener('close', onDone);
              resolve();
            };
            res.once('drain', onDone);
            res.once('close', onDone);
          });
        }
        continue;
      }

      if (seg.status === 401 || seg.status === 403 || seg.status === 410) {
        break;
      }

      misses++;
      if (misses >= MAX_CONSECUTIVE_MISSES) break;
      await new Promise((r) => setTimeout(r, 1000).unref?.());
    } catch {
      if (isStopped() || res.destroyed || res.writableEnded) break;
      misses++;
      if (misses >= MAX_CONSECUTIVE_MISSES) break;
      await new Promise((r) => setTimeout(r, 1000).unref?.());
    }
  }

  abortTrackReqs();
  try {
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch {}
}

async function startYouTubeAdaptivePump({
  videoUrl,
  audioUrl = null,
  videoMime = 'video/webm',
  audioMime = 'audio/mp4',
  userAgent = ANDROID_UA,
} = {}) {
  if (!videoUrl) throw new Error('missing adaptive videoUrl');
  await assertSafeGoogleVideoUrl(videoUrl);
  if (audioUrl) await assertSafeGoogleVideoUrl(audioUrl);

  const activeReqs = new Set();
  const sockets = new Set();
  let stopped = false;

  const headSeq = await probeHeadSeq(videoUrl, userAgent, activeReqs);
  const startSeq = Math.max(0, headSeq - 2);
  const token = crypto.randomBytes(16).toString('hex');
  const videoPath = `/${token}/video`;
  const audioPath = `/${token}/audio`;

  const server = http.createServer((req, res) => {
    if (stopped) {
      res.writeHead(503);
      res.end();
      return;
    }
    const urlPath = String(req.url || '').split('?')[0];
    if (urlPath === videoPath) {
      pumpTrack({
        trackUrl: videoUrl,
        isWebm: /webm/i.test(videoMime),
        startSeq,
        userAgent,
        res,
        activeReqs,
        isStopped: () => stopped,
      }).catch(() => {});
      return;
    }
    if (urlPath === audioPath && audioUrl) {
      pumpTrack({
        trackUrl: audioUrl,
        isWebm: /webm/i.test(audioMime),
        startSeq,
        userAgent,
        res,
        activeReqs,
        isStopped: () => stopped,
      }).catch(() => {});
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const close = () => {
    if (stopped) return;
    stopped = true;
    for (const req of activeReqs) {
      try { req.destroy(new Error('pump closed')); } catch {}
    }
    activeReqs.clear();
    for (const socket of sockets) {
      try { socket.destroy(); } catch {}
    }
    sockets.clear();
    try { server.close(); } catch {}
  };

  return {
    startSeq,
    videoUrl: `${baseUrl}${videoPath}`,
    audioUrl: audioUrl ? `${baseUrl}${audioPath}` : null,
    close,
  };
}

module.exports = {
  prepareWebmSegment,
  prepareMp4Segment,
  startYouTubeAdaptivePump,
};
