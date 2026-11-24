// routes/record.js — /api/record/* and /api/recordings/* endpoints.

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { parseChannelInput } = require('../lib/providers');
const { safeError, sanitizeQuality, sanitizeAudioBitrate, resolveRecordingPath, readEvents, parseStartTimeFromName } = require('../lib/utils');
const db = require('../lib/db');
const {
  RECORDINGS_DIR,
  recorderEvents,
  startRecording,
  stopJob,
  cutLiveClip,
  getJobsList,
  activeFilePaths,
} = require('../lib/recorder');
const {
  listRecordingFiles,
  deleteRecordingBundle,
  readMeta,
  updateRecordingMeta,
  ensureThumbnailAndMeta,
  isMediaProbeCoolingDown,
  extractAudio,
  compressRecording,
  mergeRecordingParts,
} = require('../lib/storage');
const { analyzeRecording } = require('../lib/highlights');

const router = Router();

// ── Recording control ──

router.post('/api/record/start', async (req, res) => {
  const { platform, username } = parseChannelInput(req.body?.username, req.body?.platform);
  const quality = sanitizeQuality(req.body?.quality, undefined);
  const audioOnly = !!req.body?.audioOnly;
  const recordChat = req.body?.recordChat !== false;
  const audioBitrate = req.body?.audioBitrate !== undefined
    ? sanitizeAudioBitrate(req.body.audioBitrate, null)
    : undefined;
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const result = await startRecording(username, quality, { platform, audioOnly, audioBitrate, recordChat });
    invalidateRecordingsCache();
    console.log(`[audit] record start: [${platform}] @${username} q=${quality || 'auto'} ao=${audioOnly} abr=${audioBitrate ?? 'default'} -> ${result.file}`);
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
  try {
    const result = await stopJob(id);
    if (!result) return res.status(404).json({ error: 'job not found' });
    if (!result.alreadyExited) {
      console.log(`[audit] record stop: job#${id} @${result.username} graceful=${result.graceful}`);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/api/record/live-clip', async (req, res) => {
  const id = Number(req.body?.id);
  const seconds = req.body?.seconds !== undefined ? Number(req.body.seconds) : 30;
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const result = await cutLiveClip(id, seconds);
    invalidateRecordingsCache();
    console.log(`[audit] live-clip: job#${id} -> ${result.name} (${result.durSec}s)`);
    res.json(result);
  } catch (e) {
    const status =
      e.code === 'NOT_FOUND' ? 404 :
      (e.code === 'JOB_EXITED' || e.code === 'TOO_SHORT') ? 409 :
      e.code === 'NO_FFMPEG' ? 503 : 500;
    res.status(status).json({ error: safeError(e), code: e.code });
  }
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

    const files = listRecordingFiles()
      .map((f) => {
        const resolved = resolveRecordingPath(RECORDINGS_DIR, f, '.mp4');
        if (!resolved) return null;
        const fullPath = resolved.full;
        let st;
        try { st = fs.statSync(fullPath); } catch { return null; }
        const sidecar = fullPath.replace(/\.mp4$/i, '.events.jsonl');
        const highlightsFile = fullPath.replace(/\.mp4$/i, '.highlights.json');
        let highlightCount = 0;
        try {
          if (fs.existsSync(highlightsFile)) {
            const data = JSON.parse(fs.readFileSync(highlightsFile, 'utf8'));
            highlightCount = (data?.candidates || []).length;
          }
        } catch {}
        // Count generated clips matching this recording's prefix.
        const prefix = `${resolved.artifactStem}_clip_`;
        let clipCount = 0;
        for (const c of clipFiles) {
          if (c.startsWith(prefix) && c.endsWith('.mp4')) clipCount++;
        }
        const meta = readMeta(f);
        const isActive = activeFiles.has(fullPath);
        const needsMedia = !meta?.hasMeta || (!!meta.vcodec && !meta.hasThumb);
        if (!isActive && needsMedia && st.size > 0 && !isMediaProbeCoolingDown(f)) {
          // Lazily kick off background thumbnail/probe generation for completed files
          setImmediate(() => {
            ensureThumbnailAndMeta(f)
              .then((updated) => { if (updated?.hasMeta) invalidateRecordingsCache(); })
              .catch(() => {});
          });
        }
        return {
          name: f, sizeBytes: st.size, mtime: st.mtimeMs,
          platform: meta?.platform || ((resolved.folder && /^twitch_/i.test(resolved.folder)) || /^twitch_/i.test(resolved.fileName) ? 'twitch' : 'tiktok'),
          hasEvents: fs.existsSync(sidecar),
          highlightCount,
          clipCount,
          durationSec: meta?.durationSec ?? null,
          width: meta?.width ?? null,
          height: meta?.height ?? null,
          fps: meta?.fps ?? null,
          vcodec: meta?.vcodec ?? null,
          thumbUrl: meta?.thumbUrl ?? null,
          spriteUrl: meta?.spriteUrl ?? null,
          spriteMeta: meta?.spriteMeta ?? null,
          protected: !!meta?.protected,
          displayTitle: meta?.displayTitle ?? null,
          notes: meta?.notes ?? '',
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    recordingsCache = { ts: Date.now(), data: files };
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/api/recordings/:name', (req, res) => {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  const { name, full, folder, fileName } = resolved;

  let st;
  try { st = fs.statSync(full); } catch { return res.status(404).json({ error: 'not found' }); }

  const meta = readMeta(name);
  const startMs = parseStartTimeFromName(name) || (Number.isFinite(Number(meta?.startedAt)) ? Number(meta.startedAt) : null);
  const eventsFile = full.replace(/\.mp4$/i, '.events.jsonl');
  let events = [];
  let eventsExists = false;
  try {
    if (fs.existsSync(eventsFile)) {
      eventsExists = true;
      const rawEvents = readEvents(eventsFile, { sort: false });
      events = startMs
        ? rawEvents.map((ev) => (ev.ts ? { ...ev, t: (ev.ts - startMs) / 1000 } : ev))
        : rawEvents;
    }
  } catch (e) {
    return res.status(500).json({ error: safeError(e) });
  }

  // Derive username & platform from metadata, creator subfolder, or filename
  const userMatch = fileName.match(/^(?:twitch_)?(.+?)_\d{4}(?:-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}|\d{4}_\d{6})/);
  const platform = meta?.platform || ((folder && /^twitch_/i.test(folder)) || /^twitch_/i.test(fileName) ? 'twitch' : 'tiktok');
  const username = meta?.username || (folder ? folder.replace(/^twitch_/i, '') : null) || (userMatch ? userMatch[1] : null);

  res.json({
    name, platform, username, sizeBytes: st.size, startMs, mtimeMs: st.mtimeMs,
    eventsExists, eventCount: events.length, events,
    protected: !!meta?.protected,
    displayTitle: meta?.displayTitle ?? null,
    notes: meta?.notes ?? '',
    spriteUrl: meta?.spriteUrl ?? null,
    spriteMeta: meta?.spriteMeta ?? null,
  });
});

router.post('/api/recordings/merge', async (req, res) => {
  const files = req.body?.files;
  const deleteSources = !!req.body?.deleteSources;
  try {
    const out = await mergeRecordingParts(files, {
      deleteSources,
      activeFiles: activeFilePaths(),
    });
    if (out.hasEvents) {
      try { analyzeRecording(out.name); } catch {}
    }
    try {
      db.indexRecording(out.name);
      for (const del of out.deletedSources || []) db.removeRecording(del);
    } catch {}
    invalidateRecordingsCache();
    recorderEvents.emit('recordings');
    console.log(`[audit] merge: ${out.parts.length} parts -> ${out.name} (deleted=${out.deletedSources.length})`);
    res.json({ ok: true, ...out });
  } catch (e) {
    const status =
      e.code === 'BAD_INPUT' ? 400 :
      e.code === 'NOT_FOUND' ? 404 :
      e.code === 'ACTIVE_RECORDING' ? 409 :
      e.code === 'NO_FFMPEG' ? 503 : 500;
    res.status(status).json({ error: safeError(e), code: e.code });
  }
});

router.patch('/api/recordings/:name', (req, res) => {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  try {
    const updated = updateRecordingMeta(resolved.name, {
      protected: typeof req.body?.protected === 'boolean' ? req.body.protected : undefined,
      displayTitle: req.body?.displayTitle,
      notes: req.body?.notes,
    });
    try { db.indexRecording(resolved.name); } catch {}
    invalidateRecordingsCache();
    res.json({ ok: true, meta: updated });
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : 500;
    res.status(status).json({ error: safeError(e) });
  }
});

router.post('/api/recordings/:name/audio', async (req, res) => {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  const format = req.body?.format === 'mp3' ? 'mp3' : 'm4a';
  const bitrate = sanitizeAudioBitrate(req.body?.bitrate, null);
  try {
    const out = await extractAudio(resolved.name, format, bitrate);
    res.json({ ok: true, ...out });
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'NO_FFMPEG' ? 503 : 500;
    res.status(status).json({ error: safeError(e) });
  }
});

router.post('/api/recordings/:name/compress', async (req, res) => {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  const preset = req.body?.preset === 'compact' ? 'compact' : 'balanced';
  try {
    const out = await compressRecording(resolved.name, preset);
    try { db.indexRecording(out.name); } catch {}
    invalidateRecordingsCache();
    console.log(`[audit] compress: ${resolved.name} (${preset}) -> ${out.name} (${out.sizeBytes} bytes)`);
    res.json({ ok: true, ...out });
  } catch (e) {
    const status =
      e.code === 'NOT_FOUND' ? 404 :
      e.code === 'NO_FFMPEG' ? 503 :
      (e.code === 'ALREADY_COMPRESSED' || e.code === 'AUDIO_ONLY') ? 400 : 500;
    res.status(status).json({ error: safeError(e) });
  }
});

router.delete('/api/recordings/:name', (req, res) => {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, req.params.name, '.mp4');
  if (!resolved) return res.status(400).json({ error: 'bad name' });
  if (activeFilePaths().has(resolved.full)) {
    return res.status(409).json({ error: 'recording is active' });
  }
  if (!fs.existsSync(resolved.full)) {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    deleteRecordingBundle(resolved.name);
    try { db.removeRecording(resolved.name); } catch {}
    invalidateRecordingsCache();
    console.log(`[audit] file deleted: ${resolved.name}`);
    res.json({ ok: true });
  } catch (e) {
    const status = e.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: safeError(e) });
  }
});

module.exports = router;
module.exports.invalidateRecordingsCache = invalidateRecordingsCache;
