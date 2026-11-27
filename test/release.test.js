const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveUrls } = require('../launcher');
const {
  normalizeVersion,
  normalizeNodeVersion,
  parseArgs,
  getTargetName,
  isUnixExecutablePath,
  assertNoSecretsInDir,
  pruneFfprobeStatic,
  generateChecksumsAndSource,
  createUnixTarGz,
} = require('../scripts/package-release');
const {
  extractChangelogSection,
  buildReleaseNotes,
} = require('../scripts/extract-release-notes');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-release-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('launcher.resolveUrls handles default, wildcard, LAN host, and invalid port', () => {
  const def = resolveUrls({});
  assert.equal(def.port, 3000);
  assert.equal(def.probeHost, '127.0.0.1');
  assert.equal(def.healthUrl, 'http://127.0.0.1:3000/api/health');
  assert.equal(def.openUrl, 'http://localhost:3000');

  const wildcard = resolveUrls({ PORT: '4567', HOST: '0.0.0.0' });
  assert.equal(wildcard.port, 4567);
  assert.equal(wildcard.probeHost, '127.0.0.1');
  assert.equal(wildcard.healthUrl, 'http://127.0.0.1:4567/api/health');
  assert.equal(wildcard.openUrl, 'http://localhost:4567');

  const lan = resolveUrls({ PORT: '8080', HOST: '192.168.1.50' });
  assert.equal(lan.probeHost, '192.168.1.50');
  assert.equal(lan.healthUrl, 'http://192.168.1.50:8080/api/health');
  assert.equal(lan.openUrl, 'http://192.168.1.50:8080');

  const invalid = resolveUrls({ PORT: 'not-a-port' });
  assert.equal(invalid.port, 3000);

  const outOfRange = resolveUrls({ PORT: '70000' });
  assert.equal(outOfRange.port, 3000);
});

test('package-release.normalizeVersion and getTargetName normalize inputs', () => {
  assert.equal(normalizeVersion('v1.5.0'), '1.5.0');
  assert.equal(normalizeVersion('1.4.3-rc.1'), '1.4.3-rc.1');
  assert.throws(() => normalizeVersion(''), /Invalid version/);
  assert.throws(() => normalizeVersion('1.0.0;rm -rf'), /Invalid version/);

  assert.equal(getTargetName('win32', 'x64'), 'windows-x64');
  assert.equal(getTargetName('linux', 'x64'), 'linux-x64');
  assert.equal(getTargetName('darwin', 'arm64'), 'macos-arm64');
  assert.equal(getTargetName('darwin', 'x64'), 'macos-x64');
});

test('package-release.assertNoSecretsInDir passes clean dir and rejects forbidden files', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'app', 'node_modules', 'dummy'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', '.env.example'), 'PORT=3000\n');
    fs.writeFileSync(path.join(dir, 'app', 'server.js'), '// ok\n');
    // node_modules should be skipped cleanly
    fs.writeFileSync(path.join(dir, 'app', 'node_modules', 'dummy', 'test.key'), 'ignored');
    assert.doesNotThrow(() => assertNoSecretsInDir(dir));

    for (const badName of ['.env', '.env.production', 'accounts.json', '.accounts.key', 'watchlist.json', 'settings.json', 'custom.key']) {
      const badPath = path.join(dir, 'app', badName);
      fs.writeFileSync(badPath, 'secret');
      assert.throws(() => assertNoSecretsInDir(dir), /Forbidden secret/);
      fs.unlinkSync(badPath);
    }
  });
});

