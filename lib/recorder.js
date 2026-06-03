// lib/recorder.js — Recording job management.
// Manages ffmpeg recording processes and job tracking.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  pickPreferredStream,
} = require('./room');
const { resolveFfmpeg } = require('./ffmpeg');
const chat = require('./chat');
const { timestamp, safeFilename, isValidStreamUrl } = require('./utils');
const { analyzeRecording } = require('./highlights');
const realtimeHl = require('./realtime-highlights');

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');
const MAX_CONCURRENT_JOBS = 10;
const FINISHED_JOB_TTL = 60 * 60 * 1000; // keep exited jobs for 1 hour

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// id -> { id, username, quality, kind, file, startedAt, proc, ... }
const jobs = new Map();
let nextId = 1;

// Periodically purge long-finished jobs to prevent memory leak.
setInterval(() => {
  const cutoff = Date.now() - FINISHED_JOB_TTL;
  for (const [id, j] of jobs) {
    if (j.exited && j.exitedAt && j.exitedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

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

// Tracks in-flight startRecording calls per username to dedupe races
// (e.g. UI double-click + watcher auto-record firing simultaneously).
const startingPromises = new Map();

function startRecording(username, quality) {
  const existing = hasActiveJobFor(username);
  if (existing) {
    return Promise.resolve({ reused: true, id: existing.id, file: path.basename(existing.file) });
  }
  // If a start is already in-flight for this username, return that promise.
  const inFlight = startingPromises.get(username);
  if (inFlight) return inFlight;

  const p = _startRecordingInner(username, quality).finally(() => {
    startingPromises.delete(username);
  });
  startingPromises.set(username, p);
  return p;
}

async function _startRecordingInner(username, quality) {
  // Re-check inside the locked section in case a job started between
  // the outer hasActiveJobFor check and this point.
  const existing = hasActiveJobFor(username);
  if (existing) {
    return { reused: true, id: existing.id, file: path.basename(existing.file) };
  }
  if (countActiveJobs() >= MAX_CONCURRENT_JOBS) {
    const err = new Error(`max concurrent recordings (${MAX_CONCURRENT_JOBS}) reached`);
    err.code = 'LIMIT';
    throw err;
  }

  const apiData = await fetchApiLive(username);
  if (!isLiveFromApi(apiData)) {
    const err = new Error('user not live');
    err.code = 'NOT_LIVE';
    throw err;
  }

  const streams = extractStreamUrls(apiData);
  // quality may be "<codec>:<key>" (e.g. "hevc:origin") or plain "<key>" (legacy = h264)
  let codec = 'h264', qKey = quality;
  if (typeof quality === 'string' && quality.includes(':')) {
    const [c, k] = quality.split(':');
    codec = c; qKey = k;
  }
  let pick = null;
  if (codec === 'hevc' && qKey && streams.hevc?.flv?.[qKey]) {
    pick = { url: streams.hevc.flv[qKey], kind: 'flv', quality: `hevc:${qKey}` };
  } else if (codec === 'hevc' && qKey && streams.hevc?.hls?.[qKey]) {
    pick = { url: streams.hevc.hls[qKey], kind: 'hls', quality: `hevc:${qKey}` };
  } else if (qKey && streams.flv?.[qKey]) {
    pick = { url: streams.flv[qKey], kind: 'flv', quality: qKey };
  } else if (qKey && streams.cmaf?.[qKey]) {
    pick = { url: streams.cmaf[qKey], kind: 'cmaf', quality: qKey };
  } else {
    pick = pickPreferredStream(streams);
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

  const file = path.join(RECORDINGS_DIR, `${safeFilename(username)}_${timestamp()}.mp4`);
  const ffmpegBin = resolveFfmpeg();
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-i', pick.url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+empty_moov+default_base_moof+frag_keyframe',
    '-frag_duration', '2000000',
    file,
  ];
  const proc = spawn(ffmpegBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });

  // Best-effort: open chat capture, write events to <file>.events.jsonl
  const eventsFile = file.replace(/\.mp4$/i, '.events.jsonl');
  let chatWriter = null;
  let chatStarted = false;
  let procExited = false;  // guards against late-resolving chat promise
  const detector = realtimeHl.getOrCreate(username);
  chat.ensureSession(username)
    .then((session) => {
      chatStarted = true;
      chatWriter = session.attachFile(eventsFile);
      // Register realtime highlight detector as a listener
      session.listeners.add((ev) => detector.onEvent(ev));
      // If ffmpeg already exited before chat connected, detach immediately.
      // Don't close the session — it may still be in use by the UI / other recordings.
      // Session will auto-close on streamEnd or explicit /api/chat/stop.
      if (procExited && chatWriter) session.detachFile(chatWriter);
    })
    .catch((e) => {
      console.warn(`[chat] failed for @${username}:`, e?.message || e);
    });

  const id = nextId++;
  let lastErr = '';
  proc.stderr.on('data', (b) => { lastErr = b.toString().slice(-500); });
  proc.on('exit', (code) => {
    procExited = true;
    const job = jobs.get(id);
    if (job) {
      job.exited = true;
      job.exitCode = code;
      job.exitedAt = Date.now();
      job.lastErr = lastErr;
    }
    // Detach chat writer for this recording. Don't auto-close the session —
    // the UI may still be polling it. Session closes on streamEnd or
    // explicit /api/chat/stop.
    if (chatStarted) {
      const session = chat.getSession(username);
      if (session && chatWriter) session.detachFile(chatWriter);
    }
    // Post-process: detect chat/gift spikes and persist to <file>.highlights.json.
    // Wrapped in setImmediate so the recorder's exit returns immediately —
    // analysis is a few-ms read of the events sidecar.
    if (!process.env.DISABLE_AUTO_HIGHLIGHTS && job?.file) {
      setImmediate(() => {
        try {
          const recordingName = path.basename(job.file);
          const result = analyzeRecording(recordingName);
          if (result.ok) {
            console.log(`[highlights] @${username} → ${result.candidates.length} candidate(s) in ${recordingName}`);
          }
        } catch (e) {
          console.warn(`[highlights] analysis failed:`, e?.message || e);
        }
        // Auto-cut clips from realtime spike marks
        const det = realtimeHl.get(username);
        if (det && det.marks.length > 0) {
          const recordingName = path.basename(job.file);
          const startMs = job.startedAt;
          det.autoCut(recordingName, startMs)
            .then((results) => {
              const ok = results.filter((r) => r.ok).length;
              if (ok > 0) console.log(`[realtime-hl] @${username} auto-cut ${ok} clip(s)`);
            })
            .catch((e) => console.warn(`[realtime-hl] auto-cut error:`, e?.message || e))
            .finally(() => realtimeHl.remove(username));
        } else {
          realtimeHl.remove(username);
        }
      });
    } else {
      realtimeHl.remove(username);
    }
  });

  jobs.set(id, {
    id, username, kind: pick.kind, quality: pick.quality,
    file, eventsFile,
    startedAt: Date.now(), exitedAt: null,
    proc, exited: false,
  });

  return {
    id, username, kind: pick.kind, quality: pick.quality,
    file: path.basename(file), eventsFile: path.basename(eventsFile),
    title: apiData?.liveRoom?.title || null,
    reused: false,
  };
}

async function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.exited) return { ok: true, alreadyExited: true, username: job.username };

  // Step 1: ask ffmpeg to quit gracefully via stdin "q".
  // Step 2: wait up to 8s for it to exit on its own.
  // Step 3: only as a last resort, force-kill.
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
  return {
    ok: true, graceful: finished,
    file: path.basename(job.file), sizeBytes: size,
    username: job.username,
  };
}

function getJobsList() {
  const out = [];
  // Cache statSync results for the duration of this call. Multiple jobs
  // pointing at the same active file would each statSync separately
  // otherwise — same file, same call, no reason to re-stat.
  const sizeCache = new Map();
  for (const j of jobs.values()) {
    let size = sizeCache.get(j.file);
    if (size === undefined) {
      try { size = fs.statSync(j.file).size; } catch { size = null; }
      sizeCache.set(j.file, size);
    }
    out.push({
      id: j.id, username: j.username, kind: j.kind, quality: j.quality,
      file: path.basename(j.file),
      startedAt: j.startedAt, exitedAt: j.exitedAt ?? null,
      exited: j.exited, exitCode: j.exitCode ?? null, sizeBytes: size,
      lastErr: j.exited ? j.lastErr || null : null,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

// Stop all jobs on shutdown — send 'q' and wait up to a few seconds.
async function shutdownAll() {
  const waiters = [];
  for (const j of jobs.values()) {
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
  startRecording,
  stopJob,
  getJobsList,
  shutdownAll,
};
