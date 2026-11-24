// lib/storage.js — Disk space guard, retention cleanup, thumbnails/ffprobe metadata, and audio extraction.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveFfmpeg, resolveFfprobe, isFfmpegAvailable } = require('./ffmpeg');
const {
  resolveRecordingPath,
  RESERVED_RECORDING_SUBDIRS,
  sanitizeAudioBitrate,
  atomicWriteFileSync,
  readEvents,
} = require('./utils');
const { getSettings } = require('./settings');
const { getEncoder } = require('./transcode');

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');
const THUMBS_DIR = path.join(RECORDINGS_DIR, 'thumbs');
const AUDIO_DIR = path.join(RECORDINGS_DIR, 'audio');
const CLIPS_DIR = path.join(RECORDINGS_DIR, 'highlights');

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(CLIPS_DIR, { recursive: true });

let dirBytesCache = { ts: 0, bytes: 0 };
const DIR_BYTES_CACHE_TTL_MS = 10_000;

function invalidateDirBytesCache() {
  dirBytesCache = { ts: 0, bytes: 0 };
}

function sumDirBytes(dir) {
  let total = 0;
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
      } else if (d.isDirectory()) {
        total += sumDirBytes(full);
      }
    }
  } catch {}
  return total;
}

function getRecordingsDirBytes() {
  const now = Date.now();
  if (dirBytesCache.ts > 0 && now - dirBytesCache.ts < DIR_BYTES_CACHE_TTL_MS) {
    return dirBytesCache.bytes;
  }
  const bytes = sumDirBytes(RECORDINGS_DIR);
  dirBytesCache = { ts: now, bytes };
  return bytes;
}

function getDiskStatus() {
  let freeBytes = null;
  let totalBytes = null;
  try {
    const st = fs.statfsSync(RECORDINGS_DIR);
    freeBytes = Number(st.bavail) * Number(st.bsize);
    totalBytes = Number(st.blocks) * Number(st.bsize);
  } catch {}
  const recordingsBytes = getRecordingsDirBytes();
  const { minFreeGb, maxRecordingsGb } = getSettings();
  const minFreeBytes = minFreeGb * 1024 ** 3;
  const maxRecordingsBytes = maxRecordingsGb > 0 ? maxRecordingsGb * 1024 ** 3 : null;
  return {
    freeBytes,
    totalBytes,
    recordingsBytes,
    minFreeBytes,
    maxRecordingsBytes,
    lowSpace: freeBytes !== null && minFreeBytes > 0 && freeBytes < minFreeBytes,
  };
}

/**
 * List recording paths with `ext` relative to RECORDINGS_DIR
 * (flat `<file>` or 1-level `<creator>/<file>`, normalized to `/`).
 */
function listRecordingFiles(ext = '.mp4') {
  const out = [];
  const wantExt = String(ext || '.mp4').toLowerCase();
  let entries;
  try { entries = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    if (d.isFile() && d.name.toLowerCase().endsWith(wantExt)) {
      out.push(d.name);
    } else if (d.isDirectory() && !RESERVED_RECORDING_SUBDIRS.has(d.name.toLowerCase())) {
      const subDir = path.join(RECORDINGS_DIR, d.name);
      try {
        for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
          if (sub.isFile() && !sub.name.startsWith('.') && sub.name.toLowerCase().endsWith(wantExt)) {
            out.push(`${d.name}/${sub.name}`);
          }
        }
      } catch {}
    }
  }
  return out;
}

/**
 * Safely delete a recording `.mp4` and all associated sidecars, thumbnails, audio, and clips.
 */
