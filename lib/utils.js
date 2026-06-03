// lib/utils.js — Shared utility functions.

const path = require('path');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeFilename(name) {
  return path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Sanitize error messages for client — strip file paths, stack traces, and
// any token-shaped substring that could leak credentials in upstream
// error reports (TikTok occasionally echoes parts of the request URL back).
function safeError(e) {
  const msg = e?.message || String(e);
  return msg
    .replace(/\b[A-Z]:\\[^\s]+/gi, '[path]')      // Windows: C:\foo\bar
    .replace(/\/(?:home|Users|root|var|tmp|opt)\/[^\s]+/g, '[path]')  // *nix
    .replace(/sessionid=[^;\s&"']+/gi, 'sessionid=[redacted]')
    .replace(/tt-target-idc=[^;\s&"']+/gi, 'tt-target-idc=[redacted]')
    .replace(/(?:bearer\s+|token=|signApiKey=)[^\s&"']+/gi, '[redacted]')
    .replace(/\n.*$/s, '')
    .slice(0, 200);
}

function isValidStreamUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (u.username || u.password) return false;
    // Block recording from private/loopback hosts to prevent the recorder
    // from being weaponized to SSRF internal services. TikTok streams come
    // from public CDNs only.
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' || host === '0.0.0.0' ||
      /^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      host === '::1' || /^fc[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

function isAllowedCdnUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    // Reject embedded credentials in the URL — `https://user:pass@host/...`
    // is a common SSRF/credential-leak pattern and TikTok CDNs never use it.
    if (u.username || u.password) return false;
    // Reject hostnames that are bare IPs or that resolve to private/loopback
    // addresses by literal form. DNS rebinding to private IPs is still
    // possible for hostnames; SSRF mitigations rely on the hostname-based
    // allowlist below to prevent that path.
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||           // link-local, metadata
      /^::1$/.test(host) ||                 // IPv6 loopback
      /^fc[0-9a-f]{2}:/.test(host) ||       // IPv6 ULA
      /^fe[89ab][0-9a-f]:/.test(host)       // IPv6 link-local
    ) {
      return false;
    }
    // TikTok uses different CDN domains per region. Subdomain prefix encodes
    // edge location (vn=Vietnam, jp=Japan, kr=Korea, sg=Singapore, etc.) but
    // the base domain falls into one of these:
    const allowedDomains = [
      'tiktokcdn.com',          // Global (incl. SEA/JP/KR/VN edges)
      'tiktokcdn-eu.com',       // EU
      'tiktokcdn-us.com',       // Americas
      'tiktokv.com',            // API/static
      'byteoversea.com',        // International infra
      'bytefcdn-oversea.com',   // Newer overseas CDN
      'tiktokcdn-cgla.com',     // CG-line, sometimes used for Asia
    ];
    return allowedDomains.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// Parse recording start time from filename pattern <user>_YYYYMMDD_HHMMSS.mp4
function parseStartTimeFromName(name) {
  const m = name.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(s)
  );
  return date.getTime();
}

module.exports = {
  timestamp,
  safeFilename,
  safeError,
  isValidStreamUrl,
  isAllowedCdnUrl,
  parseStartTimeFromName,
};
