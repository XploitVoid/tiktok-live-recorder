// lib/db.js — Local SQLite FTS5 search index for recordings and chat messages.
// Powered by Node.js built-in `node:sqlite` (DatabaseSync). Falls back gracefully
// if `node:sqlite` is unavailable in older Node runtimes.

const fs = require('fs');
const path = require('path');
const { MAX_EVENTS_FILE_BYTES, resolveRecordingPath, parseStartTimeFromName, readEvents } = require('./utils');
const { RECORDINGS_DIR, listRecordingFiles, readMeta } = require('./storage');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

let dbInstance = null;
let dbInstancePath = null;
let lastSyncAt = 0;
const SYNC_THROTTLE_MS = 30_000;

function getDbPath() {
  return process.env.RECORDER_DB_PATH
    ? path.resolve(process.env.RECORDER_DB_PATH)
    : path.resolve(__dirname, '..', 'recorder.db');
}

function isAvailable() {
  return typeof DatabaseSync === 'function';
}

function closeDb() {
  if (dbInstance) {
    try { dbInstance.close(); } catch {}
    dbInstance = null;
    dbInstancePath = null;
  }
  lastSyncAt = 0;
}

function ensureDb() {
  if (!isAvailable()) return null;
  const targetPath = getDbPath();
  if (dbInstance && dbInstancePath === targetPath) return dbInstance;
  if (dbInstance) closeDb();

  try { fs.mkdirSync(path.dirname(targetPath), { recursive: true }); } catch {}
  const db = new DatabaseSync(targetPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS recordings (
      name TEXT PRIMARY KEY,
      username TEXT,
      folder TEXT,
      size_bytes INTEGER,
      mtime_ms REAL,
      duration_sec REAL,
      protected INTEGER DEFAULT 0,
      display_title TEXT,
      notes TEXT,
      events_mtime_ms REAL DEFAULT 0,
      events_size INTEGER DEFAULT 0,
      event_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording TEXT NOT NULL,
      ts INTEGER,
      user TEXT,
      comment TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_recording ON chat_messages(recording);
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
      recording UNINDEXED,
      ts UNINDEXED,
      user,
      comment,
      tokenize='trigram'
    );
  `);
  dbInstance = db;
  dbInstancePath = targetPath;
  return db;
}

function deriveUsername(relName, meta, folder) {
  if (meta?.username) return meta.username;
  if (folder) return folder;
  const base = path.basename(relName);
  const m = base.match(/^(.+?)_\d{4}(?:-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}|\d{4}_\d{6})/);
  return m ? m[1] : null;
}

function indexRecording(relName) {
  const db = ensureDb();
  if (!db) return false;
  const resolved = resolveRecordingPath(RECORDINGS_DIR, relName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) return false;

  let st;
  try { st = fs.statSync(resolved.full); } catch { return false; }
  const meta = readMeta(resolved.name);
  const username = deriveUsername(resolved.name, meta, resolved.folder);

  const evFile = resolved.full.replace(/\.mp4$/i, '.events.jsonl');
  let evStat = null;
  try {
    if (fs.existsSync(evFile)) evStat = fs.statSync(evFile);
  } catch {}
  const evMtime = evStat ? evStat.mtimeMs : 0;
  const evSize = evStat ? evStat.size : 0;

  const existing = db.prepare(
    'SELECT events_mtime_ms, events_size, event_count FROM recordings WHERE name = ?'
  ).get(resolved.name);

  const eventsChanged = !existing ||
    existing.events_mtime_ms !== evMtime ||
    existing.events_size !== evSize;

  let eventCount = existing ? (existing.event_count || 0) : 0;
  let chatRows = null;
  if (eventsChanged) {
    eventCount = 0;
    chatRows = [];
    if (evStat && evSize > 0 && evSize <= MAX_EVENTS_FILE_BYTES) {
      try {
        const events = readEvents(evFile, { sort: false });
        for (const ev of events) {
          if (ev?.type !== 'chat' || typeof ev.comment !== 'string') continue;
          const user = String(ev.user?.uniqueId || ev.user?.nickname || '?').slice(0, 80);
          chatRows.push({
            ts: Number.isFinite(Number(ev.ts)) ? Number(ev.ts) : (parseStartTimeFromName(resolved.name) || 0),
            user,
            comment: ev.comment,
          });
        }
        eventCount = chatRows.length;
      } catch {
        chatRows = [];
      }
    }
  }

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO recordings (
        name, username, folder, size_bytes, mtime_ms, duration_sec,
        protected, display_title, notes, events_mtime_ms, events_size, event_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        username = excluded.username,
        folder = excluded.folder,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        duration_sec = excluded.duration_sec,
        protected = excluded.protected,
        display_title = excluded.display_title,
        notes = excluded.notes,
        events_mtime_ms = excluded.events_mtime_ms,
        events_size = excluded.events_size,
        event_count = excluded.event_count
    `).run(
      resolved.name,
      username,
      resolved.folder,
      st.size,
      st.mtimeMs,
      meta?.durationSec ?? null,
      meta?.protected ? 1 : 0,
      meta?.displayTitle || null,
      meta?.notes || '',
      evMtime,
      evSize,
      eventCount,
    );

    if (eventsChanged) {
      db.prepare('DELETE FROM chat_messages WHERE recording = ?').run(resolved.name);
      db.prepare('DELETE FROM chat_fts WHERE recording = ?').run(resolved.name);
      if (chatRows && chatRows.length > 0) {
        const insMsg = db.prepare('INSERT INTO chat_messages (recording, ts, user, comment) VALUES (?, ?, ?, ?)');
        const insFts = db.prepare('INSERT INTO chat_fts (recording, ts, user, comment) VALUES (?, ?, ?, ?)');
        for (const row of chatRows) {
          insMsg.run(resolved.name, row.ts, row.user, row.comment);
          insFts.run(resolved.name, row.ts, row.user, row.comment);
        }
      }
    }
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function removeRecording(relName) {
  const db = ensureDb();
  if (!db) return false;
  const resolved = resolveRecordingPath(RECORDINGS_DIR, relName, '.mp4');
  const name = resolved ? resolved.name : String(relName || '');
  if (!name) return false;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM chat_messages WHERE recording = ?').run(name);
    db.prepare('DELETE FROM chat_fts WHERE recording = ?').run(name);
    db.prepare('DELETE FROM recordings WHERE name = ?').run(name);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function syncAllRecordings({ force = true } = {}) {
  const db = ensureDb();
  if (!db) return { synced: 0, pruned: 0 };
  const now = Date.now();
  if (!force && lastSyncAt > 0 && now - lastSyncAt < SYNC_THROTTLE_MS) {
    return { synced: 0, pruned: 0, throttled: true };
  }
  const files = listRecordingFiles();
  const currentSet = new Set(files);
  let synced = 0;
  for (const relName of files) {
    try {
      if (indexRecording(relName)) synced++;
    } catch {}
  }

  const existingRows = db.prepare('SELECT name FROM recordings').all();
  let pruned = 0;
  for (const row of existingRows) {
    if (!currentSet.has(row.name)) {
      try {
        removeRecording(row.name);
        pruned++;
      } catch {}
    }
  }
  lastSyncAt = Date.now();
  return { synced, pruned };
}

function searchChatIndexed(query, maxResults = 50) {
  const db = ensureDb();
  if (!db) return null;
  if (typeof query !== 'string') return [];
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return [];
  const limit = Math.max(1, Math.min(200, Number(maxResults) || 50));

  let rows;
  if (trimmed.length >= 3) {
    const ftsQuery = `"${trimmed.replace(/"/g, '""')}"`;
    rows = db.prepare(
      'SELECT recording, ts, user, comment FROM chat_fts WHERE chat_fts MATCH ? ORDER BY ts DESC LIMIT ?'
    ).all(ftsQuery, limit);
  } else {
    const escaped = trimmed.toLowerCase().replace(/[\\%_]/g, '\\$&');
    const likePattern = `%${escaped}%`;
    rows = db.prepare(
      "SELECT recording, ts, user, comment FROM chat_messages WHERE LOWER(comment) LIKE ? ESCAPE '\\' OR LOWER(user) LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?"
    ).all(likePattern, likePattern, limit);
  }
  return rows.map((r) => ({
    recording: r.recording,
    ts: r.ts,
    user: r.user,
    comment: r.comment,
  }));
}

function getIndexStats() {
  if (!isAvailable()) {
    return { available: false, recordingsIndexed: 0, chatMessagesIndexed: 0, dbBytes: 0 };
  }
  const db = ensureDb();
  const recCount = db.prepare('SELECT COUNT(*) AS c FROM recordings').get()?.c || 0;
  const msgCount = db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()?.c || 0;
  const dbPath = getDbPath();
  let dbBytes = 0;
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { dbBytes += fs.statSync(p).size; } catch {}
  }
  return {
    available: true,
    recordingsIndexed: Number(recCount),
    chatMessagesIndexed: Number(msgCount),
    dbBytes,
  };
}

module.exports = {
  isAvailable,
  getDbPath,
  closeDb,
  indexRecording,
  removeRecording,
  syncAllRecordings,
  searchChatIndexed,
  getIndexStats,
};
