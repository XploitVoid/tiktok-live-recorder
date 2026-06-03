// lib/bookmarks.js — Per-recording bookmark management.
// Bookmarks are stored in <recording>.bookmarks.json sidecar files.
// Also provides full-text search across all recordings' chat events.

const fs = require('fs');
const path = require('path');
const { safeFilename } = require('./utils');

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');

// ── Bookmarks ──

function bookmarksPath(recordingName) {
  const base = recordingName.replace(/\.mp4$/i, '');
  return path.join(RECORDINGS_DIR, `${base}.bookmarks.json`);
}

function readBookmarks(recordingName) {
  const file = bookmarksPath(recordingName);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveBookmarks(recordingName, bookmarks) {
  const file = bookmarksPath(recordingName);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bookmarks, null, 2));
  fs.renameSync(tmp, file);
}

function addBookmark(recordingName, timeSec, note) {
  const bookmarks = readBookmarks(recordingName);
  const id = `bm_${Date.now()}_${Math.floor(timeSec)}`;
  const bm = {
    id,
    timeSec: Math.round(timeSec * 10) / 10,
    note: (note || '').slice(0, 200),
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
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const results = [];

  let files;
  try { files = fs.readdirSync(RECORDINGS_DIR); } catch { return []; }

  const eventFiles = files.filter((f) => f.endsWith('.events.jsonl'));

  for (const ef of eventFiles) {
    if (results.length >= maxResults) break;
    const recording = ef.replace(/\.events\.jsonl$/i, '.mp4');
    const full = path.join(RECORDINGS_DIR, ef);
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }

    for (const line of raw.split('\n')) {
      if (results.length >= maxResults) break;
      if (!line.includes(q) && !line.toLowerCase().includes(q)) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type !== 'chat' || !ev.comment) continue;
        if (!ev.comment.toLowerCase().includes(q)) continue;
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
  const base = recordingName.replace(/\.mp4$/i, '');
  const tags = [];

  // Check highlights
  const hlFile = path.join(RECORDINGS_DIR, `${base}.highlights.json`);
  try {
    if (fs.existsSync(hlFile)) {
      const data = JSON.parse(fs.readFileSync(hlFile, 'utf8'));
      const candidates = data?.candidates || [];
      if (candidates.some((c) => c.reason === 'pk_battle')) tags.push('PK');
      if (candidates.some((c) => c.reason === 'gift_spike')) tags.push('gift-spike');
      if (candidates.length > 5) tags.push('eventful');
    }
  } catch {}

  // Check events for subscriber / big gifts
  const evFile = path.join(RECORDINGS_DIR, `${base}.events.jsonl`);
  try {
    if (fs.existsSync(evFile)) {
      const raw = fs.readFileSync(evFile, 'utf8');
      let totalDiamonds = 0;
      let hasSub = false;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'gift') totalDiamonds += (Number(ev.diamondCount) || 0) * (Number(ev.repeatCount) || 1);
          if (ev.type === 'subscribe') hasSub = true;
        } catch {}
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
