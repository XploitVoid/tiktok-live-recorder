// lib/ffmpeg.js — Locate ffmpeg / ffprobe binaries.
// Priority: FFMPEG_PATH (or FFPROBE_PATH) env > system PATH > common Windows package managers > bundled static packages.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let cached = null;
let cachedProbe = null;
let cachedAvailable = null;

function probePathBinary(cmd) {
  const probeCmd = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(probeCmd, [cmd], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout) return null;
  const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first && fs.existsSync(first) ? first : null;
}

function resolveFfmpeg() {
  if (cached) return cached;

  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return (cached = process.env.FFMPEG_PATH);
  }

  const fromPath = probePathBinary('ffmpeg');
  if (fromPath) return (cached = fromPath);

  if (process.platform === 'win32') {
    const candidates = [];
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
      const pkgRoot = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
      if (fs.existsSync(pkgRoot)) {
        try {
          for (const pkg of fs.readdirSync(pkgRoot)) {
            if (!/ffmpeg/i.test(pkg)) continue;
            const pkgDir = path.join(pkgRoot, pkg);
            const direct = path.join(pkgDir, 'ffmpeg.exe');
            if (fs.existsSync(direct)) candidates.push(direct);
            for (const sub of fs.readdirSync(pkgDir)) {
              const exe = path.join(pkgDir, sub, 'bin', 'ffmpeg.exe');
              if (fs.existsSync(exe)) candidates.push(exe);
            }
          }
        } catch {}
      }
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe'));
    }
    candidates.push(
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    );
    for (const c of candidates) {
      if (fs.existsSync(c)) return (cached = c);
    }
  }

  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return (cached = bundled);
  } catch {}

  return (cached = 'ffmpeg');
}

function isFfmpegAvailable() {
  if (cachedAvailable === true) return true;
  const bin = resolveFfmpeg();
  const res = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 15000 });
  const ok = res.status === 0;
  if (ok) cachedAvailable = true;
  return ok;
}

function resolveFfprobe() {
  if (cachedProbe) return cachedProbe;

  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    return (cachedProbe = process.env.FFPROBE_PATH);
  }

  const ff = resolveFfmpeg();
  if (ff && ff !== 'ffmpeg') {
    const candidate = ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    if (candidate !== ff && fs.existsSync(candidate)) return (cachedProbe = candidate);
  }

  const fromPath = probePathBinary('ffprobe');
  if (fromPath) return (cachedProbe = fromPath);

  try {
    const bundled = require('ffprobe-static');
    if (bundled?.path && fs.existsSync(bundled.path)) return (cachedProbe = bundled.path);
  } catch {}

  return (cachedProbe = 'ffprobe');
}

/**
 * Build ffmpeg arguments for recording a live stream to fragmented MP4.
 * Inserts h264_mp4toannexb / hevc_mp4toannexb for video streams so mid-stream
 * resolution or SPS/PPS changes (e.g. TikTok PK battles on 360p/ld) inject
 * updated parameter sets in-band instead of corrupting subsequent frames.
 */
function buildRecordArgs({ url, kind = 'flv', quality, audioOnly = false, audioBitrate = null, format = 'mp4', referer = 'https://www.tiktok.com/' } = {}, outFile, proxyArgs = []) {
  const isAudioOnly = !!audioOnly || quality === 'ao';
  const useTs = format === 'ts' && !isAudioOnly;
  const isHlsInput = kind === 'hls';
  const isHevc = typeof quality === 'string' && quality.startsWith('hevc:');
  const videoBsf = isHevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';
  const safeReferer = String(referer || 'https://www.tiktok.com/').replace(/[\r\n]/g, '') || 'https://www.tiktok.com/';

  const codecArgs = [];
  if (isAudioOnly) {
    codecArgs.push('-vn');
    if (audioBitrate) {
      codecArgs.push('-c:a', 'aac', '-b:a', audioBitrate);
    } else if (useTs) {
      codecArgs.push('-c:a', 'copy');
    } else {
      codecArgs.push('-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
    }
  } else if (useTs) {
    if (audioBitrate) {
      codecArgs.push('-c:v', 'copy', ...(isHlsInput ? [] : ['-bsf:v', videoBsf]), '-c:a', 'aac', '-b:a', audioBitrate);
    } else {
      codecArgs.push('-c', 'copy', ...(isHlsInput ? [] : ['-bsf:v', videoBsf]));
    }
  } else if (audioBitrate) {
    codecArgs.push('-c:v', 'copy', ...(isHlsInput ? [] : ['-bsf:v', videoBsf]), '-c:a', 'aac', '-b:a', audioBitrate);
  } else {
    codecArgs.push('-c', 'copy', ...(isHlsInput ? ['-bsf:a', 'aac_adtstoasc'] : ['-bsf:v', videoBsf, '-bsf:a', 'aac_adtstoasc']));
  }

  const outputArgs = useTs
    ? ['-f', 'mpegts', outFile]
    : ['-movflags', '+empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '2000000', outFile];

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    '-headers', `Referer: ${safeReferer}\r\n`,
    ...proxyArgs,
    '-fflags', '+genpts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-i', url,
    ...codecArgs,
    ...outputArgs,
  ];
}

module.exports = { resolveFfmpeg, resolveFfprobe, isFfmpegAvailable, buildRecordArgs };
