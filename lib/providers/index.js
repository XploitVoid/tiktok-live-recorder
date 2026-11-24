// lib/providers/index.js — Multi-platform provider registry & channel parser.

const tiktok = require('./tiktok');
const twitch = require('./twitch');

const PROVIDERS = {
  tiktok,
  twitch,
};

const SUPPORTED_PLATFORMS = Object.keys(PROVIDERS);
const DEFAULT_PLATFORM = 'tiktok';

function normalizePlatform(raw, fallback = DEFAULT_PLATFORM) {
  if (typeof raw !== 'string') return fallback;
  const p = raw.trim().toLowerCase();
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

  const prefM = s.match(/^(tiktok|twitch):(.+)$/i);
  if (prefM) {
    const platform = normalizePlatform(prefM[1]);
    return { platform, username: getProvider(platform).normalizeUsername(prefM[2]) };
  }

  if (/twitch\.tv\//i.test(s)) {
    return { platform: 'twitch', username: twitch.normalizeUsername(s) };
  }
  if (/tiktok\.com\//i.test(s)) {
    return { platform: 'tiktok', username: tiktok.normalizeUsername(s) };
  }

  const platform = normalizePlatform(explicitPlatform);
  return { platform, username: getProvider(platform).normalizeUsername(s) };
}

function sessionKey(platform, username) {
  const p = normalizePlatform(platform);
  const u = String(username || '');
  return p === 'tiktok' ? u : `${p}:${u}`;
}

module.exports = {
  SUPPORTED_PLATFORMS,
  DEFAULT_PLATFORM,
  normalizePlatform,
  getProvider,
  parseChannelInput,
  sessionKey,
};