function deleteRecordingBundle(mp4Name) {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, mp4Name, '.mp4');
  if (!resolved) return false;
  const { full, folder, artifactStem } = resolved;

  fs.unlinkSync(full);
  for (const suffix of ['.events.jsonl', '.highlights.json', '.bookmarks.json', '.meta.json']) {
    try { fs.unlinkSync(full.replace(/\.mp4$/i, suffix)); } catch {}
  }
  if (folder) {
    try { fs.rmdirSync(path.dirname(full)); } catch {}
  }
  try { fs.unlinkSync(path.join(THUMBS_DIR, `${artifactStem}.jpg`)); } catch {}
  try { fs.unlinkSync(path.join(THUMBS_DIR, `${artifactStem}_sprite.jpg`)); } catch {}
  try { fs.unlinkSync(path.join(THUMBS_DIR, `${artifactStem}_sprite.json`)); } catch {}
  try {
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      const rest = f.startsWith(artifactStem) ? f.slice(artifactStem.length) : '';
      if (f === `${artifactStem}.m4a` || f === `${artifactStem}.mp3` || (f.startsWith(artifactStem) && /^_(?:64k|96k|128k|192k)\.(?:m4a|mp3)$/i.test(rest))) {
        try { fs.unlinkSync(path.join(AUDIO_DIR, f)); } catch {}
      }
    }
  } catch {}
  try {
    const prefix = `${artifactStem}_clip_`;
    for (const c of fs.readdirSync(CLIPS_DIR)) {
      if (c.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(CLIPS_DIR, c)); } catch {}
      }
    }
  } catch {}
  invalidateDirBytesCache();
  return true;
}

/**
 * Enforce retentionDays and maxRecordingsGb by deleting oldest completed recordings.
 */
function enforceRetention(activeFilePaths = new Set()) {
  const { retentionDays, maxRecordingsGb } = getSettings();
  if (retentionDays <= 0 && maxRecordingsGb <= 0) return { deleted: [] };

  const activeFull = new Set([...activeFilePaths].map((p) => path.resolve(p)));
  const entries = listRecordingFiles()
    .map((relName) => {
      const full = path.resolve(RECORDINGS_DIR, ...relName.split('/'));
      try {
        const st = fs.statSync(full);
        return { name: relName, full, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  const deleted = [];
  const deletedTs = [];
  const now = Date.now();
  const maxAgeMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : null;

  const tsEntries = listRecordingFiles('.ts')
    .map((relName) => {
      const full = path.resolve(RECORDINGS_DIR, ...relName.split('/'));
      try {
        const st = fs.statSync(full);
        return { name: relName, full, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    .filter((e) => e && !activeFull.has(e.full))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const removeOrphanTs = (e) => {
    fs.unlinkSync(e.full);
    if (e.name.includes('/')) {
      try { fs.rmdirSync(path.dirname(e.full)); } catch {}
    }
    deletedTs.push(e.name);
  };

  // 1. Delete expired recordings (skip active and protected/pinned files)
  if (maxAgeMs !== null) {
    for (const e of entries) {
      if (activeFull.has(e.full)) continue;
      if (readMeta(e.name)?.protected) continue;
      if (now - e.mtimeMs > maxAgeMs) {
        try {
          if (deleteRecordingBundle(e.name)) deleted.push(e.name);
        } catch {}
      }
    }
    for (const e of tsEntries) {
      if (now - e.mtimeMs > maxAgeMs) {
        try { removeOrphanTs(e); } catch {}
      }
    }
  }

  // 2. Enforce total size cap (skip active and protected/pinned files)
  if (maxRecordingsGb > 0) {
    const capBytes = maxRecordingsGb * 1024 ** 3;
    let currentBytes = sumDirBytes(RECORDINGS_DIR);
    for (const e of tsEntries) {
      if (currentBytes <= capBytes) break;
      if (deletedTs.includes(e.name)) continue;
      try {
        removeOrphanTs(e);
        currentBytes = Math.max(0, currentBytes - e.size);
      } catch {}
    }
    for (const e of entries) {
      if (currentBytes <= capBytes) break;
      if (deleted.includes(e.name) || activeFull.has(e.full)) continue;
      if (readMeta(e.name)?.protected) continue;
      try {
        if (deleteRecordingBundle(e.name)) {
          deleted.push(e.name);
          currentBytes = Math.max(0, currentBytes - e.size);
        }
      } catch {}
    }
  }

  if (deleted.length > 0) {
    try {
      const db = require('./db');
      for (const name of deleted) {
        try { db.removeRecording(name); } catch {}
      }
    } catch {}
  }

  if (deleted.length > 0 || deletedTs.length > 0) {
    invalidateDirBytesCache();
    console.log(`[storage] retention cleanup removed ${deleted.length} recording(s) and ${deletedTs.length} orphaned .ts file(s)`);
  }
  return { deleted, deletedTs };
}

function readMeta(recordingName) {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved) return null;
  const { full, artifactStem } = resolved;
  const metaFile = full.replace(/\.mp4$/i, '.meta.json');
  const thumbFile = path.join(THUMBS_DIR, `${artifactStem}.jpg`);
  const spriteImg = path.join(THUMBS_DIR, `${artifactStem}_sprite.jpg`);
  const spriteJson = path.join(THUMBS_DIR, `${artifactStem}_sprite.json`);
  let meta = null;
  let hasMeta = false;
  try {
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      hasMeta = !!(meta && typeof meta === 'object');
    }
  } catch {}
  let spriteMeta = null;
  try {
    if (fs.existsSync(spriteImg) && fs.existsSync(spriteJson)) {
      spriteMeta = JSON.parse(fs.readFileSync(spriteJson, 'utf8'));
    }
  } catch {}
  const hasThumb = fs.existsSync(thumbFile);
  return {
    ...(meta || {}),
    protected: !!meta?.protected,
    displayTitle: typeof meta?.displayTitle === 'string' && meta.displayTitle ? meta.displayTitle : null,
    notes: typeof meta?.notes === 'string' ? meta.notes : '',
    hasMeta,
    hasThumb,
    thumbUrl: hasThumb ? `/files/thumbs/${encodeURIComponent(artifactStem + '.jpg')}` : null,
    spriteUrl: spriteMeta ? `/files/thumbs/${encodeURIComponent(artifactStem + '_sprite.jpg')}` : null,
    spriteMeta,
  };
}

function updateRecordingMeta(recordingName, patch = {}) {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) {
    const err = new Error('recording not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const metaFile = resolved.full.replace(/\.mp4$/i, '.meta.json');
  let current = {};
  try {
    if (fs.existsSync(metaFile)) {
      current = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {};
    }
  } catch {}
  const next = { ...current };
  if (typeof patch.protected === 'boolean') next.protected = patch.protected;
  if (typeof patch.startedAt === 'number' && Number.isFinite(patch.startedAt)) next.startedAt = patch.startedAt;
  if (typeof patch.username === 'string' && patch.username) next.username = patch.username;
  if (typeof patch.platform === 'string' && patch.platform) next.platform = patch.platform;
  if (patch.displayTitle !== undefined) {
    next.displayTitle = typeof patch.displayTitle === 'string'
      ? patch.displayTitle.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120) || null
      : null;
  }
  if (patch.notes !== undefined) {
    next.notes = typeof patch.notes === 'string'
      ? patch.notes.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 500)
      : '';
  }
  atomicWriteFileSync(metaFile, JSON.stringify(next, null, 2));
  return readMeta(resolved.name);
}

const mediaProcs = new Set();

function shutdownMediaProcs() {
  for (const proc of mediaProcs) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  mediaProcs.clear();
}

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;

function runCommand(bin, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    mediaProcs.add(proc);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      mediaProcs.delete(proc);
      if (err) reject(err);
      else resolve(res);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish(new Error('command timed out'));
    }, timeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (b) => {
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += b.toString().slice(0, MAX_STDOUT_BYTES - stdout.length);
      }
    });
    proc.stderr.on('data', (b) => {
      stderr = (stderr + b.toString()).slice(-MAX_STDERR_CHARS);
    });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(`exit ${code}: ${stderr.slice(-200)}`));
    });
  });
}

