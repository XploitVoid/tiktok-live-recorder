// lib/recorder.js — Recording job management.
// Manages ffmpeg recording processes, live stats, disk guard, segment rollover,
// auto-retry on network drops, and post-recording media metadata/retention.

const { EventEmitter } = require('node:events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  pickPreferredStream,
} = require('./room');
const { resolveFfmpeg, isFfmpegAvailable, buildRecordArgs } = require('./ffmpeg');
const chat = require('./chat');
const { timestamp, safeFilename, isValidStreamUrl, sanitizeAudioBitrate } = require('./utils');
const { analyzeRecording } = require('./highlights');
const realtimeHl = require('./realtime-highlights');
const { getSettings } = require('./settings');
const { getFfmpegProxyArgs } = require('./proxy-config');
const { notifyEvent } = require('./notifications');
const {
  RECORDINGS_DIR,
  getDiskStatus,
  enforceRetention,
  ensureThumbnailAndMeta,
  remuxFaststart,
} = require('./storage');

const MAX_CONCURRENT_JOBS = 10;
const FINISHED_JOB_TTL = 60 * 60 * 1000; // keep exited jobs for 1 hour
const RETRY_DELAYS_MS = [5000, 10000, 20000, 30000, 30000];
const CRITICAL_FREE_BYTES = 512 * 1024 * 1024; // 512 MB hard stop floor

const recorderEvents = new EventEmitter();
recorderEvents.setMaxListeners(100);

// id -> { id, username, quality, kind, file, startedAt, proc, stats, ... }
const jobs = new Map();
const pendingRetries = new Map(); // username -> timeoutId
const postProcessingFiles = new Set(); // files currently running remux/meta/highlights
let nextId = 1;
let lastStatsEmit = 0;
let shuttingDown = false;

function emitJobs(force = false) {
  const now = Date.now();
  if (!force && now - lastStatsEmit < 1000) return;
  lastStatsEmit = now;
  recorderEvents.emit('jobs', getJobsList());
}

