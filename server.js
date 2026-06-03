// server.js — Local webapp for checking, streaming and recording TikTok LIVE.
// Run: npm run web   (opens http://localhost:3000)

require('dotenv').config();
const express = require('express');
const path = require('path');
const compression = require('compression');
const { resolveFfmpeg } = require('./lib/ffmpeg');
const { getEncoder, ENCODER_LABELS } = require('./lib/transcode');
const { RECORDINGS_DIR, shutdownAll } = require('./lib/recorder');
const chat = require('./lib/chat');
const watcher = require('./lib/watcher');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // bind to localhost only by default

const app = express();

// Trust X-Forwarded-For only when explicitly configured (i.e. when running
// behind a reverse proxy / tunnel). Otherwise a malicious client could
// spoof its IP and bypass the per-IP rate limiter.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
}

// ── gzip compression ──
// Skip media/binary content — re-compressing video is pure CPU waste and
// breaks the streaming pipeline for /api/transcode and /api/proxy m3u8 chunks.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.path.startsWith('/files/') || req.path.startsWith('/api/transcode')) return false;
    const ct = res.getHeader('Content-Type') || '';
    if (typeof ct === 'string' && /^(video|audio|image)\//i.test(ct)) return false;
    return compression.filter(req, res);
  },
}));

// ── Host validation (DNS rebinding defense) ──
// Without this, an attacker-controlled DNS name that briefly resolves to
// 127.0.0.1 lets a victim's browser bypass the same-origin guard: both Origin
// and Host become attacker.com, so they match. We reject any Host header that
// isn't a known local-binding.
//
// ALLOWED_HOSTS can be set in .env as a comma list (e.g. "myhost.local,
// 192.168.1.10:3000") for users who legitimately want to access the app
// from another device on their LAN.
const allowedHosts = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
  // Default-allow when bound to a non-loopback host (LAN install).
  HOST !== '127.0.0.1' && HOST !== 'localhost' ? `${HOST}:${PORT}` : null,
]
  .filter(Boolean));
for (const h of (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  allowedHosts.add(h.toLowerCase());
}

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const h = hostHeader.toLowerCase();
  if (allowedHosts.has(h)) return true;
  // Permit any private LAN IP plus our port (10.x, 172.16-31.x, 192.168.x).
  // This keeps "open the app from my phone on the same WiFi" working without
  // requiring the user to enumerate IPs in ALLOWED_HOSTS.
  const lanRe = new RegExp(`^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|fe80:)\\S*:${PORT}$`);
  return lanRe.test(h);
}

app.use((req, res, next) => {
  if (!hostAllowed(req.headers.host)) {
    return res.status(421).type('text/plain').send('host not allowed');
  }
  next();
});

// ── Optional shared-token auth ──
// If APP_TOKEN is set, every /api/* request must present it via either:
//   * X-App-Token header
//   * ?token=... query param
// This is a single-user defense for when the app is exposed beyond localhost
// (LAN, tunnels). It's a coarse gate, not full RBAC — appropriate for a
// solo tool. When unset, no token is required (preserves current behavior
// for local-only installs).
const APP_TOKEN = process.env.APP_TOKEN || '';
function tokenEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
if (APP_TOKEN) {
  app.use((req, res, next) => {
    // Allow static assets (the SPA shell) so the browser can load and the
    // client-side code injects the token into API calls.
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/files/')) return next();
    const supplied = String(req.headers['x-app-token'] || req.query.token || '');
    if (!supplied || !tokenEquals(supplied, APP_TOKEN)) {
      return res.status(401).type('text/plain').send('unauthorized');
    }
    next();
  });
  console.log('[auth] APP_TOKEN required for /api/* and /files/*');
}

// ── Security headers ──
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers use CSP instead
  // No 'unsafe-inline' on script-src — Vite emits hashed external bundles
  // only, so any reflection that lands inline JS will be blocked. style-src
  // keeps 'unsafe-inline' because Tailwind v4 / shadcn rely on inline style
  // attributes (CSS variables for theme tokens).
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' https: data:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'self';"
  );
  next();
});

// ── Request logging ──
// Skip the high-frequency polling endpoints by default — they otherwise
// flood the console at ~10 req/sec per active client and dominate stdout
// IO. Set VERBOSE_LOGS=1 to see them.
const QUIET_ROUTES = /^\/api\/(record\/jobs|recordings$|recordings\/.+|chat\/dashboard|chat\/events|watch(\?|$)|watch\/events)/;
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    if (process.env.VERBOSE_LOGS || !QUIET_ROUTES.test(req.url)) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
  }
  next();
});

// ── Same-origin guard for mutating requests ──
function sameOriginGuard(req, res, next) {
  const origin = req.headers['origin'];
  // Non-browser clients (curl, fetch from CLI) usually send no Origin → allow.
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host.toLowerCase();
    // Compare against the Host header the browser sent. If they match, the
    // request is same-origin from the browser's perspective. This works on
    // localhost, 127.0.0.1, LAN IPs, hostnames — anything served by us.
    const reqHost = (req.headers['host'] || '').toLowerCase();
    if (originHost === reqHost) return next();
  } catch { /* fall through */ }
  return res.status(403).json({ error: 'cross-origin request blocked' });
}
app.use((req, res, next) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
    return sameOriginGuard(req, res, next);
  }
  next();
});

