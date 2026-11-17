// lib/transcode.js — H.264 encoder detection and ffmpeg transcode arguments.
// Hardware-accelerated paths drop CPU usage from ~40% to ~5% per stream.

const { spawnSync } = require('child_process');
const { resolveFfmpeg } = require('./ffmpeg');
const { getFfmpegProxyArgs } = require('./proxy-config');

const MAX_CONCURRENT_TRANSCODES = 5;
const transcodeProcs = new Set();

let h264Encoder = null;

// Detect best available H.264 encoder once at startup without invoking a shell.
function detectH264Encoder() {
  try {
    const ffmpegBin = resolveFfmpeg();
    const probe = spawnSync(ffmpegBin, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    if (probe.status !== 0 || !probe.stdout) return 'libx264';
    const out = probe.stdout;
    // Probe order: NVIDIA NVENC > Intel QSV > AMD AMF > CPU libx264
    for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      if (new RegExp(`\\b${enc}\\b`).test(out)) {
        // Verify it actually runs (e.g. NVENC requires NVIDIA driver loaded)
        const test = spawnSync(
          ffmpegBin,
          [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=size=128x128:rate=1',
            '-frames:v', '1', '-c:v', enc, '-f', 'null', '-',
          ],
          { stdio: 'ignore', timeout: 5000 }
        );
        if (test.status === 0) return enc;
      }
    }
  } catch { /* fall through to libx264 */ }
  return 'libx264';
}

function getEncoder() {
  if (!h264Encoder) h264Encoder = detectH264Encoder();
  return h264Encoder;
}

function buildTranscodeArgs(target, encoder) {
  const common = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    '-headers', 'Referer: https://www.tiktok.com/\r\n',
    ...getFfmpegProxyArgs(),
    '-probesize', '512k',
    '-analyzeduration', '1000000',
    '-fflags', '+genpts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-i', target,
  ];
  const audio = ['-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];
  const output = ['-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1'];

  if (encoder === 'h264_nvenc') {
    return [...common,
      '-vf', 'format=yuv420p',  // ensure NVENC-compatible 8-bit 4:2:0 format
      '-c:v', 'h264_nvenc',
      '-preset', 'p2',          // fast low-latency preset
      '-tune', 'll',            // low-latency
      '-bf', '0',               // no B-frames for smooth MSE / flv.js playback
      '-rc', 'vbr',
      '-b:v', '4M', '-maxrate', '6M', '-bufsize', '8M',
      '-profile:v', 'high',
      '-g', '30',
      ...audio, ...output];
  }
  if (encoder === 'h264_qsv') {
    return [...common,
      '-vf', 'format=yuv420p',
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-global_quality', '23',
      '-look_ahead', '0',
      '-bf', '0',
      '-profile:v', 'high', '-level', '41',
      '-g', '30',
      ...audio, ...output];
  }
  if (encoder === 'h264_amf') {
    return [...common,
      '-vf', 'format=yuv420p',
      '-c:v', 'h264_amf',
      '-quality', 'speed',
      '-rc', 'cqp', '-qp_i', '23', '-qp_p', '25',
      '-bf', '0',
      '-profile:v', 'high', '-level', '4.1',
      '-g', '30',
      ...audio, ...output];
  }
  // libx264 fallback (CPU)
  return [...common,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main', '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-bf', '0',
    '-g', '30',
    ...audio, ...output];
}

const ENCODER_LABELS = {
  h264_nvenc: 'NVIDIA NVENC (GPU)',
  h264_qsv: 'Intel Quick Sync (iGPU)',
  h264_amf: 'AMD AMF (GPU)',
  libx264: 'libx264 (CPU)',
};

module.exports = {
  MAX_CONCURRENT_TRANSCODES,
  transcodeProcs,
  getEncoder,
  buildTranscodeArgs,
  ENCODER_LABELS,
};
