// lib/providers/index.js — Multi-platform provider registry & channel parser.

const path = require('path');
const tiktok = require('./tiktok');
const twitch = require('./twitch');
const youtube = require('./youtube');
const kick = require('./kick');

const PROVIDERS = {
  tiktok,
  twitch,
  youtube,
  kick,
};

const SUPPORTED_PLATFORMS = Object.keys(PROVIDERS);
const DEFAULT_PLATFORM = 'tiktok';
const PLATFORM_PREFIX_RE = /^(twitch|youtube|kick)_/i;

function normalizePlatform(raw, fallback = DEFAULT_PLATFORM) {
  if (typeof raw !== 'string') return fallback;
  const p = raw.trim().toLowerCase();
  if (p === 'yt') return 'youtube';
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

  const prefM = s.match(/^(tiktok|twitch|youtube|yt|kick):(.+)$/i);
  if (prefM) {
    const platform = normalizePlatform(prefM[1]);
    return { platform, username: getProvider(platform).normalizeUsername(prefM[2]) };
  }

  if (/twitch\.tv\//i.test(s)) {
    return { platform: 'twitch', username: twitch.normalizeUsername(s) };
  }
  if (/(?:youtube\.com|youtu\.be)\//i.test(s)) {
    return { platform: 'youtube', username: youtube.normalizeUsername(s) };
  }
  if (/kick\.com\//i.test(s)) {
    return { platform: 'kick', username: kick.normalizeUsername(s) };
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

function derivePlatformFromFilename(relName, meta, folder) {
  if (typeof meta?.platform === 'string' && meta.platform) return meta.platform;
  const target = folder || path.basename(String(relName || ''));
  const m = target.match(PLATFORM_PREFIX_RE);
  if (m) return m[1].toLowerCase();
  return 'tiktok';
}

function stripPlatformPrefix(name) {
  return String(name || '').replace(PLATFORM_PREFIX_RE, '');
}

module.exports = {
  SUPPORTED_PLATFORMS,
  DEFAULT_PLATFORM,
  normalizePlatform,
  getProvider,
  parseChannelInput,
  sessionKey,
  derivePlatformFromFilename,
  stripPlatformPrefix,
};
