// lib/settings.js — Persistent runtime settings for storage guard, segmenting, auto-retry, and proxy.

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

const DEFAULTS = {
  minFreeGb: Math.max(0, Number(process.env.MIN_FREE_DISK_GB) || 2),
  maxRecordingsGb: Math.max(0, Number(process.env.MAX_RECORDINGS_GB) || 0),
  retentionDays: Math.max(0, Number(process.env.RETENTION_DAYS) || 0),
  segmentMinutes: Math.max(0, Number(process.env.RECORD_SEGMENT_MINUTES) || 0),
  autoRetryRecord: process.env.DISABLE_AUTO_RETRY ? false : true,
  proxyUrl: process.env.TIKTOK_PROXY_URL || '',
};

let cached = null;

function isValidProxyUrl(raw) {
  if (!raw) return true;
  if (typeof raw !== 'string' || raw.length > 512) return false;
  try {
    const u = new URL(raw.trim());
    return ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(u.protocol) && !!u.hostname;
  } catch {
    return false;
  }
}

function maskProxyUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    return '***';
  }
}

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function loadSettings() {
  if (cached) return { ...cached };
  const out = { ...DEFAULTS };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (parsed.minFreeGb !== undefined) out.minFreeGb = clampNum(parsed.minFreeGb, 0, 1000, out.minFreeGb);
        if (parsed.maxRecordingsGb !== undefined) out.maxRecordingsGb = clampNum(parsed.maxRecordingsGb, 0, 10000, out.maxRecordingsGb);
        if (parsed.retentionDays !== undefined) out.retentionDays = clampNum(parsed.retentionDays, 0, 3650, out.retentionDays);
        if (parsed.segmentMinutes !== undefined) out.segmentMinutes = Math.floor(clampNum(parsed.segmentMinutes, 0, 1440, out.segmentMinutes));
        if (typeof parsed.autoRetryRecord === 'boolean') out.autoRetryRecord = parsed.autoRetryRecord;
        if (typeof parsed.proxyUrl === 'string' && isValidProxyUrl(parsed.proxyUrl)) {
          out.proxyUrl = parsed.proxyUrl.trim();
        }
      }
    }
  } catch (e) {
    console.warn('[settings] load error:', e.message);
  }
  cached = out;
  return { ...cached };
}

function saveSettings(next) {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
  fs.renameSync(tmp, SETTINGS_FILE);
  cached = { ...next };
}

function getSettings() {
  return loadSettings();
}

function getPublicSettings() {
  const s = loadSettings();
  return {
    minFreeGb: s.minFreeGb,
    maxRecordingsGb: s.maxRecordingsGb,
    retentionDays: s.retentionDays,
    segmentMinutes: s.segmentMinutes,
    autoRetryRecord: s.autoRetryRecord,
    hasProxy: !!s.proxyUrl,
    proxyPreview: maskProxyUrl(s.proxyUrl),
  };
}

function updateSettings(patch) {
  const cur = loadSettings();
  const next = { ...cur };
  if (patch.minFreeGb !== undefined) next.minFreeGb = clampNum(patch.minFreeGb, 0, 1000, cur.minFreeGb);
  if (patch.maxRecordingsGb !== undefined) next.maxRecordingsGb = clampNum(patch.maxRecordingsGb, 0, 10000, cur.maxRecordingsGb);
  if (patch.retentionDays !== undefined) next.retentionDays = clampNum(patch.retentionDays, 0, 3650, cur.retentionDays);
  if (patch.segmentMinutes !== undefined) next.segmentMinutes = Math.floor(clampNum(patch.segmentMinutes, 0, 1440, cur.segmentMinutes));
  if (typeof patch.autoRetryRecord === 'boolean') next.autoRetryRecord = patch.autoRetryRecord;
  if (patch.proxyUrl !== undefined) {
    const p = typeof patch.proxyUrl === 'string' ? patch.proxyUrl.trim() : '';
    if (!isValidProxyUrl(p)) {
      throw new Error('invalid proxy URL (must be http://, https://, socks4://, or socks5://)');
    }
    next.proxyUrl = p;
  }
  saveSettings(next);
  return getPublicSettings();
}

module.exports = {
  isValidProxyUrl,
  maskProxyUrl,
  getSettings,
  getPublicSettings,
  updateSettings,
};
