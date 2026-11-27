// lib/stealth.js — Unified Stealth & Anonymous enforcement across all 5 platforms.
// Provides persistent global + per-platform stealth toggles, rotating desktop
// User-Agents, identity-header stripping, and yt-dlp anonymous flags.

const settings = require('./settings');

const ALL_PLATFORMS = [...settings.STEALTH_PLATFORMS_LIST];

const STEALTH_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

const DEFAULT_DESKTOP_UA = STEALTH_USER_AGENTS[0];

const IDENTITY_HEADER_NAMES = new Set([
  'cookie',
  'authorization',
  'x-csrf-token',
  'x-csrftoken',
  'x-goog-visitor-id',
]);

function normalizePlatform(raw) {
  const p = String(raw || 'tiktok').trim().toLowerCase();
  if (p === 'yt') return 'youtube';
  if (p === 'sooplive' || p === 'afreeca' || p === 'afreecatv') return 'soop';
  return ALL_PLATFORMS.includes(p) ? p : 'tiktok';
}

const initialSettings = settings.getSettings();
let stealthMode = Boolean(initialSettings.stealthMode);
let stealthPlatforms = settings.normalizeStealthPlatforms(initialSettings.stealthPlatforms);
let uaCursor = 0;

function syncFromSettings(s = settings.getSettings()) {
  stealthMode = Boolean(s?.stealthMode);
  stealthPlatforms = settings.normalizeStealthPlatforms(s?.stealthPlatforms);
}

function getStealthMode() {
  return stealthMode;
}

function getStealthPlatforms() {
  return { ...stealthPlatforms };
}

function setStealthMode(enabled, { persist = false } = {}) {
  stealthMode = Boolean(enabled);
  if (persist) {
    settings.updateSettings({ stealthMode });
  }
  return stealthMode;
}

function setPlatformStealth(platform, enabled, { persist = false } = {}) {
  const norm = normalizePlatform(platform);
  stealthPlatforms = {
    ...stealthPlatforms,
    [norm]: Boolean(enabled),
  };
  if (persist) {
    settings.updateSettings({ stealthPlatforms });
  }
  return getStealthPlatforms();
}

function setStealthPlatforms(map, { persist = false } = {}) {
  const src = map && typeof map === 'object' ? map : {};
  const merged = { ...stealthPlatforms };
  for (const [k, v] of Object.entries(src)) {
    const raw = String(k || '').trim().toLowerCase();
    if (!['tiktok', 'twitch', 'youtube', 'yt', 'kick', 'soop', 'sooplive', 'afreeca', 'afreecatv'].includes(raw)) {
      continue;
    }
    merged[normalizePlatform(raw)] = Boolean(v);
  }
  stealthPlatforms = settings.normalizeStealthPlatforms(merged);
  if (persist) {
    settings.updateSettings({ stealthPlatforms });
  }
  return getStealthPlatforms();
}

function isPlatformStealth(platform) {
  const norm = normalizePlatform(platform);
  return Boolean(stealthMode || stealthPlatforms[norm]);
}

function shouldUseAnonymous(platform, { accountId = null, forceAnon = false } = {}) {
  return Boolean(forceAnon || accountId === 'anon' || isPlatformStealth(platform));
}

function getStealthUserAgent(isStealthOrAnon = true) {
  if (!isStealthOrAnon) return DEFAULT_DESKTOP_UA;
  const ua = STEALTH_USER_AGENTS[uaCursor % STEALTH_USER_AGENTS.length];
  uaCursor = (uaCursor + 1) % STEALTH_USER_AGENTS.length;
  return ua;
}

function stripIdentityHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    if (IDENTITY_HEADER_NAMES.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function getStealthYtDlpArgs(isAnon = true) {
  if (!isAnon) return [];
  return ['--no-cookies', '--user-agent', getStealthUserAgent(true)];
}

module.exports = {
  ALL_PLATFORMS,
  DEFAULT_DESKTOP_UA,
  STEALTH_USER_AGENTS,
  normalizePlatform,
  getStealthMode,
  getStealthPlatforms,
  setStealthMode,
  setPlatformStealth,
  setStealthPlatforms,
  isPlatformStealth,
  shouldUseAnonymous,
  getStealthUserAgent,
  stripIdentityHeaders,
  getStealthYtDlpArgs,
  syncFromSettings,
};
