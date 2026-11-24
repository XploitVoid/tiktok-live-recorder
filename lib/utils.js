// lib/utils.js — Shared utility and security validation functions.

const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_EVENTS_FILE_BYTES = Number(process.env.MAX_EVENTS_FILE_BYTES) || 50 * 1024 * 1024; // 50 MB safety cap
const QUALITY_RE = /^(?:hevc:)?(?:origin|uhd(?:_60)?|hd(?:_60)?|sd|ld|md|ao)$/;
const ALLOWED_AUDIO_BITRATES = new Set(['64k', '96k', '128k', '192k']);
const RESERVED_RECORDING_SUBDIRS = new Set(['thumbs', 'audio', 'highlights']);
const DEFAULT_FILENAME_TEMPLATE = '{username}_{date}_{time}';

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeFilename(name) {
  if (typeof name !== 'string' || !name) return '';
  const cleaned = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return '';
  return cleaned;
}

/**
 * Safely resolve a user-supplied filename inside `baseDir`.
 * Prevents path traversal, dotfile access, prefix-matching bugs, and symlink escapes.
 * Returns `{ name, full }` or `null` if invalid.
 */
function resolveInsideDir(baseDir, rawName, requiredExt = null) {
  const name = safeFilename(rawName);
  if (!name) return null;
  if (requiredExt && !name.toLowerCase().endsWith(requiredExt.toLowerCase())) return null;

  const base = path.resolve(baseDir);
  const full = path.resolve(base, name);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return null;
  }

  // If the target exists, ensure a symlink cannot escape baseDir.
  try {
    const realBase = fs.realpathSync(base);
    if (fs.existsSync(full)) {
      const realFull = fs.realpathSync(full);
      const realRel = path.relative(realBase, realFull);
      if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return null;
      }
    }
  } catch {
    return null;
  }

  return { name, full };
}

/**
 * Resolve a recording path inside `baseDir`, allowing either flat `<file>.mp4`
 * or 1-level creator subfolder `<creator>/<file>.mp4` (never reserved subdirs,
 * backslashes, dotfiles, traversal segments, or symlink escapes).
 */
function resolveRecordingPath(baseDir, rawRelPath, requiredExt = '.mp4') {
  if (typeof rawRelPath !== 'string' || !rawRelPath || rawRelPath.includes('\\') || rawRelPath.includes('\0')) {
    return null;
  }
  const segments = rawRelPath.split('/');
  if (segments.length < 1 || segments.length > 2) return null;
  for (const seg of segments) {
    if (!seg || safeFilename(seg) !== seg) return null;
  }
  if (segments.length === 2 && RESERVED_RECORDING_SUBDIRS.has(segments[0].toLowerCase())) {
    return null;
  }
  const fileName = segments[segments.length - 1];
  if (requiredExt && !fileName.toLowerCase().endsWith(requiredExt.toLowerCase())) return null;

  const base = path.resolve(baseDir);
  const full = path.resolve(base, ...segments);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  try {
    const realBase = fs.realpathSync(base);
    if (fs.existsSync(full)) {
      const realFull = fs.realpathSync(full);
      const realRel = path.relative(realBase, realFull);
      if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    } else if (segments.length === 2) {
      const parentDir = path.dirname(full);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        const parentRel = path.relative(realBase, realParent);
        if (!parentRel || parentRel.startsWith('..') || path.isAbsolute(parentRel)) return null;
      }
    }
  } catch {
    return null;
  }

  const name = segments.join('/');
  const folder = segments.length === 2 ? segments[0] : null;
  const artifactStem = segments.join('__').replace(/\.[^.]+$/, '');
  return { name, folder, fileName, artifactStem, full };
}

function sanitizeFilenameTemplate(raw) {
  if (typeof raw !== 'string') return DEFAULT_FILENAME_TEMPLATE;
  const cleaned = raw.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '').trim().slice(0, 100);
  return cleaned || DEFAULT_FILENAME_TEMPLATE;
}

