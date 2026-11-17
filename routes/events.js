// routes/events.js — Server-Sent Events (SSE) real-time push stream.
// Replaces high-frequency polling for jobs, watchlist, chat, and dashboard.

const { Router } = require('express');
const { normalizeUsername } = require('../lib/room');
const { recorderEvents, getJobsList } = require('../lib/recorder');
const watcher = require('../lib/watcher');
const chat = require('../lib/chat');
const { highlightsEvents } = require('../lib/highlights');
const { buildDashboardData } = require('./chat');

const router = Router();
const MAX_SSE_CLIENTS = 30;
let activeSseClients = 0;

function sendSse(res, eventName, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

router.get('/api/events/stream', (req, res) => {
  if (activeSseClients >= MAX_SSE_CLIENTS) {
    return res.status(429).json({ error: 'too many active event streams' });
  }
  activeSseClients++;

  const channelsRaw = String(req.query.channels || '').split(',').map((s) => s.trim()).filter(Boolean);
  const channels = new Set(channelsRaw);
  const chatUser = req.query.chat ? normalizeUsername(String(req.query.chat)) : '';
  const sinceId = Number(req.query.sinceId) || 0;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const cleanups = [];

  // ── Jobs & recordings channels ──
  if (channels.has('jobs')) {
    sendSse(res, 'jobs', getJobsList());
    const onJobs = (list) => sendSse(res, 'jobs', list);
    const onRecordings = () => sendSse(res, 'recordings', { updatedAt: Date.now() });
    recorderEvents.on('jobs', onJobs);
    recorderEvents.on('recordings', onRecordings);
    cleanups.push(() => {
      recorderEvents.off('jobs', onJobs);
      recorderEvents.off('recordings', onRecordings);
    });
  }

  // ── Highlights cut progress channel ──
  if (channels.has('highlights')) {
    const onCutProgress = (ev) => sendSse(res, 'cut_progress', ev);
    highlightsEvents.on('cut_progress', onCutProgress);
    cleanups.push(() => highlightsEvents.off('cut_progress', onCutProgress));
  }

  // ── Watchlist channel ──
  if (channels.has('watch')) {
    sendSse(res, 'watch_list', watcher.getWatchlist());
    const onWatchList = (wl) => sendSse(res, 'watch_list', wl);
    const onWatchEvent = (ev) => sendSse(res, 'watch_event', ev);
    watcher.watchEventsEmitter.on('list', onWatchList);
    watcher.watchEventsEmitter.on('event', onWatchEvent);
    cleanups.push(() => {
      watcher.watchEventsEmitter.off('list', onWatchList);
      watcher.watchEventsEmitter.off('event', onWatchEvent);
    });
  }

  // ── Single-room chat channel ──
  if (chatUser) {
    const s = chat.getSession(chatUser);
    sendSse(res, 'chat_snapshot', s
      ? {
          state: s.state,
          error: s.error,
          viewerCount: s.viewerCount,
          events: s.snapshot(sinceId),
          lastEventId: s.nextId - 1,
        }
      : { state: 'idle', events: [], lastEventId: 0 });

    const onChatEvent = ({ username, event, session }) => {
      if (username !== chatUser) return;
      sendSse(res, 'chat_event', { event, state: session.state, viewerCount: session.viewerCount });
    };
    const onChatState = ({ username, session }) => {
      if (username !== chatUser) return;
      sendSse(res, 'chat_state', { state: session.state, error: session.error, viewerCount: session.viewerCount });
    };
    chat.chatEvents.on('event', onChatEvent);
    chat.chatEvents.on('state', onChatState);
    cleanups.push(() => {
      chat.chatEvents.off('event', onChatEvent);
      chat.chatEvents.off('state', onChatState);
    });
  }

  // ── Dashboard unified channel (throttled to max 1 push / 500ms) ──
  if (channels.has('dashboard')) {
    sendSse(res, 'dashboard', buildDashboardData());
    let dashTimer = null;
    const onAnyChat = () => {
      if (dashTimer) return;
      dashTimer = setTimeout(() => {
        dashTimer = null;
        sendSse(res, 'dashboard', buildDashboardData());
      }, 500);
    };
    chat.chatEvents.on('event', onAnyChat);
    chat.chatEvents.on('state', onAnyChat);
    cleanups.push(() => {
      if (dashTimer) clearTimeout(dashTimer);
      chat.chatEvents.off('event', onAnyChat);
      chat.chatEvents.off('state', onAnyChat);
    });
  }

  // Keepalive comment every 15s to prevent proxy/browser idle timeouts
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': keepalive\n\n');
    }
  }, 15_000);
  heartbeat.unref();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeSseClients = Math.max(0, activeSseClients - 1);
    clearInterval(heartbeat);
    for (const fn of cleanups) { try { fn(); } catch {} }
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

module.exports = router;