// Periodically purge long-finished jobs to prevent memory leak.
setInterval(() => {
  const cutoff = Date.now() - FINISHED_JOB_TTL;
  for (const [id, j] of jobs) {
    if (j.exited && j.exitedAt && j.exitedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

// Periodic disk space safety check while recordings are active.
setInterval(() => {
  if (countActiveJobs() === 0) return;
  const disk = getDiskStatus();
  if (disk.freeBytes !== null && disk.freeBytes < CRITICAL_FREE_BYTES) {
    console.error('[recorder] CRITICAL: less than 512 MB disk space left — stopping active recordings!');
    notifyEvent('disk_low', { error: 'Less than 512 MB disk space left — active recordings stopped' }).catch(() => {});
    for (const j of jobs.values()) {
      if (!j.exited) {
        j.manualStop = true;
        j.lastErr = 'Stopped: disk space critically low (<512 MB)';
        try { j.proc.stdin?.write('q'); j.proc.stdin?.end(); } catch {}
      }
    }
  }
}, 20_000).unref();

// Stalled stream watchdog: detect frozen ffmpeg processes whose outTime and file size stop advancing.
function isJobStalled(job, now, timeoutMs, currentBytes) {
  if (!job || job.exited || job.manualStop || job.rollover || job.stalled) return false;
  if (!timeoutMs || timeoutMs <= 0) return false;
  if (typeof currentBytes === 'number' && currentBytes > (job.lastBytes || 0)) {
    job.lastBytes = currentBytes;
    job.lastProgressAt = now;
    return false;
  }
  return now - (job.lastProgressAt || job.startedAt) >= timeoutMs;
}

setInterval(() => {
  const { stalledTimeoutSec } = getSettings();
  const timeoutMs = (Number(stalledTimeoutSec) || 0) * 1000;
  if (timeoutMs <= 0) return;
  const now = Date.now();
  for (const j of jobs.values()) {
    if (j.exited || j.manualStop || j.rollover || j.stalled) continue;
    let size = null;
    try { size = fs.statSync(j.file).size; } catch {}
    if (isJobStalled(j, now, timeoutMs, size)) {
      const willRetry = !!getSettings().autoRetryRecord && (j.retryCount || 0) < RETRY_DELAYS_MS.length;
      const actionLabel = willRetry ? 'reconnecting' : 'stopped';
      console.warn(`[recorder] @${j.username} stream stalled (no progress for ${stalledTimeoutSec}s) — ${actionLabel}`);
      j.stalled = true;
      j.lastErr = `Stream stalled (no progress for ${stalledTimeoutSec}s) — ${actionLabel}`;
      notifyEvent('record_stalled', { username: j.username, error: j.lastErr }).catch(() => {});
      try { j.proc.stdin?.write('q'); j.proc.stdin?.end(); } catch {}
      const killTimer = setTimeout(() => {
        if (!j.exited) {
          try { j.proc.kill(); } catch {}
        }
      }, 5000);
      killTimer.unref();
    }
  }
}, 10_000).unref();

function hasActiveJobFor(username) {
  for (const j of jobs.values()) {
    if (!j.exited && j.username === username) return j;
  }
  return null;
}

function countActiveJobs() {
  let n = 0;
  for (const j of jobs.values()) if (!j.exited) n++;
  return n;
}

function activeFilePaths() {
  const set = new Set(postProcessingFiles);
  for (const j of jobs.values()) {
    if (!j.exited && j.file) set.add(j.file);
  }
  return set;
}

function cancelPendingRetry(username) {
  const t = pendingRetries.get(username);
  if (t) {
    clearTimeout(t);
    pendingRetries.delete(username);
  }
}

function parseStatsLine(line) {
  const timeM = line.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  const bitrateM = line.match(/bitrate=\s*([^\s]+)/);
  const speedM = line.match(/speed=\s*([^\s]+)/);
  const fpsM = line.match(/fps=\s*([\d.]+)/);
  if (!timeM && !bitrateM && !speedM) return null;
  return {
    outTime: timeM ? timeM[1].split('.')[0] : null,
    bitrate: bitrateM && bitrateM[1] !== 'N/A' ? bitrateM[1] : null,
    speed: speedM && speedM[1] !== 'N/A' ? speedM[1] : null,
    fps: fpsM ? Number(fpsM[1]) : null,
  };
}

function getNextRetryAttempt({ manualStop, rollover, autoRetryRecord, ranMs, retryCount }) {
  if (manualStop || rollover || !autoRetryRecord) return null;
  const attempt = ranMs >= 60_000 ? 0 : (Number(retryCount) || 0);
  return attempt < RETRY_DELAYS_MS.length ? attempt : null;
}

function notifyFinalOutcome(username, { file, exitCode, stalled, lastErr }) {
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(file).size; } catch {}
  const sizeMb = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(1) : null;
  if ((exitCode !== 0 && !(stalled && sizeBytes > 0)) || (stalled && sizeBytes <= 0)) {
    notifyEvent('record_failed', { username, error: lastErr || `ffmpeg exited ${exitCode}` }).catch(() => {});
  } else {
    notifyEvent('record_finished', { username, file: path.basename(file), sizeMb }).catch(() => {});
  }
}

function scheduleRetryAttempt(username, quality, part, idx, retryOpts = {}) {
  if (shuttingDown || idx >= RETRY_DELAYS_MS.length) {
    if (!shuttingDown && retryOpts.file) {
      notifyFinalOutcome(username, retryOpts);
    }
    return;
  }
  const delay = RETRY_DELAYS_MS[idx];
  console.log(`[recorder] @${username} checking live for auto-retry #${idx + 1} in ${delay}ms`);
  const t = setTimeout(async () => {
    pendingRetries.delete(username);
    if (shuttingDown || hasActiveJobFor(username)) return;
    try {
      const check = await fetchApiLive(username, {
        noCache: true,
        accountId: retryOpts.accountId,
      });
      if (shuttingDown || hasActiveJobFor(username)) return;
      if (isLiveFromApi(check)) {
        await startRecording(username, quality, {
          ...retryOpts,
          noCache: true,
          retryCount: idx + 1,
          part: part + 1,
        });
      } else if ((retryOpts.exitCode !== 0 || retryOpts.stalled) && idx === 0) {
        // Give one extra retry when the process died abnormally in case TikTok API status lagged.
        scheduleRetryAttempt(username, quality, part, idx + 1, retryOpts);
      } else if (retryOpts.file) {
        notifyFinalOutcome(username, retryOpts);
      }
    } catch (e) {
      console.warn(`[recorder] @${username} auto-retry #${idx + 1} failed:`, e?.message || e);
      if (e?.code === 'NOT_LIVE') {
        if (retryOpts.file) notifyFinalOutcome(username, retryOpts);
        return;
      }
      if (e?.code === 'DISK_FULL' || e?.code === 'NO_FFMPEG') {
        notifyEvent('record_failed', { username, error: e.message }).catch(() => {});
        return;
      }
      scheduleRetryAttempt(username, quality, part, idx + 1, retryOpts);
    }
  }, delay);
  t.unref();
  pendingRetries.set(username, t);
}

// Tracks in-flight startRecording calls per username to dedupe races.
const startingPromises = new Map();

function startRecording(username, quality, opts = {}) {
  cancelPendingRetry(username);
  const existing = hasActiveJobFor(username);
  if (existing) {
    return Promise.resolve({ reused: true, id: existing.id, file: path.basename(existing.file) });
  }
  const inFlight = startingPromises.get(username);
  if (inFlight) return inFlight;

  const p = _startRecordingInner(username, quality, opts).finally(() => {
    startingPromises.delete(username);
  });
  startingPromises.set(username, p);
  return p;
}

async function _startRecordingInner(username, quality, opts = {}) {
  const existing = hasActiveJobFor(username);
  if (existing) {
    return { reused: true, id: existing.id, file: path.basename(existing.file) };
  }
  if (countActiveJobs() >= MAX_CONCURRENT_JOBS) {
    const err = new Error(`max concurrent recordings (${MAX_CONCURRENT_JOBS}) reached`);
    err.code = 'LIMIT';
    throw err;
  }
  if (!isFfmpegAvailable()) {
    const err = new Error('ffmpeg is not installed on the server');
    err.code = 'NO_FFMPEG';
    throw err;
  }

  const disk = getDiskStatus();
  if (disk.lowSpace) {
    const freeGb = disk.freeBytes != null ? (disk.freeBytes / 1024 ** 3).toFixed(2) : '?';
    const err = new Error(`low disk space (${freeGb} GB free)`);
    err.code = 'DISK_FULL';
    throw err;
  }

  const apiData = await fetchApiLive(username, {
    noCache: !!opts.noCache,
    accountId: opts.accountId,
  });
  if (!isLiveFromApi(apiData)) {
    const err = new Error('user not live');
    err.code = 'NOT_LIVE';
    throw err;
  }

  const streams = extractStreamUrls(apiData);
  const audioOnly = !!opts.audioOnly || quality === 'ao';
  const audioBitrate = sanitizeAudioBitrate(
    opts.audioBitrate !== undefined ? opts.audioBitrate : getSettings().defaultAudioBitrate,
    null,
  );
  let codec = 'h264', qKey = quality;
  if (typeof quality === 'string' && quality.includes(':')) {
    const [c, k] = quality.split(':');
    codec = c; qKey = k;
  }
  let pick = null;
  if (audioOnly && (!qKey || qKey === 'ao')) {
    if (streams.flv?.ao) pick = { url: streams.flv.ao, kind: 'flv', quality: 'ao' };
    else if (streams.cmaf?.ao) pick = { url: streams.cmaf.ao, kind: 'cmaf', quality: 'ao' };
    else if (streams.flv?.ld) pick = { url: streams.flv.ld, kind: 'flv', quality: 'ld' };
    else if (streams.flv?.sd) pick = { url: streams.flv.sd, kind: 'flv', quality: 'sd' };
  }
  if (!pick) {
    if (codec === 'hevc' && qKey && streams.hevc?.flv?.[qKey]) {
      pick = { url: streams.hevc.flv[qKey], kind: 'flv', quality: `hevc:${qKey}` };
    } else if (codec === 'hevc' && qKey && streams.hevc?.hls?.[qKey]) {
      pick = { url: streams.hevc.hls[qKey], kind: 'hls', quality: `hevc:${qKey}` };
    } else if (qKey && streams.flv?.[qKey]) {
      pick = { url: streams.flv[qKey], kind: 'flv', quality: qKey };
    } else if (qKey && streams.cmaf?.[qKey]) {
      pick = { url: streams.cmaf[qKey], kind: 'cmaf', quality: qKey };
    } else if (qKey && streams.hlsByQuality?.[qKey]) {
      pick = { url: streams.hlsByQuality[qKey], kind: 'hls', quality: qKey };
    } else {
      pick = pickPreferredStream(streams);
    }
  }
  if (!pick) {
    const err = new Error('no stream URL available');
    err.code = 'NO_STREAM';
    throw err;
  }
  if (!isValidStreamUrl(pick.url)) {
    const err = new Error('stream URL has invalid protocol');
    err.code = 'BAD_URL';
    throw err;
  }

  const partSuffix = opts.part && opts.part > 1 ? `_p${opts.part}` : '';
  const file = path.join(RECORDINGS_DIR, `${safeFilename(username)}_${timestamp()}${partSuffix}.mp4`);
  const ffmpegBin = resolveFfmpeg();
  const args = buildRecordArgs({ ...pick, audioOnly, audioBitrate }, file, getFfmpegProxyArgs());
  const proc = spawn(ffmpegBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });

  // Best-effort: open chat capture, write events to <file>.events.jsonl
  const eventsFile = file.replace(/\.mp4$/i, '.events.jsonl');
  let chatWriter = null;
  let chatListener = null;
  let chatAcquired = true;
  let procExited = false;
  const detector = new realtimeHl.RealtimeHighlightDetector(username);
  chat.ensureSession(username, { source: 'recorder', accountId: opts.accountId || null })
    .then((session) => {
      if (procExited) {
        chatAcquired = false;
        chat.releaseRecorderSession(username, null, null);
        return;
      }
      chatWriter = session.attachFile(eventsFile);
      chatListener = (ev) => detector.onEvent(ev);
      session.listeners.add(chatListener);
    })
    .catch((e) => {
      chatAcquired = false;
      console.warn(`[chat] failed for @${username}:`, e?.message || e);
    });

  const id = nextId++;
  const job = {
    id,
    username,
    kind: pick.kind,
    quality: audioOnly ? 'ao' : pick.quality,
    requestedQuality: quality,
    audioOnly,
    audioBitrate,
    accountId: opts.accountId || null,
    file,
    eventsFile,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    lastOutTime: null,
    lastBytes: 0,
    exitedAt: null,
    proc,
    exited: false,
    manualStop: false,
    rollover: false,
    stalled: false,
    retryCount: Number(opts.retryCount || 0),
    part: Number(opts.part || 1),
    stats: null,
    lastErr: '',
    segmentTimer: null,
  };

  // Optional segment rollover timer
  const { segmentMinutes } = getSettings();
  if (segmentMinutes > 0) {
    job.segmentTimer = setTimeout(() => {
      if (job.exited || job.manualStop) return;
      console.log(`[recorder] @${username} segment limit (${segmentMinutes}m) reached — rolling over`);
      job.rollover = true;
      try { job.proc.stdin?.write('q'); job.proc.stdin?.end(); } catch {}
    }, segmentMinutes * 60_000);
    job.segmentTimer.unref();
  }

  let lastErr = '';
  const markExited = (code, errMsg) => {
    if (procExited) return;
    procExited = true;
    if (job.segmentTimer) {
      clearTimeout(job.segmentTimer);
      job.segmentTimer = null;
    }
    if (errMsg) lastErr = (lastErr + '\n' + errMsg).slice(-500);
    job.exited = true;
    job.exitCode = code;
    job.exitedAt = Date.now();
    try { job.finalSizeBytes = fs.statSync(job.file).size; } catch { job.finalSizeBytes = null; }
    if (!job.lastErr) job.lastErr = lastErr.trim();
    if (job.file) postProcessingFiles.add(job.file);

    if (chatAcquired) {
      chatAcquired = false;
      chat.releaseRecorderSession(username, chatWriter, chatListener);
      chatWriter = null;
      chatListener = null;
    }

    emitJobs(true);

    const retryOpts = {
      audioOnly: job.audioOnly,
      audioBitrate: job.audioBitrate,
      accountId: job.accountId,
      file: job.file,
      exitCode: code,
      stalled: job.stalled,
      lastErr: job.lastErr,
    };
    // Rollover to next part if segment split triggered
    if (job.rollover && !job.manualStop) {
      setImmediate(() => {
        startRecording(username, quality, { ...retryOpts, noCache: true, part: job.part + 1, retryCount: 0 })
          .catch((e) => console.warn(`[recorder] @${username} rollover failed:`, e?.message || e));
      });
    } else {
      const attempt = getNextRetryAttempt({
        manualStop: job.manualStop,
        rollover: job.rollover,
        autoRetryRecord: getSettings().autoRetryRecord,
        ranMs: Date.now() - job.startedAt,
        retryCount: job.retryCount,
      });
      if (attempt !== null) {
        console.log(`[recorder] @${username} exited (${code}) — scheduling recovery`);
        scheduleRetryAttempt(username, quality, job.part, attempt, retryOpts);
      } else if (!job.rollover) {
        if ((code !== 0 || job.stalled) && !job.manualStop) {
          notifyEvent('record_failed', { username, error: job.lastErr || `ffmpeg exited ${code}` }).catch(() => {});
        } else {
          let sizeMb = null;
          if (job.finalSizeBytes != null) sizeMb = (job.finalSizeBytes / (1024 * 1024)).toFixed(1);
          notifyEvent('record_finished', { username, file: path.basename(job.file), sizeMb }).catch(() => {});
        }
      }
    }

    // Post-process: remux +faststart, thumbnail/sprite + ffprobe metadata, highlights, retention cleanup
    setImmediate(async () => {
      const recordingName = path.basename(job.file);
      try {
        if (!shuttingDown && !job.stalled && code === 0) {
          await remuxFaststart(recordingName).catch(() => {});
          try { job.finalSizeBytes = fs.statSync(job.file).size; } catch {}
        }

        await ensureThumbnailAndMeta(recordingName, { force: true }).catch(() => {});

        if (!process.env.DISABLE_AUTO_HIGHLIGHTS && job?.file) {
          try {
            const result = analyzeRecording(recordingName);
            if (result.ok) {
              console.log(`[highlights] @${username} → ${result.candidates.length} candidate(s) in ${recordingName}`);
            }
          } catch (e) {
            console.warn(`[highlights] analysis failed:`, e?.message || e);
          }
          if (detector.marks.length > 0) {
            try {
              const results = await detector.autoCut(recordingName, job.startedAt);
              const ok = results.filter((r) => r.ok).length;
              if (ok > 0) console.log(`[realtime-hl] @${username} auto-cut ${ok} clip(s)`);
            } catch (e) {
              console.warn(`[realtime-hl] auto-cut error:`, e?.message || e);
            }
          }
        }
      } finally {
        if (job.file) postProcessingFiles.delete(job.file);
        try { enforceRetention(activeFilePaths()); } catch {}
        recorderEvents.emit('recordings');
      }
    });
  };

  proc.stderr.on('data', (b) => {
    const chunk = b.toString();
    const lines = chunk.split(/[\r\n]+/).filter(Boolean);
    for (const line of lines) {
      const stats = parseStatsLine(line);
      if (stats) {
        job.stats = stats;
        if (stats.outTime && stats.outTime !== job.lastOutTime) {
          job.lastOutTime = stats.outTime;
          job.lastProgressAt = Date.now();
        }
        emitJobs(false);
      } else {
        lastErr = (lastErr + '\n' + line).slice(-500);
      }
    }
  });
  proc.on('error', (err) => {
    console.warn(`[recorder] @${username} ffmpeg error:`, err?.message || err);
    markExited(-1, err?.message || String(err));
  });
  proc.on('exit', (code) => markExited(code));

  jobs.set(id, job);
  emitJobs(true);

  return {
    id, username, kind: pick.kind, quality: audioOnly ? 'ao' : pick.quality,
    audioOnly, audioBitrate,
    file: path.basename(file), eventsFile: path.basename(eventsFile),
    title: apiData?.liveRoom?.title || null,
    reused: false,
  };
}

async function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  cancelPendingRetry(job.username);
  job.manualStop = true;
  if (job.exited) return { ok: true, alreadyExited: true, username: job.username };

  try { job.proc.stdin?.write('q'); } catch {}
  try { job.proc.stdin?.end(); } catch {}

  const finished = await new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (graceful) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(graceful);
    };
    job.proc.once('exit', () => finish(true));
    timer = setTimeout(() => finish(false), 8000);
  });

  if (!finished) {
    try { job.proc.kill(); } catch {}
  }

  let size = null;
  try { size = fs.statSync(job.file).size; } catch {}
  emitJobs(true);
  return {
    ok: true, graceful: finished,
    file: path.basename(job.file), sizeBytes: size,
    username: job.username,
  };
}

