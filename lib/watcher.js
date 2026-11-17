// lib/watcher.js — Auto-watch: poll TikTok users and auto-record when live.
// Persisted list of usernames to poll; auto-records when they go live and
// surfaces events for the frontend to show as notifications.

const { EventEmitter } = require('node:events');
const fs = require('fs');
const path = require('path');
const { fetchApiLive, isLiveFromApi, normalizeUsername } = require('./room');
const { startRecording, hasActiveJobFor } = require('./recorder');
const { safeError, sanitizeQuality, sanitizeAudioBitrate } = require('./utils');
const { notifyEvent } = require('./notifications');

const watchEventsEmitter = new EventEmitter();
watchEventsEmitter.setMaxListeners(100);

const WATCHLIST_FILE = path.resolve(__dirname, '..', 'watchlist.json');
const DEFAULT_POLL_SECONDS = Number(process.env.WATCH_POLL_SECONDS) || 30;
const MAX_POLL_SECONDS = 300; // 5 minutes max
const MAX_WATCHLIST = 50;

let watchlist = []; // { username, autoRecord, quality, addedAt, lastStatus, ... }
let pollSeconds = DEFAULT_POLL_SECONDS;
let polling = false; // guard against concurrent pollAll runs
const watchEvents = []; // ring buffer of { id, ts, type, username, ... }
let nextEventId = 1;
let pollTimer = null;

// ── Internal helpers ──

function pushEvent(ev) {
  ev.id = nextEventId++;
  ev.ts = Date.now();
  watchEvents.push(ev);
  // cap ring buffer
  while (watchEvents.length > 200) watchEvents.shift();
  watchEventsEmitter.emit('event', ev);
}

function loadWatchlist() {
  try {
    const raw = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.list)) {
      watchlist = data.list
        .map((e) => {
          const username = normalizeUsername(e?.username);
          if (!username) return null;
          return {
            ...e,
            username,
            autoRecord: !!e.autoRecord,
            quality: sanitizeQuality(e.quality, null),
            audioOnly: !!e.audioOnly,
            audioBitrate: sanitizeAudioBitrate(e.audioBitrate, null),
            // Reset runtime status on startup so live channels re-trigger autoRecord after restart.
            lastStatus: null,
            _autoRecordedThisLive: false,
          };
        })
        .filter(Boolean)
        .slice(0, MAX_WATCHLIST);
    }
    if (typeof data?.pollSeconds === 'number' && Number.isFinite(data.pollSeconds)) {
      pollSeconds = Math.max(10, Math.min(Math.floor(data.pollSeconds), MAX_POLL_SECONDS));
    }
  } catch {}
}

function saveWatchlist() {
  try {
    // Atomic write to prevent corruption on crash mid-write.
    const tmp = WATCHLIST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ list: watchlist, pollSeconds }, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
    fs.renameSync(tmp, WATCHLIST_FILE);
  } catch (e) { console.warn('saveWatchlist:', e.message); }
}

// ── Polling ──

async function pollOne(entry) {
  try {
    const apiData = await fetchApiLive(entry.username);
    // Guard against entry removal while the upstream fetch was in flight.
    if (!watchlist.includes(entry)) return;

    const live = isLiveFromApi(apiData);
    const wasLive = entry.lastStatus === 'live';
    entry.lastTitle = apiData?.liveRoom?.title || null;
    entry.lastViewerCount = apiData?.liveRoom?.liveRoomStats?.userCount ?? null;
    entry.lastError = null;  // clear stale error on successful fetch

    if (live && !wasLive) {
      entry.lastStatus = 'live';
      entry.lastChangedAt = Date.now();
      entry._autoRecordedThisLive = false;
      pushEvent({
        type: 'went_live',
        username: entry.username,
        title: entry.lastTitle,
        viewerCount: entry.lastViewerCount,
      });
      notifyEvent('went_live', {
        username: entry.username,
        title: entry.lastTitle,
        viewerCount: entry.lastViewerCount,
      }).catch(() => {});
    } else if (!live && wasLive) {
      entry.lastStatus = 'offline';
      entry.lastChangedAt = Date.now();
      entry._autoRecordedThisLive = false;
      pushEvent({ type: 'went_offline', username: entry.username });
    } else if (!entry.lastStatus) {
      entry.lastStatus = live ? 'live' : 'offline';
      entry.lastChangedAt = Date.now();
      if (!live) entry._autoRecordedThisLive = false;
    }

    if (live && entry.autoRecord && !entry._autoRecordedThisLive) {
      if (hasActiveJobFor(entry.username)) {
        entry._autoRecordedThisLive = true;
      } else {
        try {
          const r = await startRecording(entry.username, entry.quality, {
            audioOnly: !!entry.audioOnly,
            audioBitrate: entry.audioBitrate || undefined,
          });
          entry._autoRecordedThisLive = true;
          pushEvent({
            type: r.reused ? 'record_reused' : 'record_started',
            username: entry.username,
            jobId: r.id,
            file: r.file,
            quality: r.quality,
          });
          if (!r.reused) {
            notifyEvent('record_started', {
              username: entry.username,
              quality: r.quality,
              audioOnly: !!entry.audioOnly,
              file: r.file,
            }).catch(() => {});
          }
        } catch (e) {
          const errText = safeError(e);
          pushEvent({
            type: 'record_failed',
            username: entry.username,
            error: errText,
          });
          notifyEvent('record_failed', { username: entry.username, error: errText }).catch(() => {});
        }
      }
    }
  } catch (e) {
    entry.lastError = safeError(e);
  }
}

