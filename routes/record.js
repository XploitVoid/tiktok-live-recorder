// routes/record.js — /api/record/* and /api/recordings/* endpoints.

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { normalizeUsername } = require('../lib/room');
const { safeError, sanitizeQuality, resolveInsideDir, readEvents, parseStartTimeFromName } = require('../lib/utils');
const {
  RECORDINGS_DIR,
  recorderEvents,
  startRecording,
  stopJob,
  getJobsList,
  activeFilePaths,
} = require('../lib/recorder');
const {
  deleteRecordingBundle,
  readMeta,
  ensureThumbnailAndMeta,
  extractAudio,
} = require('../lib/storage');

const router = Router();

// ── Recording control ──

router.post('/api/record/start', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const quality = sanitizeQuality(req.body?.quality, undefined);
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const result = await startRecording(username, quality);
    invalidateRecordingsCache();
    console.log(`[audit] record start: @${username} q=${quality || 'auto'} -> ${result.file}`);
    res.json(result);
  } catch (e) {
    const status =
      e.code === 'NOT_LIVE' ? 409 :
      e.code === 'LIMIT' ? 429 :
      e.code === 'DISK_FULL' ? 507 :
      e.code === 'NO_FFMPEG' ? 503 : 500;
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
recorderEvents.on('recordings', invalidateRecordingsCache);

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
    const activeFiles = activeFilePaths();

    const files = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.mp4'))
      .map((d) => {
        const f = d.name;
        const fullPath = path.join(RECORDINGS_DIR, f);
        const st = fs.statSync(fullPath);
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
        const meta = readMeta(f);
        const isActive = activeFiles.has(fullPath);
        const needsMedia = !meta?.hasMeta || (!!meta.vcodec && !meta.hasThumb);
        if (!isActive && needsMedia && st.size > 0) {
          // Lazily kick off background thumbnail/probe generation for completed files
          setImmediate(() => { ensureThumbnailAndMeta(f).then(() => invalidateRecordingsCache()).catch(() => {}); });
        }
        return {
          name: f, sizeBytes: st.size, mtime: st.mtimeMs,
          hasEvents: fs.existsSync(sidecar),
          highlightCount,
          clipCount,
          durationSec: meta?.durationSec ?? null,
          width: meta?.width ?? null,
          height: meta?.height ?? null,
          fps: meta?.fps ?? null,
          thumbUrl: meta?.thumbUrl ?? null,
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
  const resolved = resolveInsideDir(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  const { name, full } = resolved;

  let st;
  try { st = fs.statSync(full); } catch { return res.status(404).json({ error: 'not found' }); }

  const startMs = parseStartTimeFromName(name);
  const eventsFile = full.replace(/\.mp4$/i, '.events.jsonl');
  let events = [];
  let eventsExists = false;
  try {
    if (fs.existsSync(eventsFile)) {
      eventsExists = true;
      events = readEvents(eventsFile, { sort: false });
      for (const ev of events) {
        if (startMs && ev.ts) ev.t = (ev.ts - startMs) / 1000;
      }
    }
  } catch (e) {
    return res.status(500).json({ error: safeError(e) });
  }

  // Derive username from filename: <user>_YYYYMMDD_HHMMSS[_pN].mp4
  const userMatch = name.match(/^(.+)_\d{4}\d{2}\d{2}_\d{2}\d{2}\d{2}(?:_p\d+)?\.mp4$/i);
  const username = userMatch ? userMatch[1] : null;

  res.json({
    name, username, sizeBytes: st.size, startMs, mtimeMs: st.mtimeMs,
    eventsExists, eventCount: events.length, events,
  });
});

router.post('/api/recordings/:name/audio', async (req, res) => {
  const resolved = resolveInsideDir(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  const format = req.body?.format === 'mp3' ? 'mp3' : 'm4a';
  try {
    const out = await extractAudio(resolved.name, format);
    res.json({ ok: true, ...out });
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'NO_FFMPEG' ? 503 : 500;
    res.status(status).json({ error: safeError(e) });
  }
});

router.delete('/api/recordings/:name', (req, res) => {
  const resolved = resolveInsideDir(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  try {
    deleteRecordingBundle(resolved.name);
    invalidateRecordingsCache();
    console.log(`[audit] file deleted: ${resolved.name}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
module.exports.invalidateRecordingsCache = invalidateRecordingsCache;
