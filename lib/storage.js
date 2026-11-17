// lib/storage.js — Disk space guard, retention cleanup, thumbnails/ffprobe metadata, and audio extraction.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveFfmpeg, resolveFfprobe, isFfmpegAvailable } = require('./ffmpeg');
const { resolveInsideDir, sanitizeAudioBitrate } = require('./utils');
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
 * Safely delete a recording `.mp4` and all associated sidecars, thumbnails, audio, and clips.
 */
function deleteRecordingBundle(mp4Name) {
  const resolved = resolveInsideDir(RECORDINGS_DIR, mp4Name, '.mp4');
  if (!resolved) return false;
  const { name, full } = resolved;
  const base = name.replace(/\.mp4$/i, '');

  fs.unlinkSync(full);
  for (const suffix of ['.events.jsonl', '.highlights.json', '.bookmarks.json', '.meta.json']) {
    try { fs.unlinkSync(path.join(RECORDINGS_DIR, `${base}${suffix}`)); } catch {}
  }
  try { fs.unlinkSync(path.join(THUMBS_DIR, `${base}.jpg`)); } catch {}
  try { fs.unlinkSync(path.join(THUMBS_DIR, `${base}_sprite.jpg`)); } catch {}
  try { fs.unlinkSync(path.join(THUMBS_DIR, `${base}_sprite.json`)); } catch {}
  try {
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      if (f === `${base}.m4a` || f === `${base}.mp3` || (f.startsWith(`${base}_`) && (f.endsWith('.m4a') || f.endsWith('.mp3')))) {
        try { fs.unlinkSync(path.join(AUDIO_DIR, f)); } catch {}
      }
    }
  } catch {}
  try {
    const prefix = `${base}_clip_`;
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

  const activeNames = new Set([...activeFilePaths].map((p) => path.basename(p)));
  let entries = [];
  try {
    entries = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.mp4'))
      .map((d) => {
        const full = path.join(RECORDINGS_DIR, d.name);
        const st = fs.statSync(full);
        return { name: d.name, mtimeMs: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  } catch {
    return { deleted: [] };
  }

  const deleted = [];
  const now = Date.now();
  const maxAgeMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : null;

  // 1. Delete expired recordings (skip active and protected/pinned files)
  if (maxAgeMs !== null) {
    for (const e of entries) {
      if (activeNames.has(e.name)) continue;
      if (readMeta(e.name)?.protected) continue;
      if (now - e.mtimeMs > maxAgeMs) {
        try {
          if (deleteRecordingBundle(e.name)) deleted.push(e.name);
        } catch {}
      }
    }
  }

  // 2. Enforce total size cap (skip active and protected/pinned files)
  if (maxRecordingsGb > 0) {
    const capBytes = maxRecordingsGb * 1024 ** 3;
    let currentBytes = sumDirBytes(RECORDINGS_DIR);
    for (const e of entries) {
      if (currentBytes <= capBytes) break;
      if (deleted.includes(e.name) || activeNames.has(e.name)) continue;
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
    invalidateDirBytesCache();
    console.log(`[storage] retention cleanup removed ${deleted.length} recording(s): ${deleted.join(', ')}`);
  }
  return { deleted };
}

function readMeta(recordingName) {
  const resolved = resolveInsideDir(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved) return null;
  const base = resolved.name.replace(/\.mp4$/i, '');
  const metaFile = path.join(RECORDINGS_DIR, `${base}.meta.json`);
  const thumbFile = path.join(THUMBS_DIR, `${base}.jpg`);
  const spriteImg = path.join(THUMBS_DIR, `${base}_sprite.jpg`);
  const spriteJson = path.join(THUMBS_DIR, `${base}_sprite.json`);
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
    thumbUrl: hasThumb ? `/files/thumbs/${encodeURIComponent(base + '.jpg')}` : null,
    spriteUrl: spriteMeta ? `/files/thumbs/${encodeURIComponent(base + '_sprite.jpg')}` : null,
    spriteMeta,
  };
}

function updateRecordingMeta(recordingName, patch = {}) {
  const resolved = resolveInsideDir(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) {
    const err = new Error('recording not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const base = resolved.name.replace(/\.mp4$/i, '');
  const metaFile = path.join(RECORDINGS_DIR, `${base}.meta.json`);
  let current = {};
  try {
    if (fs.existsSync(metaFile)) {
      current = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {};
    }
  } catch {}
  const next = { ...current };
  if (typeof patch.protected === 'boolean') next.protected = patch.protected;
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
  const tmp = metaFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, metaFile);
  return readMeta(resolved.name);
}

function runCommand(bin, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('command timed out'));
    }, timeoutMs);
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit ${code}: ${stderr.slice(-200)}`));
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
  const resolved = resolveInsideDir(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) return null;
  if (!isFfmpegAvailable()) return null;

  const { name, full } = resolved;
  if (!force) {
    const failedTs = failedProbeAt.get(name);
    if (failedTs && Date.now() - failedTs < FAILED_PROBE_COOLDOWN_MS) {
      return readMeta(name);
    }
  }
  const key = force ? `${name}:force` : name;
  if (inflightMedia.has(key)) return inflightMedia.get(key);

  const task = (async () => {
    await acquireMediaSlot();
    try {
      const base = name.replace(/\.mp4$/i, '');
      const metaFile = path.join(RECORDINGS_DIR, `${base}.meta.json`);
      const thumbFile = path.join(THUMBS_DIR, `${base}.jpg`);

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
          probedMeta = {
            ...existingMeta,
            durationSec: info.format?.duration ? Math.round(Number(info.format.duration)) : null,
            width: v?.width || null,
            height: v?.height || null,
            fps,
            vcodec: v?.codec_name || null,
            acodec: a?.codec_name || null,
          };
          const tmp = metaFile + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(probedMeta, null, 2));
          fs.renameSync(tmp, metaFile);
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
        try {
          await runCommand(ff, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-ss', '3',
            '-i', full,
            '-frames:v', '1',
            '-vf', 'scale=320:-2',
            '-q:v', '5',
            thumbFile,
          ], 15000);
        } catch {
          // Retry at 0s in case video is < 3s
          try {
            await runCommand(ff, [
              '-hide_banner', '-loglevel', 'error', '-y',
              '-i', full,
              '-frames:v', '1',
              '-vf', 'scale=320:-2',
              '-q:v', '5',
              thumbFile,
            ], 15000);
          } catch {}
        }
      }

      // 3. Generate timeline sprite sheet (max 8x8 = 64 tiles at 160px wide)
      // For >= 60s streams, try -skip_frame nokey first so ffmpeg only decodes keyframes (~50x faster).
      const spriteImg = path.join(THUMBS_DIR, `${base}_sprite.jpg`);
      const spriteJson = path.join(THUMBS_DIR, `${base}_sprite.json`);
      const dur = probedMeta?.durationSec || 0;
      if (hasVideo && dur >= 10 && (!fs.existsSync(spriteImg) || !fs.existsSync(spriteJson))) {
        const cols = 8;
        const rows = 8;
        const intervalSec = Math.max(5, Math.ceil(dur / (cols * rows)));
        const ff = resolveFfmpeg();
        const buildSpriteArgs = (fastKeyOnly) => [
          '-hide_banner', '-loglevel', 'error', '-y',
          ...(fastKeyOnly ? ['-skip_frame', 'nokey'] : []),
          '-i', full,
          '-vf', `fps=1/${intervalSec},scale=160:-2,tile=${cols}x${rows}`,
          '-frames:v', '1',
          '-q:v', '6',
          spriteImg,
        ];
        try {
          let ok = false;
          if (dur >= 60) {
            try {
              await runCommand(ff, buildSpriteArgs(true), 25_000);
              ok = fs.existsSync(spriteImg);
            } catch { /* fall back to full decode if keyframe-only fails */ }
          }
          if (!ok) {
            await runCommand(ff, buildSpriteArgs(false), 25_000);
          }
          if (fs.existsSync(spriteImg)) {
            const tileHeight = (probedMeta?.width && probedMeta?.height)
              ? Math.round((160 * probedMeta.height) / probedMeta.width / 2) * 2
              : 284;
            const tmpS = spriteJson + '.tmp';
            fs.writeFileSync(tmpS, JSON.stringify({
              intervalSec,
              cols,
              rows,
              tileWidth: 160,
              tileHeight,
              durationSec: dur,
            }));
            fs.renameSync(tmpS, spriteJson);
          }
        } catch { /* non-fatal */ }
      }

      return readMeta(name);
    } finally {
      releaseMediaSlot();
    }
  })().finally(() => {
    inflightMedia.delete(key);
  });

  inflightMedia.set(key, task);
  return task;
}

async function extractAudio(recordingName, format = 'm4a', rawBitrate = null) {
  if (!['m4a', 'mp3'].includes(format)) {
    const err = new Error('unsupported audio format');
    err.code = 'BAD_FORMAT';
    throw err;
  }
  const bitrate = sanitizeAudioBitrate(rawBitrate, null);
  const resolved = resolveInsideDir(RECORDINGS_DIR, recordingName, '.mp4');
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

  const base = resolved.name.replace(/\.mp4$/i, '');
  const outName = bitrate ? `${base}_${bitrate}.${format}` : `${base}.${format}`;
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
  const resolved = resolveInsideDir(RECORDINGS_DIR, recordingName, '.mp4');
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

  const base = resolved.name.replace(/\.mp4$/i, '');
  const outName = `${base}_${preset}.mp4`;
  const outPath = path.join(RECORDINGS_DIR, outName);
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
    const tmpPath = path.join(RECORDINGS_DIR, `.tmp_${process.pid}_${Date.now()}_${outName}`);
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
    const origEvents = path.join(RECORDINGS_DIR, `${base}.events.jsonl`);
    const outEvents = path.join(RECORDINGS_DIR, `${base}_${preset}.events.jsonl`);
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
  const resolved = resolveInsideDir(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) return false;
  if (!isFfmpegAvailable()) return false;
  let origSize = 0;
  try { origSize = fs.statSync(resolved.full).size; } catch { return false; }
  if (origSize <= 0) return false;

  const tmpPath = path.join(RECORDINGS_DIR, `.faststart_${process.pid}_${Date.now()}_${resolved.name}`);
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

module.exports = {
  RECORDINGS_DIR,
  THUMBS_DIR,
  AUDIO_DIR,
  CLIPS_DIR,
  getDiskStatus,
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
};