const inflightMedia = new Map();
const inflightAudio = new Map();
const inflightCompress = new Map();
const failedProbeAt = new Map(); // filename -> timestamp ms
const FAILED_PROBE_COOLDOWN_MS = 5 * 60_000;
const MAX_CONCURRENT_MEDIA = 2;
let activeMediaCount = 0;
const mediaWaiters = [];

function isMediaProbeCoolingDown(recordingName) {
  const failedTs = failedProbeAt.get(recordingName);
  return !!(failedTs && Date.now() - failedTs < FAILED_PROBE_COOLDOWN_MS);
}

function acquireMediaSlot() {
  if (activeMediaCount < MAX_CONCURRENT_MEDIA) {
    activeMediaCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => mediaWaiters.push(resolve));
}

function releaseMediaSlot() {
  const next = mediaWaiters.shift();
  if (next) {
    next();
  } else {
    activeMediaCount = Math.max(0, activeMediaCount - 1);
  }
}

async function ensureThumbnailAndMeta(recordingName, { force = false } = {}) {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) return null;
  if (!isFfmpegAvailable()) return null;

  const { name, full, artifactStem } = resolved;
  if (!force) {
    const failedTs = failedProbeAt.get(name);
    if (failedTs && Date.now() - failedTs < FAILED_PROBE_COOLDOWN_MS) {
      return readMeta(name);
    }
  }
  if (inflightMedia.has(name)) {
    const cur = inflightMedia.get(name);
    return force ? cur.then(() => ensureThumbnailAndMeta(name, { force: true })) : cur;
  }

  const task = (async () => {
    await acquireMediaSlot();
    try {
      const metaFile = full.replace(/\.mp4$/i, '.meta.json');
      const thumbFile = path.join(THUMBS_DIR, `${artifactStem}.jpg`);

      let existingMeta = {};
      if (fs.existsSync(metaFile)) {
        try { existingMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch {}
      }
      let probedMeta = !force && existingMeta.vcodec !== undefined ? existingMeta : null;

      // 1. Probe metadata if missing or forced (e.g. immediately after recording ends)
      if (force || !probedMeta) {
        try {
          const { stdout } = await runCommand(resolveFfprobe(), [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format', '-show_streams',
            full,
          ], 10000);
          const info = JSON.parse(stdout);
          const streams = Array.isArray(info.streams) ? info.streams : [];
          const v = streams.find((s) => s.codec_type === 'video');
          const a = streams.find((s) => s.codec_type === 'audio');
          let fps = null;
          if (v?.avg_frame_rate && v.avg_frame_rate.includes('/')) {
            const [n, d] = v.avg_frame_rate.split('/').map(Number);
            if (d > 0 && Number.isFinite(n / d)) fps = Math.round(n / d);
          }
          // Re-read metaFile immediately before merging so concurrent user updates
          // (protected pin, displayTitle, notes) made during ffprobe are preserved.
          let freshMeta = {};
          if (fs.existsSync(metaFile)) {
            try { freshMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch {}
          }
          probedMeta = {
            ...freshMeta,
            durationSec: info.format?.duration ? Math.round(Number(info.format.duration)) : null,
            width: v?.width || null,
            height: v?.height || null,
            fps,
            vcodec: v?.codec_name || null,
            acodec: a?.codec_name || null,
          };
          atomicWriteFileSync(metaFile, JSON.stringify(probedMeta, null, 2));
          failedProbeAt.delete(name);
        } catch {
          failedProbeAt.set(name, Date.now());
          return readMeta(name);
        }
      }

      // 2. Generate thumbnail if missing (skip audio-only files where vcodec is null)
      const hasVideo = probedMeta ? !!probedMeta.vcodec : true;
      if (hasVideo && !fs.existsSync(thumbFile)) {
        const ff = resolveFfmpeg();
        const tmpThumb = path.join(THUMBS_DIR, `.tmp_${process.pid}_${Date.now()}_${artifactStem}.jpg`);
        try {
          try {
            await runCommand(ff, [
              '-hide_banner', '-loglevel', 'error', '-y',
              '-ss', '3',
              '-i', full,
              '-frames:v', '1',
              '-vf', 'scale=320:-2',
              '-q:v', '5',
              tmpThumb,
            ], 15000);
          } catch {
            try { fs.unlinkSync(tmpThumb); } catch {}
            // Retry at 0s in case video is < 3s
            await runCommand(ff, [
              '-hide_banner', '-loglevel', 'error', '-y',
              '-i', full,
              '-frames:v', '1',
              '-vf', 'scale=320:-2',
              '-q:v', '5',
              tmpThumb,
            ], 15000);
          }
          if (fs.existsSync(tmpThumb)) fs.renameSync(tmpThumb, thumbFile);
        } catch {
          try { fs.unlinkSync(tmpThumb); } catch {}
        }
      }

      // 3. Generate timeline sprite sheet (max 8x8 = 64 tiles at 160px wide)
      // For >= 60s streams, try -skip_frame nokey first so ffmpeg only decodes keyframes (~50x faster).
      const spriteImg = path.join(THUMBS_DIR, `${artifactStem}_sprite.jpg`);
      const spriteJson = path.join(THUMBS_DIR, `${artifactStem}_sprite.json`);
      const dur = probedMeta?.durationSec || 0;
      if (hasVideo && dur >= 10 && (!fs.existsSync(spriteImg) || !fs.existsSync(spriteJson))) {
        const cols = 8;
        const rows = 8;
        const intervalSec = Math.max(5, Math.ceil(dur / (cols * rows)));
        const ff = resolveFfmpeg();
        const tmpSprite = path.join(THUMBS_DIR, `.tmp_${process.pid}_${Date.now()}_${artifactStem}_sprite.jpg`);
        const buildSpriteArgs = (fastKeyOnly) => [
          '-hide_banner', '-loglevel', 'error', '-y',
          ...(fastKeyOnly ? ['-skip_frame', 'nokey'] : []),
          '-i', full,
          '-vf', `fps=1/${intervalSec},scale=160:-2,tile=${cols}x${rows}`,
          '-frames:v', '1',
          '-q:v', '6',
          tmpSprite,
        ];
        try {
          let ok = false;
          if (dur >= 60) {
            try {
              await runCommand(ff, buildSpriteArgs(true), 25_000);
              ok = fs.existsSync(tmpSprite);
            } catch { /* fall back to full decode if keyframe-only fails */ }
          }
          if (!ok) {
            try { fs.unlinkSync(tmpSprite); } catch {}
            await runCommand(ff, buildSpriteArgs(false), 25_000);
          }
          if (fs.existsSync(tmpSprite)) {
            fs.renameSync(tmpSprite, spriteImg);
            const tileHeight = (probedMeta?.width && probedMeta?.height)
              ? Math.round((160 * probedMeta.height) / probedMeta.width / 2) * 2
              : 284;
            atomicWriteFileSync(spriteJson, JSON.stringify({
              intervalSec,
              cols,
              rows,
              tileWidth: 160,
              tileHeight,
              durationSec: dur,
            }));
          }
        } catch {
          try { fs.unlinkSync(tmpSprite); } catch {}
        }
      }

      return readMeta(name);
    } finally {
      releaseMediaSlot();
    }
  })().finally(() => {
    inflightMedia.delete(name);
  });

  inflightMedia.set(name, task);
  return task;
}

async function extractAudio(recordingName, format = 'm4a', rawBitrate = null) {
  if (!['m4a', 'mp3'].includes(format)) {
    const err = new Error('unsupported audio format');
    err.code = 'BAD_FORMAT';
    throw err;
  }
  const bitrate = sanitizeAudioBitrate(rawBitrate, null);
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) {
    const err = new Error('recording not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!isFfmpegAvailable()) {
    const err = new Error('ffmpeg is not installed');
    err.code = 'NO_FFMPEG';
    throw err;
  }

  const outName = bitrate ? `${resolved.artifactStem}_${bitrate}.${format}` : `${resolved.artifactStem}.${format}`;
  const outPath = path.join(AUDIO_DIR, outName);

  if (fs.existsSync(outPath)) {
    const st = fs.statSync(outPath);
    return {
      name: outName,
      url: `/files/audio/${encodeURIComponent(outName)}`,
      sizeBytes: st.size,
      bitrate: bitrate || 'auto',
      reused: true,
    };
  }

  if (inflightAudio.has(outName)) {
    return inflightAudio.get(outName);
  }

  const task = (async () => {
    const ff = resolveFfmpeg();
    const codecArgs = format === 'mp3'
      ? (bitrate ? ['-vn', '-c:a', 'libmp3lame', '-b:a', bitrate] : ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'])
      : (bitrate ? ['-vn', '-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart'] : ['-vn', '-c:a', 'copy', '-movflags', '+faststart']);

    const tmpPath = path.join(AUDIO_DIR, `.tmp_${process.pid}_${Date.now()}_${outName}`);
    try {
      try {
        await runCommand(ff, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', resolved.full,
          ...codecArgs,
          tmpPath,
        ], 120_000);
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch {}
        // If stream-copy into m4a failed, re-encode to AAC
        if (format === 'm4a' && !bitrate) {
          await runCommand(ff, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', resolved.full,
            '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
            tmpPath,
          ], 120_000);
        } else {
          throw e;
        }
      }
      fs.renameSync(tmpPath, outPath);
      invalidateDirBytesCache();
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw e;
    }

    const st = fs.statSync(outPath);
    return {
      name: outName,
      url: `/files/audio/${encodeURIComponent(outName)}`,
      sizeBytes: st.size,
      bitrate: bitrate || 'auto',
      reused: false,
    };
  })().finally(() => {
    inflightAudio.delete(outName);
  });

  inflightAudio.set(outName, task);
  return task;
}

