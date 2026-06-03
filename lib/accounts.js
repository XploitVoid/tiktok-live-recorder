// lib/accounts.js — Manage multiple TikTok session accounts.
//
// Owns the single source of truth for the *active* TikTok credentials at
// runtime. Other modules (room.js, chat.js) must call getActiveCredentials()
// instead of reading process.env directly — this keeps account switches
// localized and avoids cross-request leakage via mutable global env vars.

const fs = require('fs');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'accounts.json');

/** @typedef {{ id: string, label: string, sessionId: string, ttTargetIdc: string }} Account */

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

/** @returns {Account[]} */
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[accounts] load error:', e.message);
  }
  return [];
}

/** @param {Account[]} list */
function saveAccounts(list) {
  // Atomic write: write to temp file, then rename. Prevents corruption if
  // the process is killed mid-write. The file contains the user's TikTok
  // sessionId (a long-lived bearer cookie) so we tighten its permissions to
  // owner-only on Unix-like systems. Windows ACLs aren't covered here —
  // .gitignore prevents accidental commit, which is the realistic threat.
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  try { fs.chmodSync(tmp, 0o600); } catch { /* not supported on Windows; ignore */ }
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

function getAll() {
  return loadAccounts();
}

function getActive() {
  return { sessionId: active.sessionId, ttTargetIdc: active.ttTargetIdc, id: active.id };
}

function add(label, sessionId, ttTargetIdc) {
  const list = loadAccounts();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const account = { id, label: label || 'Account ' + (list.length + 1), sessionId, ttTargetIdc: ttTargetIdc || '' };
  list.push(account);
  saveAccounts(list);
  return account;
}

function remove(id) {
  let list = loadAccounts();
  list = list.filter((a) => a.id !== id);
  saveAccounts(list);
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
  active = {
    id: account.id,
    sessionId: account.sessionId,
    ttTargetIdc: account.ttTargetIdc || '',
  };
  console.log(`[accounts] switched to "${account.label}"`);
  return { sessionId: account.sessionId, ttTargetIdc: account.ttTargetIdc };
}

module.exports = { getAll, getActive, getActiveCredentials, add, remove, switchTo };
