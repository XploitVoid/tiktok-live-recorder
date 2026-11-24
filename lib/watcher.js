// lib/watcher.js — Auto-watch: poll TikTok users and auto-record when live.
// Persisted list of usernames to poll; auto-records when they go live and
// surfaces events for the frontend to show as notifications.

const { EventEmitter } = require('node:events');
const fs = require('fs');
const path = require('path');
const { getProvider, normalizePlatform, sessionKey } = require('./providers');
const { startRecording, hasActiveJobFor } = require('./recorder');
const { safeError, sanitizeQuality, sanitizeAudioBitrate, atomicWriteFileSync } = require('./utils');
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

function normalizeHHMM(val) {
  if (typeof val !== 'string' || !val.trim()) return null;
  const m = val.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function isWithinSchedule(now, startHHMM, endHHMM) {
  if (!startHHMM || !endHHMM) return true;
  const parseMin = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = parseMin(startHHMM);
  const end = parseMin(endHHMM);
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  // Overnight schedule (e.g. 18:00 -> 03:00)
  return cur >= start || cur < end;
}

function normalizeMinViewers(val) {
  if (val == null || val === '' || Number(val) <= 0) return null;
  const n = Math.floor(Number(val));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000_000) : null;
}

function loadWatchlist() {
  try {
    const raw = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.list)) {
      watchlist = data.list
        .map((e) => {
          const platform = normalizePlatform(e?.platform, 'tiktok');
          const provider = getProvider(platform);
          const username = provider.normalizeUsername(e?.username);
          if (!username) return null;
          return {
            ...e,
            platform,
            username,
            autoRecord: !!e.autoRecord,
            quality: sanitizeQuality(e.quality, null),
            audioOnly: !!e.audioOnly,
            audioBitrate: sanitizeAudioBitrate(e.audioBitrate, null),
            recordChat: e.recordChat !== false,
            priority: e.priority === 'high' ? 'high' : 'normal',
            accountId: typeof e.accountId === 'string' && e.accountId ? e.accountId : null,
            minViewers: normalizeMinViewers(e.minViewers),
            scheduleStart: normalizeHHMM(e.scheduleStart),
            scheduleEnd: normalizeHHMM(e.scheduleEnd),
            _lastPolledAt: 0,
            // Reset runtime status on startup so live channels re-trigger autoRecord after restart.
            lastStatus: null,
            _autoRecordedThisLive: false,
            _nextRecordAttemptAt: 0,
            _recordFailedNotifiedThisLive: false,
            _lastRoomId: null,
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
    atomicWriteFileSync(WATCHLIST_FILE, JSON.stringify({ list: watchlist, pollSeconds }, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (e) { console.warn('saveWatchlist:', e.message); }
}

// ── Polling ──

const pollingUsers = new Set();

async function pollOne(entry) {
  const platform = normalizePlatform(entry.platform, 'tiktok');
  const key = sessionKey(platform, entry.username);
  if (pollingUsers.has(key)) return;
  pollingUsers.add(key);
  entry._lastPolledAt = Date.now();
  try {
    const provider = getProvider(platform);
    const apiData = await provider.fetchLiveStatus(entry.username, {
      accountId: entry.accountId || undefined,
    });
    // Guard against entry removal while the upstream fetch was in flight.
    if (!watchlist.includes(entry)) return;

    const live = provider.isLive(apiData);
    const wasLive = entry.lastStatus === 'live';
    const roomId = apiData?.user?.roomId || apiData?.liveRoom?.roomId || apiData?.stream?.id || null;
    const newBroadcast = live && wasLive && roomId && entry._lastRoomId && String(roomId) !== String(entry._lastRoomId);
    entry._lastRoomId = live ? (roomId ? String(roomId) : entry._lastRoomId) : null;
    entry.lastTitle = apiData?.liveRoom?.title || apiData?.stream?.title || null;
    entry.lastViewerCount = apiData?.liveRoom?.liveRoomStats?.userCount ?? apiData?.stream?.viewersCount ?? null;
    entry.lastError = null;  // clear stale error on successful fetch

    if ((live && !wasLive) || newBroadcast) {
      entry.lastStatus = 'live';
      entry.lastChangedAt = Date.now();
      entry._autoRecordedThisLive = false;
      entry._nextRecordAttemptAt = 0;
      entry._recordFailedNotifiedThisLive = false;
      pushEvent({
        type: 'went_live',
        platform,
        username: entry.username,
        title: entry.lastTitle,
        viewerCount: entry.lastViewerCount,
      });
      notifyEvent('went_live', {
        platform,
        username: entry.username,
        title: entry.lastTitle,
        viewerCount: entry.lastViewerCount,
      }).catch(() => {});
    } else if (!live && wasLive) {
      entry.lastStatus = 'offline';
      entry.lastChangedAt = Date.now();
      entry._autoRecordedThisLive = false;
      entry._nextRecordAttemptAt = 0;
      entry._recordFailedNotifiedThisLive = false;
      pushEvent({ type: 'went_offline', platform, username: entry.username });
    } else if (!entry.lastStatus) {
      entry.lastStatus = live ? 'live' : 'offline';
      entry.lastChangedAt = Date.now();
      if (!live) {
        entry._autoRecordedThisLive = false;
        entry._nextRecordAttemptAt = 0;
        entry._recordFailedNotifiedThisLive = false;
      }
    }

    if (live && entry.autoRecord && !entry._autoRecordedThisLive) {
      if (entry._nextRecordAttemptAt && Date.now() < entry._nextRecordAttemptAt) return;
      const scheduleOk = isWithinSchedule(new Date(), entry.scheduleStart, entry.scheduleEnd);
      const viewersOk = entry.minViewers == null || (entry.lastViewerCount != null && entry.lastViewerCount >= entry.minViewers);
      if (!scheduleOk || !viewersOk) return;

      if (hasActiveJobFor(entry.username, platform)) {
        entry._autoRecordedThisLive = true;
      } else {
        try {
          const r = await startRecording(entry.username, entry.quality, {
            platform,
            audioOnly: !!entry.audioOnly,
            audioBitrate: entry.audioBitrate || undefined,
            recordChat: entry.recordChat !== false,
            accountId: entry.accountId || undefined,
          });
          entry._autoRecordedThisLive = true;
          entry._nextRecordAttemptAt = 0;
          entry._recordFailedNotifiedThisLive = false;
          pushEvent({
            type: r.reused ? 'record_reused' : 'record_started',
            platform,
            username: entry.username,
            jobId: r.id,
            file: r.file,
            quality: r.quality,
          });
          if (!r.reused) {
            notifyEvent('record_started', {
              platform,
              username: entry.username,
              quality: r.quality,
              audioOnly: !!entry.audioOnly,
              file: r.file,
            }).catch(() => {});
          }
        } catch (e) {
          const errText = safeError(e);
          const longCooldown = e?.code === 'DISK_FULL' || e?.code === 'NO_FFMPEG' || e?.code === 'NO_STREAM' || e?.code === 'BAD_URL';
          entry._nextRecordAttemptAt = Date.now() + (longCooldown ? 180_000 : 60_000);
          if (!entry._recordFailedNotifiedThisLive) {
            entry._recordFailedNotifiedThisLive = true;
            pushEvent({
              type: 'record_failed',
              platform,
              username: entry.username,
              error: errText,
            });
            notifyEvent('record_failed', { platform, username: entry.username, error: errText }).catch(() => {});
          }
        }
      }
    }
  } catch (e) {
    entry.lastError = safeError(e);
  } finally {
    pollingUsers.delete(key);
  }
}

async function pollAll(onlyDue = false) {
  if (polling) return; // skip if previous poll is still running
  polling = true;
  try {
    const now = Date.now();
    const list = onlyDue
      ? watchlist.filter((e) => {
          const intervalMs = e.priority === 'high'
            ? Math.max(10_000, Math.floor((pollSeconds * 1000) / 2))
            : pollSeconds * 1000;
          return now - (e._lastPolledAt || 0) >= intervalMs;
        })
      : watchlist;
    if (list.length === 0) return;

    const concurrency = 5;
    let i = 0;
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
  // Tick every 5s so high-priority entries can poll faster than normal entries
  pollTimer = setInterval(() => { pollAll(true).catch(() => {}); }, 5000);
  pollTimer.unref?.();
  console.log(`[watch] polling normal=${pollSeconds}s high=${Math.max(10, Math.floor(pollSeconds / 2))}s — ${watchlist.length} users`);
}

function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Public API ──

function getWatchlist() {
  return {
    pollSeconds,
    list: watchlist.map((e) => ({
      platform: normalizePlatform(e.platform, 'tiktok'),
      username: e.username,
      autoRecord: !!e.autoRecord,
      quality: e.quality || null,
      audioOnly: !!e.audioOnly,
      audioBitrate: e.audioBitrate || null,
      recordChat: e.recordChat !== false,
      priority: e.priority === 'high' ? 'high' : 'normal',
      accountId: e.accountId || null,
      minViewers: e.minViewers ?? null,
      scheduleStart: e.scheduleStart || null,
      scheduleEnd: e.scheduleEnd || null,
      addedAt: e.addedAt,
      lastStatus: e.lastStatus || 'unknown',
      lastChangedAt: e.lastChangedAt || null,
      lastTitle: e.lastTitle || null,
      lastViewerCount: e.lastViewerCount ?? null,
      lastError: e.lastError || null,
    })),
  };
}

function addToWatchlist(username, {
  platform = 'tiktok', autoRecord, quality, audioOnly, audioBitrate, recordChat,
  priority, accountId, minViewers, scheduleStart, scheduleEnd,
} = {}) {
  const normPlatform = normalizePlatform(platform, 'tiktok');
  if (watchlist.find((e) => e.username === username && normalizePlatform(e.platform, 'tiktok') === normPlatform)) {
    return { error: 'already in watchlist', status: 409 };
  }
  if (watchlist.length >= MAX_WATCHLIST) {
    return { error: `watchlist full (max ${MAX_WATCHLIST})`, status: 429 };
  }
  const entry = {
    platform: normPlatform,
    username,
    autoRecord: !!autoRecord,
    quality: quality || null,
    audioOnly: !!audioOnly,
    audioBitrate: sanitizeAudioBitrate(audioBitrate, null),
    recordChat: recordChat !== false,
    priority: priority === 'high' ? 'high' : 'normal',
    accountId: typeof accountId === 'string' && accountId ? accountId : null,
    minViewers: normalizeMinViewers(minViewers),
    scheduleStart: normalizeHHMM(scheduleStart),
    scheduleEnd: normalizeHHMM(scheduleEnd),
    _lastPolledAt: 0,
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

function updateWatchEntry(username, {
  platform = 'tiktok', autoRecord, quality, audioOnly, audioBitrate, recordChat,
  priority, accountId, minViewers, scheduleStart, scheduleEnd,
} = {}) {
  const normPlatform = normalizePlatform(platform, 'tiktok');
  const entry = watchlist.find((e) => e.username === username && normalizePlatform(e.platform, 'tiktok') === normPlatform);
  if (!entry) return null;
  const turnedOnAuto = typeof autoRecord === 'boolean' && autoRecord && !entry.autoRecord;
  if (typeof autoRecord === 'boolean') entry.autoRecord = autoRecord;
  if (quality !== undefined) entry.quality = quality || null;
  if (typeof audioOnly === 'boolean') {
    entry.audioOnly = audioOnly;
    if (!audioOnly && entry.quality === 'ao' && quality === undefined) {
      entry.quality = null;
    }
  }
  if (audioBitrate !== undefined) entry.audioBitrate = sanitizeAudioBitrate(audioBitrate, null);
  if (typeof recordChat === 'boolean') entry.recordChat = recordChat;
  if (priority === 'high' || priority === 'normal') entry.priority = priority;
  if (accountId !== undefined) entry.accountId = (typeof accountId === 'string' && accountId) ? accountId : null;
  if (minViewers !== undefined) entry.minViewers = normalizeMinViewers(minViewers);
  if (scheduleStart !== undefined) entry.scheduleStart = normalizeHHMM(scheduleStart);
  if (scheduleEnd !== undefined) entry.scheduleEnd = normalizeHHMM(scheduleEnd);
  saveWatchlist();
  watchEventsEmitter.emit('list', getWatchlist());
  if (turnedOnAuto && entry.lastStatus === 'live') {
    entry._autoRecordedThisLive = false;
    entry._nextRecordAttemptAt = 0;
    entry._recordFailedNotifiedThisLive = false;
    pollOne(entry).then(() => watchEventsEmitter.emit('list', getWatchlist())).catch(() => {});
  }
  return { ok: true };
}

function removeFromWatchlist(username, platform = 'tiktok') {
  const normPlatform = normalizePlatform(platform, 'tiktok');
  const i = watchlist.findIndex((e) => e.username === username && normalizePlatform(e.platform, 'tiktok') === normPlatform);
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
  stopPoller,
  pollAll,
  getWatchlist,
  addToWatchlist,
  updateWatchEntry,
  removeFromWatchlist,
  setPollSeconds,
  getEvents,
  getWatchlistRaw,
  isWithinSchedule,
};