function buildCompressEncodeArgs(encoder, preset) {
  const isCompact = preset === 'compact';
  const maxHeight = isCompact ? 480 : 720;
  const cq = isCompact ? '28' : '24';
  const audioBitrate = isCompact ? '64k' : '96k';
  const vf = `scale=w='trunc(iw*min(1,${maxHeight}/ih)/2)*2':h='trunc(ih*min(1,${maxHeight}/ih)/2)*2',format=yuv420p`;

  let videoArgs;
  if (encoder === 'h264_nvenc') {
    videoArgs = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', cq];
  } else if (encoder === 'h264_qsv') {
    videoArgs = ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', cq];
  } else if (encoder === 'h264_amf') {
    videoArgs = ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', cq, '-qp_p', cq];
  } else {
    videoArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', cq];
  }
  return {
    vf,
    args: [...videoArgs, '-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart'],
  };
}

async function compressRecording(recordingName, rawPreset = 'balanced') {
  const preset = rawPreset === 'compact' ? 'compact' : 'balanced';
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) {
    const err = new Error('recording not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!isFfmpegAvailable()) {
    const err = new Error('ffmpeg is not installed');
    err.code = 'NO_FFMPEG';
    throw err;
  }

  const fileBase = resolved.fileName.replace(/\.mp4$/i, '');
  const cleanFileBase = fileBase.replace(/_(?:balanced|compact)$/i, '');
  const outFileName = `${cleanFileBase}_${preset}.mp4`;
  const outName = resolved.folder ? `${resolved.folder}/${outFileName}` : outFileName;
  if (outName.toLowerCase() === resolved.name.toLowerCase()) {
    const err = new Error('recording is already compressed with this preset');
    err.code = 'ALREADY_COMPRESSED';
    throw err;
  }
  const existingMeta = readMeta(resolved.name);
  if (existingMeta?.hasMeta && !existingMeta.vcodec) {
    const err = new Error('cannot video-compress an audio-only recording');
    err.code = 'AUDIO_ONLY';
    throw err;
  }
  const targetDir = path.dirname(resolved.full);
  const outPath = path.join(targetDir, outFileName);
  const origBytes = fs.statSync(resolved.full).size;

  if (fs.existsSync(outPath)) {
    const sizeBytes = fs.statSync(outPath).size;
    return { name: outName, sizeBytes, origBytes, preset, reused: true };
  }
  if (inflightCompress.has(outName)) {
    return inflightCompress.get(outName);
  }

  const task = (async () => {
    const ff = resolveFfmpeg();
    const { vf, args } = buildCompressEncodeArgs(getEncoder(), preset);
    const tmpPath = path.join(targetDir, `.tmp_${process.pid}_${Date.now()}_${outFileName}`);
    try {
      await runCommand(ff, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', resolved.full,
        '-vf', vf,
        ...args,
        tmpPath,
      ], 10 * 60_000);
      fs.renameSync(tmpPath, outPath);
      invalidateDirBytesCache();
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw e;
    }

    // Copy .events.jsonl sidecar if present so Replay/Highlights still work on compressed file
    const origEvents = resolved.full.replace(/\.mp4$/i, '.events.jsonl');
    const outEvents = outPath.replace(/\.mp4$/i, '.events.jsonl');
    if (fs.existsSync(origEvents) && !fs.existsSync(outEvents)) {
      try { fs.copyFileSync(origEvents, outEvents); } catch {}
    }

    await ensureThumbnailAndMeta(outName, { force: true }).catch(() => {});
    const sizeBytes = fs.statSync(outPath).size;
    return { name: outName, sizeBytes, origBytes, preset, reused: false };
  })().finally(() => {
    inflightCompress.delete(outName);
  });

  inflightCompress.set(outName, task);
  return task;
}

