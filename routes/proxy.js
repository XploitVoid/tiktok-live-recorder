// routes/proxy.js — /api/proxy (HLS/CDN proxy) and /api/transcode endpoints.

const { Router } = require('express');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { isAllowedCdnUrl, safeError } = require('../lib/utils');
const {
  MAX_CONCURRENT_TRANSCODES,
  transcodeProcs,
  getEncoder,
  buildTranscodeArgs,
} = require('../lib/transcode');

const router = Router();

// ── HLS / CDN proxy ──
// Browsers block tiktokcdn.com due to CORS; this lets <video> play it.

// Simple counter-based rate limiter for proxy requests (O(1) per check).
// Sized for grid mode: each tile may fetch 1 manifest + ~3 segments every
// few seconds. 5 tiles × ~4 req/3s × 10s = ~70 req/10s baseline. We allow
// ~5x headroom for refresh bursts and multiple browser tabs.
let proxyHitCount = 0;
let proxyWindowStart = Date.now();
const PROXY_RATE_WINDOW = 10_000; // 10 seconds
const PROXY_RATE_LIMIT = 800;     // max requests per window

// Manually follow redirects so each hop is re-validated against the CDN
// allowlist. Without this, an open-redirect on any allowed CDN would let an
// attacker pivot the server into fetching arbitrary URLs (including
// 169.254.169.254 cloud metadata or internal services bound to localhost).
async function safeFetch(target, init = {}, hops = 0) {
  if (hops > 4) throw new Error('too many redirects');
  if (!isAllowedCdnUrl(target)) throw new Error('redirect to disallowed host');
  const res = await fetch(target, { ...init, redirect: 'manual' });
  // Manual redirect handling — surface 3xx + Location to validate.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) return res;
    let next;
    try { next = new URL(loc, target).toString(); } catch { return res; }
    return safeFetch(next, init, hops + 1);
  }
  return res;
}

router.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target || !isAllowedCdnUrl(target)) {
    return res.status(400).send('invalid url');
  }
  // Rate limit
  const now = Date.now();
  if (now - proxyWindowStart >= PROXY_RATE_WINDOW) {
    proxyHitCount = 0;
    proxyWindowStart = now;
  }
  if (proxyHitCount >= PROXY_RATE_LIMIT) {
    return res.status(429).send('proxy rate limit exceeded');
  }
  proxyHitCount++;
  try {
    const upstream = await safeFetch(target, {
      headers: {
        // Some TikTok CDNs check referer/UA
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Referer': 'https://www.tiktok.com/',
      },
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lk)) return;
      // Block any Set-Cookie / auth-bearing headers leaking back to the
      // browser — the proxy's purpose is media bytes, not session state.
      if (['set-cookie', 'www-authenticate', 'authorization'].includes(lk)) return;
      res.setHeader(k, v);
    });

    const ct = upstream.headers.get('content-type') || '';
    // Rewrite m3u8 manifests so segments also go through this proxy.
    if (/mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(target)) {
      const text = await upstream.text();
      const baseUrl = new URL(target);
      const rewritten = text
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            // Rewrite URI="..." inside tags too
            return line.replace(/URI="([^"]+)"/g, (_, u) => {
              try {
                const abs = new URL(u, baseUrl).toString();
                return `URI="/api/proxy?url=${encodeURIComponent(abs)}"`;
              } catch { return _; }
            });
          }
          try {
            const abs = new URL(trimmed, baseUrl).toString();
            return `/api/proxy?url=${encodeURIComponent(abs)}`;
          } catch { return line; }
        })
        .join('\n');
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    res.status(502).send(safeError(e));
  }
});

// ── HEVC → H.264 transcoding ──
// Pipes ffmpeg output as FLV (H.264 + AAC) so flv.js can play it.
// Used when the browser cannot decode HEVC natively.

router.get('/api/transcode', (req, res) => {
  const target = req.query.url;
  if (!target || !isAllowedCdnUrl(target)) {
    return res.status(400).send('invalid url');
  }
  if (transcodeProcs.size >= MAX_CONCURRENT_TRANSCODES) {
    return res.status(429).send('max concurrent transcodes reached');
  }

  const ffmpegBin = resolveFfmpeg();
  const encoder = getEncoder();
  const args = buildTranscodeArgs(target, encoder);
  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  transcodeProcs.add(proc);
  console.log(`[transcode] start enc=${encoder} (${transcodeProcs.size}/${MAX_CONCURRENT_TRANSCODES})`);

  res.setHeader('content-type', 'video/x-flv');
  res.setHeader('cache-control', 'no-store');
  proc.stdout.pipe(res);

  let stderrTail = '';
  proc.stderr.on('data', (b) => { stderrTail = (stderrTail + b.toString()).slice(-500); });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (!proc.killed) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    transcodeProcs.delete(proc);
    console.log(`[transcode] end (${transcodeProcs.size}/${MAX_CONCURRENT_TRANSCODES})`);
  };
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) console.warn('[transcode] ffmpeg exit', code, stderrTail);
    cleanup();
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
  req.on('close', cleanup);
  res.on('close', cleanup);
});

module.exports = router;
