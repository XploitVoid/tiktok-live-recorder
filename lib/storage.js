// lib/storage.js — Disk space guard, retention cleanup, thumbnails/ffprobe metadata, and audio extraction.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveFfmpeg, resolveFfprobe, isFfmpegAvailable } = require('./ffmpeg');
const { resolveInsideDir } = require('./utils');
const { getSettings } = require('./settings');

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');
const THUMBS_DIR = path.join(RECORDINGS_DIR, 'thumbs');
const AUDIO_DIR = path.join(RECORDINGS_DIR, 'audio');
const CLIPS_DIR = path.join(RECORDINGS_DIR, 'highlights');

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(CLIPS_DIR, { recursive: true });

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

function getDiskStatus() {
  let freeBytes = null;
  let totalBytes = null;
  try {
    const st = fs.statfsSync(RECORDINGS_DIR);
    freeBytes = Number(st.bavail) * Number(st.bsize);
    totalBytes = Number(st.blocks) * Number(st.bsize);
  } catch {}
  const recordingsBytes = sumDirBytes(RECORDINGS_DIR);
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
  for (const ext of ['.m4a', '.mp3']) {
    try { fs.unlinkSync(path.join(AUDIO_DIR, `${base}${ext}`)); } catch {}
  }
  try {
    const prefix = `${base}_clip_`;
    for (const c of fs.readdirSync(CLIPS_DIR)) {
      if (c.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(CLIPS_DIR, c)); } catch {}
      }
    }
  } catch {}
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

  // 1. Delete expired recordings
  if (maxAgeMs !== null) {
    for (const e of entries) {
      if (activeNames.has(e.name)) continue;
      if (now - e.mtimeMs > maxAgeMs) {
        try {
          if (deleteRecordingBundle(e.name)) deleted.push(e.name);
        } catch {}
      }
    }
  }

  // 2. Enforce total size cap
  if (maxRecordingsGb > 0) {
    const capBytes = maxRecordingsGb * 1024 ** 3;
    let currentBytes = sumDirBytes(RECORDINGS_DIR);
    for (const e of entries) {
      if (currentBytes <= capBytes) break;
      if (deleted.includes(e.name) || activeNames.has(e.name)) continue;
      try {
        if (deleteRecordingBundle(e.name)) {
          deleted.push(e.name);
          currentBytes = sumDirBytes(RECORDINGS_DIR);
        }
      } catch {}
    }
  }

  if (deleted.length > 0) {
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
  let meta = null;
  let hasMeta = false;
  try {
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      hasMeta = !!(meta && typeof meta === 'object');
    }
  } catch {}
  const hasThumb = fs.existsSync(thumbFile);
  return {
    ...(meta || {}),
    hasMeta,
    hasThumb,
    thumbUrl: hasThumb ? `/files/thumbs/${encodeURIComponent(base + '.jpg')}` : null,
  };
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

async function ensureThumbnailAndMeta(recordingName, { force = false } = {}) {
  const resolved = resolveInsideDir(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved || !fs.existsSync(resolved.full)) return null;
  if (!isFfmpegAvailable()) return null;

  const { name, full } = resolved;
  const key = force ? `${name}:force` : name;
  if (inflightMedia.has(key)) return inflightMedia.get(key);

  const task = (async () => {
    const base = name.replace(/\.mp4$/i, '');
    const metaFile = path.join(RECORDINGS_DIR, `${base}.meta.json`);
    const thumbFile = path.join(THUMBS_DIR, `${base}.jpg`);

    let probedMeta = null;
    if (!force && fs.existsSync(metaFile)) {
      try { probedMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
    }

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
      } catch { /* ignore probe failure on partial/unreadable files */ }
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

    return readMeta(name);
  })().finally(() => {
    inflightMedia.delete(key);
  });

  inflightMedia.set(key, task);
  return task;
}

async function extractAudio(recordingName, format = 'm4a') {
  if (!['m4a', 'mp3'].includes(format)) {
    const err = new Error('unsupported audio format');
    err.code = 'BAD_FORMAT';
    throw err;
  }
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
  const outName = `${base}.${format}`;
  const outPath = path.join(AUDIO_DIR, outName);

  if (fs.existsSync(outPath)) {
    const st = fs.statSync(outPath);
    return {
      name: outName,
      url: `/files/audio/${encodeURIComponent(outName)}`,
      sizeBytes: st.size,
      reused: true,
    };
  }

  if (inflightAudio.has(outName)) {
    return inflightAudio.get(outName);
  }

  const task = (async () => {
    const ff = resolveFfmpeg();
    const codecArgs = format === 'mp3'
      ? ['-vn', '-c:a', 'libmp3lame', '-q:a', '2']
      : ['-vn', '-c:a', 'copy', '-movflags', '+faststart'];

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
        if (format === 'm4a') {
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
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw e;
    }

    const st = fs.statSync(outPath);
    return {
      name: outName,
      url: `/files/audio/${encodeURIComponent(outName)}`,
      sizeBytes: st.size,
      reused: false,
    };
  })().finally(() => {
    inflightAudio.delete(outName);
  });

  inflightAudio.set(outName, task);
  return task;
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
  ensureThumbnailAndMeta,
  extractAudio,
};
