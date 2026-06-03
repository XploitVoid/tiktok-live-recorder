// routes/record.js — /api/record/* and /api/recordings/* endpoints.

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { normalizeUsername } = require('../lib/room');
const { safeError, safeFilename, parseStartTimeFromName } = require('../lib/utils');
const {
  RECORDINGS_DIR,
  startRecording,
  stopJob,
  getJobsList,
} = require('../lib/recorder');

const router = Router();

// Same quality whitelist as routes/watch.js. The recorder validates `quality`
// internally too, but rejecting at the edge gives clean 400s instead of
// "unknown quality" silently falling through to default.
const QUALITY_RE = /^(?:hevc:)?(?:origin|uhd|hd|sd|ld|md|ao)$/;
function sanitizeQuality(q) {
  if (q == null || q === '' || q === 'auto') return undefined;
  if (typeof q !== 'string' || !QUALITY_RE.test(q)) return undefined;
  return q;
}

// ── Recording control ──

router.post('/api/record/start', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const quality = sanitizeQuality(req.body?.quality);
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const result = await startRecording(username, quality);
    invalidateRecordingsCache();
    console.log(`[audit] record start: @${username} q=${quality || 'auto'} -> ${result.file}`);
    res.json(result);
  } catch (e) {
    const status = e.code === 'NOT_LIVE' ? 409 : e.code === 'LIMIT' ? 429 : 500;
    res.status(status).json({ error: safeError(e), code: e.code });
  }
});

router.post('/api/record/stop', async (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const result = await stopJob(id);
  if (!result) return res.status(404).json({ error: 'job not found' });
  if (!result.alreadyExited) {
    console.log(`[audit] record stop: job#${id} @${result.username} graceful=${result.graceful}`);
  }
  res.json(result);
});

router.get('/api/record/jobs', (_req, res) => {
  res.json(getJobsList());
});

// ── Recordings file management ──

// Lightweight in-memory cache for the recording list. Many UI clients
// (SavedRecordings polls on mount, multiple tabs, repeated refresh after
// recording start) hit this endpoint at the same time. Without caching,
// each call does a sync readdir + statSync per file + JSON parse of the
// highlights sidecar, which can spike CPU on large libraries.
let recordingsCache = { ts: 0, data: null };
const RECORDINGS_LIST_TTL_MS = 2000;
function invalidateRecordingsCache() { recordingsCache = { ts: 0, data: null }; }

router.get('/api/recordings', (_req, res) => {
  const now = Date.now();
  if (recordingsCache.data && now - recordingsCache.ts < RECORDINGS_LIST_TTL_MS) {
    return res.json(recordingsCache.data);
  }
  try {
    // Cache the highlights sidecar dir listing so we don't readdir for every mp4.
    const clipsDir = path.join(RECORDINGS_DIR, 'highlights');
    let clipFiles = [];
    try { clipFiles = fs.readdirSync(clipsDir); } catch {}

    const files = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.mp4'))
      .map((d) => {
        const f = d.name;
        const st = fs.statSync(path.join(RECORDINGS_DIR, f));
        const base = f.replace(/\.mp4$/i, '');
        const sidecar = path.join(RECORDINGS_DIR, `${base}.events.jsonl`);
        const highlightsFile = path.join(RECORDINGS_DIR, `${base}.highlights.json`);
        let highlightCount = 0;
        try {
          if (fs.existsSync(highlightsFile)) {
            const data = JSON.parse(fs.readFileSync(highlightsFile, 'utf8'));
            highlightCount = (data?.candidates || []).length;
          }
        } catch {}
        // Count generated clips matching this recording's prefix.
        const prefix = `${base}_clip_`;
        let clipCount = 0;
        for (const c of clipFiles) {
          if (c.startsWith(prefix) && c.endsWith('.mp4')) clipCount++;
        }
        return {
          name: f, sizeBytes: st.size, mtime: st.mtimeMs,
          hasEvents: fs.existsSync(sidecar),
          highlightCount,
          clipCount,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    recordingsCache = { ts: Date.now(), data: files };
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/api/recordings/:name', (req, res) => {
  const name = safeFilename(req.params.name);
  const full = path.join(RECORDINGS_DIR, name);
  if (!full.startsWith(RECORDINGS_DIR)) return res.status(400).json({ error: 'bad name' });

  let st;
  try { st = fs.statSync(full); } catch { return res.status(404).json({ error: 'not found' }); }

  const startMs = parseStartTimeFromName(name);
  const eventsFile = full.replace(/\.mp4$/i, '.events.jsonl');
  let events = [];
  let eventsExists = false;
  try {
    if (fs.existsSync(eventsFile)) {
      eventsExists = true;
      const raw = fs.readFileSync(eventsFile, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (startMs && ev.ts) ev.t = (ev.ts - startMs) / 1000;
          events.push(ev);
        } catch {}
      }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Derive username from filename: <user>_YYYYMMDD_HHMMSS.mp4
  const userMatch = name.match(/^(.+)_\d{4}\d{2}\d{2}_\d{2}\d{2}\d{2}\.mp4$/i);
  const username = userMatch ? userMatch[1] : null;

  res.json({
    name, username, sizeBytes: st.size, startMs, mtimeMs: st.mtimeMs,
    eventsExists, eventCount: events.length, events,
  });
});

router.delete('/api/recordings/:name', (req, res) => {
  const name = safeFilename(req.params.name);
  const full = path.join(RECORDINGS_DIR, name);
  if (!full.startsWith(RECORDINGS_DIR)) return res.status(400).json({ error: 'bad name' });
  try {
    fs.unlinkSync(full);
    invalidateRecordingsCache();
    // Also remove the sidecar events file if it exists.
    const sidecar = full.replace(/\.mp4$/i, '.events.jsonl');
    try { fs.unlinkSync(sidecar); } catch {}
    // And the highlights metadata + any generated clips.
    const highlightsFile = full.replace(/\.mp4$/i, '.highlights.json');
    try { fs.unlinkSync(highlightsFile); } catch {}
    // And the bookmarks sidecar.
    const bookmarksFile = full.replace(/\.mp4$/i, '.bookmarks.json');
    try { fs.unlinkSync(bookmarksFile); } catch {}
    try {
      const base = name.replace(/\.mp4$/i, '');
      const prefix = `${base}_clip_`;
      const clipsDir = path.join(RECORDINGS_DIR, 'highlights');
      if (fs.existsSync(clipsDir)) {
        for (const c of fs.readdirSync(clipsDir)) {
          if (c.startsWith(prefix)) {
            try { fs.unlinkSync(path.join(clipsDir, c)); } catch {}
          }
        }
      }
    } catch {}
    console.log(`[audit] file deleted: ${name}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