function getJobsList() {
  const out = [];
  const sizeCache = new Map();
  for (const j of jobs.values()) {
    let size;
    if (j.exited && j.finalSizeBytes !== undefined) {
      size = j.finalSizeBytes;
    } else {
      size = sizeCache.get(j.file);
      if (size === undefined) {
        try { size = fs.statSync(j.file).size; } catch { size = null; }
        sizeCache.set(j.file, size);
      }
    }
    out.push({
      id: j.id,
      username: j.username,
      kind: j.kind,
      quality: j.quality,
      file: path.basename(j.file),
      startedAt: j.startedAt,
      exitedAt: j.exitedAt ?? null,
      exited: j.exited,
      exitCode: j.exitCode ?? null,
      sizeBytes: size,
      retryCount: j.retryCount || 0,
      part: j.part || 1,
      stats: !j.exited ? j.stats : null,
      lastErr: j.exited ? j.lastErr || null : null,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

async function shutdownAll() {
  shuttingDown = true;
  for (const t of pendingRetries.values()) clearTimeout(t);
  pendingRetries.clear();
  const waiters = [];
  for (const j of jobs.values()) {
    j.manualStop = true;
    if (!j.exited) {
      try { j.proc.stdin?.write('q'); j.proc.stdin?.end(); } catch {}
      waiters.push(new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = (kill) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (kill) { try { j.proc.kill(); } catch {} }
          resolve();
        };
        j.proc.once('exit', () => finish(false));
        timer = setTimeout(() => finish(true), 6000);
      }));
    }
  }
  await Promise.all(waiters);
}

module.exports = {
  RECORDINGS_DIR,
  MAX_CONCURRENT_JOBS,
  recorderEvents,
  startRecording,
  stopJob,
  getJobsList,
  hasActiveJobFor,
  activeFilePaths,
  shutdownAll,
  getNextRetryAttempt,
  isJobStalled,
};
