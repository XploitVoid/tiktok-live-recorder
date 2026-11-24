// server.js — Local webapp for checking, streaming and recording TikTok LIVE.
// Run: npm run web   (opens http://localhost:3000)

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { resolveFfmpeg } = require('./lib/ffmpeg');
const { getEncoder, ENCODER_LABELS, shutdownTranscodes } = require('./lib/transcode');
const { RECORDINGS_DIR, shutdownAll, activeFilePaths } = require('./lib/recorder');
const { shutdownMediaProcs, recoverOrphanedTsFiles } = require('./lib/storage');
const { shutdownCutProcs } = require('./lib/highlights');
const chat = require('./lib/chat');
const watcher = require('./lib/watcher');
const db = require('./lib/db');
const {
  AUTH_COOKIE_NAME,
  parseTrustProxy,
  tokenEquals,
  createSessionCookieValue,
  verifySessionCookieValue,
  parseCookies,
  isLoopbackBindHost,
  buildAllowedHosts,
  hostAllowed,
  isCrossSiteRequest,
  stripProto,
  createRateLimiter,
} = require('./lib/security');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // bind to localhost only by default
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
const APP_TOKEN = process.env.APP_TOKEN || '';

const app = express();
app.disable('x-powered-by');

// Trust X-Forwarded-For only when explicitly configured (i.e. when running
// behind a reverse proxy / tunnel). Otherwise a malicious client could
// spoof its IP and bypass the per-IP rate limiter.
if (TRUST_PROXY !== false) {
  app.set('trust proxy', TRUST_PROXY);
}

// ── gzip compression ──
// Skip media/binary content — re-compressing video is pure CPU waste and
// breaks the streaming pipeline for /api/transcode and /api/proxy m3u8 chunks.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    const p = req.path.toLowerCase();
    if (p.startsWith('/files/') || p.startsWith('/api/transcode') || p.startsWith('/api/proxy') || p.replace(/\/+$/, '') === '/api/events/stream') return false;
    const ct = res.getHeader('Content-Type') || '';
    if (typeof ct === 'string' && /^(video|audio|image|text\/event-stream)\b/i.test(ct)) return false;
    return compression.filter(req, res);
  },
}));

// ── Host validation (DNS rebinding defense) ──
const allowedHosts = buildAllowedHosts(PORT, HOST, process.env.ALLOWED_HOSTS);
app.use((req, res, next) => {
  if (!hostAllowed(req.headers.host, { port: PORT, host: HOST, allowedHosts, trustProxy: TRUST_PROXY !== false })) {
    return res.status(421).type('text/plain').send('host not allowed');
  }
  next();
});

// ── Security headers ──
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
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
    "worker-src 'self' blob:; " +
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
const QUIET_ROUTES = /^\/api\/(record\/jobs|recordings$|recordings\/.+|chat\/dashboard|chat\/events|watch(\?|$)|watch\/events|events\/stream|health$)/i;
app.use((req, _res, next) => {
  const p = req.path.toLowerCase();
  if (p.startsWith('/api/')) {
    if (process.env.VERBOSE_LOGS || !QUIET_ROUTES.test(req.url)) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
  }
  next();
});

// ── Same-origin / CSRF guard for mutating requests & sensitive GETs ──
app.use((req, res, next) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
    if (isCrossSiteRequest(req)) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
  }
  next();
});

// Stricter origin guard for GET endpoints that trigger outbound network IO,
// consume persistent SSE slots, or return sensitive account metadata.
const SENSITIVE_GET_PATHS = new Set([
  '/api/check',
  '/api/stream',
  '/api/watch/live-streams',
  '/api/proxy',
  '/api/transcode',
  '/api/accounts',
  '/api/events/stream',
]);
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const normPath = req.path.toLowerCase().replace(/\/+$/, '');
  if (!SENSITIVE_GET_PATHS.has(normPath)) return next();
  if (isCrossSiteRequest(req)) {
    return res.status(403).type('text/plain').send('cross-origin GET blocked');
  }
  next();
});

// ── JSON body parser with size limit + prototype pollution filter ──
app.use(express.json({ limit: '32kb' }));
app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    stripProto(req.body);
  }
  next();
});

// ── Health endpoint (unauthenticated for Docker HEALTHCHECK) ──
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// ── Optional shared-token auth + HttpOnly SameSite=Strict session cookie ──
function isRequestAuthenticated(req) {
  if (!APP_TOKEN) return true;
  const headerOrQuery = String(req.headers['x-app-token'] || req.query.token || '');
  if (headerOrQuery && tokenEquals(headerOrQuery, APP_TOKEN)) return true;
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionCookieValue(cookies[AUTH_COOKIE_NAME], APP_TOKEN);
}

