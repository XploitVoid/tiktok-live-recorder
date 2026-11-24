// lib/security.js — Security middleware and helpers for server.js.

const crypto = require('crypto');
const net = require('net');

const AUTH_COOKIE_NAME = 'tlr_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Constant-time string comparison using SHA-256 digests so lengths never leak.
 */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sessionHmacKey(appToken) {
  return crypto.createHmac('sha256', appToken).update('tlr-session-key-v1').digest();
}

function createSessionCookieValue(appToken, now = Date.now()) {
  const exp = String(now + SESSION_TTL_MS);
  const sig = crypto.createHmac('sha256', sessionHmacKey(appToken)).update(exp).digest('hex');
  return `${exp}.${sig}`;
}

function verifySessionCookieValue(value, appToken, now = Date.now()) {
  if (typeof value !== 'string' || !appToken) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expStr = value.slice(0, dot);
  const sigHex = value.slice(dot + 1);
  if (!/^\d+$/.test(expStr) || !/^[0-9a-f]{64}$/i.test(sigHex)) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false;

  const expectedHex = crypto.createHmac('sha256', sessionHmacKey(appToken)).update(expStr).digest('hex');
  const a = Buffer.from(sigHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    }
  }
  return out;
}

function parseTrustProxy(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (lower === '0' || lower === 'false' || lower === 'off' || lower === 'no') return false;
  if (lower === 'true' || lower === 'on' || lower === 'yes') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function isLoopbackBindHost(host) {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function formatHostForHeader(h) {
  const lower = String(h || '').trim().toLowerCase();
  if (!lower) return '';
  if (net.isIPv6(lower)) return `[${lower}]`;
  return lower;
}

function buildAllowedHosts(port, host, envAllowedHosts = '') {
  const normHost = String(host || '').trim().toLowerCase();
  const formattedHost = formatHostForHeader(normHost);
  const includeCustomHost = normHost && !isLoopbackBindHost(normHost) && normHost !== '0.0.0.0' && normHost !== '::';
  const baseHosts = ['localhost', '127.0.0.1', '[::1]', ...(includeCustomHost ? [formattedHost] : [])];
  const set = new Set();
  for (const h of baseHosts) {
    set.add(`${h}:${port}`);
    if (port === 80 || port === 443) {
      set.add(h);
    }
  }
  for (const h of String(envAllowedHosts || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    set.add(h);
  }
  return set;
}

function isLanIpForPort(hostHeader, port) {
  const allowPortless = port === 80 || port === 443;
  // IPv6 link-local: [fe80:...]:PORT or [fe80:...] on 80/443
  const v6Match = hostHeader.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6Match) {
    const ip = v6Match[1].split('%')[0];
    const p = v6Match[2] !== undefined ? Number(v6Match[2]) : (allowPortless ? port : -1);
    return p === port && net.isIPv6(ip) && /^fe[89ab][0-9a-f]:/i.test(ip);
  }
  // IPv4 private LAN: A.B.C.D:PORT or A.B.C.D on 80/443
  const v4Match = hostHeader.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
  if (!v4Match) return false;
  const ip = v4Match[1];
  const p = v4Match[2] !== undefined ? Number(v4Match[2]) : (allowPortless ? port : -1);
  if (p !== port || !net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function hostAllowed(hostHeader, { port, host, allowedHosts, trustProxy = false }) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  // Reject whitespace, credentials, paths, or query characters in Host header
  if (/[\s/@?#\\]/.test(hostHeader)) return false;
  const h = hostHeader.toLowerCase();
  if (allowedHosts.has(h)) return true;

  // Permit private LAN IPs with our port only when bound to non-loopback or behind proxy
  const allowLan = !isLoopbackBindHost(host) || !!trustProxy;
  if (allowLan && isLanIpForPort(h, port)) return true;
  return false;
}

function isCrossSiteRequest(req) {
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') return true;

  const reqHost = String(req.headers['host'] || '').toLowerCase();
  const origin = req.headers['origin'];
  if (origin !== undefined) {
    try {
      return new URL(origin).host.toLowerCase() !== reqHost;
    } catch {
      return true;
    }
  }

  // Fallback for mutating requests where Origin was stripped by a client/proxy
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method) && req.headers['referer']) {
    try {
      return new URL(req.headers['referer']).host.toLowerCase() !== reqHost;
    } catch {
      return true;
    }
  }
  return false;
}

function stripProto(obj, depth = 0) {
  if (obj == null || typeof obj !== 'object' || depth > 20) return;
  if (!Array.isArray(obj)) {
    delete obj.__proto__;
    delete obj.constructor;
    delete obj.prototype;
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') stripProto(v, depth + 1);
  }
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of hits) {
      if (b.resetAt < now) hits.delete(ip);
    }
  }, Math.max(60_000, windowMs));
  timer.unref();

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = hits.get(ip);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: 'too many requests' });
    }
    next();
  };
}

module.exports = {
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
};
