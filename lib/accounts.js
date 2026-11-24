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
const path = require('path');
const { atomicWriteFileSync } = require('./utils');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'accounts.json');
const KEY_FILE = path.join(__dirname, '..', '.accounts.key');
const ENC_PREFIX = 'enc:v1:';

/** @typedef {{ id: string, label: string, sessionId: string, ttTargetIdc: string }} Account */

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

// Current active credentials. Initialized from process.env at module load
// (i.e. from .env via dotenv in server.js). After startup, only switchTo()
// mutates this state.
let active = {
  id: null,  // null = anonymous or loaded-from-env (no saved account)
  sessionId: process.env.TIKTOK_SESSIONID || '',
  ttTargetIdc: process.env.TIKTOK_TT_TARGET_IDC || '',
};

/** Returns a snapshot of the active credentials. Callers should snapshot
 *  this value synchronously at the top of any async operation to avoid
 *  reading stale credentials after a concurrent switchTo(). */
function getActiveCredentials() {
  return { ...active };
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

function add(label, sessionId, ttTargetIdc) {
  const list = loadRawAccounts();
  const id = crypto.randomBytes(8).toString('hex');
  const account = {
    id,
    label: label || 'Account ' + (list.length + 1),
    sessionId,
    ttTargetIdc: ttTargetIdc || '',
  };
  list.push(account);
  saveAccounts(list);
  return account;
}

function remove(id) {
  let list = loadRawAccounts();
  list = list.filter((a) => a.id !== id);
  saveAccounts(list);
  if (active.id === id) {
    switchTo(null);
  }
}

function switchTo(id) {
  if (!id) {
    active = { id: null, sessionId: '', ttTargetIdc: '' };
    console.log('[accounts] switched to anonymous (no session)');
    return { sessionId: '', ttTargetIdc: '' };
  }
  const list = loadAccounts();
  const account = list.find((a) => a.id === id);
  if (!account) throw new Error('Account not found: ' + id);
  if (!account.sessionId) throw new Error('Account credentials unavailable (check ACCOUNTS_SECRET / .accounts.key)');
  active = {
    id: account.id,
    sessionId: account.sessionId,
    ttTargetIdc: account.ttTargetIdc || '',
  };
  console.log(`[accounts] switched to "${account.label}"`);
  return { sessionId: account.sessionId, ttTargetIdc: account.ttTargetIdc };
}

module.exports = { getAll, getActive, getActiveCredentials, getCredentialsById, add, remove, switchTo };
