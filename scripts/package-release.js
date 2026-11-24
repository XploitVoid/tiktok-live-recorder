#!/usr/bin/env node
// scripts/package-release.js — Stage self-contained cross-platform release bundles,
// Windows Inno Setup installer, SHA256SUMS.txt, and release notes locally.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { once } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const zlib = require('zlib');

const { extractChangelogSection, buildReleaseNotes } = require('./extract-release-notes');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_REPO = 'XploitVoid/tiktok-live-recorder';
const DEFAULT_REPO_URL = `https://github.com/${DEFAULT_REPO}`;
const DEFAULT_NODE_VERSION = 'v22.23.5';

const FORBIDDEN_RELEASE_FILES = new Set([
  '.env',
  'accounts.json',
  '.accounts.key',
  'watchlist.json',
  'settings.json',
]);

const TARGETS = {
  'windows-x64': {
    name: 'windows-x64',
    platform: 'win32',
    arch: 'x64',
    nodeArch: 'win-x64',
    nodeExt: 'zip',
    isWindows: true,
  },
  'linux-x64': {
    name: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    nodeArch: 'linux-x64',
    nodeExt: 'tar.gz',
    isWindows: false,
  },
  'macos-arm64': {
    name: 'macos-arm64',
    platform: 'darwin',
    arch: 'arm64',
    nodeArch: 'darwin-arm64',
    nodeExt: 'tar.gz',
    isWindows: false,
  },
  'macos-x64': {
    name: 'macos-x64',
    platform: 'darwin',
    arch: 'x64',
    nodeArch: 'darwin-x64',
    nodeExt: 'tar.gz',
    isWindows: false,
  },
};

function normalizeVersion(raw) {
  const cleaned = String(raw || '').trim().replace(/^v/i, '');
  if (!cleaned || !/^[0-9A-Za-z._+-]+$/.test(cleaned)) {
    throw new Error(`Invalid version string: "${raw}"`);
  }
  return cleaned;
}

function getTargetName(platform = process.platform, arch = process.arch) {
  const map = {
    win32: 'windows',
    darwin: 'macos',
    linux: 'linux',
  };
  const osName = map[platform] || platform;
  return `${osName}-${arch}`;
}

function isUnixExecutablePath(relPosixPath) {
  const p = String(relPosixPath || '').replace(/\\/g, '/');
  if (p === 'runtime/bin/node') return true;
  if (p === 'start.sh' || p === 'Start TikTok LIVE Recorder.command') return true;
  if (p === 'app/node_modules/ffmpeg-static/ffmpeg') return true;
  if (/^app\/node_modules\/ffprobe-static\/bin\/[^/]+\/[^/]+\/ffprobe$/.test(p)) return true;
  return false;
}

function assertNoSecretsInDir(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const lower = entry.name.toLowerCase();
      const isForbiddenEnv = lower.startsWith('.env.') && lower !== '.env.example';
      const isKeyFile = lower.endsWith('.key');
      if (FORBIDDEN_RELEASE_FILES.has(lower) || isForbiddenEnv || isKeyFile) {
        throw new Error(`Forbidden secret/user-data file detected in release staging: ${fullPath}`);
      }
    }
  }
}

function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  }
  return total;
}

function pruneFfprobeStatic(nodeModulesDir, platform = process.platform, arch = process.arch) {
  const binDir = path.join(nodeModulesDir, 'ffprobe-static', 'bin');
  if (!fs.existsSync(binDir)) return { savedBytes: 0 };

  let savedBytes = 0;
  for (const platEntry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!platEntry.isDirectory()) continue;
    const platDir = path.join(binDir, platEntry.name);
    if (platEntry.name !== platform) {
      savedBytes += dirSizeBytes(platDir);
      fs.rmSync(platDir, { recursive: true, force: true });
      continue;
    }
    for (const archEntry of fs.readdirSync(platDir, { withFileTypes: true })) {
      if (!archEntry.isDirectory()) continue;
      if (archEntry.name !== arch) {
        const archDir = path.join(platDir, archEntry.name);
        savedBytes += dirSizeBytes(archDir);
        fs.rmSync(archDir, { recursive: true, force: true });
      }
    }
  }

  const savedMb = (savedBytes / (1024 * 1024)).toFixed(1);
  console.log(`[package] Pruned ffprobe-static non-target binaries (saved ${savedMb} MB)`);
  return { savedBytes };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function generateChecksumsAndSource(assetsDir, { version, repoUrl = DEFAULT_REPO_URL, commitSha = '' } = {}) {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Assets directory does not exist: ${assetsDir}`);
  }
  const files = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(exe|zip|tar\.gz|dmg|AppImage|deb|rpm)$/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const lines = files.map((name) => `${sha256File(path.join(assetsDir, name))}  ${name}`);
  const checksumsPath = path.join(assetsDir, 'SHA256SUMS.txt');
  fs.writeFileSync(checksumsPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');

  const resolvedVersion = version ? normalizeVersion(version) : readPackageVersion();
  const resolvedCommit = commitSha || getGitCommitSha() || 'unknown';
  const sourceContent = [
    `Repository: ${repoUrl}`,
    `Version: v${resolvedVersion}`,
    `Commit: ${resolvedCommit}`,
    `Built-At: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  const sourcePath = path.join(assetsDir, 'SOURCE.txt');
  fs.writeFileSync(sourcePath, sourceContent, 'utf8');

  return { files, checksumsPath, sourcePath };
}

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  return normalizeVersion(pkg.version);
}