async function pollAll() {
  if (polling) return; // skip if previous poll is still running
  polling = true;
  try {
    // Process in small parallel batches. Inside lib/room.js the apiCache
    // collapses duplicate concurrent calls, so the cost here is just the
    // upstream TikTok hit per user. A small concurrency limit keeps memory
    // usage and rate-limit pressure bounded.
    const concurrency = 5;
    let i = 0;
    const list = watchlist;
    async function worker() {
      while (i < list.length) {
        const entry = list[i++];
        await pollOne(entry);
      }
    }
    const workers = Array.from(
      { length: Math.min(concurrency, list.length) },
      () => worker()
    );
    await Promise.all(workers);
    watchEventsEmitter.emit('list', getWatchlist());
  } finally {
    polling = false;
  }
}

function schedulePoller() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollAll().catch(() => {}); }, pollSeconds * 1000);
  console.log(`[watch] polling every ${pollSeconds}s — ${watchlist.length} users`);
}

// ── Public API ──

function getWatchlist() {
  return {
    pollSeconds,
    list: watchlist.map((e) => ({
      username: e.username,
      autoRecord: !!e.autoRecord,
      quality: e.quality || null,
      audioOnly: !!e.audioOnly,
      audioBitrate: e.audioBitrate || null,
      addedAt: e.addedAt,
      lastStatus: e.lastStatus || 'unknown',
      lastChangedAt: e.lastChangedAt || null,
      lastTitle: e.lastTitle || null,
      lastViewerCount: e.lastViewerCount ?? null,
      lastError: e.lastError || null,
    })),
  };
}

function addToWatchlist(username, { autoRecord, quality, audioOnly, audioBitrate } = {}) {
  if (watchlist.find((e) => e.username === username)) {
    return { error: 'already in watchlist', status: 409 };
  }
  if (watchlist.length >= MAX_WATCHLIST) {
    return { error: `watchlist full (max ${MAX_WATCHLIST})`, status: 429 };
  }
  const entry = {
    username,
    autoRecord: !!autoRecord,
    quality: quality || null,
    audioOnly: !!audioOnly,
    audioBitrate: sanitizeAudioBitrate(audioBitrate, null),
    addedAt: Date.now(),
    lastStatus: null,
  };
  watchlist.push(entry);
  saveWatchlist();
  watchEventsEmitter.emit('list', getWatchlist());
  // Probe immediately so UI shows status quickly.
  pollOne(entry).then(() => watchEventsEmitter.emit('list', getWatchlist())).catch(() => {});
  return { ok: true, entry };
}

function updateWatchEntry(username, { autoRecord, quality, audioOnly, audioBitrate } = {}) {
  const entry = watchlist.find((e) => e.username === username);
  if (!entry) return null;
  const turnedOnAuto = typeof autoRecord === 'boolean' && autoRecord && !entry.autoRecord;
  if (typeof autoRecord === 'boolean') entry.autoRecord = autoRecord;
  if (quality !== undefined) entry.quality = quality || null;
  if (typeof audioOnly === 'boolean') entry.audioOnly = audioOnly;
  if (audioBitrate !== undefined) entry.audioBitrate = sanitizeAudioBitrate(audioBitrate, null);
  saveWatchlist();
  watchEventsEmitter.emit('list', getWatchlist());
  if (turnedOnAuto && entry.lastStatus === 'live') {
    entry._autoRecordedThisLive = false;
    pollOne(entry).then(() => watchEventsEmitter.emit('list', getWatchlist())).catch(() => {});
  }
  return { ok: true };
}

function removeFromWatchlist(username) {
  const i = watchlist.findIndex((e) => e.username === username);
  if (i < 0) return false;
  watchlist.splice(i, 1);
  saveWatchlist();
  watchEventsEmitter.emit('list', getWatchlist());
  return true;
}

function setPollSeconds(n) {
  pollSeconds = Math.max(10, Math.min(Math.floor(n), MAX_POLL_SECONDS));
  saveWatchlist();
  schedulePoller();
  return pollSeconds;
}

function getEvents(sinceId = 0) {
  return watchEvents.filter((e) => e.id > sinceId);
}

// Returns raw watchlist array (for live-streams bulk endpoint).
function getWatchlistRaw() {
  return watchlist;
}

module.exports = {
  watchEventsEmitter,
  loadWatchlist,
  schedulePoller,
  pollAll,
  getWatchlist,
  addToWatchlist,
  updateWatchEntry,
  removeFromWatchlist,
  setPollSeconds,
  getEvents,
  getWatchlistRaw,
};
