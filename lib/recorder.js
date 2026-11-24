// lib/recorder.js — Recording job management.
// Manages ffmpeg recording processes, live stats, disk guard, segment rollover,
// auto-retry on network drops, and post-recording media metadata/retention.

const { EventEmitter } = require('node:events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getProvider, normalizePlatform, sessionKey } = require('./providers');
const { resolveFfmpeg, isFfmpegAvailable, buildRecordArgs } = require('./ffmpeg');
const chat = require('./chat');
const { timestamp, safeFilename, isValidStreamUrl, sanitizeAudioBitrate, renderRecordingFilename, atomicWriteFileSync, RESERVED_RECORDING_SUBDIRS } = require('./utils');
const { analyzeRecording } = require('./highlights');
const realtimeHl = require('./realtime-highlights');
const { getSettings, parseEnvBoolFlag } = require('./settings');
const { getFfmpegProxyArgs } = require('./proxy-config');
const { notifyEvent } = require('./notifications');
const db = require('./db');
const {
  RECORDINGS_DIR,
  CLIPS_DIR,
  getDiskStatus,
  enforceRetention,
  ensureThumbnailAndMeta,
  remuxFaststart,
  remuxTsToMp4,
  mergeRecordingParts,
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
const postProcessingPromises = new Map(); // file -> Promise
const liveClipProcs = new Set();
const mergedSessionKeys = new Set();
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

function safeWriteQuit(proc) {
  try {
    if (proc?.stdin && !proc.stdin.destroyed && !proc.stdin.writableEnded) {
      proc.stdin.write('q');
      proc.stdin.end();
    }
  } catch {}
}

function gracefulStopJob(job, killAfterMs = 6000) {
  if (!job || job.exited || job.stopping) return;
  job.stopping = true;
  safeWriteQuit(job.proc);
  const killTimer = setTimeout(() => {
    if (!job.exited) {
      try { job.proc.kill('SIGKILL'); } catch {}
    }
  }, killAfterMs);
  killTimer.unref();
}

// Periodic disk space safety check while recordings are active.
setInterval(() => {
  if (countActiveJobs() === 0) return;
  const disk = getDiskStatus();
  if (disk.freeBytes !== null && disk.freeBytes < CRITICAL_FREE_BYTES) {
    console.error('[recorder] CRITICAL: less than 512 MB disk space left — stopping active recordings!');
    notifyEvent('disk_low', { error: 'Less than 512 MB disk space left — active recordings stopped' }).catch(() => {});
    for (const j of jobs.values()) {
      if (!j.exited && !j.stopping) {
        j.manualStop = true;
        j.lastErr = 'Stopped: disk space critically low (<512 MB)';
        gracefulStopJob(j, 5000);
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
    try { size = fs.statSync(j.captureFile || j.file).size; } catch {}
    if (isJobStalled(j, now, timeoutMs, size)) {
      const willRetry = !!getSettings().autoRetryRecord && (j.retryCount || 0) < RETRY_DELAYS_MS.length;
      const actionLabel = willRetry ? 'reconnecting' : 'stopped';
      console.warn(`[recorder] @${j.username} stream stalled (no progress for ${stalledTimeoutSec}s) — ${actionLabel}`);
      j.stalled = true;
      j.lastErr = `Stream stalled (no progress for ${stalledTimeoutSec}s) — ${actionLabel}`;
      notifyEvent('record_stalled', { platform: j.platform || 'tiktok', username: j.username, error: j.lastErr }).catch(() => {});
      gracefulStopJob(j, 5000);
    }
  }
}, 10_000).unref();

function hasActiveJobFor(username, platform = 'tiktok') {
  const normPlatform = normalizePlatform(platform);
  for (const j of jobs.values()) {
    if (!j.exited && j.username === username && (j.platform || 'tiktok') === normPlatform) return j;
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
    if (!j.exited) {
      if (j.file) set.add(j.file);
      if (j.captureFile) set.add(j.captureFile);
    }
  }
  return set;
}

function cancelPendingRetry(username, platform = 'tiktok') {
  const key = sessionKey(platform, username);
  const t = pendingRetries.get(key);
  if (t) {
    clearTimeout(t);
    pendingRetries.delete(key);
  }
}

function parseStatsLine(line) {
  const timeM = line.match(/time=(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/);
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

function isStatsOrSummaryLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return true;
  if (/^(?:frame|size)=\s*\d/i.test(trimmed)) return true;
  if (/^(?:\[[^\]]+\]\s*)?video:\d+/i.test(trimmed)) return true;
  if (/muxing overhead:/i.test(trimmed)) return true;
  return false;
}

/**
 * Buffer FFmpeg stderr chunks into complete CR/LF-delimited lines so
 * single-line progress updates split across pipe reads are not misclassified as errors.
 */
function createStderrParser({ onStats, onErrorLine } = {}) {
  let buf = '';
  const handleLine = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const stats = parseStatsLine(trimmed);
    if (stats) {
      onStats?.(stats);
    } else if (!isStatsOrSummaryLine(trimmed)) {
      onErrorLine?.(trimmed);
    }
  };
  return {
    push(chunk) {
      if (chunk == null) return;
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf.charCodeAt(i);
        if (ch === 10 || ch === 13) {
          handleLine(buf.slice(start, i));
          start = i + 1;
        }
      }
      buf = start > 0 ? buf.slice(start) : buf;
      if (buf.length > 8192) buf = buf.slice(-4096);
    },
    flush() {
      if (!buf) return;
      const rem = buf;
      buf = '';
      handleLine(rem);
    },
  };
}

function shouldExposeStderrOnExit({ code, manualStop, errMsg }) {
  return Boolean(errMsg) || (code !== 0 && !manualStop);
}

function getNextRetryAttempt({ manualStop, rollover, autoRetryRecord, ranMs, retryCount }) {
  if (manualStop || rollover || !autoRetryRecord) return null;
  const attempt = ranMs >= 60_000 ? 0 : (Number(retryCount) || 0);
  return attempt < RETRY_DELAYS_MS.length ? attempt : null;
}

function parseHmsToSec(hms) {
  if (typeof hms !== 'string') return null;
  const m = hms.trim().match(/^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function maybeAutoMergeSessionParts(username, sessionParts, platform = 'tiktok') {
  if (shuttingDown || !getSettings().autoMergeParts) return null;
  if (!Array.isArray(sessionParts) || sessionParts.length < 2) return null;
  const key = sessionParts.join('|');
  if (mergedSessionKeys.has(key)) return null;

  // Wait for any in-flight post-processing (e.g. remuxFaststart) on session parts before merging
  const waiters = [];
  for (const name of sessionParts) {
    const full = path.resolve(RECORDINGS_DIR, ...String(name || '').split('/').filter(Boolean));
    const p = postProcessingPromises.get(full);
    if (p) waiters.push(p.catch(() => {}));
  }
  if (waiters.length > 0) await Promise.all(waiters);
  if (shuttingDown) return null;

  const active = activeFilePaths();
  const validParts = sessionParts.filter((name) => {
    const full = path.resolve(RECORDINGS_DIR, ...String(name || '').split('/').filter(Boolean));
    if (active.has(full)) return false;
    try { return fs.statSync(full).size > 0; } catch { return false; }
  });
  if (validParts.length < 2) return null;

  mergedSessionKeys.add(key);
  if (mergedSessionKeys.size > 200) {
    mergedSessionKeys.delete(mergedSessionKeys.values().next().value);
  }
  try {
    const merged = await mergeRecordingParts(validParts, { deleteSources: false, activeFiles: active });
    if (!shuttingDown && merged.hasEvents) {
      try { analyzeRecording(merged.name); } catch {}
    }
    if (!shuttingDown) {
      try { db.indexRecording(merged.name); } catch {}
      recorderEvents.emit('recordings');
      const sizeMb = merged.sizeBytes ? (merged.sizeBytes / (1024 * 1024)).toFixed(1) : null;
      notifyEvent('parts_merged', { platform, username, partsCount: validParts.length, file: merged.name, sizeMb }).catch(() => {});
    }
    console.log(`[recorder] @${username} auto-merged ${validParts.length} parts -> ${merged.name}`);
    return merged;
  } catch (e) {
    mergedSessionKeys.delete(key);
    console.warn(`[recorder] @${username} auto-merge failed:`, e?.message || e);
    return null;
  }
}

function notifyFinalOutcome(username, { platform = 'tiktok', file, exitCode, stalled, lastErr, sessionParts }) {
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(file).size; } catch {}
  const sizeMb = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(1) : null;
  if ((exitCode !== 0 && !(stalled && sizeBytes > 0)) || (stalled && sizeBytes <= 0)) {
    notifyEvent('record_failed', { platform, username, error: lastErr || `ffmpeg exited ${exitCode}` }).catch(() => {});
  } else {
    notifyEvent('record_finished', { platform, username, file: path.basename(file), sizeMb }).catch(() => {});
  }
  if (Array.isArray(sessionParts) && sessionParts.length >= 2) {
    setImmediate(() => {
      maybeAutoMergeSessionParts(username, sessionParts, platform).catch(() => {});
    });
  }
}

function scheduleRetryAttempt(username, quality, part, idx, retryOpts = {}) {
  const platform = normalizePlatform(retryOpts.platform);
  const key = sessionKey(platform, username);
  if (shuttingDown || idx >= RETRY_DELAYS_MS.length) {
    if (!shuttingDown && retryOpts.file) {
      notifyFinalOutcome(username, retryOpts);
    }
    return;
  }
  const delay = RETRY_DELAYS_MS[idx];
  console.log(`[recorder] [${platform}] @${username} checking live for auto-retry #${idx + 1} in ${delay}ms`);
  const t = setTimeout(async () => {
    pendingRetries.delete(key);
    if (shuttingDown || hasActiveJobFor(username, platform)) return;
    try {
      const provider = getProvider(platform);
      const check = await provider.fetchLiveStatus(username, {
        noCache: true,
        accountId: retryOpts.accountId,
      });
      if (shuttingDown || hasActiveJobFor(username, platform)) return;
      if (provider.isLive(check)) {
        await startRecording(username, quality, {
          ...retryOpts,
          platform,
          noCache: true,
          retryCount: idx + 1,
          part: part + 1,
        });
      } else if ((retryOpts.exitCode !== 0 || retryOpts.stalled) && idx === 0) {
        // Give one extra retry when the process died abnormally in case upstream API status lagged.
        scheduleRetryAttempt(username, quality, part, idx + 1, retryOpts);
      } else if (retryOpts.file) {
        notifyFinalOutcome(username, retryOpts);
      }
    } catch (e) {
      console.warn(`[recorder] [${platform}] @${username} auto-retry #${idx + 1} failed:`, e?.message || e);
      if (e?.code === 'NOT_LIVE') {
        if (retryOpts.file) notifyFinalOutcome(username, retryOpts);
        return;
      }
      if (e?.code === 'DISK_FULL' || e?.code === 'NO_FFMPEG') {
        notifyEvent('record_failed', { platform, username, error: e.message }).catch(() => {});
        return;
      }
      scheduleRetryAttempt(username, quality, part, idx + 1, retryOpts);
    }
  }, delay);
  t.unref();
  pendingRetries.set(key, t);
}

// Tracks in-flight startRecording calls per channel key to dedupe races.
const startingPromises = new Map();

function startRecording(username, quality, opts = {}) {
  const platform = normalizePlatform(opts.platform);
  const key = sessionKey(platform, username);
  cancelPendingRetry(username, platform);
  const existing = hasActiveJobFor(username, platform);
  if (existing) {
    return Promise.resolve({ reused: true, id: existing.id, platform, file: existing.relName || path.basename(existing.file) });
  }
  const inFlight = startingPromises.get(key);
  if (inFlight) return inFlight.then((r) => ({ ...r, reused: true }));

  const p = _startRecordingInner(username, quality, { ...opts, platform }).finally(() => {
    startingPromises.delete(key);
  });
  startingPromises.set(key, p);
  return p;
}

async function _startRecordingInner(username, quality, opts = {}) {
  const platform = normalizePlatform(opts.platform);
  const provider = getProvider(platform);
  if (shuttingDown) {
    const err = new Error('server shutting down');
    err.code = 'SHUTTING_DOWN';
    throw err;
  }
  const existing = hasActiveJobFor(username, platform);
  if (existing) {
    return { reused: true, id: existing.id, platform, file: existing.relName || path.basename(existing.file) };
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

  const apiData = await provider.fetchLiveStatus(username, {
    noCache: !!opts.noCache,
    accountId: opts.accountId,
  });
  if (shuttingDown) {
    const err = new Error('server shutting down');
    err.code = 'SHUTTING_DOWN';
    throw err;
  }
  if (!provider.isLive(apiData)) {
    const err = new Error('user not live');
    err.code = 'NOT_LIVE';
    throw err;
  }

  const streams = provider.extractStreamUrls(apiData);
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
    else if (streams.hlsByQuality?.ao) pick = { url: streams.hlsByQuality.ao, kind: 'hls', quality: 'ao' };
    else if (streams.flv?.ld) pick = { url: streams.flv.ld, kind: 'flv', quality: 'ld' };
    else if (streams.flv?.sd) pick = { url: streams.flv.sd, kind: 'flv', quality: 'sd' };
    else if (streams.hlsByQuality?.md) pick = { url: streams.hlsByQuality.md, kind: 'hls', quality: 'md' };
    else if (streams.hlsByQuality?.ld) pick = { url: streams.hlsByQuality.ld, kind: 'hls', quality: 'ld' };
    else if (streams.hlsByQuality?.sd) pick = { url: streams.hlsByQuality.sd, kind: 'hls', quality: 'sd' };
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
      pick = provider.pickPreferredStream(streams);
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

  const summary = provider.buildSummary(username, apiData);
  const settings = getSettings();
  const safeUser = safeFilename(username) || 'live';
  const baseCreator = RESERVED_RECORDING_SUBDIRS.has(safeUser.toLowerCase()) ? `_${safeUser}` : safeUser;
  const creatorFolder = platform === 'tiktok' ? baseCreator : `${platform}_${baseCreator}`;
  const liveTitle = summary?.title || apiData?.liveRoom?.title || apiData?.stream?.title || null;
  const baseStem = renderRecordingFilename(settings.filenameTemplate, {
    platform,
    username,
    title: liveTitle,
    part: opts.part,
  });
  const targetDir = settings.organizeByCreator ? path.join(RECORDINGS_DIR, creatorFolder) : RECORDINGS_DIR;
  fs.mkdirSync(targetDir, { recursive: true });
  let file = path.join(targetDir, `${baseStem}.mp4`);
  for (
    let suffix = 2;
    (fs.existsSync(file) || fs.existsSync(file.replace(/\.mp4$/i, '.ts'))) && suffix < 100;
    suffix++
  ) {
    file = path.join(targetDir, `${baseStem}_${suffix}.mp4`);
  }
  const fileName = path.basename(file);
  const relName = settings.organizeByCreator ? `${creatorFolder}/${fileName}` : fileName;
  const artifactStem = (settings.organizeByCreator ? `${creatorFolder}__${fileName}` : fileName).replace(/\.mp4$/i, '');
  const captureFormat = (settings.recordFormat === 'ts' && !audioOnly) ? 'ts' : 'mp4';
  const captureFile = captureFormat === 'ts' ? file.replace(/\.mp4$/i, '.ts') : file;
  const recordChat = opts.recordChat !== false;
  const startedAt = Date.now();

  try {
    atomicWriteFileSync(
      file.replace(/\.mp4$/i, '.meta.json'),
      JSON.stringify({ startedAt, username, platform }, null, 2),
    );
  } catch {}

  const ffmpegBin = resolveFfmpeg();
  const args = buildRecordArgs({ ...pick, audioOnly, audioBitrate, format: captureFormat, referer: provider.referer }, captureFile, getFfmpegProxyArgs());
  const proc = spawn(ffmpegBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  proc.stdin?.on('error', () => {});

  // Best-effort: open chat capture (when recordChat !== false), write events to <file>.events.jsonl
  const eventsFile = file.replace(/\.mp4$/i, '.events.jsonl');
  let chatWriter = null;
  let chatListener = null;
  const chatRef = { released: false };
  let procExited = false;
  const detector = new realtimeHl.RealtimeHighlightDetector(username);
  const roomId = summary?.roomId || apiData?.user?.roomId || apiData?.liveRoom?.roomId || apiData?.stream?.id || null;
  if (recordChat) {
    chat.ensureSession(username, { platform, source: 'recorder', accountId: opts.accountId || null, roomId, recorderRef: chatRef })
      .then((session) => {
        if (procExited || chatRef.released) {
          chat.releaseRecorderSession(username, null, null, chatRef, platform);
          return;
        }
        chatWriter = session.attachFile(eventsFile);
        chatListener = (ev) => detector.onEvent(ev);
        session.listeners.add(chatListener);
      })
      .catch((e) => {
        chat.releaseRecorderSession(username, null, null, chatRef, platform);
        console.warn(`[chat] failed for ${platform}:${username}:`, e?.message || e);
      });
  }

  const id = nextId++;
  const job = {
    id,
    platform,
    username,
    kind: pick.kind,
    quality: audioOnly ? 'ao' : pick.quality,
    requestedQuality: quality,
    audioOnly,
    audioBitrate,
    recordChat,
    captureFormat,
    captureFile,
    accountId: opts.accountId || null,
    file,
    relName,
    artifactStem,
    eventsFile,
    startedAt,
    lastProgressAt: startedAt,
    lastOutTime: null,
    lastBytes: 0,
    exitedAt: null,
    proc,
    exited: false,
    manualStop: false,
    rollover: false,
    stalled: false,
    stopping: false,
    retryCount: Number(opts.retryCount || 0),
    part: Number(opts.part || 1),
    sessionParts: Array.isArray(opts.sessionParts) ? [...opts.sessionParts, relName] : [relName],
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
      gracefulStopJob(job, 6000);
    }, segmentMinutes * 60_000);
    job.segmentTimer.unref();
  }

  let lastErr = '';
  const stderrParser = createStderrParser({
    onStats(stats) {
      job.stats = stats;
      if (stats.outTime && stats.outTime !== job.lastOutTime) {
        job.lastOutTime = stats.outTime;
        job.lastProgressAt = Date.now();
      }
      emitJobs(false);
    },
    onErrorLine(line) {
      lastErr = (lastErr + '\n' + line).slice(-500);
    },
  });

  const markExited = (code, errMsg) => {
    if (procExited) return;
    procExited = true;
    stderrParser.flush();
    if (job.segmentTimer) {
      clearTimeout(job.segmentTimer);
      job.segmentTimer = null;
    }
    if (errMsg) lastErr = (lastErr + '\n' + errMsg).slice(-500);
    job.exited = true;
    job.exitCode = code;
    job.exitedAt = Date.now();
    try { job.finalSizeBytes = fs.statSync(job.captureFile || job.file).size; } catch { job.finalSizeBytes = null; }
    if (!job.lastErr && shouldExposeStderrOnExit({ code, manualStop: job.manualStop, errMsg })) {
      job.lastErr = lastErr.trim();
    }
    if (job.file) postProcessingFiles.add(job.file);
    if (job.captureFile) postProcessingFiles.add(job.captureFile);

    if (job.recordChat) {
      chat.releaseRecorderSession(username, chatWriter, chatListener, chatRef, platform);
    }
    chatWriter = null;
    chatListener = null;

    emitJobs(true);

    const retryOpts = {
      platform,
      audioOnly: job.audioOnly,
      audioBitrate: job.audioBitrate,
      recordChat: job.recordChat,
      accountId: job.accountId,
      file: job.file,
      exitCode: code,
      stalled: job.stalled,
      lastErr: job.lastErr,
      sessionParts: job.sessionParts,
    };
    let scheduledRecovery = false;
    // Rollover to next part if segment split triggered
    if (job.rollover && !job.manualStop) {
      setImmediate(() => {
        startRecording(username, quality, { ...retryOpts, platform, noCache: true, part: job.part + 1, retryCount: 0 })
          .catch((e) => {
            console.warn(`[recorder] @${username} rollover failed:`, e?.message || e);
            if (job.sessionParts?.length >= 2) {
              maybeAutoMergeSessionParts(username, job.sessionParts, platform).catch(() => {});
            }
          });
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
        scheduledRecovery = true;
        console.log(`[recorder] @${username} exited (${code}) — scheduling recovery`);
        scheduleRetryAttempt(username, quality, job.part, attempt, retryOpts);
      } else if (!job.rollover) {
        if ((code !== 0 || job.stalled) && !job.manualStop) {
          notifyEvent('record_failed', { platform, username, error: job.lastErr || `ffmpeg exited ${code}` }).catch(() => {});
        } else {
          let sizeMb = null;
          if (job.finalSizeBytes != null) sizeMb = (job.finalSizeBytes / (1024 * 1024)).toFixed(1);
          notifyEvent('record_finished', { platform, username, file: path.basename(job.file), sizeMb }).catch(() => {});
        }
      }
    }

    // Post-process: remux (.ts -> .mp4 or +faststart), thumbnail/sprite + ffprobe metadata, highlights, SQLite index, retention cleanup
    const ppPromise = (async () => {
      const recordingName = job.relName;
      try {
        if (shuttingDown) return;
        if (job.captureFormat === 'ts' && fs.existsSync(job.captureFile)) {
          const okTs = await remuxTsToMp4(job.captureFile, job.file).catch(() => false);
          if (okTs) {
            try { job.finalSizeBytes = fs.statSync(job.file).size; } catch {}
          }
        } else if (!job.stalled && code === 0) {
          await remuxFaststart(recordingName).catch(() => {});
          try { job.finalSizeBytes = fs.statSync(job.file).size; } catch {}
        }

        if (shuttingDown || !fs.existsSync(job.file)) return;
        await ensureThumbnailAndMeta(recordingName, { force: true }).catch(() => {});

        if (!shuttingDown && !parseEnvBoolFlag(process.env.DISABLE_AUTO_HIGHLIGHTS) && job?.file && (job.finalSizeBytes || 0) > 0) {
          try {
            const result = analyzeRecording(recordingName);
            if (result.ok) {
              console.log(`[highlights] @${username} → ${result.candidates.length} candidate(s) in ${recordingName}`);
            }
          } catch (e) {
            console.warn(`[highlights] analysis failed:`, e?.message || e);
          }
          if (!shuttingDown && detector.marks.length > 0) {
            try {
              const results = await detector.autoCut(recordingName, job.startedAt);
              const ok = results.filter((r) => r.ok).length;
              if (ok > 0) console.log(`[realtime-hl] @${username} auto-cut ${ok} clip(s)`);
            } catch (e) {
              console.warn(`[realtime-hl] auto-cut error:`, e?.message || e);
            }
          }
        }
        if (!shuttingDown && fs.existsSync(job.file)) {
          try { db.indexRecording(recordingName); } catch {}
        }
      } finally {
        if (job.file) {
          postProcessingFiles.delete(job.file);
          postProcessingPromises.delete(job.file);
        }
        if (job.captureFile) postProcessingFiles.delete(job.captureFile);
        if (!shuttingDown && !job.rollover && !scheduledRecovery && !pendingRetries.has(sessionKey(platform, username)) && job.sessionParts?.length >= 2) {
          await maybeAutoMergeSessionParts(username, job.sessionParts, platform).catch(() => {});
        }
        if (!shuttingDown) {
          try { enforceRetention(activeFilePaths()); } catch {}
          recorderEvents.emit('recordings');
        }
      }
    })();
    if (job.file) postProcessingPromises.set(job.file, ppPromise);
  };

  proc.stderr.on('data', (b) => stderrParser.push(b));
  proc.stderr.on('end', () => stderrParser.flush());
  proc.on('error', (err) => {
    console.warn(`[recorder] @${username} ffmpeg error:`, err?.message || err);
    markExited(-1, err?.message || String(err));
  });
  proc.on('exit', (code) => markExited(code));

  jobs.set(id, job);
  emitJobs(true);

  return {
    id, platform, username, kind: pick.kind, quality: audioOnly ? 'ao' : pick.quality,
    audioOnly, audioBitrate, recordChat, format: captureFormat,
    file: relName, eventsFile: recordChat ? path.basename(eventsFile) : null,
    title: liveTitle,
    reused: false,
  };
}

async function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  cancelPendingRetry(job.username, job.platform);
  job.manualStop = true;
  if (job.exited) return { ok: true, alreadyExited: true, username: job.username };

  job.stopping = true;
  safeWriteQuit(job.proc);

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

  if (!finished && !job.exited) {
    try { job.proc.kill('SIGKILL'); } catch {}
  }

  let size = null;
  try { size = fs.statSync(job.captureFile || job.file).size; } catch {}
  emitJobs(true);
  return {
    ok: true, graceful: finished,
    file: job.relName || path.basename(job.file), sizeBytes: size,
    username: job.username,
  };
}

function getJobsList() {
  const out = [];
  const sizeCache = new Map();
  for (const j of jobs.values()) {
    const activeTarget = j.captureFile || j.file;
    let size;
    if (j.exited && j.finalSizeBytes !== undefined) {
      size = j.finalSizeBytes;
    } else {
      size = sizeCache.get(activeTarget);
      if (size === undefined) {
        try { size = fs.statSync(activeTarget).size; } catch { size = null; }
        sizeCache.set(activeTarget, size);
      }
    }
    out.push({
      id: j.id,
      platform: j.platform || 'tiktok',
      username: j.username,
      kind: j.kind,
      quality: j.quality,
      recordChat: j.recordChat !== false,
      format: j.captureFormat || 'mp4',
      file: j.relName || path.basename(j.file),
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

function runLiveClipFfmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    liveClipProcs.add(proc);
    let stderr = '';
    let settled = false;
    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveClipProcs.delete(proc);
      if (err) reject(err);
      else resolve({ code, stderr });
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish(new Error('live clip timed out'));
    }, timeoutMs);
    timer.unref?.();
    proc.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-2048); });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => finish(null, code));
  });
}

