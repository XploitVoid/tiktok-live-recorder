#!/usr/bin/env node
// scripts/extract-release-notes.js — Build structured GitHub Release notes from CHANGELOG.md & packaged assets.

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO = 'XploitVoid/tiktok-live-recorder';

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionByHeading(markdown, headingMatcher) {
  const lines = String(markdown || '').split(/\r?\n/);
  let capturing = false;
  const captured = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (capturing) break;
      if (headingMatcher(line)) {
        capturing = true;
      }
      continue;
    }
    if (capturing) {
      captured.push(line);
    }
  }
  return captured.join('\n').trim();
}

function extractChangelogSection(markdown, version) {
  const cleanVersion = String(version || '').trim().replace(/^v/i, '');
  if (cleanVersion) {
    const verRegex = new RegExp(`^##\\s+\\[?v?${escapeRegExp(cleanVersion)}\\]?(?:\\s|$)`, 'i');
    const exact = extractSectionByHeading(markdown, (line) => verRegex.test(line));
    if (exact) return exact;
  }

  const unreleased = extractSectionByHeading(markdown, (line) => /^##\s+\[?Unreleased\]?(?:\s|$)/i.test(line));
  if (unreleased) return unreleased;

  return 'See the commit log for changes included in this release.';
}

function classifyAsset(filename) {
  const name = String(filename || '');
  if (/windows-x64-setup\.exe$/i.test(name)) return { platform: 'Windows (x64)', format: 'Installer (`.exe`)' };
  if (/windows-x64-portable\.zip$/i.test(name)) return { platform: 'Windows (x64)', format: 'Portable (`.zip`)' };
  if (/linux-x64\.tar\.gz$/i.test(name)) return { platform: 'Linux (x64)', format: 'Bundle (`.tar.gz`)' };
  if (/macos-arm64\.tar\.gz$/i.test(name)) return { platform: 'macOS (Apple Silicon arm64)', format: 'Bundle (`.tar.gz`)' };
  if (/macos-x64\.tar\.gz$/i.test(name)) return { platform: 'macOS (Intel x64)', format: 'Bundle (`.tar.gz`)' };
  return { platform: 'Cross-Platform', format: path.extname(name) || 'File' };
}

function formatSizeMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildReleaseNotes({ version, changelogBody, assets = [], repo = DEFAULT_REPO }) {
  const cleanVersion = String(version || '').trim().replace(/^v/i, '') || '0.0.0';
  const bodyText = String(changelogBody || '').trim() || 'See the commit log for changes included in this release.';
  const sections = [
    `# TikTok LIVE Recorder v${cleanVersion}`,
    '',
    bodyText,
  ];

  const downloadable = (assets || []).filter((a) => !/^(SHA256SUMS\.txt|SOURCE\.txt)$/i.test(a.name));
  if (downloadable.length > 0) {
    sections.push(
      '',
      '## Downloads',
      '',
      '| Platform | Package | File | Size |',
      '|---|---|---|---|',
      ...downloadable.map((a) => {
        const meta = classifyAsset(a.name);
        const size = typeof a.size === 'number' ? formatSizeMb(a.size) : '-';
        return `| ${meta.platform} | ${meta.format} | \`${a.name}\` | ${size} |`;
      })
    );
  }

  sections.push(
    '',
    '## Quick Start',
    '',
    `- **Windows Installer**: Download \`*-windows-x64-setup.exe\` and run it (no Node.js or FFmpeg needed).`,
    `- **Windows Portable**: Extract \`*-windows-x64-portable.zip\` and double-click \`TikTok LIVE Recorder.bat\`.`,
    `- **Linux / macOS**: Extract the \`.tar.gz\` archive and run \`./start.sh\` (macOS users can also double-click \`Start TikTok LIVE Recorder.command\`).`,
    `- **Docker**: Clone or download source and run \`docker-compose up -d\`.`,
    '',
    '## Verify Checksums',
    '',
    'All binaries include SHA-256 checksums in `SHA256SUMS.txt`:',
    '',
    '```powershell',
    '# Windows (PowerShell)',
    'Get-FileHash .\\tiktok-live-recorder-v' + cleanVersion + '-windows-x64-setup.exe -Algorithm SHA256',
    '```',
    '',
    '```bash',
    '# Linux / macOS',
    'sha256sum -c SHA256SUMS.txt --ignore-missing',
    '```',
    ''
  );

  return sections.join('\n');
}

function collectAssets(assetsDir) {
  if (!assetsDir || !fs.existsSync(assetsDir)) return [];
  return fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(exe|zip|tar\.gz|dmg|AppImage|deb|rpm)$/i.test(d.name))
    .map((d) => ({
      name: d.name,
      size: fs.statSync(path.join(assetsDir, d.name)).size,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function parseArgs(argv) {
  const root = path.resolve(__dirname, '..');
  const opts = {
    version: '',
    changelog: path.join(root, 'CHANGELOG.md'),
    assetsDir: '',
    out: '',
    repo: DEFAULT_REPO,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') opts.version = argv[++i] || '';
    else if (arg === '--changelog') opts.changelog = path.resolve(root, argv[++i] || 'CHANGELOG.md');
    else if (arg === '--assets-dir') opts.assetsDir = path.resolve(root, argv[++i] || '');
    else if (arg === '--out') opts.out = path.resolve(root, argv[++i] || '');
    else if (arg === '--repo') opts.repo = argv[++i] || DEFAULT_REPO;
    else throw new Error(`Unknown CLI argument: ${arg}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const version = opts.version || JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  const changelogMd = fs.existsSync(opts.changelog) ? fs.readFileSync(opts.changelog, 'utf8') : '';
  const changelogBody = extractChangelogSection(changelogMd, version);
  const assets = collectAssets(opts.assetsDir);
  const output = buildReleaseNotes({ version, changelogBody, assets, repo: opts.repo });

  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, output, 'utf8');
    console.log(`[release-notes] Wrote ${opts.out}`);
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[release-notes] ERROR: ${err?.message || err}`);
    process.exit(1);
  }
}

module.exports = {
  extractChangelogSection,
  buildReleaseNotes,
  classifyAsset,
};