test('package-release.pruneFfprobeStatic removes non-target platforms and architectures', () => {
  withTempDir((dir) => {
    const nm = path.join(dir, 'node_modules');
    const targets = [
      ['win32', 'x64', 'ffprobe.exe'],
      ['win32', 'ia32', 'ffprobe.exe'],
      ['linux', 'x64', 'ffprobe'],
      ['darwin', 'arm64', 'ffprobe'],
    ];
    for (const [plat, arch, bin] of targets) {
      const p = path.join(nm, 'ffprobe-static', 'bin', plat, arch);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, bin), Buffer.alloc(1024, 1));
    }

    const res = pruneFfprobeStatic(nm, 'win32', 'x64');
    assert.equal(res.savedBytes, 3072);
    assert.equal(fs.existsSync(path.join(nm, 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')), true);
    assert.equal(fs.existsSync(path.join(nm, 'ffprobe-static', 'bin', 'win32', 'ia32')), false);
    assert.equal(fs.existsSync(path.join(nm, 'ffprobe-static', 'bin', 'linux')), false);
    assert.equal(fs.existsSync(path.join(nm, 'ffprobe-static', 'bin', 'darwin')), false);
  });
});

test('package-release.generateChecksumsAndSource writes sorted SHA256SUMS.txt and SOURCE.txt', () => {
  withTempDir((dir) => {
    const bPath = path.join(dir, 'b-app.zip');
    const aPath = path.join(dir, 'a-app-setup.exe');
    fs.writeFileSync(bPath, 'zip-content');
    fs.writeFileSync(aPath, 'exe-content');
    fs.writeFileSync(path.join(dir, 'ignore.txt'), 'not-an-asset');

    const res = generateChecksumsAndSource(dir, { version: 'v1.5.0', commitSha: 'abc1234' });
    assert.deepEqual(res.files, ['a-app-setup.exe', 'b-app.zip']);

    const sums = fs.readFileSync(res.checksumsPath, 'utf8').trim().split('\n');
    assert.equal(sums.length, 2);

    const hashA = crypto.createHash('sha256').update('exe-content').digest('hex');
    const hashB = crypto.createHash('sha256').update('zip-content').digest('hex');
    assert.equal(sums[0], `${hashA}  a-app-setup.exe`);
    assert.equal(sums[1], `${hashB}  b-app.zip`);

    const sourceText = fs.readFileSync(res.sourcePath, 'utf8');
    assert.match(sourceText, /^Repository: https:\/\/github\.com\/XploitVoid\/live-stream-recorder$/m);
    assert.match(sourceText, /^Version: v1\.5\.0$/m);
    assert.match(sourceText, /^Commit: abc1234$/m);
    assert.match(sourceText, /^Built-At: \d{4}-\d{2}-\d{2}T/m);
  });
});

test('extract-release-notes parses exact version, falls back to Unreleased, and builds Markdown', () => {
  const sampleChangelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '- New release pipeline',
    '',
    '## [1.4.2]',
    '',
    '### Fixed',
    '- DEVICE_BLOCKED fallback',
  ].join('\n');

  const exact = extractChangelogSection(sampleChangelog, 'v1.4.2');
  assert.match(exact, /DEVICE_BLOCKED fallback/);
  assert.doesNotMatch(exact, /New release pipeline/);

  const fallback = extractChangelogSection(sampleChangelog, '9.9.9');
  assert.match(fallback, /New release pipeline/);

  const empty = extractChangelogSection('', '1.0.0');
  assert.match(empty, /See the commit log/);

  const notes = buildReleaseNotes({
    version: '1.5.0',
    changelogBody: fallback,
    assets: [
      { name: 'tiktok-live-recorder-v1.5.0-windows-x64-setup.exe', size: 70 * 1024 * 1024 },
      { name: 'tiktok-live-recorder-v1.5.0-linux-x64.tar.gz', size: 60 * 1024 * 1024 },
      { name: 'SHA256SUMS.txt', size: 200 },
    ],
  });

  assert.match(notes, /### Added/);
  assert.match(notes, /New release pipeline/);
  assert.doesNotMatch(notes, /# TikTok LIVE Recorder/);
  assert.doesNotMatch(notes, /## Downloads/);
  assert.doesNotMatch(notes, /## Quick Start/);
  assert.doesNotMatch(notes, /## Verify Checksums/);
});

test('package-release.createUnixTarGz preserves 0755 executable bits and writes PAX headers for long paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-tar-test-'));
  try {
    const bundle = 'bundle-v1.5.0';
    const base = path.join(dir, bundle);
    fs.mkdirSync(path.join(base, 'runtime', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(base, 'app', 'node_modules', 'ffmpeg-static'), { recursive: true });
    fs.mkdirSync(path.join(base, 'app', 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64'), { recursive: true });
    const longSubDir = path.join(base, 'app', 'a'.repeat(50), 'b'.repeat(50));
    fs.mkdirSync(longSubDir, { recursive: true });

    fs.writeFileSync(path.join(base, 'start.sh'), '#!/usr/bin/env bash\necho ok\n');
    fs.writeFileSync(path.join(base, 'Start TikTok LIVE Recorder.command'), '#!/usr/bin/env bash\necho ok\n');
    fs.writeFileSync(path.join(base, 'runtime', 'bin', 'node'), 'fake-node');
    fs.writeFileSync(path.join(base, 'app', 'node_modules', 'ffmpeg-static', 'ffmpeg'), 'fake-ff');
    fs.writeFileSync(path.join(base, 'app', 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe'), 'fake-fp');
    fs.writeFileSync(path.join(base, 'app', 'server.js'), '// server');
    fs.writeFileSync(path.join(longSubDir, 'long-file-name.txt'), 'long-path-content');

    const outTar = path.join(dir, 'out.tar.gz');
    await createUnixTarGz(dir, bundle, outTar, isUnixExecutablePath);
    assert.equal(fs.existsSync(outTar), true);

    const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const listRes = spawnSync(tarCmd, ['-tvzf', outTar], { encoding: 'utf8' });
    assert.equal(listRes.status, 0, listRes.stderr);

    const lines = listRes.stdout.split(/\r?\n/);
    const findLine = (needle) => lines.find((l) => l.includes(needle));

    for (const execRel of [
      'start.sh',
      'Start TikTok LIVE Recorder.command',
      'runtime/bin/node',
      'app/node_modules/ffmpeg-static/ffmpeg',
      'app/node_modules/ffprobe-static/bin/linux/x64/ffprobe',
    ]) {
      const line = findLine(execRel);
      assert.ok(line, `Missing entry in tar: ${execRel}`);
      assert.match(line, /^-rwxr-xr-x/, `Expected 0755 for ${execRel}, got: ${line}`);
    }

    const serverLine = findLine('app/server.js');
    assert.ok(serverLine);
    assert.match(serverLine, /^-rw-r--r--/, `Expected 0644 for server.js, got: ${serverLine}`);

    const longLine = findLine('long-file-name.txt');
    assert.ok(longLine, 'Long PAX path entry missing from tar listing');
    assert.match(longLine, /a{50}\/b{50}\/long-file-name\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('package-release Phase 5 regressions: node version validation, strict parseArgs, secret extensions, and escaping symlinks', async () => {
  assert.equal(normalizeNodeVersion('local'), 'local');
  assert.equal(normalizeNodeVersion('v22.23.5'), 'v22.23.5');
  assert.equal(normalizeNodeVersion('22.23.5'), 'v22.23.5');
  assert.throws(() => normalizeNodeVersion('../evil'), /Invalid --node-version/i);
  assert.throws(() => normalizeNodeVersion('v22/foo'), /Invalid --node-version/i);

  assert.throws(() => parseArgs(['--version']), /Missing value for --version/i);
  assert.throws(() => parseArgs(['--node-version']), /Missing value for --node-version/i);
  assert.throws(() => parseArgs(['--node-version', '../bad']), /Invalid --node-version/i);
  assert.equal(parseArgs(['--node-version', '22.23.5']).nodeVersion, 'v22.23.5');

  for (const secretName of ['temp.tmp', 'cert.pem', 'bundle.p12', 'win.pfx']) {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, secretName), 'secret');
      assert.throws(() => assertNoSecretsInDir(dir), /Forbidden secret/);
    });
  }

  // Symlink containment check in createUnixTarGz (skip on Windows EPERM)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-tar-sym-'));
  try {
    const bundle = 'bundle-v1.6.0';
    const base = path.join(dir, bundle);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside-secret.txt'), 'secret');
    let symCreated = false;
    try {
      fs.symlinkSync('../outside-secret.txt', path.join(base, 'escape-link.txt'));
      symCreated = true;
    } catch (e) {
      if (e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e;
    }
    if (symCreated) {
      await assert.rejects(
        () => createUnixTarGz(dir, bundle, path.join(dir, 'out.tar.gz'), isUnixExecutablePath),
        /escaping symlink/i
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
