// lib/accounts.js — Manage multiple TikTok session accounts.
//
// Owns the single source of truth for the *active* TikTok credentials at
// runtime. Other modules (room.js, chat.js) must call getActiveCredentials()
// instead of reading process.env directly — this keeps account switches
// localized and avoids cross-request leakage via mutable global env vars.
//
// Stored session cookies in accounts.json are encrypted at rest with
// AES-256-GCM using ACCOUNTS_SECRET (if set) or an owner-only .accounts.key
// file. Legacy plaintext accounts.json files are read transparently and
// upgraded to encrypted storage on the next write.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { atomicWriteFileSync, safeError, stripControlChars } = require('./utils');
const { getProxyAgent } = require('./proxy-config');
const { notifyEvent } = require('./notifications');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'accounts.json');
const KEY_FILE = path.join(__dirname, '..', '.accounts.key');
const ENC_PREFIX = 'enc:v1:';

/** @typedef {{ id: string, label: string, platform: string, sessionId: string, ttTargetIdc: string }} Account */

const ACCOUNT_PLATFORMS = new Set(['tiktok', 'twitch', 'youtube', 'kick']);

function normalizeAccountPlatform(raw) {
  const p = String(raw || 'tiktok').trim().toLowerCase();
  return ACCOUNT_PLATFORMS.has(p) ? p : 'tiktok';
}

let cachedKeySecret = null;
let cachedKey = null;

function getEncryptionKey() {
  const secret = process.env.ACCOUNTS_SECRET || '';
  if (secret) {
    if (cachedKey && cachedKeySecret === secret) return cachedKey;
    cachedKey = crypto.scryptSync(secret, 'tiktok-live-recorder-accounts-v1', 32);
    cachedKeySecret = secret;
    return cachedKey;
  }

  try {
    if (fs.existsSync(KEY_FILE)) {
      const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        return Buffer.from(hex, 'hex');
      }
      // Do NOT overwrite an existing invalid/unreadable keyfile — preserve it for recovery.
      console.error('[accounts] existing .accounts.key is invalid; refusing to overwrite it');
      return null;
    }
    const key = crypto.randomBytes(32);
    atomicWriteFileSync(KEY_FILE, key.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 });
    return key;
  } catch (e) {
    console.warn('[accounts] keyfile unavailable, credentials will not be encrypted at rest:', e.message);
    return null;
  }
}

function encryptField(plaintext) {
  if (!plaintext) return '';
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptField(value) {
  if (typeof value !== 'string' || !value) return '';
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext compatibility
  const key = getEncryptionKey();
  if (!key) return '';
  try {
    const parts = value.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) return '';
    const [ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    console.warn('[accounts] failed to decrypt credential:', e.message);
    return '';
  }
}

function getPlatformEnvFallback(platform) {
  if (platform === 'twitch') return process.env.TWITCH_OAUTH_TOKEN || '';
  if (platform === 'youtube') return process.env.YOUTUBE_COOKIE || '';
  if (platform === 'kick') return process.env.KICK_TOKEN || '';
  return '';
}

// Current active credentials. Initialized from process.env at module load
// (i.e. from .env via dotenv in server.js). After startup, only switchTo()
// mutates this state.
let active = {
  id: null,  // null = anonymous or loaded-from-env (no saved account)
  sessionId: process.env.TIKTOK_SESSIONID || '',
  ttTargetIdc: process.env.TIKTOK_TT_TARGET_IDC || '',
};

const activeByPlatform = {
  twitch: { id: null, token: getPlatformEnvFallback('twitch') },
  youtube: { id: null, token: getPlatformEnvFallback('youtube') },
  kick: { id: null, token: getPlatformEnvFallback('kick') },
};

/** Returns a snapshot of the active TikTok credentials. Callers should snapshot
 *  this value synchronously at the top of any async operation to avoid
 *  reading stale credentials after a concurrent switchTo(). */
function getActiveCredentials() {
  return { ...active };
}

function getActivePlatformCredential(platform) {
  const p = normalizeAccountPlatform(platform);
  if (p === 'tiktok') return active.sessionId || '';
  return activeByPlatform[p]?.token || getPlatformEnvFallback(p);
}

function getActiveByPlatform() {
  return {
    tiktok: active.id || null,
    twitch: activeByPlatform.twitch.id || null,
    youtube: activeByPlatform.youtube.id || null,
    kick: activeByPlatform.kick.id || null,
  };
}

function getCredentialsById(accountId) {
  if (!accountId) return getActiveCredentials();
  if (accountId === 'anon') return { id: 'anon', sessionId: '', ttTargetIdc: '' };
  const list = loadAccounts();
  const found = list.find((a) => a.id === accountId);
  if (!found || !found.sessionId) return getActiveCredentials();
  return {
    id: found.id,
    sessionId: found.sessionId,
    ttTargetIdc: found.ttTargetIdc || '',
  };
}

/** Reads raw account records without decrypting; throws if an existing file is corrupt. */
function loadRawAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('accounts.json is not a JSON array');
  }
  return parsed.map((a) => ({
    id: String(a.id || ''),
    label: String(a.label || ''),
    platform: normalizeAccountPlatform(a.platform),
    sessionId: typeof a.sessionId === 'string' ? a.sessionId : '',
    ttTargetIdc: typeof a.ttTargetIdc === 'string' ? a.ttTargetIdc : '',
  }));
}

