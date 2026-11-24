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

function buildReleaseNotes({ changelogBody }) {
  const bodyText = String(changelogBody || '').trim() || 'See the commit log for changes included in this release.';
  return `${bodyText}\n`;
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
