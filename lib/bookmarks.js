// lib/bookmarks.js — Per-recording bookmark management.
// Bookmarks are stored in <recording>.bookmarks.json sidecar files.
// Also provides full-text search across all recordings' chat events.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MAX_EVENTS_FILE_BYTES, assertPathInsideRealDir, resolveRecordingPath, stripControlChars, atomicWriteFileSync, readEvents } = require('./utils');
const { RECORDINGS_DIR, listRecordingFiles } = require('./storage');
const db = require('./db');

const MAX_BOOKMARKS_PER_RECORDING = 500;
const FALLBACK_SEARCH_MAX_FILES = 20;
const FALLBACK_SEARCH_MAX_BYTES = 50 * 1024 * 1024;

// ── Bookmarks ──

function resolvedMp4(recordingName) {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved) throw new Error('invalid recording name');
  return resolved;
}

function bookmarksPath(recordingName) {
  const bmPath = resolvedMp4(recordingName).full.replace(/\.mp4$/i, '.bookmarks.json');
  if (!assertPathInsideRealDir(RECORDINGS_DIR, bmPath)) throw new Error('invalid bookmark path');
  return bmPath;
}

function readBookmarks(recordingName) {
  const file = bookmarksPath(recordingName);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBookmarks(recordingName, bookmarks) {
  const file = bookmarksPath(recordingName);
  atomicWriteFileSync(file, JSON.stringify(bookmarks, null, 2));
}

function addBookmark(recordingName, timeSec, note) {
  if (!Number.isFinite(Number(timeSec)) || Number(timeSec) < 0) {
    throw new Error('invalid timeSec');
  }
  const bookmarks = readBookmarks(recordingName);
  if (bookmarks.length >= MAX_BOOKMARKS_PER_RECORDING) {
    throw new Error(`max ${MAX_BOOKMARKS_PER_RECORDING} bookmarks per recording`);
  }
  const rand = crypto.randomBytes(4).toString('hex');
  const id = `bm_${Date.now()}_${Math.floor(timeSec)}_${rand}`;
  const bm = {
    id,
    timeSec: Math.round(Number(timeSec) * 10) / 10,
    note: stripControlChars(note, 200),
    createdAt: Date.now(),
  };
  bookmarks.push(bm);
  bookmarks.sort((a, b) => a.timeSec - b.timeSec);
  saveBookmarks(recordingName, bookmarks);
  return bm;
}

function removeBookmark(recordingName, bookmarkId) {
  let bookmarks = readBookmarks(recordingName);
  const before = bookmarks.length;
  bookmarks = bookmarks.filter((b) => b.id !== bookmarkId);
  if (bookmarks.length === before) return false;
  saveBookmarks(recordingName, bookmarks);
  return true;
}

// ── Full-text search across recordings ──

function searchChat(query, maxResults = 50) {
  if (typeof query !== 'string') return [];
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return [];
  const limit = Math.max(1, Math.min(200, Number(maxResults) || 50));

  if (db.isAvailable()) {
    try {
      db.syncAllRecordings({ force: false });
      const indexed = db.searchChatIndexed(trimmed, limit);
      if (Array.isArray(indexed)) return indexed;
    } catch {}
  }

  const q = trimmed.toLowerCase();
  const results = [];

  const eventFiles = listRecordingFiles()
    .map((recording) => {
      const resolved = resolveRecordingPath(RECORDINGS_DIR, recording, '.mp4');
      if (!resolved) return null;
      const evFull = resolved.full.replace(/\.mp4$/i, '.events.jsonl');
      if (!assertPathInsideRealDir(RECORDINGS_DIR, evFull)) return null;
      try {
        const st = fs.statSync(evFull);
        return { evFull, recording: resolved.name, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, FALLBACK_SEARCH_MAX_FILES);

  let totalBytesRead = 0;
  for (const { evFull, recording, size } of eventFiles) {
    if (results.length >= limit) break;
    if (size > MAX_EVENTS_FILE_BYTES || totalBytesRead + size > FALLBACK_SEARCH_MAX_BYTES) continue;
    let raw;
    try {
      raw = fs.readFileSync(evFull, 'utf8');
      totalBytesRead += size;
    } catch { continue; }

    for (const line of raw.split('\n')) {
      if (results.length >= limit) break;
      if (!line.trim() || !line.includes('"chat"')) continue;
      try {
        const ev = JSON.parse(line);
        if (!ev || ev.type !== 'chat' || typeof ev.comment !== 'string') continue;
        const uname = String(ev.user?.uniqueId || '');
        const nick = String(ev.user?.nickname || '');
        if (!ev.comment.toLowerCase().includes(q) && !uname.toLowerCase().includes(q) && !nick.toLowerCase().includes(q)) continue;
        results.push({
          recording,
          ts: ev.ts,
          user: ev.user?.uniqueId || ev.user?.nickname || '?',
          comment: ev.comment,
        });
      } catch {}
    }
  }

  return results;
}

// ── Auto-tags for recordings ──

function autoTags(recordingName) {
  const full = resolvedMp4(recordingName).full;
  const tags = [];

  // Check highlights
  const hlFile = full.replace(/\.mp4$/i, '.highlights.json');
  try {
    if (assertPathInsideRealDir(RECORDINGS_DIR, hlFile) && fs.existsSync(hlFile)) {
      const data = JSON.parse(fs.readFileSync(hlFile, 'utf8'));
      const candidates = data?.candidates || [];
      if (candidates.some((c) => c.reason === 'pk_battle')) tags.push('PK');
      if (candidates.some((c) => c.reason === 'gift_spike')) tags.push('gift-spike');
      if (candidates.length > 5) tags.push('eventful');
    }
  } catch {}

  // Check events for subscriber / big gifts via shared LRU cache
  const evFile = full.replace(/\.mp4$/i, '.events.jsonl');
  try {
    if (assertPathInsideRealDir(RECORDINGS_DIR, evFile) && fs.existsSync(evFile)) {
      const events = readEvents(evFile, { sort: false });
      let totalDiamonds = 0;
      let hasSub = false;
      for (const ev of events) {
        if (ev.type === 'gift') {
          const d = Number(ev.diamondCount);
          const r = Number(ev.repeatCount);
          const safeD = Number.isFinite(d) && d >= 0 ? d : 0;
          const safeR = Number.isFinite(r) && r > 0 ? r : 1;
          totalDiamonds += safeD * safeR;
        }
        if (ev.type === 'subscribe' || ev.type === 'superFan') hasSub = true;
      }
      if (totalDiamonds >= 1000) tags.push('high-diamond');
      if (totalDiamonds >= 5000) tags.push('whale-stream');
      if (hasSub) tags.push('subscriber');
    }
  } catch {}

  return tags;
}

module.exports = {
  readBookmarks,
  addBookmark,
  removeBookmark,
  searchChat,
  autoTags,
};
