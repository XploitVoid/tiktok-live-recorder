// routes/proxy.js — /api/proxy (HLS/CDN proxy) and /api/transcode endpoints.

const { Router } = require('express');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { resolveFfmpeg, isFfmpegAvailable } = require('../lib/ffmpeg');
const { isAllowedCdnUrl, assertPublicDns, safeError } = require('../lib/utils');
const { getProxyAgent } = require('../lib/proxy-config');
const {
  MAX_CONCURRENT_TRANSCODES,
  transcodeProcs,
  getEncoder,
  buildTranscodeArgs,
} = require('../lib/transcode');

const router = Router();

// ── HLS / CDN proxy ──
// Browsers block tiktokcdn.com due to CORS; this lets <video> play it.

// Per-IP counter-based rate limiter for proxy requests.
// Sized for grid mode: each tile may fetch 1 manifest + ~3 segments every
// few seconds. 5 tiles × ~4 req/3s × 10s = ~70 req/10s baseline.
const proxyHitsByIp = new Map(); // ip -> { count, resetAt }
const PROXY_RATE_WINDOW = 10_000; // 10 seconds
const PROXY_RATE_LIMIT = 800;     // max requests per IP per window
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2 MB cap for m3u8 playlists
const MAX_TRANSCODES_PER_IP = 3;

const transcodeCountByIp = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of proxyHitsByIp) {
    if (b.resetAt < now) proxyHitsByIp.delete(ip);
  }
}, 60_000).unref();

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
]);

const BLOCKED_CONTENT_TYPES = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/javascript|text\/javascript|application\/x-javascript)/i;

function requestViaAgent(target, headers, agent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.request(parsed, { method: 'GET', headers, agent }, (res) => {
      const hdrs = {
        get: (name) => {
          const v = res.headers[name.toLowerCase()];
          return Array.isArray(v) ? v.join(', ') : (v ?? null);
        },
        forEach: (cb) => {
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) cb(Array.isArray(v) ? v.join(', ') : String(v), k);
          }
        },
      };
      resolve({
        status: res.statusCode || 502,
        finalUrl: target,
        headers: hdrs,
        getNodeStream: () => res,
        cancelBody: () => { try { res.destroy(); } catch {} },
        readBuffer: (maxBytes) => new Promise((resBuf, rejBuf) => {
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > maxBytes) {
              res.destroy();
              return rejBuf(new Error('manifest too large'));
            }
            chunks.push(c);
          });
          res.on('end', () => resBuf(Buffer.concat(chunks)));
          res.on('error', rejBuf);
        }),
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('upstream timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function wrapFetchResponse(res, target) {
  let cachedNodeStream = null;
  return {
    status: res.status,
    finalUrl: target,
    headers: res.headers,
    getNodeStream: () => {
      if (!res.body) return null;
      if (!cachedNodeStream) cachedNodeStream = Readable.fromWeb(res.body);
      return cachedNodeStream;
    },
    cancelBody: async () => {
      try {
        if (cachedNodeStream) {
          cachedNodeStream.destroy();
        } else if (res.body && !res.body.locked) {
          await res.body.cancel();
        }
      } catch {}
    },
    readBuffer: async (maxBytes) => {
      if (!res.body) return Buffer.alloc(0);
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error('manifest too large');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    },
  };
}