// Stricter origin guard for GET endpoints that trigger outbound network IO
// (TikTok lookups, fan-outs). Without this, an attacker page can embed
// <img src="http://localhost:3000/api/stream?u=anyone"> to make our server
// hammer TikTok for them, leaking credentials and consuming our rate limits.
//
// We still allow no-Origin requests so that direct visits, curl, and the
// browser's address-bar requests work — those aren't drive-by attacks.
const OUTBOUND_GET_ROUTES = [
  /^\/api\/check(\?|$)/,
  /^\/api\/stream(\?|$)/,
  /^\/api\/watch\/live-streams(\?|$)/,
  /^\/api\/proxy(\?|$)/,
  /^\/api\/transcode(\?|$)/,
];
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const origin = req.headers['origin'];
  if (!origin) return next();
  if (!OUTBOUND_GET_ROUTES.some((r) => r.test(req.url))) return next();
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const reqHost = (req.headers['host'] || '').toLowerCase();
    if (originHost === reqHost) return next();
  } catch { /* fall through */ }
  return res.status(403).type('text/plain').send('cross-origin GET blocked');
});

// ── JSON body parser with size limit + prototype pollution filter ──
app.use(express.json({ limit: '32kb' }));
function stripProto(obj) {
  if (obj == null || typeof obj !== 'object') return;
  delete obj.__proto__;
  delete obj.constructor;
  delete obj.prototype;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') stripProto(v);
  }
}
app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    stripProto(req.body);
  }
  next();
});

// ── Per-IP rate limit for mutations ──
// Without this, a malicious page that does pass the same-origin guard (e.g.
// a compromised dependency on the same host, a browser extension) could
// rapidly POST /api/record/start in a loop to exhaust disk + ffmpeg slots.
// Coarse cap: 60 mutations per IP per minute is plenty for human use.
const mutationHits = new Map(); // ip -> { count, resetAt }
const MUTATION_WINDOW_MS = 60_000;
const MUTATION_LIMIT = 60;
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = mutationHits.get(ip);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + MUTATION_WINDOW_MS };
    mutationHits.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > MUTATION_LIMIT) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
});
// Periodically prune expired buckets so the map doesn't grow unboundedly
// from short-lived addresses (e.g. tunnels assigning new IPs).
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of mutationHits) {
    if (b.resetAt < now) mutationHits.delete(ip);
  }
}, 5 * 60_000).unref();

// ── Static files ──
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist, {
  dotfiles: 'deny',
  // Vite emits hashed filenames in /assets/, safe to cache hard.
  // The HTML shell (index.html) is served via the SPA fallback below with
  // its own no-cache headers, so this immutable cache only hits hashed assets.
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.use('/files', express.static(RECORDINGS_DIR, {
  dotfiles: 'deny',
  // Recording mp4s never change once written; let the browser cache them.
  maxAge: '1h',
}));

// ── API routes ──
app.use(require('./routes/check'));
app.use(require('./routes/proxy'));
app.use(require('./routes/record'));
app.use(require('./routes/chat'));
app.use(require('./routes/watch'));
app.use(require('./routes/accounts'));
app.use(require('./routes/highlights'));

// ── 404 for unknown API paths (don't fall through to SPA index.html) ──
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// ── SPA fallback (React Router) ──
// Only serve index.html for paths that look like SPA routes — never for
// /api/* or /files/*. Without this guard, requesting a missing recording
// returns the HTML shell instead of a proper 404, which confuses downloads.
app.get(/^\/(?!api\/|files\/|favicon|assets\/).*$/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(clientDist, 'index.html'));
});

// 404 for anything else (e.g. missing /files/<name>.mp4)
app.use((_req, res) => {
  res.status(404).send('not found');
});

// ── Graceful shutdown ──
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Hard-exit safety net in case cleanup hangs (e.g. ffmpeg won't quit).
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  try {
    await shutdownAll();
  } catch (e) {
    console.warn('[shutdown] error:', e?.message || e);
  }
  try { chat.closeAll(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start server ──
app.listen(PORT, HOST, () => {
  console.log(`\n  TikTok LIVE Recorder  →  http://localhost:${PORT}\n`);
  console.log(`  ffmpeg: ${resolveFfmpeg()}`);
  const encoder = getEncoder();
  console.log(`  transcode encoder: ${ENCODER_LABELS[encoder] || encoder}`);
  console.log(`  recordings dir: ${RECORDINGS_DIR}\n`);
  watcher.loadWatchlist();
  watcher.schedulePoller();
  // Probe once immediately so the UI gets quick initial status.
  watcher.pollAll().catch(() => {});
});
