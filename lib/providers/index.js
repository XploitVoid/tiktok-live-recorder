// lib/providers/index.js — Multi-platform provider registry & channel parser.

const path = require('path');
const tiktok = require('./tiktok');
const twitch = require('./twitch');
const youtube = require('./youtube');
const kick = require('./kick');
const soop = require('./soop');

const PROVIDERS = {
  tiktok,
  twitch,
  youtube,
  kick,
  soop,
};

const SUPPORTED_PLATFORMS = Object.keys(PROVIDERS);
const DEFAULT_PLATFORM = 'tiktok';
const PLATFORM_PREFIX_RE = /^(twitch|youtube|kick|soop)_/i;

function normalizePlatform(raw, fallback = DEFAULT_PLATFORM) {
  if (typeof raw !== 'string') return fallback;
  const p = raw.trim().toLowerCase();
  if (p === 'yt') return 'youtube';
  if (p === 'sooplive' || p === 'afreeca' || p === 'afreecatv') return 'soop';
  return Object.prototype.hasOwnProperty.call(PROVIDERS, p) ? p : fallback;
}

function getProvider(platform) {
  return PROVIDERS[normalizePlatform(platform)] || PROVIDERS[DEFAULT_PLATFORM];
}

function parseChannelInput(raw, explicitPlatform = null) {
  if (typeof raw !== 'string') {
    return { platform: normalizePlatform(explicitPlatform), username: '' };
  }
  const s = raw.trim();
  if (!s) {
    return { platform: normalizePlatform(explicitPlatform), username: '' };
  }

  const prefM = s.match(/^(tiktok|twitch|youtube|yt|kick|soop|sooplive|afreeca|afreecatv):(.+)$/i);
  if (prefM) {
    const platform = normalizePlatform(prefM[1]);
    return { platform, username: getProvider(platform).normalizeUsername(prefM[2]) };
  }

  if (/^https?:\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) {
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const h = u.hostname.toLowerCase();
      if (h === 'twitch.tv' || h.endsWith('.twitch.tv')) {
        return { platform: 'twitch', username: twitch.normalizeUsername(u.toString()) };
      }
      if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') {
        return { platform: 'youtube', username: youtube.normalizeUsername(u.toString()) };
      }
      if (h === 'kick.com' || h.endsWith('.kick.com')) {
        return { platform: 'kick', username: kick.normalizeUsername(u.toString()) };
      }
      if (
        h === 'sooplive.com' || h.endsWith('.sooplive.com') ||
        h === 'sooplive.co.kr' || h.endsWith('.sooplive.co.kr') ||
        h === 'afreecatv.com' || h.endsWith('.afreecatv.com') ||
        h === 'afreeca.tv' || h.endsWith('.afreeca.tv')
      ) {
        return { platform: 'soop', username: soop.normalizeUsername(u.toString()) };
      }
      if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) {
        return { platform: 'tiktok', username: tiktok.normalizeUsername(u.toString()) };
      }
    } catch {}
  }

  const platform = normalizePlatform(explicitPlatform);
  return { platform, username: getProvider(platform).normalizeUsername(s) };
}

function sessionKey(platform, username) {
  const p = normalizePlatform(platform);
  const u = String(username || '');
  return p === 'tiktok' ? u : `${p}:${u}`;
}

function derivePlatformFromFilename(relName, meta, folder) {
  if (typeof meta?.platform === 'string' && meta.platform) {
    const norm = normalizePlatform(meta.platform, null);
    if (norm) return norm;
  }
  const target = folder || path.basename(String(relName || ''));
  const m = target.match(PLATFORM_PREFIX_RE);
  if (m) return m[1].toLowerCase();
  return 'tiktok';
}

function stripPlatformPrefix(name) {
  return String(name || '').replace(PLATFORM_PREFIX_RE, '');
}

function invalidateAllProviderCaches(username) {
  for (const p of Object.values(PROVIDERS)) {
    try { p.invalidateCache?.(username); } catch {}
  }
}

module.exports = {
  SUPPORTED_PLATFORMS,
  DEFAULT_PLATFORM,
  PLATFORM_PREFIX_RE,
  normalizePlatform,
  getProvider,
  parseChannelInput,
  sessionKey,
  derivePlatformFromFilename,
  stripPlatformPrefix,
  invalidateAllProviderCaches,
};
