# TikTok LIVE Tools

A local Node.js and React stack I put together to monitor TikTok LIVE streams, grab chat events, and record broadcasts straight to MP4. It runs locally and is completely unofficial.

Under the hood, it uses the [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector) library to pull data without needing an API key, and `ffmpeg` to handle the heavy lifting for video.

---

## What it does

### The Web UI (`http://localhost:3000`)
- **Watch & Preview:** Look up any user and watch their stream. It supports whatever quality TikTok throws at it (including HEVC/1080p).
- **Chat Capture:** Pulls chat messages, gifts, likes, and viewer counts via WebSockets. It auto-reconnects if the connection drops.
- **Recording:** Dumps the stream straight to `.mp4` using `ffmpeg`. Since it's just a stream-copy without re-encoding, it barely uses any CPU. It also saves a `.events.jsonl` file alongside the video so you have the chat logs.
- **Watchlist:** Add creators you care about. The backend polls every few seconds and can trigger an auto-record the second they go live.
- **Live Grid:** Basically a multi-cam view for watching multiple streams at once.
- **Replay:** A custom player that loads your recorded `.mp4` and syncs the `.events.jsonl` chat log to the video's current timestamp.
- **Auto-Highlight:** It scans the chat logs for spikes in activity or huge gifts and lets you extract those specific clips with one click.
- **Multi-Account:** You can load in different session cookies and swap between them in the UI. There's also a "Stealth Mode" if you want to lurk anonymously.
- **Transcoding:** If you're on a browser that hates HEVC (looking at you, Chrome), the backend will auto-detect your GPU (NVENC/QuickSync/AMF) and transcode it to H.264 on the fly.

### CLI Tools
If you don't want to use the UI, you can just run the scripts directly:
- `node check.js <username>` — Returns their current live status.
- `node get-stream.js <username>` — Spits out the raw HLS/FLV urls.
- `node record.js <username>` — Starts recording the stream to disk.

---

## Getting Started

### Prerequisites
- **Node.js** v18+ (I usually run it on 20)
- **ffmpeg** needs to be installed and in your system PATH.
  - On Windows: `winget install Gyan.FFmpeg`

### Setup

Install the packages for both the backend and frontend. I made a shortcut script for it:

```bash
npm run install:all
```

To run it normally, just build the frontend once and start the Express server:

```bash
npm run build:start
```
Then open **`http://localhost:3000`**.

If you're hacking on the code, you'll probably want hot-reloading. Just run `npm start` in one terminal and `npm run client:dev` in another (or run `.\dev.bat` on Windows).

---

## Config (`.env`)

You honestly don't need to configure anything if you're just watching public game/IRL streams anonymously. 

But if you need to bypass region locks or age restrictions, you'll need to pass your session cookies. Copy `.env.example` to `.env` and fill it out:

```ini
# Find these in your browser devtools (F12) -> Application -> Cookies -> tiktok.com
TIKTOK_SESSIONID=...
TIKTOK_TT_TARGET_IDC=...

# If you're connecting to massive chat rooms, TikTok might rate limit your IP.
# You can bypass this with a free signing key from eulerstream.com
EULER_API_KEY=...
```

> [!IMPORTANT]
# **Don't leak your cookies.**
> The `.gitignore` is already set up to ignore your `.env`, `accounts.json`, `watchlist.json`, and the `recordings/` directory. Keep it that way.

---

## A few tips

- **Stealth Mode:** You can toggle this in the Account Switcher. It strips your session cookies from the requests so you can watch without showing up in the viewer list.
- **Auto-recording:** Just add a user to the Watchlist in the UI and tick the "Auto-record" box. The server will handle the rest in the background.
- **LAN Access:** By default, the server binds to localhost. If you want to watch from your phone on the same Wi-Fi, set `HOST=0.0.0.0` in your `.env`.

---

## License

MIT. 

> [!CAUTION]
> This is just a personal project built for educational purposes. It's not affiliated with TikTok or ByteDance. Please respect their Terms of Service and don't use this to mass-scrape or re-upload people's content without asking them first.