function getGitCommitSha() {
  try {
    const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' });
    if (res.status === 0 && res.stdout) return res.stdout.trim();
  } catch {}
  return '';
}

function runNpm(args, cwd) {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmBin, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${npmBin} ${args.join(' ')} exited with code ${res.status}`);
  }
}

function writeTextFile(filePath, content, { crlf = false, mode } = {}) {
  const normalized = crlf ? content.replace(/\r?\n/g, '\r\n') : content.replace(/\r\n/g, '\n');
  fs.writeFileSync(filePath, normalized, 'utf8');
  if (mode !== undefined && process.platform !== 'win32') {
    fs.chmodSync(filePath, mode);
  }
}

async function ensureNodeBinary(targetSpec, nodeVersion) {
  if (nodeVersion === 'local') {
    if (targetSpec.platform !== process.platform || targetSpec.arch !== process.arch) {
      throw new Error(`--node-version local only supports host target (${getTargetName()}), got ${targetSpec.name}`);
    }
    return process.execPath;
  }

  const ver = nodeVersion.startsWith('v') ? nodeVersion : `v${nodeVersion}`;
  const cacheDir = path.join(os.tmpdir(), 'tlr-node-cache', ver, targetSpec.nodeArch);
  const binName = targetSpec.isWindows ? 'node.exe' : 'node';
  const cachedBin = path.join(cacheDir, binName);
  const minBytes = 10 * 1024 * 1024;

  if (fs.existsSync(cachedBin) && fs.statSync(cachedBin).size > minBytes) {
    return cachedBin;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const archiveName = `node-${ver}-${targetSpec.nodeArch}.${targetSpec.nodeExt}`;
  const url = `https://nodejs.org/dist/${ver}/${archiveName}`;
  const tmpArchive = path.join(cacheDir, archiveName);

  console.log(`[package] Downloading portable Node.js ${ver} (${targetSpec.nodeArch})...`);
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} downloading ${url}`);
    }
    const out = fs.createWriteStream(tmpArchive);
    await finished(Readable.fromWeb(res.body).pipe(out));

    const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const extractArgs = targetSpec.isWindows
      ? ['-xf', tmpArchive, '-C', cacheDir, '--strip-components=1', `node-${ver}-${targetSpec.nodeArch}/node.exe`]
      : ['-xzf', tmpArchive, '-C', cacheDir, '--strip-components=2', `node-${ver}-${targetSpec.nodeArch}/bin/node`];
    const ex = spawnSync(tarCmd, extractArgs, { stdio: 'inherit' });
    if (ex.status !== 0) {
      throw new Error(`Failed extracting ${binName} from ${archiveName} (exit ${ex.status})`);
    }
  } finally {
    fs.rmSync(tmpArchive, { force: true });
  }

  if (!fs.existsSync(cachedBin) || fs.statSync(cachedBin).size <= minBytes) {
    throw new Error(`Extracted Node.js binary missing or too small: ${cachedBin}`);
  }
  return cachedBin;
}

function stageAndVerifyMediaBinaries(stagingApp, targetSpec) {
  const ffmpegPkgDir = path.join(stagingApp, 'node_modules', 'ffmpeg-static');
  const expectedFfmpeg = path.join(ffmpegPkgDir, targetSpec.isWindows ? 'ffmpeg.exe' : 'ffmpeg');
  const minBytes = 10 * 1024 * 1024;

  if (targetSpec.platform !== process.platform || targetSpec.arch !== process.arch) {
    for (const file of fs.readdirSync(ffmpegPkgDir)) {
      if (/^ffmpeg(\.exe)?(\.(LICENSE|README))?$/i.test(file)) {
        fs.rmSync(path.join(ffmpegPkgDir, file), { force: true });
      }
    }
    console.log(`[package] Fetching ffmpeg-static for ${targetSpec.platform}-${targetSpec.arch}...`);
    const res = spawnSync(process.execPath, [path.join(ffmpegPkgDir, 'install.js')], {
      cwd: ffmpegPkgDir,
      env: {
        ...process.env,
        npm_config_platform: targetSpec.platform,
        npm_config_arch: targetSpec.arch,
        CI: '1',
      },
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      throw new Error(`ffmpeg-static install.js failed for ${targetSpec.name} (status ${res.status})`);
    }
  }

  if (!fs.existsSync(expectedFfmpeg) || fs.statSync(expectedFfmpeg).size <= minBytes) {
    throw new Error(`Bundled ffmpeg binary missing or invalid at ${expectedFfmpeg}`);
  }

  pruneFfprobeStatic(path.join(stagingApp, 'node_modules'), targetSpec.platform, targetSpec.arch);
  const expectedFfprobe = path.join(
    stagingApp,
    'node_modules',
    'ffprobe-static',
    'bin',
    targetSpec.platform,
    targetSpec.arch,
    targetSpec.isWindows ? 'ffprobe.exe' : 'ffprobe'
  );
  if (!fs.existsSync(expectedFfprobe) || fs.statSync(expectedFfprobe).size <= minBytes) {
    throw new Error(`Bundled ffprobe binary missing or invalid at ${expectedFfprobe}`);
  }

  if (targetSpec.platform === process.platform && targetSpec.arch === process.arch) {
    const ffCheck = spawnSync(expectedFfmpeg, ['-version'], { stdio: 'ignore', timeout: 15000 });
    if (ffCheck.status !== 0) {
      throw new Error(`Bundled ffmpeg failed -version check (status ${ffCheck.status})`);
    }
    const fpCheck = spawnSync(expectedFfprobe, ['-version'], { stdio: 'ignore', timeout: 15000 });
    if (fpCheck.status !== 0) {
      throw new Error(`Bundled ffprobe failed -version check (status ${fpCheck.status})`);
    }
  }
}

function buildPaxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  while (true) {
    const line = `${len}${body}`;
    const actual = Buffer.byteLength(line, 'utf8');
    if (actual === len) return Buffer.from(line, 'utf8');
    len = actual;
  }
}

function encodeTarHeader({ name, mode, size, mtimeSec, typeflag }) {
  const hdr = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(name, 'utf8');
  nameBuf.copy(hdr, 0, 0, Math.min(nameBuf.length, 100));

  hdr.write(`${(mode & 0o7777).toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  hdr.write('0000000\0', 108, 8, 'ascii');
  hdr.write('0000000\0', 116, 8, 'ascii');
  hdr.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  hdr.write(`${mtimeSec.toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  hdr.fill(0x20, 148, 156); // spaces for checksum calculation
  hdr.write(typeflag, 156, 1, 'ascii');
  hdr.write('ustar\0', 257, 6, 'ascii');
  hdr.write('00', 263, 2, 'ascii');
  hdr.write('0000000\0', 329, 8, 'ascii');
  hdr.write('0000000\0', 337, 8, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += hdr[i];
  hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return hdr;
}

function toSafeAsciiFallback(tarPath, maxLen = 96) {
  const clean = tarPath.replace(/[^\x20-\x7e]/g, '_');
  if (Buffer.byteLength(clean, 'utf8') <= maxLen) return clean;
  return clean.slice(-maxLen);
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

async function createUnixTarGz(stagingParent, bundleDirName, outTarGz, isExecutableRelPath = isUnixExecutablePath) {
  const rootPath = path.join(stagingParent, bundleDirName);
  const entries = [];

  function walk(absDir, relSubPath) {
    const dirRelTar = relSubPath ? `${bundleDirName}/${relSubPath}` : bundleDirName;
    const dirStat = fs.statSync(absDir);
    entries.push({
      tarName: `${dirRelTar}/`,
      absPath: absDir,
      isDir: true,
      mode: 0o755,
      size: 0,
      mtimeSec: Math.floor(dirStat.mtimeMs / 1000),
    });

    const children = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const childAbs = path.join(absDir, child.name);
      const childRelSub = relSubPath ? `${relSubPath}/${child.name}` : child.name;
      if (child.isDirectory()) {
        walk(childAbs, childRelSub);
      } else if (child.isFile()) {
        const st = fs.statSync(childAbs);
        entries.push({
          tarName: `${bundleDirName}/${childRelSub}`,
          absPath: childAbs,
          isDir: false,
          mode: isExecutableRelPath(childRelSub) ? 0o755 : 0o644,
          size: st.size,
          mtimeSec: Math.floor(st.mtimeMs / 1000),
        });
      }
    }
  }

  walk(rootPath, '');

  fs.mkdirSync(path.dirname(outTarGz), { recursive: true });
  fs.rmSync(outTarGz, { force: true });

  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(outTarGz);
  const donePromise = finished(out);
  gzip.pipe(out);

  try {
    const readBuf = Buffer.allocUnsafe(64 * 1024);
    for (const entry of entries) {
      const nameByteLen = Buffer.byteLength(entry.tarName, 'utf8');
      const needsPax = nameByteLen > 100 || /[^\x20-\x7e]/.test(entry.tarName);

      if (needsPax) {
        const paxData = buildPaxRecord('path', entry.tarName);
        const paxHdrName = toSafeAsciiFallback(`PaxHeaders/${path.posix.basename(entry.tarName.replace(/\/$/, '')) || 'entry'}`, 99);
        const paxHdr = encodeTarHeader({
          name: paxHdrName,
          mode: 0o644,
          size: paxData.length,
          mtimeSec: entry.mtimeSec,
          typeflag: 'x',
        });
        await writeChunk(gzip, paxHdr);
        await writeChunk(gzip, paxData);
        const paxPad = (512 - (paxData.length % 512)) % 512;
        if (paxPad > 0) await writeChunk(gzip, Buffer.alloc(paxPad, 0));
      }

      const headerName = needsPax ? toSafeAsciiFallback(entry.tarName, 99) : entry.tarName;
      const hdr = encodeTarHeader({
        name: headerName,
        mode: entry.mode,
        size: entry.isDir ? 0 : entry.size,
        mtimeSec: entry.mtimeSec,
        typeflag: entry.isDir ? '5' : '0',
      });
      await writeChunk(gzip, hdr);

      if (!entry.isDir && entry.size > 0) {
        const fd = fs.openSync(entry.absPath, 'r');
        try {
          let bytesRead = 0;
          while ((bytesRead = fs.readSync(fd, readBuf, 0, readBuf.length, null)) > 0) {
            await writeChunk(gzip, Buffer.from(readBuf.subarray(0, bytesRead)));
          }
        } finally {
          fs.closeSync(fd);
        }
        const pad = (512 - (entry.size % 512)) % 512;
        if (pad > 0) await writeChunk(gzip, Buffer.alloc(pad, 0));
      }
    }

    await writeChunk(gzip, Buffer.alloc(1024, 0));
    gzip.end();
    await donePromise;
  } catch (err) {
    gzip.destroy(err);
    out.destroy(err);
    throw err;
  }

  return outTarGz;
}

async function createArchive({ stagingParent, bundleDirName, outDir, version, targetSpec }) {
  const artifactsDir = path.join(outDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  if (targetSpec.isWindows) {
    const outZip = path.join(artifactsDir, `tiktok-live-recorder-v${version}-${targetSpec.name}-portable.zip`);
    fs.rmSync(outZip, { force: true });

    if (process.platform === 'win32') {
      const tarRes = spawnSync('tar.exe', ['-a', '-cf', outZip, '-C', stagingParent, bundleDirName], {
        stdio: 'inherit',
      });
      if (tarRes.status !== 0 || !fs.existsSync(outZip)) {
        console.log('[package] tar.exe archive failed or unavailable, falling back to Compress-Archive...');
        const srcDir = path.join(stagingParent, bundleDirName);
        const psScript = `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force`;
        const psRes = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          stdio: 'inherit',
        });
        if (psRes.status !== 0 || !fs.existsSync(outZip)) {
          throw new Error('Failed to create portable zip archive via tar.exe and Compress-Archive');
        }
      }
    } else {
      const zipRes = spawnSync('zip', ['-rq', outZip, bundleDirName], { cwd: stagingParent, stdio: 'inherit' });
      if (zipRes.status !== 0 || !fs.existsSync(outZip)) {
        throw new Error('Failed to create portable zip archive via zip');
      }
    }
    return outZip;
  }

  const outTar = path.join(artifactsDir, `tiktok-live-recorder-v${version}-${targetSpec.name}.tar.gz`);
  await createUnixTarGz(stagingParent, bundleDirName, outTar, isUnixExecutablePath);
  return outTar;
}

function findIsccPath() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe') : '',
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const whereRes = spawnSync('where.exe', ['ISCC.exe'], { encoding: 'utf8' });
  if (whereRes.status === 0 && whereRes.stdout) {
    const first = whereRes.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

function buildWindowsInstaller({ stagingRoot, artifactsDir, version }) {
  const isccPath = findIsccPath();
  if (!isccPath) {
    console.log('[package] ISCC.exe not found; skipping Windows Setup installer (.exe).');
    return null;
  }
  const issPath = path.join(ROOT_DIR, 'packaging', 'windows', 'installer.iss');
  const outBaseName = `tiktok-live-recorder-v${version}-windows-x64-setup`;
  const expectedExe = path.join(artifactsDir, `${outBaseName}.exe`);
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.rmSync(expectedExe, { force: true });

  console.log(`[package] Compiling Windows Setup installer via ${isccPath}...`);
  const res = spawnSync(
    isccPath,
    [
      `/DMyAppVersion=${version}`,
      `/DSourceDir=${stagingRoot}`,
      `/DOutputDir=${artifactsDir}`,
      `/DOutputBaseName=${outBaseName}`,
      issPath,
    ],
    { stdio: 'inherit' }
  );
  if (res.status !== 0 || !fs.existsSync(expectedExe)) {
    throw new Error(`Inno Setup compilation failed (exit ${res.status})`);
  }
  return expectedExe;
}

function parseArgs(argv) {
  const opts = {
    generateChecksumsDir: '',
    version: '',
    commit: '',
    target: '',
    nodeVersion: DEFAULT_NODE_VERSION,
    outDir: path.join(ROOT_DIR, 'release-dist'),
    skipBuild: false,
    reuseNodeModules: false,
    noArchive: false,
    noInstaller: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--generate-checksums') {
      opts.generateChecksumsDir = path.resolve(ROOT_DIR, argv[++i] || '');
    } else if (arg === '--version') {
      opts.version = argv[++i] || '';
    } else if (arg === '--commit') {
      opts.commit = argv[++i] || '';
    } else if (arg === '--target') {
      opts.target = argv[++i] || '';
    } else if (arg === '--node-version') {
      opts.nodeVersion = argv[++i] || DEFAULT_NODE_VERSION;
    } else if (arg === '--out-dir') {
      opts.outDir = path.resolve(ROOT_DIR, argv[++i] || 'release-dist');
    } else if (arg === '--skip-build') {
      opts.skipBuild = true;
    } else if (arg === '--reuse-node-modules') {
      opts.reuseNodeModules = true;
    } else if (arg === '--no-archive') {
      opts.noArchive = true;
    } else if (arg === '--no-installer') {
      opts.noInstaller = true;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }
  return opts;
}

function resolveVersionOption(explicit) {
  if (explicit) return normalizeVersion(explicit);
  if (process.env.GITHUB_REF_NAME && /^v/i.test(process.env.GITHUB_REF_NAME)) {
    return normalizeVersion(process.env.GITHUB_REF_NAME);
  }
  return readPackageVersion();
}

async function stageAndPackageTarget(opts, targetSpec, version) {
  const target = targetSpec.name;
  const bundleDirName = `tiktok-live-recorder-v${version}-${target}`;
  const stagingParent = path.join(opts.outDir, 'staging');
  const stagingRoot = path.join(stagingParent, bundleDirName);
  const stagingApp = path.join(stagingRoot, 'app');
  const artifactsDir = path.join(opts.outDir, 'artifacts');

  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingApp, { recursive: true });

  const nodeBinPath = await ensureNodeBinary(targetSpec, opts.nodeVersion);
  if (targetSpec.isWindows) {
    const runtimeDir = path.join(stagingRoot, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(nodeBinPath, path.join(runtimeDir, 'node.exe'));
  } else {
    const runtimeBinDir = path.join(stagingRoot, 'runtime', 'bin');
    fs.mkdirSync(runtimeBinDir, { recursive: true });
    const destNode = path.join(runtimeBinDir, 'node');
    fs.copyFileSync(nodeBinPath, destNode);
    if (process.platform !== 'win32') fs.chmodSync(destNode, 0o755);
  }

  const filesToCopy = [
    'server.js',
    'launcher.js',
    'check.js',
    'get-stream.js',
    'record.js',
    'package.json',
    'package-lock.json',
    '.env.example',
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
  ];
  for (const rel of filesToCopy) {
    const src = path.join(ROOT_DIR, rel);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(stagingApp, rel));
    }
  }

  const dirsToCopy = ['lib', 'routes', path.join('client', 'dist')];
  for (const rel of dirsToCopy) {
    const src = path.join(ROOT_DIR, rel);
    const dst = path.join(stagingApp, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }

  fs.mkdirSync(path.join(stagingApp, 'recordings', 'highlights'), { recursive: true });

  if (opts.reuseNodeModules) {
    const repoModules = path.join(ROOT_DIR, 'node_modules');
    if (!fs.existsSync(repoModules)) {
      throw new Error(`--reuse-node-modules passed but missing: ${repoModules}`);
    }
    console.log(`[package] (${target}) Copying node_modules (--reuse-node-modules)...`);
    fs.cpSync(repoModules, path.join(stagingApp, 'node_modules'), { recursive: true, dereference: true });
  } else {
    console.log(`[package] (${target}) Installing production dependencies via npm ci --omit=dev...`);
    runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], stagingApp);
  }

  stageAndVerifyMediaBinaries(stagingApp, targetSpec);
  assertNoSecretsInDir(stagingRoot);

  if (targetSpec.isWindows) {
    writeTextFile(
      path.join(stagingRoot, 'TikTok LIVE Recorder.bat'),
      [
        '@echo off',
        'setlocal',
        'title TikTok LIVE Recorder',
        'cd /d "%~dp0app"',
        '"%~dp0runtime\\node.exe" "%~dp0app\\launcher.js" %*',
        'if errorlevel 1 (',
        '  echo.',
        '  echo TikTok LIVE Recorder exited with an error.',
        '  pause',
        ')',
        '',
      ].join('\n'),
      { crlf: true }
    );
    writeTextFile(
      path.join(stagingRoot, 'Open Recordings Folder.bat'),
      [
        '@echo off',
        'if not exist "%~dp0app\\recordings" mkdir "%~dp0app\\recordings"',
        'start "" "%~dp0app\\recordings"',
        '',
      ].join('\n'),
      { crlf: true }
    );
  } else {
    const unixLauncher = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'cd "$DIR/app"',
      'exec "$DIR/runtime/bin/node" "$DIR/app/launcher.js" "$@"',
      '',
    ].join('\n');
    writeTextFile(path.join(stagingRoot, 'start.sh'), unixLauncher, { mode: 0o755 });
    if (targetSpec.platform === 'darwin') {
      writeTextFile(path.join(stagingRoot, 'Start TikTok LIVE Recorder.command'), unixLauncher, { mode: 0o755 });
    }
  }

  writeTextFile(path.join(stagingRoot, 'VERSION.txt'), `v${version} (${target})\n`);
  writeTextFile(
    path.join(stagingRoot, 'README-RELEASE.txt'),
    [
      `TikTok LIVE Recorder v${version} (${target})`,
      '==========================================',
      '',
      'Quick Start (English):',
      targetSpec.isWindows
        ? '1. Double-click "TikTok LIVE Recorder.bat" to start the app and open http://localhost:3000.'
        : '1. Run "./start.sh" (or double-click "Start TikTok LIVE Recorder.command" on macOS) to open http://localhost:3000.',
      '2. Recordings are saved inside "app/recordings/".',
      '3. Optional configuration: copy "app/.env.example" to "app/.env".',
      '   For LAN access, set HOST=0.0.0.0 and set a strong APP_TOKEN in "app/.env".',
      '4. Upgrading portable builds: keep "app/.env", "app/accounts.json", "app/.accounts.key",',
      '   "app/watchlist.json", "app/settings.json", and "app/recordings/" when replacing files.',
      '',
      'วิธีใช้งานเบื้องต้น (ภาษาไทย):',
      targetSpec.isWindows
        ? '1. ดับเบิลคลิก "TikTok LIVE Recorder.bat" เพื่อเปิดเซิร์ฟเวอร์และเปิดเบราว์เซอร์ที่ http://localhost:3000'
        : '1. รัน "./start.sh" (หรือดับเบิลคลิก "Start TikTok LIVE Recorder.command" บน macOS) เพื่อเปิด http://localhost:3000',
      '2. ไฟล์ที่อัดไว้จะถูกบันทึกในโฟลเดอร์ "app/recordings/"',
      '3. ตั้งค่าเพิ่มเติม (ถ้าต้องการ): คัดลอก "app/.env.example" เป็น "app/.env"',
      '   หากเปิดใช้ผ่านวง LAN ให้ตั้ง HOST=0.0.0.0 และกำหนด APP_TOKEN ให้เรียบร้อย',
      '4. อัปเกรดแบบ Portable: อย่าลืมเก็บไฟล์ .env, accounts.json, .accounts.key, watchlist.json, settings.json และโฟลเดอร์ recordings เดิมไว้',
      '',
    ].join('\n'),
    { crlf: targetSpec.isWindows }
  );

  let archivePath = null;
  let installerPath = null;
  if (!opts.noArchive) {
    archivePath = await createArchive({
      stagingParent,
      bundleDirName,
      outDir: opts.outDir,
      version,
      targetSpec,
    });
    if (targetSpec.isWindows && !opts.noInstaller) {
      installerPath = buildWindowsInstaller({ stagingRoot, artifactsDir, version });
    }
  }

  return {
    target,
    stagingRoot,
    archivePath,
    installerPath,
  };
}

async function runPackaging(opts) {
  const version = resolveVersionOption(opts.version);
  const clientIndex = path.join(ROOT_DIR, 'client', 'dist', 'index.html');
  if (!fs.existsSync(clientIndex)) {
    if (opts.skipBuild) {
      throw new Error(`client/dist/index.html missing and --skip-build specified: ${clientIndex}`);
    }
    console.log('[package] Building frontend client...');
    runNpm(['run', 'build'], ROOT_DIR);
    if (!fs.existsSync(clientIndex)) {
      throw new Error(`client/dist/index.html still missing after build: ${clientIndex}`);
    }
  }

  const requestedTarget = opts.target || getTargetName();
  const targetList = requestedTarget === 'all' ? Object.values(TARGETS) : [TARGETS[requestedTarget]];
  if (targetList.some((t) => !t)) {
    throw new Error(`Unsupported target "${requestedTarget}". Valid targets: all, ${Object.keys(TARGETS).join(', ')}`);
  }

  const results = [];
  for (const spec of targetList) {
    results.push(await stageAndPackageTarget(opts, spec, version));
  }

  const artifactsDir = path.join(opts.outDir, 'artifacts');
  if (!opts.noArchive && fs.existsSync(artifactsDir)) {
    const checksumInfo = generateChecksumsAndSource(artifactsDir, {
      version,
      commitSha: opts.commit,
    });
    const changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md');
    const changelogMd = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    const changelogBody = extractChangelogSection(changelogMd, version);
    const assetInfos = checksumInfo.files.map((name) => ({
      name,
      size: fs.statSync(path.join(artifactsDir, name)).size,
    }));
    const notesMd = buildReleaseNotes({
      version,
      changelogBody,
      assets: assetInfos,
      repo: DEFAULT_REPO,
    });
    const notesPath = path.join(opts.outDir, 'release-notes.md');
    fs.writeFileSync(notesPath, notesMd, 'utf8');
    console.log(`[package] Generated ${checksumInfo.files.length} asset checksums and ${notesPath}`);
  }

  console.log(JSON.stringify({ version, targets: results }, null, 2));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.generateChecksumsDir) {
    const version = resolveVersionOption(opts.version);
    const res = generateChecksumsAndSource(opts.generateChecksumsDir, {
      version,
      commitSha: opts.commit,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  await runPackaging(opts);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[package] ERROR: ${err?.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  TARGETS,
  FORBIDDEN_RELEASE_FILES,
  normalizeVersion,
  getTargetName,
  isUnixExecutablePath,
  assertNoSecretsInDir,
  pruneFfprobeStatic,
  sha256File,
  generateChecksumsAndSource,
  createUnixTarGz,
};
