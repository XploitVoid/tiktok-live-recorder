# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-11-24

### Added
- **Live Instant Clip:** Cut the last 30s or 60s of any active recording on-the-fly (`POST /api/record/live-clip`) without interrupting the main stream capture.
- **Auto-Merge Split Parts & Manual Merge:** Automatically or manually concatenate split recording parts (`_p1`, `_p2`, ...) and merge their `.events.jsonl` chat logs chronologically (`POST /api/recordings/merge`), preserving `protected` pins.
- **Account Cookie Health Check:** Validate saved `sessionid` cookies manually or every 6 hours (`POST /api/accounts/:id/check`, `POST /api/accounts/check-all`) with UI status badges and Discord/Telegram expiry alerts.
- **Creator Subfolders & Filename Templates:** Optionally organize recordings into `@username/` folders (`organizeByCreator`) and customize filenames with `{username}`, `{date}`, `{time}`, `{date_iso}`, `{time_hms}`, and `{title}` tokens.
- **Multi-Format Capture & Per-Channel Chat Toggle:** Capture streams as MPEG-TS (`.ts`) with automatic `+faststart` MP4 remux on exit (`recordFormat`), and toggle chat capture per channel (`recordChat`) in Watchlist.
- **Local SQLite FTS5 Search Index (`recorder.db`):** Built-in `node:sqlite` FTS5 (`trigram`) full-text index with cross-recording chat search UI and reindex controls (`/api/search/status`, `/api/search/reindex`), alongside `.events.jsonl` sidecars.

### Fixed
- Buffered FFmpeg `stderr` chunks by CR/LF lines and suppressed clean exit (`EXITED 0`) progress fragments from appearing as error output.
- Hardened recording path resolution for 1-level creator subfolders and blocked path traversal / reserved directory escapes.

## [1.5.0] - 2026-11-24

### Added
- Standalone cross-platform releases for Windows, Linux, and macOS (Node.js & FFmpeg bundled — no setup required).
- Windows installer (`setup.exe`) with Start Menu / Desktop shortcuts and safe in-place upgrades.
- Smart launcher that auto-opens `http://localhost:3000` or focuses an already running instance.
- `SHA256SUMS.txt` and `SOURCE.txt` included with every release.

### Fixed
- Enforced case-insensitive `APP_TOKEN` authentication and hardened path-traversal protection.
- Fixed compressed recording replay sidecars, transcode IP counter leaks, SSE compression handling, and chat unmount race conditions.
- Fixed stability and Thai/English UI parity issues across recorder, chat, highlights, watcher, and proxy failover.

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
