// lib/ffmpeg.js — Locate ffmpeg / ffprobe binaries.
// Priority: FFMPEG_PATH (or FFPROBE_PATH) env > system PATH > common Windows package managers > bundled static packages.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getStealthUserAgent, isPlatformStealth } = require('./stealth');

let cached = null;
let cachedProbe = null;
let cachedAvailable = null;

function probePathBinary(cmd) {
  const probeCmd = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(probeCmd, [cmd], { encoding: 'utf8', timeout: 5000 });
  if (probe.status !== 0 || !probe.stdout) return null;
  const lines = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s));
  if (lines.length === 0) return null;
  if (process.platform === 'win32') {
    const exe = lines.find((s) => /\.exe$/i.test(s));
    if (exe) return exe;
  }
  return lines[0];
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
            try {
              for (const sub of fs.readdirSync(pkgDir)) {
                const exe = path.join(pkgDir, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exe)) candidates.push(exe);
              }
            } catch {}
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

  return 'ffmpeg';
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

  return 'ffprobe';
}

/**
 * Build ffmpeg arguments for recording a live stream to fragmented MP4.
 * Inserts h264_mp4toannexb / hevc_mp4toannexb for video streams so mid-stream
 * resolution or SPS/PPS changes (e.g. TikTok PK battles on 360p/ld) inject
 * updated parameter sets in-band instead of corrupting subsequent frames.
 */
function buildRecordArgs({ url, audioUrl = null, kind = 'flv', quality, audioOnly = false, audioBitrate = null, format = 'mp4', referer = 'https://www.tiktok.com/', platform = 'tiktok' } = {}, outFile, proxyArgs = []) {
  const isAudioOnly = !!audioOnly || quality === 'ao';
  const isAdaptive = kind === 'yt_adaptive';
  const isCmaf = kind === 'cmaf';
  const primaryUrl = isAudioOnly && audioUrl ? audioUrl : url;
  const isLoopback = /^http:\/\/127\.0\.0\.1:/i.test(String(primaryUrl || ''));
  const isHttpNetwork = /^https?:\/\//i.test(String(primaryUrl || ''));
  const useTs = format === 'ts' && !isAudioOnly && !isAdaptive && !isCmaf;
  const isHlsInput = kind === 'hls';
  const hasSeparateAudio = !isAudioOnly && Boolean(audioUrl);
  const isHevc = typeof quality === 'string' && quality.startsWith('hevc:');
  const videoBsf = isHevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';
  const ua = getStealthUserAgent(isPlatformStealth(platform));
  const safeReferer = String(referer || 'https://www.tiktok.com/').replace(/[\r\n]/g, '') || 'https://www.tiktok.com/';

  const codecArgs = [];
  if (isAudioOnly) {
    codecArgs.push('-vn');
    if (audioBitrate) {
      codecArgs.push('-c:a', 'aac', '-b:a', audioBitrate);
    } else {
      codecArgs.push('-c:a', 'copy', ...(isCmaf || isAdaptive ? [] : ['-bsf:a', 'aac_adtstoasc']));
    }
  } else if (isAdaptive || isCmaf) {
    if (audioBitrate) {
      codecArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', audioBitrate);
    } else {
      codecArgs.push('-c', 'copy');
    }
  } else if (audioBitrate) {
    codecArgs.push('-c:v', 'copy', ...(isHlsInput ? [] : ['-bsf:v', videoBsf]), '-c:a', 'aac', '-b:a', audioBitrate);
  } else if (useTs) {
    codecArgs.push('-c', 'copy', ...(isHlsInput ? [] : ['-bsf:v', videoBsf]));
  } else {
    codecArgs.push('-c', 'copy', ...(isHlsInput ? ['-bsf:a', 'aac_adtstoasc'] : ['-bsf:v', videoBsf, '-bsf:a', 'aac_adtstoasc']));
  }

  const inputHeadArgs = [
    ...(isHttpNetwork ? ['-protocol_whitelist', 'https,http,tcp,tls,crypto'] : []),
    '-user_agent', ua,
    '-headers', `Referer: ${safeReferer}\r\n`,
    ...(isAdaptive || isLoopback ? [] : proxyArgs),
    '-fflags', '+genpts+discardcorrupt',
  ];

  const outputArgs = useTs
    ? ['-avoid_negative_ts', 'make_zero', '-f', 'mpegts', outFile]
    : ['-avoid_negative_ts', 'make_zero', '-movflags', '+empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '2000000', outFile];

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    ...inputHeadArgs,
    '-i', primaryUrl,
    ...(hasSeparateAudio ? [...inputHeadArgs, '-i', audioUrl, '-map', '0:v:0', '-map', '1:a:0'] : []),
    ...codecArgs,
    ...outputArgs,
  ];
}

module.exports = { resolveFfmpeg, resolveFfprobe, isFfmpegAvailable, buildRecordArgs };
