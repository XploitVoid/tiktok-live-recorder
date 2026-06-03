// lib/ffmpeg.js — Locate ffmpeg.exe even if PATH wasn't refreshed.
// Priority: FFMPEG_PATH env > PATH lookup > known winget Gyan.FFmpeg dir.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let cached = null;

function resolveFfmpeg() {
  if (cached) return cached;

  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return (cached = process.env.FFMPEG_PATH);
  }

  const probeCmd = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(probeCmd, ['ffmpeg'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return (cached = first);
  }

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wingetDir = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft', 'WinGet', 'Packages',
      'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe'
    );
    if (fs.existsSync(wingetDir)) {
      const sub = fs.readdirSync(wingetDir).find((d) => d.startsWith('ffmpeg-'));
      if (sub) {
        const exe = path.join(wingetDir, sub, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(exe)) return (cached = exe);
      }
    }
  }

  return (cached = 'ffmpeg');
}

module.exports = { resolveFfmpeg };
