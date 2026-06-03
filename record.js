// record.js — Record a live TikTok stream to an MP4 file via ffmpeg.
// Usage: node record.js <username> [outputDir]
//   e.g. node record.js tv_asahi_news ./recordings
//
// Requires ffmpeg installed and on PATH.
// Stop recording with Ctrl+C — ffmpeg will finalize the file cleanly.

require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  normalizeUsername,
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  pickPreferredStream,
} = require('./lib/room');
const { resolveFfmpeg } = require('./lib/ffmpeg');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  const username = normalizeUsername(process.argv[2]);
  const outDir = process.argv[3] || './recordings';
  if (!username) {
    console.error('Usage: node record.js <username> [outputDir]');
    process.exit(2);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const apiData = await fetchApiLive(username);
  if (!isLiveFromApi(apiData)) {
    console.error(`@${username} is not live right now.`);
    process.exit(1);
  }

  const streams = extractStreamUrls(apiData);
  const pick = pickPreferredStream(streams);
  if (!pick) {
    console.error('Could not extract a stream URL from API response.');
    process.exit(2);
  }

  const outFile = path.join(outDir, `${username}_${timestamp()}.mp4`);
  const ffmpegBin = resolveFfmpeg();
  console.log(`▶ Recording @${username} (${pick.kind}/${pick.quality})`);
  console.log(`  Title:  ${apiData?.liveRoom?.title || '(no title)'}`);
  console.log(`  Source: ${pick.url}`);
  console.log(`  Output: ${outFile}`);
  console.log(`  ffmpeg: ${ffmpegBin}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-fflags', '+genpts',
    '-i', pick.url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    // Fragmented MP4 so the file is playable even if killed mid-recording.
    '-movflags', '+empty_moov+default_base_moof+frag_keyframe',
    '-frag_duration', '2000000',
    outFile,
  ];

  const ff = spawn(ffmpegBin, args, { stdio: ['pipe', 'inherit', 'inherit'] });

  let stopping = false;
  const stop = () => {
    if (stopping || ff.killed) return;
    stopping = true;
    try { ff.stdin?.write('q'); ff.stdin?.end(); } catch {}
    // Force-kill only if ffmpeg doesn't finalize within 8s.
    setTimeout(() => { try { ff.kill(); } catch {} }, 8000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  ff.on('exit', (code) => {
    console.log(`\nffmpeg exited with code ${code}. File: ${outFile}`);
    process.exit(code ?? 0);
  });
  ff.on('error', (err) => {
    console.error('Failed to start ffmpeg. Is it installed and on PATH?');
    console.error(err.message);
    process.exit(2);
  });
}

main().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(2);
});
