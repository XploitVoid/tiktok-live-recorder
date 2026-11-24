# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-11-24

### Added
- **Self-Contained Release Packaging**: Bundled portable Node.js runtime, pre-built Web UI (`client/dist`), and bundled `ffmpeg-static` / `ffprobe-static` into standalone cross-platform releases (zero Node.js or FFmpeg prerequisites).
- **Windows Setup Installer**: Added Inno Setup (`installer.iss`) producing `*-windows-x64-setup.exe` with Start Menu & optional Desktop shortcuts, per-user install (preserving `recordings/`, `.env`, `accounts.json`, `watchlist.json`, and `settings.json` on upgrade), and uninstaller.
- **Cross-Platform Archives & Verification**: Added local cross-platform release packager (`scripts/package-release.js --target all`) building Windows Portable (`.zip`), Linux x64 (`.tar.gz`), macOS arm64/x64 (`.tar.gz`), `SHA256SUMS.txt`, and `SOURCE.txt`.
- **Smart Launcher (`launcher.js`)**: Checks if the local server is already running and automatically opens `http://localhost:3000` (or configured `HOST`/`PORT`) in the user's default browser.

### Security
- Enforced case-insensitive `APP_TOKEN` authentication checks for `/api/*` and `/files/*` routes.
- Hardened path-traversal validation, `.mp4`/sidecar path checks, and release staging secret exclusion checks (`assertNoSecretsInDir`).

### Fixed
- Fixed compressed recording sidecar naming when re-compressing `_balanced` outputs so `.events.jsonl` metadata maps cleanly.
- Fixed transcode per-IP active stream counter leak on early error throw in `/api/transcode`.
- Normalized trailing slashes on `/api/events/stream` compression bypass check in `server.js`.
- Fixed React `ChatPanel` unmount/channel-switch race condition while `startChat` is still in flight.
- Resolved backend recorder, chat WebSocket, highlights, storage, watcher, proxy, and Thai/English i18n parity issues across the codebase.

## [1.4.2]

### Fixed
- Pass `roomId` to chat WebSocket connections and add automatic anonymous/preset/proxy fallback on `DEVICE_BLOCKED`.

## [1.4.1]

### Fixed
- Fixed compressed replay parsing, SSE multiplexing, reconnect loops, webhook notifications, and CPU/RAM usage optimizations.

## [1.4.0]

### Added
- Pin/protect recordings from auto-cleanup, `pk-split` 9:16 highlight export, `+faststart` remuxing, per-channel watchlist rules, proxy failover list, visual timeline trimmer, and sprite previews.

## [1.3.0]

### Fixed
- Fixed PK 360p stream corruption with in-band SPS/PPS injection, stalled-stream watchdog, audio-only/bitrate modes, background audio (`MediaSession`), and Discord/Telegram webhooks.

## [1.2.0]

### Security
- Added security hardening (`APP_TOKEN` HMAC session cookies, DNS rebinding protection, CSRF checks), SSE/storage/settings improvements, and comprehensive bug fixes.
