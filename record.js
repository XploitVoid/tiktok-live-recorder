// record.js — Record a live TikTok stream to an MP4 file via ffmpeg.
// Usage: node record.js <username> [outputDir]
//   e.g. node record.js tv_asahi_news ./recordings
//
// Requires ffmpeg installed and on PATH.
// Stop recording with Ctrl+C — ffmpeg will finalize the file cleanly.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { spawn } = require('child_process');
const fs = require('fs');
const {
  normalizeUsername,
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  pickPreferredStream,
} = require('./lib/room');
const { resolveFfmpeg, buildRecordArgs } = require('./lib/ffmpeg');
const { isValidStreamUrl, assertPublicDns, safeError } = require('./lib/utils');
const { getProxyAgent, getFfmpegProxyEnv } = require('./lib/proxy-config');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  const username = normalizeUsername(process.argv[2]);
  const rawOutDir = process.argv[3] || './recordings';
  if (!username) {
    console.error('Usage: node record.js <username> [outputDir]');
    process.exit(2);
  }
  if (rawOutDir.startsWith('-')) {
    console.error('Invalid output directory path');
    process.exit(2);
  }
  const outDir = path.resolve(rawOutDir);

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
  if (!isValidStreamUrl(pick.url) || (pick.audioUrl && !isValidStreamUrl(pick.audioUrl))) {
    console.error('Stream URL has invalid protocol.');
    process.exit(2);
  }
  if (!getProxyAgent()) {
    try {
      await assertPublicDns(new URL(pick.url).hostname);
      if (pick.audioUrl) await assertPublicDns(new URL(pick.audioUrl).hostname);
    } catch {
      console.error('Stream host resolved to disallowed IP.');
      process.exit(2);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${username}_${timestamp()}.mp4`);
  const ffmpegBin = resolveFfmpeg();
  console.log(`▶ Recording @${username} (${pick.kind}/${pick.quality})`);
  console.log(`  Title:  ${apiData?.liveRoom?.title || '(no title)'}`);
  console.log(`  Source: ${pick.url}`);
  console.log(`  Output: ${outFile}`);
  console.log(`  ffmpeg: ${ffmpegBin}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  const args = buildRecordArgs(pick, outFile, []);
  const proxyEnv = getFfmpegProxyEnv();

  const ff = spawn(ffmpegBin, args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: Object.keys(proxyEnv).length > 0 ? { ...process.env, ...proxyEnv } : process.env,
  });
  ff.stdin?.on('error', () => {});

  let stopping = false;
  const stop = () => {
    if (stopping || ff.killed) return;
    stopping = true;
    try {
      if (ff.stdin && !ff.stdin.destroyed && !ff.stdin.writableEnded) {
        ff.stdin.write('q');
        ff.stdin.end();
      }
    } catch {}
    // Force-kill only if ffmpeg doesn't finalize within 8s.
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 8000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  ff.on('exit', (code) => {
    console.log(`\nffmpeg exited with code ${code}. File: ${outFile}`);
    process.exit(code === null ? (stopping ? 0 : 1) : code);
  });
  ff.on('error', (err) => {
    console.error('Failed to start ffmpeg. Is it installed and on PATH?');
    console.error(err.message);
    process.exit(2);
  });
}

main().catch((e) => {
  console.error('Error:', safeError(e));
  process.exit(2);
});
