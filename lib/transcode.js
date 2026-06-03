// lib/transcode.js — H.264 encoder detection and ffmpeg transcode arguments.
// Hardware-accelerated paths drop CPU usage from ~40% to ~5% per stream.

const { resolveFfmpeg } = require('./ffmpeg');

const MAX_CONCURRENT_TRANSCODES = 5;
const transcodeProcs = new Set();

let h264Encoder = null;

// Detect best available H.264 encoder once at startup.
function detectH264Encoder() {
  try {
    const ffmpegBin = resolveFfmpeg();
    const { execSync } = require('child_process');
    const out = execSync(`"${ffmpegBin}" -hide_banner -encoders`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Probe order: NVIDIA NVENC > Intel QSV > AMD AMF > CPU libx264
    for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      if (new RegExp(`\\b${enc}\\b`).test(out)) {
        // Verify it actually runs (e.g. NVENC requires NVIDIA driver loaded)
        try {
          execSync(
            `"${ffmpegBin}" -hide_banner -loglevel error -f lavfi -i color=size=128x128:rate=1 -frames:v 1 -c:v ${enc} -f null - `,
            { stdio: 'ignore' }
          );
          return enc;
        } catch { /* encoder listed but not usable, try next */ }
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
    '-fflags', '+genpts+discardcorrupt',
    '-rtbufsize', '64M',
    '-thread_queue_size', '512',
    '-i', target,
  ];
  const audio = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];
  const output = ['-f', 'flv', 'pipe:1'];

  if (encoder === 'h264_nvenc') {
    return [...common,
      '-vf', 'format=yuv420p',  // ensure NVENC-compatible pixel format
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',          // p1=fastest..p7=slowest; p4 balanced
      '-tune', 'll',            // low-latency
      '-rc', 'vbr',
      '-b:v', '4M', '-maxrate', '6M', '-bufsize', '8M',
      '-profile:v', 'high',
      '-g', '60',
      ...audio, ...output];
  }
  if (encoder === 'h264_qsv') {
    return [...common,
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-global_quality', '23',
      '-look_ahead', '0',
      '-profile:v', 'high', '-level', '41',
      '-g', '60',
      ...audio, ...output];
  }
  if (encoder === 'h264_amf') {
    return [...common,
      '-c:v', 'h264_amf',
      '-quality', 'speed',
      '-rc', 'cqp', '-qp_i', '23', '-qp_p', '25',
      '-profile:v', 'high', '-level', '4.1',
      '-g', '60',
      ...audio, ...output];
  }
  // libx264 fallback (CPU)
  return [...common,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main', '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
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