async function remuxFaststart(recordingName) {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) return false;
  if (!isFfmpegAvailable()) return false;
  let origSize = 0;
  try { origSize = fs.statSync(resolved.full).size; } catch { return false; }
  if (origSize <= 0) return false;

  const tmpPath = path.join(path.dirname(resolved.full), `.faststart_${process.pid}_${Date.now()}_${resolved.fileName}`);
  try {
    await runCommand(resolveFfmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', resolved.full,
      '-c', 'copy',
      '-movflags', '+faststart',
      tmpPath,
    ], 5 * 60_000);
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
      fs.renameSync(tmpPath, resolved.full);
      invalidateDirBytesCache();
      return true;
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

async function remuxTsToMp4(tsFullPath, mp4FullPath) {
  if (!tsFullPath || !mp4FullPath || !fs.existsSync(tsFullPath)) return false;
  if (!isFfmpegAvailable()) return false;
  let origSize = 0;
  try { origSize = fs.statSync(tsFullPath).size; } catch { return false; }
  if (origSize <= 0) return false;

  const tmpPath = path.join(path.dirname(mp4FullPath), `.tsremux_${process.pid}_${Date.now()}_${path.basename(mp4FullPath)}`);
  try {
    await runCommand(resolveFfmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', tsFullPath,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      tmpPath,
    ], 5 * 60_000);
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
      fs.renameSync(tmpPath, mp4FullPath);
      try { fs.unlinkSync(tsFullPath); } catch {}
      invalidateDirBytesCache();
      return true;
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

/**
 * Merge multiple recorded `.mp4` parts into a single stream-copied `+faststart` `.mp4`
 * and combine their `.events.jsonl` sidecars in chronological order.
 */
async function mergeRecordingParts(partNames, { deleteSources = false, activeFiles = new Set() } = {}) {
  if (!isFfmpegAvailable()) {
    const err = new Error('ffmpeg is not installed');
    err.code = 'NO_FFMPEG';
    throw err;
  }
  if (!Array.isArray(partNames)) {
    const err = new Error('files must be an array');
    err.code = 'BAD_INPUT';
    throw err;
  }

  const seen = new Set();
  const list = [];
  for (const raw of partNames) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      list.push(trimmed);
    }
  }
  if (list.length < 2 || list.length > 50) {
    const err = new Error('select between 2 and 50 parts to merge');
    err.code = 'BAD_INPUT';
    throw err;
  }

  const resolved = [];
  for (const name of list) {
    if (name.includes('\\') || name.includes('\0') || name.startsWith('.')) {
      const err = new Error(`invalid recording name: ${name}`);
      err.code = 'BAD_INPUT';
      throw err;
    }
    const r = resolveRecordingPath(RECORDINGS_DIR, name, '.mp4');
    if (!r) {
      const err = new Error(`invalid recording name: ${name}`);
      err.code = 'BAD_INPUT';
      throw err;
    }
    if (activeFiles.has(r.full)) {
      const err = new Error(`recording is currently active: ${r.name}`);
      err.code = 'ACTIVE_RECORDING';
      throw err;
    }
    let st;
    try { st = fs.statSync(r.full); } catch { st = null; }
    if (!st || !st.isFile() || st.size <= 0) {
      const err = new Error(`recording not found or empty: ${r.name}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    resolved.push(r);
  }

  const outDir = path.dirname(resolved[0].full);
  const stem = resolved[0].fileName
    .replace(/\.mp4$/i, '')
    .replace(/_p\d+$/i, '')
    .replace(/_merged(?:_\d+)?$/i, '');
  let outFileName = `${stem}_merged.mp4`;
  let outPath = path.join(outDir, outFileName);
  for (let suffix = 2; fs.existsSync(outPath) && suffix < 100; suffix++) {
    outFileName = `${stem}_merged_${suffix}.mp4`;
    outPath = path.join(outDir, outFileName);
  }
  const outName = resolved[0].folder ? `${resolved[0].folder}/${outFileName}` : outFileName;
  if (fs.existsSync(outPath)) {
    const err = new Error('too many merged files with the same name');
    err.code = 'BAD_INPUT';
    throw err;
  }

  const uniq = `${process.pid}_${Date.now()}`;
  const listFile = path.join(RECORDINGS_DIR, `.tmp_concat_${uniq}.txt`);
  const tmpOut = path.join(outDir, `.tmp_merge_${uniq}_${outFileName}`);
  const concatBody = resolved
    .map((r) => `file '${r.full.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`)
    .join('');

  try {
    fs.writeFileSync(listFile, concatBody, 'utf8');
    await runCommand(resolveFfmpeg(), [
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      tmpOut,
    ], 10 * 60_000);

    let outStat = null;
    try { outStat = fs.statSync(tmpOut); } catch {}
    if (!outStat || outStat.size <= 0) {
      throw new Error('merged output file was empty');
    }
    fs.renameSync(tmpOut, outPath);
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
  }

  // Merge .events.jsonl sidecars chronologically with adjacent duplicate removal
  const mergedEvents = [];
  for (const r of resolved) {
    const evFile = r.full.replace(/\.mp4$/i, '.events.jsonl');
    if (!fs.existsSync(evFile)) continue;
    try {
      const partEvents = readEvents(evFile, { sort: false });
      for (const ev of partEvents) {
        if (ev && typeof ev === 'object') mergedEvents.push({ ...ev });
      }
    } catch {}
  }

  let hasEvents = false;
  if (mergedEvents.length > 0) {
    mergedEvents.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    const deduped = [];
    for (const ev of mergedEvents) {
      const prev = deduped[deduped.length - 1];
      if (
        prev &&
        prev.ts === ev.ts &&
        prev.type === ev.type &&
        (prev.user?.uniqueId || '') === (ev.user?.uniqueId || '') &&
        (prev.comment || '') === (ev.comment || '') &&
        (prev.giftName || '') === (ev.giftName || '') &&
        (prev.repeatCount || 0) === (ev.repeatCount || 0)
      ) {
        continue;
      }
      deduped.push({ ...ev, id: deduped.length + 1 });
    }
    const outEventsFile = outPath.replace(/\.mp4$/i, '.events.jsonl');
    atomicWriteFileSync(outEventsFile, deduped.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    hasEvents = true;
  }

  // Preserve protected flag and initial startedAt/username metadata from first source part
  const anyProtected = resolved.some((r) => readMeta(r.name)?.protected === true);
  const firstMeta = readMeta(resolved[0].name);
  const mergeMetaPatch = {};
  if (anyProtected) mergeMetaPatch.protected = true;
  if (Number.isFinite(Number(firstMeta?.startedAt)) && Number(firstMeta.startedAt) > 0) {
    mergeMetaPatch.startedAt = Number(firstMeta.startedAt);
  }
  if (typeof firstMeta?.username === 'string' && firstMeta.username) {
    mergeMetaPatch.username = firstMeta.username;
  }
  if (typeof firstMeta?.platform === 'string' && firstMeta.platform) {
    mergeMetaPatch.platform = firstMeta.platform;
  }
  if (Object.keys(mergeMetaPatch).length > 0) {
    try { updateRecordingMeta(outName, mergeMetaPatch); } catch {}
  }

  await ensureThumbnailAndMeta(outName, { force: true }).catch(() => {});

  const deletedSources = [];
  if (deleteSources && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    for (const r of resolved) {
      if (readMeta(r.name)?.protected === true) continue;
      try {
        if (deleteRecordingBundle(r.name)) deletedSources.push(r.name);
      } catch {}
    }
  }

  invalidateDirBytesCache();
  const sizeBytes = fs.statSync(outPath).size;
  return {
    name: outName,
    sizeBytes,
    parts: resolved.map((r) => r.name),
    hasEvents,
    deletedSources,
  };
}

async function recoverOrphanedTsFiles(activeFilePaths = new Set()) {
  if (!isFfmpegAvailable()) return [];
  const activeFull = new Set([...activeFilePaths].map((p) => path.resolve(p)));
  const recovered = [];
  for (const relTs of listRecordingFiles('.ts')) {
    const tsFull = path.resolve(RECORDINGS_DIR, ...relTs.split('/'));
    if (activeFull.has(tsFull)) continue;
    const mp4Rel = relTs.replace(/\.ts$/i, '.mp4');
    const mp4Full = tsFull.replace(/\.ts$/i, '.mp4');
    if (fs.existsSync(mp4Full)) continue;
    try {
      const ok = await remuxTsToMp4(tsFull, mp4Full);
      if (ok) {
        await ensureThumbnailAndMeta(mp4Rel, { force: true }).catch(() => {});
        recovered.push(mp4Rel);
      }
    } catch {}
  }
  return recovered;
}

module.exports = {
  RECORDINGS_DIR,
  THUMBS_DIR,
  AUDIO_DIR,
  CLIPS_DIR,
  getDiskStatus,
  listRecordingFiles,
  deleteRecordingBundle,
  enforceRetention,
  readMeta,
  updateRecordingMeta,
  ensureThumbnailAndMeta,
  isMediaProbeCoolingDown,
  invalidateDirBytesCache,
  extractAudio,
  compressRecording,
  remuxFaststart,
  remuxTsToMp4,
  recoverOrphanedTsFiles,
  mergeRecordingParts,
  shutdownMediaProcs,
};