async function cutLiveClipFromFile(filePath, elapsedSec, seconds = 30, opts = {}) {
  if (!isFfmpegAvailable()) {
    const err = new Error('ffmpeg is not installed on the server');
    err.code = 'NO_FFMPEG';
    throw err;
  }
  let st = null;
  try { st = fs.statSync(filePath); } catch {}
  if (!st || !st.isFile() || st.size <= 0) {
    const err = new Error('recording file has no data yet');
    err.code = 'TOO_SHORT';
    throw err;
  }
  const safeElapsed = Math.floor(Number(elapsedSec) || 0);
  if (safeElapsed < 2) {
    const err = new Error('recording is too short to clip yet');
    err.code = 'TOO_SHORT';
    throw err;
  }

  const dur = Math.min(180, Math.max(5, Math.round(Number(seconds) || 30)));
  let startSec = Math.max(0, safeElapsed - dur);
  let actualDur = Math.max(1, safeElapsed - startSec);
  const recordingName = opts.relName || path.basename(filePath);
  const base = opts.artifactStem || path.basename(filePath).replace(/\.(?:mp4|ts)$/i, '');
  const isTsInput = /\.ts$/i.test(filePath);

  const makeOutName = (sSec, dSec) => {
    const mm = String(Math.floor(sSec / 60)).padStart(2, '0');
    const ss = String(sSec % 60).padStart(2, '0');
    let candidate = `${base}_clip_${mm}${ss}_${dSec}s_live.mp4`;
    for (let suffix = 2; fs.existsSync(path.join(CLIPS_DIR, candidate)) && suffix < 100; suffix++) {
      candidate = `${base}_clip_${mm}${ss}_${dSec}s_live_${suffix}.mp4`;
    }
    return candidate;
  };

  let outName = makeOutName(startSec, actualDur);
  let outPath = path.join(CLIPS_DIR, outName);
  const tmpOut = path.join(CLIPS_DIR, `.tmp_live_${process.pid}_${Date.now()}_${outName}`);

  try {
    const buildArgs = (sSec, dSec) => [
      '-hide_banner', '-loglevel', 'warning', '-y',
      ...(sSec > 0 ? ['-ss', String(sSec)] : []),
      '-i', filePath,
      '-t', String(dSec),
      '-c', 'copy',
      ...(isTsInput ? ['-bsf:a', 'aac_adtstoasc'] : []),
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      tmpOut,
    ];

    let res = await runLiveClipFfmpeg(buildArgs(startSec, actualDur));
    let tmpSize = 0;
    try { tmpSize = fs.statSync(tmpOut).size; } catch {}

    if ((res.code !== 0 || tmpSize <= 0) && startSec > 0) {
      try { fs.unlinkSync(tmpOut); } catch {}
      startSec = 0;
      actualDur = safeElapsed;
      outName = makeOutName(startSec, actualDur);
      outPath = path.join(CLIPS_DIR, outName);
      res = await runLiveClipFfmpeg(buildArgs(0, actualDur));
      try { tmpSize = fs.statSync(tmpOut).size; } catch { tmpSize = 0; }
    }

    if (res.code !== 0 || tmpSize <= 0) {
      const err = new Error(`live clip failed (ffmpeg exit ${res.code})`);
      err.code = 'FFMPEG_FAIL';
      throw err;
    }

    fs.renameSync(tmpOut, outPath);
    recorderEvents.emit('recordings');
    return {
      ok: true,
      name: outName,
      url: `/files/highlights/${encodeURIComponent(outName)}`,
      sizeBytes: fs.statSync(outPath).size,
      startSec,
      durSec: actualDur,
      recording: recordingName,
    };
  } finally {
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
  }
}