/** @returns {Account[]} */
function loadAccounts() {
  try {
    return loadRawAccounts().map((a) => ({
      id: a.id,
      label: a.label,
      platform: normalizeAccountPlatform(a.platform),
      sessionId: decryptField(a.sessionId),
      ttTargetIdc: decryptField(a.ttTargetIdc),
    }));
  } catch (e) {
    console.error('[accounts] load error:', e.message);
  }
  return [];
}

/** @param {Account[]} list */
function saveAccounts(list) {
  // Atomic write: write to temp file with 0600 permissions, then rename.
  // Preserve already-encrypted values (`enc:v1:...`) untouched so unrelated
  // accounts are never wiped if decryption failed temporarily.
  const serialized = list.map((a) => ({
    id: a.id,
    label: a.label,
    platform: normalizeAccountPlatform(a.platform),
    sessionId: encryptField(a.sessionId),
    ttTargetIdc: encryptField(a.ttTargetIdc || ''),
  }));
  atomicWriteFileSync(ACCOUNTS_FILE, JSON.stringify(serialized, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function getAll() {
  return loadAccounts();
}

function getActive() {
  return { sessionId: active.sessionId, ttTargetIdc: active.ttTargetIdc, id: active.id };
}

function add(label, sessionId, ttTargetIdc, platform = 'tiktok') {
  const list = loadRawAccounts();
  const id = crypto.randomBytes(8).toString('hex');
  const normPlat = normalizeAccountPlatform(platform);
  const account = {
    id,
    label: label || 'Account ' + (list.length + 1),
    platform: normPlat,
    sessionId,
    ttTargetIdc: normPlat === 'tiktok' ? (ttTargetIdc || '') : '',
  };
  list.push(account);
  saveAccounts(list);
  return account;
}

const healthMap = new Map(); // id -> { status, checkedAt, username, reason }
const COOKIE_CHECK_TIMEOUT_MS = 10_000;
const COOKIE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function remove(id) {
  let list = loadRawAccounts();
  const target = list.find((a) => a.id === id);
  list = list.filter((a) => a.id !== id);
  saveAccounts(list);
  healthMap.delete(id);
  if (active.id === id) {
    switchTo(null, 'tiktok');
  }
  if (target && target.platform !== 'tiktok' && activeByPlatform[target.platform]?.id === id) {
    switchTo(null, target.platform);
  }
}

function switchTo(id, platform = null) {
  if (!id) {
    const p = platform ? normalizeAccountPlatform(platform) : null;
    if (!p || p === 'tiktok') {
      active = { id: null, sessionId: '', ttTargetIdc: '' };
    }
    if (!p) {
      for (const k of Object.keys(activeByPlatform)) {
        activeByPlatform[k] = { id: null, token: getPlatformEnvFallback(k) };
      }
      console.log('[accounts] switched to anonymous (no session)');
    } else if (p !== 'tiktok') {
      activeByPlatform[p] = { id: null, token: getPlatformEnvFallback(p) };
      console.log(`[accounts] cleared active ${p} credential`);
    } else {
      console.log('[accounts] switched to anonymous (no session)');
    }
    return { sessionId: active.sessionId, ttTargetIdc: active.ttTargetIdc, platform: p || 'tiktok' };
  }
  const list = loadAccounts();
  const account = list.find((a) => a.id === id);
  if (!account) throw new Error('Account not found: ' + id);
  if (!account.sessionId) throw new Error('Account credentials unavailable (check ACCOUNTS_SECRET / .accounts.key)');
  const plat = normalizeAccountPlatform(account.platform);
  if (plat === 'tiktok') {
    active = {
      id: account.id,
      sessionId: account.sessionId,
      ttTargetIdc: account.ttTargetIdc || '',
    };
  } else {
    activeByPlatform[plat] = {
      id: account.id,
      token: account.sessionId,
    };
  }
  console.log(`[accounts] switched ${plat} to "${account.label}"`);
  return { sessionId: account.sessionId, ttTargetIdc: account.ttTargetIdc || '', platform: plat };
}

function defaultCookieRequest(cookieHeader) {
  return new Promise((resolve, reject) => {
    const agent = getProxyAgent();
    const req = https.request(
      'https://www.tiktok.com/passport/web/account/info/',
      {
        method: 'GET',
        agent: agent || undefined,
        timeout: COOKIE_CHECK_TIMEOUT_MS,
        headers: {
          Cookie: cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 64 * 1024) {
            body += chunk.slice(0, 64 * 1024 - body.length);
          }
        });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('cookie check timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function validateCookie({ sessionId, ttTargetIdc } = {}, { requestImpl } = {}) {
  const checkedAt = Date.now();
  if (!sessionId || typeof sessionId !== 'string') {
    return { status: 'expired', checkedAt, username: null, reason: 'Missing sessionId' };
  }
  const cookieParts = [`sessionid=${sessionId}`];
  if (ttTargetIdc) cookieParts.push(`tt-target-idc=${ttTargetIdc}`);
  const requester = typeof requestImpl === 'function' ? requestImpl : defaultCookieRequest;

  try {
    const res = await requester(cookieParts.join('; '));
    const statusCode = Number(res?.statusCode || 0);
    if (statusCode >= 500 || statusCode === 429) {
      return { status: 'unknown', checkedAt, username: null, reason: `HTTP ${statusCode}` };
    }
    let json = null;
    try { json = JSON.parse(String(res?.body || '')); } catch {}
    if (!json || typeof json !== 'object') {
      return { status: 'unknown', checkedAt, username: null, reason: 'Unable to verify' };
    }

    const d = json.data && typeof json.data === 'object' ? json.data : {};
    if (
      json.message === 'success' &&
      (d.user_id_str || d.user_id || d.username || d.screen_name)
    ) {
      const uname = d.username || d.screen_name || '';
      return {
        status: 'valid',
        checkedAt,
        username: uname ? stripControlChars(String(uname), 64) : null,
        reason: null,
      };
    }

    const errCode = Number(d.error_code);
    const desc = String(d.description || json.message || '');
    if (
      json.message === 'error' ||
      [8, 10008, 10009, 10010, 10011].includes(errCode) ||
      /login|expired|session/i.test(desc)
    ) {
      return {
        status: 'expired',
        checkedAt,
        username: null,
        reason: stripControlChars(d.description || 'Session expired', 100) || 'Session expired',
      };
    }

    return { status: 'unknown', checkedAt, username: null, reason: 'Unable to verify' };
  } catch (e) {
    return {
      status: 'unknown',
      checkedAt,
      username: null,
      reason: safeError(e) || 'Unable to verify',
    };
  }
}

function getAccountHealth(id) {
  return healthMap.get(id) || null;
}

async function checkAccountHealth(id, opts = {}) {
  const acc = loadAccounts().find((a) => a.id === id);
  if (!acc) return null;
  if (normalizeAccountPlatform(acc.platform) !== 'tiktok') {
    const health = {
      status: 'unknown',
      checkedAt: Date.now(),
      username: null,
      reason: 'Token saved (auto-check for TikTok only)',
    };
    healthMap.set(id, health);
    return health;
  }
  const prev = healthMap.get(id);
  const health = await validateCookie(
    { sessionId: acc.sessionId, ttTargetIdc: acc.ttTargetIdc },
    opts,
  );
  healthMap.set(id, health);
  if (health.status === 'expired' && prev?.status !== 'expired') {
    notifyEvent('cookie_expired', { label: acc.label, reason: health.reason }).catch(() => {});
  }
  return health;
}

async function checkAllAccountsHealth(opts = {}) {
  const list = loadAccounts();
  const results = {};
  for (const acc of list) {
    results[acc.id] = await checkAccountHealth(acc.id, opts);
  }
  return results;
}

if (process.env.QUIET_LOGS !== '1' && process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const list = loadAccounts();
    if (list.length === 0) return;
    checkAllAccountsHealth().catch(() => {});
  }, COOKIE_CHECK_INTERVAL_MS).unref();
}

module.exports = {
  ACCOUNT_PLATFORMS,
  normalizeAccountPlatform,
  getAll,
  getActive,
  getActiveByPlatform,
  getActiveCredentials,
  getActivePlatformCredential,
  getCredentialsById,
  add,
  remove,
  switchTo,
  getAccountHealth,
  validateCookie,
  checkAccountHealth,
  checkAllAccountsHealth,
};