// Manually follow redirects so each hop is re-validated against the CDN
// allowlist AND DNS-resolved to public IPs (defending against DNS rebinding).
async function safeFetch(target, init = {}, hops = 0) {
  if (hops > 4) throw new Error('too many redirects');
  if (!isAllowedCdnUrl(target)) throw new Error('redirect to disallowed host');
  const parsed = new URL(target);
  await assertPublicDns(parsed.hostname);

  const agent = getProxyAgent();
  let upstream;
  if (agent) {
    upstream = await requestViaAgent(target, init.headers || {}, agent, UPSTREAM_TIMEOUT_MS);
  } else {
    // Only apply UPSTREAM_TIMEOUT_MS to connecting & receiving response headers;
    // do not kill long-lived FLV live streams after 15s while data is flowing.
    const ac = new AbortController();
    const headerTimer = setTimeout(() => ac.abort(new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(target, {
        ...init,
        redirect: 'manual',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(headerTimer);
    }
    upstream = wrapFetchResponse(res, target);
  }

  // Manual redirect handling — surface 3xx + Location to validate.
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get('location');
    if (!loc) return upstream;
    let next;
    try { next = new URL(loc, target).toString(); } catch { return upstream; }
    await upstream.cancelBody();
    return safeFetch(next, init, hops + 1);
  }
  return upstream;
}

function checkProxyRate(ip) {
  const now = Date.now();
  let bucket = proxyHitsByIp.get(ip);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + PROXY_RATE_WINDOW };
    proxyHitsByIp.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count <= PROXY_RATE_LIMIT;
}

router.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (typeof target !== 'string' || !isAllowedCdnUrl(target)) {
    return res.status(400).send('invalid url');
  }
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!checkProxyRate(ip)) {
    return res.status(429).send('proxy rate limit exceeded');
  }

  try {
    const targetHost = new URL(target).hostname.toLowerCase();
    let referer = 'https://www.tiktok.com/';
    if (targetHost.endsWith('.ttvnw.net') || targetHost === 'ttvnw.net' || targetHost.endsWith('.jtvnw.net') || targetHost === 'jtvnw.net') {
      referer = 'https://www.twitch.tv/';
    } else if (
      targetHost.endsWith('.googlevideo.com') || targetHost === 'googlevideo.com' ||
      targetHost.endsWith('.ytimg.com') || targetHost === 'ytimg.com' ||
      targetHost.endsWith('.ggpht.com') || targetHost === 'ggpht.com'
    ) {
      referer = 'https://www.youtube.com/';
    } else if (
      targetHost.endsWith('.live-video.net') || targetHost === 'live-video.net' ||
      targetHost.endsWith('.kick.com') || targetHost === 'kick.com'
    ) {
      referer = 'https://kick.com/';
    }
    const upstream = await safeFetch(target, {
      headers: {
        // Some CDNs check referer/UA
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Referer': referer,
      },
    });

    const ct = upstream.headers.get('content-type') || '';
    if (BLOCKED_CONTENT_TYPES.test(ct)) {
      await upstream.cancelBody();
      return res.status(502).type('text/plain').send('disallowed upstream content-type');
    }

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (SAFE_RESPONSE_HEADERS.has(lk)) {
        res.setHeader(lk, v);
      }
    });

    // Rewrite m3u8 manifests so segments also go through this proxy.
    const effectiveUrl = upstream.finalUrl || target;
    if (upstream.status >= 200 && upstream.status < 300 && (/mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(effectiveUrl))) {
      const contentLen = Number(upstream.headers.get('content-length') || 0);
      if (contentLen > MAX_MANIFEST_BYTES) {
        await upstream.cancelBody();
        return res.status(502).type('text/plain').send('manifest too large');
      }
      const buf = await upstream.readBuffer(MAX_MANIFEST_BYTES);
      const text = buf.toString('utf8');
      const baseUrl = new URL(effectiveUrl);
      const rewriteProxyUri = (rawUri) => {
        const abs = new URL(rawUri, baseUrl).toString();
        if (!isAllowedCdnUrl(abs)) return null;
        return `/api/proxy?url=${encodeURIComponent(abs)}`;
      };
      const rewritten = text
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            // Rewrite URI="..." inside tags too
            return line.replace(/URI="([^"]+)"/g, (full, u) => {
              try {
                const proxied = rewriteProxyUri(u);
                return proxied ? `URI="${proxied}"` : full;
              } catch { return full; }
            });
          }
          try {
            const proxied = rewriteProxyUri(trimmed);
            return proxied || '# disallowed segment skipped';
          } catch { return line; }
        })
        .join('\n');
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.setHeader('cache-control', 'no-store');
      return res.send(rewritten);
    }

    const nodeStream = upstream.getNodeStream();
    if (nodeStream) {
      let idleTimer = null;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!nodeStream.destroyed) nodeStream.destroy(new Error('upstream idle timeout'));
        }, 30_000);
        idleTimer.unref?.();
      };
      const clearIdle = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      };
      resetIdle();
      nodeStream.on('data', resetIdle);
      nodeStream.on('end', clearIdle);
      nodeStream.on('error', () => {
        clearIdle();
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
      res.on('close', () => {
        clearIdle();
        if (!nodeStream.destroyed) nodeStream.destroy();
      });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) {
      res.status(502).type('text/plain').send(safeError(e));
    }
  }
});