async function cutLiveClip(jobId, seconds = 30) {
  if (!isFfmpegAvailable()) {
    const err = new Error('ffmpeg is not installed on the server');
    err.code = 'NO_FFMPEG';
    throw err;
  }
  const job = jobs.get(Number(jobId));
  if (!job) {
    const err = new Error('recording job not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (job.exited) {
    const err = new Error('recording has already ended');
    err.code = 'JOB_EXITED';
    throw err;
  }
  const elapsedSec = parseHmsToSec(job.stats?.outTime) ?? Math.floor((Date.now() - job.startedAt) / 1000);
  return cutLiveClipFromFile(job.captureFile || job.file, elapsedSec, seconds, {
    artifactStem: job.artifactStem,
    relName: job.relName,
  });
}

async function shutdownAll() {
  shuttingDown = true;
  for (const t of pendingRetries.values()) clearTimeout(t);
  pendingRetries.clear();
  for (const p of liveClipProcs) {
    try { p.kill('SIGKILL'); } catch {}
  }
  liveClipProcs.clear();
  const waiters = [];
  for (const j of jobs.values()) {
    j.manualStop = true;
    if (!j.exited) {
      j.stopping = true;
      safeWriteQuit(j.proc);
      waiters.push(new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = (kill) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (kill && !j.exited) { try { j.proc.kill('SIGKILL'); } catch {} }
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
  cutLiveClip,
  cutLiveClipFromFile,
  getJobsList,
  hasActiveJobFor,
  activeFilePaths,
  shutdownAll,
  getNextRetryAttempt,
  isJobStalled,
  createStderrParser,
  shouldExposeStderrOnExit,
};
