// routes/chat.js — /api/chat/* endpoints.

const { Router } = require('express');
const { normalizeUsername } = require('../lib/room');
const { safeError } = require('../lib/utils');
const chat = require('../lib/chat');

const router = Router();

router.post('/api/chat/start', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const s = await chat.ensureSession(username);
    res.json(s.info());
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.post('/api/chat/stop', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) return res.status(400).json({ error: 'missing username' });
  res.json({ ok: chat.closeSession(username) });
});

router.get('/api/chat/sessions', (_req, res) => {
  res.json(chat.listSessions());
});

// Aggregated dashboard stats across all active chat sessions.
router.get('/api/chat/dashboard', (_req, res) => {
  const sessions = chat.listSessions();
  const connected = sessions.filter((s) => s.state === 'connected');
  let totalViewers = 0;
  let totalEvents = 0;
  const streams = [];

  for (const s of connected) {
    totalViewers += s.viewerCount || 0;
    totalEvents += s.eventCount || 0;
    // Get recent events for unified feed
    const session = chat.getSession(s.username);
    const recentEvents = session ? session.snapshot(Math.max(0, session.nextId - 50)) : [];
    // Count diamonds in recent events
    let recentDiamonds = 0;
    for (const ev of recentEvents) {
      if (ev.type === 'gift') recentDiamonds += (Number(ev.diamondCount) || 0) * (Number(ev.repeatCount) || 1);
    }

    streams.push({
      username: s.username,
      viewerCount: s.viewerCount || 0,
      eventCount: s.eventCount,
      startedAt: s.startedAt,
      recentDiamonds,
      health: s.health || null,
    });
  }

  // Unified feed: last 100 events across all sessions, sorted by ts
  const allEvents = [];
  for (const s of connected) {
    const session = chat.getSession(s.username);
    if (!session) continue;
    const events = session.snapshot(Math.max(0, session.nextId - 30));
    for (const ev of events) {
      allEvents.push({ ...ev, _username: s.username });
    }
  }
  allEvents.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const unifiedFeed = allEvents.slice(-100);

  res.json({
    totalStreams: connected.length,
    totalViewers,
    totalEvents,
    streams: streams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0)),
    unifiedFeed,
  });
});

router.get('/api/chat/events', (req, res) => {
  const username = normalizeUsername(req.query.username);
  if (!username) return res.status(400).json({ error: 'missing username' });
  const sinceId = Number(req.query.sinceId) || 0;
  const s = chat.getSession(username);
  if (!s) return res.json({ state: 'idle', events: [], lastEventId: 0 });
  res.json({
    state: s.state,
    error: s.error,
    viewerCount: s.viewerCount,
    events: s.snapshot(sinceId),
    lastEventId: s.nextId - 1,
  });
});

module.exports = router;