// ── HEVC → H.264 transcoding ──
// Pipes ffmpeg output as FLV (H.264 + AAC) so flv.js can play it.
// Used when the browser cannot decode HEVC natively.

router.get('/api/transcode', async (req, res) => {
  const target = req.query.url;
  if (typeof target !== 'string' || !isAllowedCdnUrl(target)) {
    return res.status(400).send('invalid url');
  }
  if (!isFfmpegAvailable()) {
    return res.status(503).json({ error: 'ffmpeg is not installed on the server (required for HEVC/1080p transcode)' });
  }
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ipActive = transcodeCountByIp.get(ip) || 0;
  if (ipActive >= MAX_TRANSCODES_PER_IP || transcodeProcs.size >= MAX_CONCURRENT_TRANSCODES) {
    return res.status(429).send('max concurrent transcodes reached');
  }

  try {
    await assertPublicDns(new URL(target).hostname);
  } catch (e) {
    return res.status(400).send(safeError(e));
  }

  // Re-check limits and client socket after async DNS lookup to close race conditions
  if (req.destroyed || res.destroyed || res.writableEnded) return;
  const ipActiveAfter = transcodeCountByIp.get(ip) || 0;
  if (ipActiveAfter >= MAX_TRANSCODES_PER_IP || transcodeProcs.size >= MAX_CONCURRENT_TRANSCODES) {
    return res.status(429).send('max concurrent transcodes reached');
  }

  let proc;
  let cleaned = false;
  let counted = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (proc && !proc.killed) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    if (proc) transcodeProcs.delete(proc);
    if (counted) {
      counted = false;
      const cur = transcodeCountByIp.get(ip) || 1;
      if (cur <= 1) transcodeCountByIp.delete(ip);
      else transcodeCountByIp.set(ip, cur - 1);
    }
    console.log(`[transcode] end (${transcodeProcs.size}/${MAX_CONCURRENT_TRANSCODES})`);
  };

  try {
    const ffmpegBin = resolveFfmpeg();
    const encoder = getEncoder();
    const args = buildTranscodeArgs(target, encoder);
    proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    transcodeProcs.add(proc);
    transcodeCountByIp.set(ip, ipActiveAfter + 1);
    counted = true;
    console.log(`[transcode] start enc=${encoder} (${transcodeProcs.size}/${MAX_CONCURRENT_TRANSCODES})`);

    res.setHeader('content-type', 'video/x-flv');
    res.setHeader('cache-control', 'no-store');
    proc.stdout.pipe(res);

    let stderrTail = '';
    proc.stderr.on('data', (b) => { stderrTail = (stderrTail + b.toString()).slice(-500); });

    proc.on('error', (err) => {
      console.warn('[transcode] ffmpeg spawn error:', err?.message || err);
      cleanup();
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) console.warn('[transcode] ffmpeg exit', code, stderrTail);
      cleanup();
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    req.on('close', cleanup);
    res.on('close', cleanup);
  } catch (e) {
    cleanup();
    if (!res.headersSent) res.status(502).send(safeError(e));
    else res.end();
  }
});

router.wrapFetchResponse = wrapFetchResponse;

module.exports = router;
