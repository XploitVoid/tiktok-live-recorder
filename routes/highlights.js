// routes/highlights.js — /api/highlights/* endpoints.
//
// GET    /api/highlights/:recording           → candidates + clips for one recording
// POST   /api/highlights/analyze              → re-run detection (in case events grew)
// POST   /api/highlights/cut                  → cut a clip { recording, startSec, endSec }
// DELETE /api/highlights/clip/:name           → delete a generated clip

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { safeFilename, safeError } = require('../lib/utils');
const {
  CLIPS_DIR,
  analyzeRecording,
  readHighlights,
  cutClip,
  listClipsFor,
  deleteClip,
} = require('../lib/highlights');
const { buildLeaderboard } = require('../lib/leaderboard');
const { buildGiftEconomy, buildWordFrequency } = require('../lib/analytics');
const { readBookmarks, addBookmark, removeBookmark, searchChat, autoTags } = require('../lib/bookmarks');

const router = Router();
const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');

// Validate that the requested recording name corresponds to an actual mp4
// inside RECORDINGS_DIR — prevents path traversal and pointing at random files.
function resolveRecording(rawName) {
  const name = safeFilename(rawName || '');
  if (!name.endsWith('.mp4')) return null;
  const full = path.join(RECORDINGS_DIR, name);
  if (!full.startsWith(RECORDINGS_DIR)) return null;
  if (!fs.existsSync(full)) return null;
  return name;
}

router.get('/api/highlights/:recording', (req, res) => {
  const name = resolveRecording(req.params.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  const data = readHighlights(name);
  const clips = listClipsFor(name);
  res.json({
    recording: name,
    analyzed: !!data,
    analyzedAt: data?.analyzedAt || null,
    candidates: data?.candidates || [],
    stats: data?.stats || null,
    usedFallback: !!data?.stats?.usedFallback,
    clips,
  });
});

router.post('/api/highlights/analyze', (req, res) => {
  const name = resolveRecording(req.body?.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  try {
    const result = analyzeRecording(name);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, candidates: result.candidates });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/api/highlights/cut', async (req, res) => {
  const name = resolveRecording(req.body?.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  const startSec = Number(req.body?.startSec);
  const endSec = Number(req.body?.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return res.status(400).json({ error: 'invalid startSec/endSec' });
  }
  try {
    const out = await cutClip(name, startSec, endSec);
    console.log(`[audit] highlight cut: ${name} [${startSec}-${endSec}s] -> ${out.name}`);
    res.json({ ok: true, clip: out });
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'BAD_RANGE' ? 400 : 500;
    res.status(status).json({ error: safeError(e), code: e.code });
  }
});

router.delete('/api/highlights/clip/:name', (req, res) => {
  try {
    const name = safeFilename(req.params.name);
    if (!name.endsWith('.mp4')) return res.status(400).json({ error: 'bad name' });
    const full = path.join(CLIPS_DIR, name);
    if (!full.startsWith(CLIPS_DIR) || !fs.existsSync(full)) {
      return res.status(404).json({ error: 'clip not found' });
    }
    deleteClip(name);
    console.log(`[audit] highlight clip deleted: ${name}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// Top supporters / leaderboard for one recording.
// Computed on-demand from <recording>.events.jsonl — no caching since the
// aggregation is O(events) and runs in tens of ms even for long streams.
router.get('/api/leaderboard/:recording', (req, res) => {
  const name = resolveRecording(req.params.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  try {
    const data = buildLeaderboard(name);
    if (!data.ok) return res.status(400).json({ error: data.error });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// Gift economy heatmap + stats for one recording.
router.get('/api/analytics/gifts/:recording', (req, res) => {
  const name = resolveRecording(req.params.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  try {
    const data = buildGiftEconomy(name);
    if (!data.ok) return res.status(400).json({ error: data.error });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// Word frequency / trending phrases for one recording.
router.get('/api/analytics/words/:recording', (req, res) => {
  const name = resolveRecording(req.params.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  try {
    const data = buildWordFrequency(name);
    if (!data.ok) return res.status(400).json({ error: data.error });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// ── Bookmarks ──

router.get('/api/bookmarks/:recording', (req, res) => {
  const name = resolveRecording(req.params.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  res.json({ recording: name, bookmarks: readBookmarks(name) });
});

router.post('/api/bookmarks', (req, res) => {
  const name = resolveRecording(req.body?.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  const timeSec = Number(req.body?.timeSec);
  if (!Number.isFinite(timeSec) || timeSec < 0) return res.status(400).json({ error: 'invalid timeSec' });
  const note = String(req.body?.note || '');
  try {
    const bm = addBookmark(name, timeSec, note);
    res.json({ ok: true, bookmark: bm });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.delete('/api/bookmarks/:recording/:id', (req, res) => {
  const name = resolveRecording(req.params.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  const ok = removeBookmark(name, req.params.id);
  if (!ok) return res.status(404).json({ error: 'bookmark not found' });
  res.json({ ok: true });
});

// ── Search ──

router.get('/api/search/chat', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'query too short (min 2 chars)' });
  try {
    const results = searchChat(q);
    res.json({ query: q, results });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// ── Auto-tags ──

router.get('/api/tags/:recording', (req, res) => {
  const name = resolveRecording(req.params.recording);
  if (!name) return res.status(404).json({ error: 'recording not found' });
  res.json({ recording: name, tags: autoTags(name) });
});

module.exports = router;
