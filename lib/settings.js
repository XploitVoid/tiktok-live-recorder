// lib/settings.js — Persistent runtime settings for storage guard, segmenting, auto-retry, and proxy.

const fs = require('fs');
const path = require('path');
const { sanitizeAudioBitrate } = require('./utils');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

const DEFAULTS = {
  minFreeGb: Math.max(0, Number(process.env.MIN_FREE_DISK_GB) || 2),
  maxRecordingsGb: Math.max(0, Number(process.env.MAX_RECORDINGS_GB) || 0),
  retentionDays: Math.max(0, Number(process.env.RETENTION_DAYS) || 0),
  segmentMinutes: Math.max(0, Number(process.env.RECORD_SEGMENT_MINUTES) || 0),
  autoRetryRecord: process.env.DISABLE_AUTO_RETRY ? false : true,
  stalledTimeoutSec: Math.max(0, Number(process.env.STALLED_TIMEOUT_SEC) || 25),
  defaultAudioBitrate: sanitizeAudioBitrate(process.env.DEFAULT_AUDIO_BITRATE, null),
  proxyUrl: process.env.TIKTOK_PROXY_URL || '',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
};

let cached = null;

const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
]);

function isValidDiscordWebhookUrl(raw) {
  if (!raw) return true;
  if (typeof raw !== 'string' || raw.length > 512) return false;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && DISCORD_WEBHOOK_HOSTS.has(u.hostname.toLowerCase()) && /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(u.pathname);
  } catch {
    return false;
  }
}

function isValidTelegramBotToken(raw) {
  if (!raw) return true;
  if (typeof raw !== 'string' || raw.length > 128) return false;
  return /^\d{5,16}:[A-Za-z0-9_-]{20,64}$/.test(raw.trim());
}

function isValidTelegramChatId(raw) {
  if (!raw) return true;
  if (typeof raw !== 'string' || raw.length > 64) return false;
  return /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(raw.trim());
}

function maskSecret(raw, keepStart = 4, keepEnd = 4) {
  if (!raw) return '';
  if (raw.length <= keepStart + keepEnd) return '***';
  return `${raw.slice(0, keepStart)}***${raw.slice(-keepEnd)}`;
}

function maskDiscordWebhook(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/');
    const last = parts[parts.length - 1] || '';
    parts[parts.length - 1] = maskSecret(last, 4, 4);
    u.pathname = parts.join('/');
    return u.toString();
  } catch {
    return '***';
  }
}

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
        if (parsed.stalledTimeoutSec !== undefined) out.stalledTimeoutSec = Math.floor(clampNum(parsed.stalledTimeoutSec, 0, 600, out.stalledTimeoutSec));
        if (parsed.defaultAudioBitrate !== undefined) out.defaultAudioBitrate = sanitizeAudioBitrate(parsed.defaultAudioBitrate, null);
        if (typeof parsed.proxyUrl === 'string' && isValidProxyUrl(parsed.proxyUrl)) {
          out.proxyUrl = parsed.proxyUrl.trim();
        }
        if (typeof parsed.discordWebhookUrl === 'string' && isValidDiscordWebhookUrl(parsed.discordWebhookUrl)) {
          out.discordWebhookUrl = parsed.discordWebhookUrl.trim();
        }
        if (typeof parsed.telegramBotToken === 'string' && isValidTelegramBotToken(parsed.telegramBotToken)) {
          out.telegramBotToken = parsed.telegramBotToken.trim();
        }
        if (typeof parsed.telegramChatId === 'string' && isValidTelegramChatId(parsed.telegramChatId)) {
          out.telegramChatId = parsed.telegramChatId.trim();
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
    stalledTimeoutSec: s.stalledTimeoutSec,
    defaultAudioBitrate: s.defaultAudioBitrate,
    hasProxy: !!s.proxyUrl,
    proxyPreview: maskProxyUrl(s.proxyUrl),
    hasDiscordWebhook: !!s.discordWebhookUrl,
    discordWebhookPreview: maskDiscordWebhook(s.discordWebhookUrl),
    hasTelegram: !!(s.telegramBotToken && s.telegramChatId),
    telegramBotPreview: maskSecret(s.telegramBotToken, 6, 4),
    telegramChatId: s.telegramChatId || '',
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
  if (patch.stalledTimeoutSec !== undefined) next.stalledTimeoutSec = Math.floor(clampNum(patch.stalledTimeoutSec, 0, 600, cur.stalledTimeoutSec));
  if (patch.defaultAudioBitrate !== undefined) {
    if (patch.defaultAudioBitrate && !sanitizeAudioBitrate(patch.defaultAudioBitrate, null)) {
      throw new Error('invalid audio bitrate (allowed: 64k, 96k, 128k, 192k, or empty)');
    }
    next.defaultAudioBitrate = sanitizeAudioBitrate(patch.defaultAudioBitrate, null);
  }
  if (patch.proxyUrl !== undefined) {
    const p = typeof patch.proxyUrl === 'string' ? patch.proxyUrl.trim() : '';
    if (!isValidProxyUrl(p)) {
      throw new Error('invalid proxy URL (must be http://, https://, socks4://, or socks5://)');
    }
    next.proxyUrl = p;
  }
  if (patch.discordWebhookUrl !== undefined) {
    const d = typeof patch.discordWebhookUrl === 'string' ? patch.discordWebhookUrl.trim() : '';
    if (!isValidDiscordWebhookUrl(d)) {
      throw new Error('invalid Discord webhook URL (must be https://discord.com/api/webhooks/...)');
    }
    next.discordWebhookUrl = d;
  }
  if (patch.telegramBotToken !== undefined) {
    const tok = typeof patch.telegramBotToken === 'string' ? patch.telegramBotToken.trim() : '';
    if (!isValidTelegramBotToken(tok)) {
      throw new Error('invalid Telegram bot token');
    }
    next.telegramBotToken = tok;
  }
  if (patch.telegramChatId !== undefined) {
    const cid = typeof patch.telegramChatId === 'string' ? patch.telegramChatId.trim() : '';
    if (!isValidTelegramChatId(cid)) {
      throw new Error('invalid Telegram chat ID');
    }
    next.telegramChatId = cid;
  }
  saveSettings(next);
  return getPublicSettings();
}

module.exports = {
  isValidProxyUrl,
  maskProxyUrl,
  isValidDiscordWebhookUrl,
  isValidTelegramBotToken,
  isValidTelegramChatId,
  getSettings,
  getPublicSettings,
  updateSettings,
};