function renderRecordingFilename(template, { platform = 'tiktok', username, title, dateObj = new Date(), part = 1 } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const safePlat = safeFilename(platform) || 'tiktok';
  const safeUser = safeFilename(username) || 'live';
  const y = dateObj.getFullYear();
  const mo = pad(dateObj.getMonth() + 1);
  const d = pad(dateObj.getDate());
  const h = pad(dateObj.getHours());
  const mi = pad(dateObj.getMinutes());
  const s = pad(dateObj.getSeconds());
  const dateCompact = `${y}${mo}${d}`;
  const timeCompact = `${h}${mi}${s}`;
  const dateIso = `${y}-${mo}-${d}`;
  const timeHms = `${h}-${mi}-${s}`;
  const cleanTitle = String(title || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'live';

  const tpl = sanitizeFilenameTemplate(template);
  const hasPlatToken = tpl.includes('{platform}');
  let stem = tpl
    .replace(/\{platform\}/g, safePlat)
    .replace(/\{username\}/g, safeUser)
    .replace(/\{date\}/g, dateCompact)
    .replace(/\{time\}/g, timeCompact)
    .replace(/\{date_iso\}/g, dateIso)
    .replace(/\{time_hms\}/g, timeHms)
    .replace(/\{title\}/g, cleanTitle);

  if (safePlat !== 'tiktok' && !hasPlatToken && !stem.toLowerCase().startsWith(`${safePlat.toLowerCase()}_`)) {
    stem = `${safePlat}_${stem}`;
  }

  stem = safeFilename(stem).replace(/\.+$/, '');
  const partSuffix = part && Number(part) > 1 ? `_p${Number(part)}` : '';
  if (!stem) {
    const prefix = safePlat !== 'tiktok' ? `${safePlat}_` : '';
    return `${prefix}${safeUser}_${dateCompact}_${timeCompact}${partSuffix}`;
  }
  const maxBase = Math.max(16, 140 - partSuffix.length);
  return `${stem.slice(0, maxBase)}${partSuffix}`;
}

function stripControlChars(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}

function sanitizeQuality(q, fallback = null) {
  if (q == null || q === '' || q === 'auto') return fallback;
  if (typeof q !== 'string') return fallback;
  return QUALITY_RE.test(q) ? q : fallback;
}

function sanitizeAudioBitrate(b, fallback = null) {
  if (b == null || b === '' || b === 'copy' || b === 'auto') return fallback;
  if (typeof b !== 'string') return fallback;
  const v = b.trim().toLowerCase();
  return ALLOWED_AUDIO_BITRATES.has(v) ? v : fallback;
}

// Sanitize error messages for client — strip file paths, stack traces, and
// any token-shaped substring that could leak credentials in upstream
// error reports (TikTok occasionally echoes parts of the request URL back).
function safeError(e) {
  const msg = e?.message || String(e);
  return msg
    .replace(/\b[A-Z]:\\[^\s]+/gi, '[path]')                       // Windows: C:\foo\bar
    .replace(/\\\\[^\s]+/g, '[path]')                              // UNC paths: \\server\share
    .replace(/\/(?:home|Users|root|var|tmp|opt|app|etc)\/[^\s]+/g, '[path]') // *nix
    .replace(/sessionid=[^;\s&"']+/gi, 'sessionid=[redacted]')
    .replace(/tt-target-idc=[^;\s&"']+/gi, 'tt-target-idc=[redacted]')
    .replace(/(?:bearer\s+|token=|signApiKey=|x-app-token[:=]\s*)[^\s&"']+/gi, '[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1***@')
    .replace(/(\/webhooks\/\d+\/)[^\s/?#"']+/gi, '$1[redacted]')
    .replace(/(\/bot)\d+:[^\s/?#"']+/gi, '$1[redacted]')
    .replace(/\n.*$/s, '')
    .slice(0, 200);
}

function atomicWriteFileSync(filePath, content, options = {}) {
  const { encoding = 'utf8', mode } = typeof options === 'string' ? { encoding: options } : options;
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const writeOpts = mode !== undefined ? { encoding, mode } : { encoding };
  try {
    fs.writeFileSync(tmp, content, writeOpts);
    if (mode !== undefined) {
      try { fs.chmodSync(tmp, mode); } catch { /* Windows */ }
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (e) {
      if (e?.code === 'EXDEV' || e?.code === 'EBUSY' || e?.code === 'EPERM') {
        // Fallback for Docker single-file bind mounts where rename across mounts fails
        fs.writeFileSync(filePath, content, writeOpts);
      } else {
        throw e;
      }
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function stripIpBrackets(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zoneIdx = h.indexOf('%');
  if (zoneIdx !== -1) h = h.slice(0, zoneIdx);
  return h;
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // treat malformed IP as unsafe
  }
  const [a, b, c] = parts;
  if (a === 0) return true;                                  // 0.0.0.0/8 ("this" network)
  if (a === 10) return true;                                 // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true;                                // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;                   // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true;          // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true;          // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true;                   // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true;      // 198.18.0.0/15 (benchmark)
  if (a === 198 && b === 51 && c === 100) return true;       // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true;        // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true;                                 // 224.0.0.0/4+ (multicast & reserved)
  return false;
}

function isPrivateOrReservedIp(rawIp) {
  const ip = stripIpBrackets(rawIp);
  const ver = net.isIP(ip);
  if (ver === 4) return isPrivateIpv4(ip);
  if (ver !== 6) return false;

  // Unspecified & loopback
  if (ip === '::' || ip === '::1') return true;

  // IPv4-mapped / IPv4-compatible IPv6 in dotted form (e.g. ::ffff:127.0.0.1)
  const v4MappedDotted = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedDotted) return isPrivateIpv4(v4MappedDotted[1]);

  // IPv4-mapped IPv6 in hex form (e.g. ::ffff:7f00:1)
  const v4MappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIpv4(dotted);
  }

  // Extract first hextet for prefix bitmask checks
  const firstPart = ip.split(':')[0];
  if (firstPart) {
    const h = parseInt(firstPart, 16);
    if ((h & 0xfe00) === 0xfc00) return true; // fc00::/7 (Unique Local Address)
    if ((h & 0xffc0) === 0xfe80) return true; // fe80::/10 (Link-local)
    if ((h & 0xff00) === 0xff00) return true; // ff00::/8 (Multicast)
    if (ip.startsWith('2001:db8:')) return true; // Documentation
    if (ip.startsWith('64:ff9b:')) return true;  // NAT64
    if (ip.startsWith('100::')) return true;     // Discard-only
  }

  return false;
}

function isPrivateHostname(hostname) {
  const host = stripIpBrackets(hostname);
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  if (net.isIP(host)) return isPrivateOrReservedIp(host);
  return false;
}

function isValidStreamUrl(url) {
  try {
    if (typeof url !== 'string' || url.length > 4096) return false;
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (u.username || u.password) return false;
    if (isPrivateHostname(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const ALLOWED_CDN_DOMAINS = [
  'tiktokcdn.com',          // Global (incl. SEA/JP/KR/VN edges)
  'tiktokcdn-eu.com',       // EU
  'tiktokcdn-us.com',       // Americas
  'tiktokv.com',            // API/static
  'byteoversea.com',        // International infra
  'bytefcdn-oversea.com',   // Newer overseas CDN
  'tiktokcdn-cgla.com',     // CG-line, sometimes used for Asia
  'ttvnw.net',              // Twitch Usher / Weaver HLS
  'jtvnw.net',              // Twitch static thumbnails/avatars
];

function isAllowedCdnUrl(urlStr) {
  try {
    if (typeof urlStr !== 'string' || urlStr.length > 4096) return false;
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    // Reject embedded credentials in the URL — `https://user:pass@host/...`
    if (u.username || u.password) return false;
    const host = stripIpBrackets(u.hostname);
    if (isPrivateHostname(host) || net.isIP(host)) return false;
    return ALLOWED_CDN_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * Resolve DNS for `hostname` and verify none of the resolved IPs are private/reserved.
 * Mitigates DNS rebinding SSRF attacks against allowlisted CDN domains.
 */
async function assertPublicDns(hostname) {
  const host = stripIpBrackets(hostname);
  if (isPrivateHostname(host)) {
    throw new Error('disallowed host');
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new Error('disallowed IP');
    return;
  }
  const records = await dns.lookup(host, { all: true });
  if (!records || records.length === 0) {
    throw new Error('DNS lookup returned no addresses');
  }
  for (const r of records) {
    if (isPrivateOrReservedIp(r.address)) {
      throw new Error('DNS resolved to private IP');
    }
  }
}

// Parse recording start time from filename (supports compact YYYYMMDD_HHMMSS or ISO YYYY-MM-DD_HH-MM-SS and custom templates)
function parseStartTimeFromName(name) {
  const base = path.basename(String(name || ''));
  const m = base.match(/(?:^|[_-])((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])_([01]\d|2[0-3])([0-5]\d)([0-5]\d)(?=$|[_.-])/) ||
    base.match(/(?:^|[_-])((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])_([01]\d|2[0-3])-([0-5]\d)-([0-5]\d)(?=$|[_.-])/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(s)
  );
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

const EVENTS_CACHE_MAX = 4;
const EVENTS_CACHE_TTL_MS = 60_000;
const eventsCache = new Map(); // path -> { size, mtimeMs, cachedAt, sorted, unsorted }

function getCachedEvents(eventsFile, st, sort) {
  const entry = eventsCache.get(eventsFile);
  if (!entry) return null;
  if (entry.size !== st.size || entry.mtimeMs !== st.mtimeMs || Date.now() - entry.cachedAt > EVENTS_CACHE_TTL_MS) {
    eventsCache.delete(eventsFile);
    return null;
  }
  if (sort && entry.sorted) return entry.sorted;
  if (!sort && entry.unsorted) return entry.unsorted;
  return null;
}

/**
 * Shared reader for `.events.jsonl` sidecars with a size cap to prevent OOM DoS
 * and a short-lived LRU cache so concurrent Replay panels don't re-parse the same file 4x.
 */
function readEvents(eventsFile, { sort = true, maxBytes = MAX_EVENTS_FILE_BYTES } = {}) {
  let st;
  try {
    st = fs.statSync(eventsFile);
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  if (st.size > maxBytes) {
    throw new Error(`events file exceeds safety limit (${maxBytes} bytes)`);
  }

  const cached = getCachedEvents(eventsFile, st, sort);
  if (cached) return cached;

  const out = [];
  const raw = fs.readFileSync(eventsFile, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }

  const entry = eventsCache.get(eventsFile);
  const record = (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs)
    ? entry
    : { size: st.size, mtimeMs: st.mtimeMs, cachedAt: Date.now(), sorted: null, unsorted: null };
  record.cachedAt = Date.now();
  if (sort) {
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    record.sorted = out;
  } else {
    record.unsorted = out;
  }
  if (!eventsCache.has(eventsFile) && eventsCache.size >= EVENTS_CACHE_MAX) {
    const oldestKey = eventsCache.keys().next().value;
    eventsCache.delete(oldestKey);
  }
  eventsCache.set(eventsFile, record);
  return out;
}

module.exports = {
  QUALITY_RE,
  MAX_EVENTS_FILE_BYTES,
  RESERVED_RECORDING_SUBDIRS,
  DEFAULT_FILENAME_TEMPLATE,
  timestamp,
  safeFilename,
  resolveInsideDir,
  resolveRecordingPath,
  sanitizeFilenameTemplate,
  renderRecordingFilename,
  stripControlChars,
  sanitizeQuality,
  sanitizeAudioBitrate,
  ALLOWED_AUDIO_BITRATES,
  safeError,
  atomicWriteFileSync,
  isPrivateOrReservedIp,
  isValidStreamUrl,
  isAllowedCdnUrl,
  assertPublicDns,
  parseStartTimeFromName,
  readEvents,
};