const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 15 });

app.get('/api/auth/status', (req, res) => {
  res.json({
    authRequired: !!APP_TOKEN,
    authenticated: isRequestAuthenticated(req),
  });
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  if (!APP_TOKEN) {
    return res.json({ ok: true, authRequired: false });
  }
  const supplied = String(req.body?.token || '');
  if (!tokenEquals(supplied, APP_TOKEN)) {
    return res.status(401).json({ error: 'invalid token' });
  }
  const cookieVal = createSessionCookieValue(APP_TOKEN);
  const isHttps = req.secure || (TRUST_PROXY !== false && req.headers['x-forwarded-proto'] === 'https');
  res.cookie(AUTH_COOKIE_NAME, cookieVal, {
    httpOnly: true,
    sameSite: 'strict',
    secure: !!isHttps,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, authRequired: true });
});

app.post('/api/auth/logout', (req, res) => {
  const isHttps = req.secure || (TRUST_PROXY !== false && req.headers['x-forwarded-proto'] === 'https');
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/', sameSite: 'strict', httpOnly: true, secure: !!isHttps });
  res.json({ ok: true });
});

if (APP_TOKEN) {
  app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    if (!p.startsWith('/api/') && !p.startsWith('/files/')) return next();
    if (p === '/api/health' || p.startsWith('/api/auth/')) return next();
    if (!isRequestAuthenticated(req)) {
      if (p.startsWith('/api/')) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      return res.status(401).type('text/plain').send('unauthorized');
    }
    next();
  });
  console.log('[auth] APP_TOKEN required for /api/* and /files/*');
} else if (!isLoopbackBindHost(HOST)) {
  console.warn(
    `[security] WARNING: Server is bound to non-loopback host (${HOST}) without APP_TOKEN! ` +
    'Set APP_TOKEN in .env to protect recordings and TikTok session cookies.'
  );
}

// ── Per-IP rate limit for mutations ──
const mutationLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  return mutationLimiter(req, res, next);
});

// ── Static files ──
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist, {
  dotfiles: 'deny',
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
app.use(require('./routes/settings'));
app.use(require('./routes/events'));

// ── 404 for unknown API paths (don't fall through to SPA index.html) ──
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// ── SPA fallback (React Router) ──
app.get(/^\/(?!api\/|files\/|favicon|assets\/).*$/, (_req, res) => {
  const indexHtml = path.join(clientDist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return res.status(503).type('text/plain').send('Frontend not built. Run: npm run build');
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexHtml);
});

// 404 for anything else (e.g. missing /files/<name>.mp4)
app.use((_req, res) => {
  res.status(404).send('not found');
});

// Express error fallback (e.g. malformed JSON body)
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body too large' });
  }
  console.error('[server] unhandled route error:', err?.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal server error' });
  }
});

// ── Graceful shutdown ──
let shuttingDown = false;
let httpServer = null;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  try { watcher.stopPoller?.(); } catch {}
  try { httpServer?.close?.(); } catch {}
  try {
    await shutdownAll();
  } catch (e) {
    console.warn('[shutdown] error:', e?.message || e);
  }
  try { shutdownTranscodes(); } catch {}
  try { shutdownMediaProcs(); } catch {}
  try { shutdownCutProcs(); } catch {}
  try { chat.closeAll(); } catch {}
  try { db.closeDb(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  console.warn('[server] unhandledRejection:', reason?.message || reason);
});

// ── Start server ──
httpServer = app.listen(PORT, HOST, () => {
  console.log(`\n  TikTok LIVE Recorder  →  http://localhost:${PORT}\n`);
  console.log(`  ffmpeg: ${resolveFfmpeg()}`);
  const encoder = getEncoder();
  console.log(`  transcode encoder: ${ENCODER_LABELS[encoder] || encoder}`);
  console.log(`  recordings dir: ${RECORDINGS_DIR}\n`);
  watcher.loadWatchlist();
  watcher.schedulePoller();
  // Probe once immediately so the UI gets quick initial status.
  watcher.pollAll().catch(() => {});
  if (process.env.QUIET_LOGS !== '1') {
    setImmediate(async () => {
      try { await recoverOrphanedTsFiles(activeFilePaths()); } catch {}
      try { db.syncAllRecordings({ force: true }); } catch {}
    });
  }
});
