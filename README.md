# TikTok LIVE Tools

A Node.js + React toolkit for monitoring TikTok LIVE streams, capturing chat events, and recording broadcasts as MP4 files. Designed for personal, local usage. **Unofficial and unaffiliated with TikTok.**

Powered by the excellent [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector) (unofficial, free, no API key required) and `ffmpeg` for recording and transcoding.

---

## 🌟 Features

### Web UI (runs at `http://localhost:3000`)
- 🔍 **Check & Preview:** Search for any user and watch their live stream at any available quality (including HEVC/1080p).
- 💬 **Real-time Chat:** Capture chat messages, gifts, likes, and viewers via WebSockets with auto-reconnect.
- 🔴 **Record Streams:** Save streams directly to `.mp4` using `ffmpeg` (stream-copy, no re-encoding required = extremely lightweight). Includes a sidecar `.events.jsonl` file for chat replay.
- 👁 **Watchlist & Auto-Record:** Monitor your favorite creators. The system polls every N seconds and can automatically start recording when they go live.
- 📺 **Live Grid:** Watch multiple streams simultaneously in a multi-cam grid view.
- ▶ **Replay Mode:** Play back recorded streams synchronized with the exact chat events from that specific timestamp.
- ⭐ **Auto-Highlight:** Automatically detects spikes in chat activity or large gifts. One-click clip extraction (stream-copy, incredibly fast).
- 👤 **Multi-Account Support:** Store multiple session cookies and switch between them. Includes a **Stealth Mode** for anonymous viewing.
- 🎮 **Hardware-Accelerated Transcoding:** Auto-detects NVENC / Quick Sync / AMF / libx264 (used only if HEVC → H.264 transcoding is necessary for browser playback).

### CLI Tools (Alternative usage)
- `check.js` — Check if a user is live.
- `get-stream.js` — Extract raw HLS/FLV pull URLs.
- `record.js` — Record a live stream directly via CLI.

---

## 🚀 Installation

### Prerequisites
- **Node.js** ≥ 18 (20+ recommended)
- **ffmpeg** must be installed and available in your system PATH.
  - Windows: `winget install Gyan.FFmpeg` or download from [ffmpeg.org](https://ffmpeg.org/download.html).

### Install Dependencies

Run the all-in-one install script for both server and client:

```bash
npm run install:all
```

*(Alternatively, run `npm install` in the root folder, and `npm install` inside the `client/` folder).*

---

## 💻 Usage

### Standard Mode (Build + Start)

The easiest way to run the app. This builds the React client and starts the Express server.

```bash
npm run build:start
```
Once running, open your browser to **`http://localhost:3000`**.

For subsequent runs (if you haven't changed the frontend code), just run:
```bash
npm start
```

### Developer Mode (Hot Reload)

If you want to modify the code, run the backend and frontend separately:

```bash
# Terminal 1: Start the backend server
npm start

# Terminal 2: Start the Vite dev server
npm run client:dev
```
Then navigate to **`http://localhost:5173`**.

*(On Windows, you can simply run `.\dev.bat`)*

---

## 🛠 Configuration (`.env`)

All configurations are optional. The system works perfectly fine for public rooms anonymously right out of the box.

Copy `.env.example` to `.env` to configure:

```ini
# --- Optional: TikTok session cookies ---
# Required for region-locked or age-restricted streams.
# Find them in your browser: F12 → Application → Cookies → tiktok.com
TIKTOK_SESSIONID=your_sessionid_here
TIKTOK_TT_TARGET_IDC=your_idc_here

# --- Optional: Euler Stream API Key ---
# Prevents rate-limiting when connecting to the chat WebSocket.
# Free signup at: https://www.eulerstream.com
EULER_API_KEY=your_key_here

# Server Port (Default: 3000)
# PORT=3000

# Bind Host (Default: 127.0.0.1)
# Set to 0.0.0.0 if you want to access the UI from other devices on your LAN.
# HOST=127.0.0.1
```

> [!IMPORTANT]
> **Session Cookies:** If you use session cookies, you **MUST** provide both `TIKTOK_SESSIONID` and `TIKTOK_TT_TARGET_IDC`. If one is missing, the system will ignore them to prevent authentication errors.

> [!TIP]
> You can also manage sessions directly via the Web UI using the **Multi-Account** feature without touching the `.env` file!

---

## ⚠️ Important Security & Usage Warnings

> [!WARNING]
> **Do NOT commit your personal data!** 
> The `.gitignore` is pre-configured to ignore `.env`, `accounts.json`, `watchlist.json`, and the `recordings/` folder. Ensure these stay local.

- **LAN Access:** By default, the server binds to `127.0.0.1` (localhost only). If you change `HOST=0.0.0.0` to allow LAN access, ensure your network is trusted.
- **API Stability:** This tool uses an **unofficial** API. TikTok frequently changes their internal endpoints. If the tool suddenly breaks, wait for an update to the `tiktok-live-connector` package.
- **Chat Rate Limits:** Connecting to many chat rooms simultaneously may result in TikTok temporarily blocking your IP from the WebSocket servers. Use an `EULER_API_KEY` to mitigate this.

---

## 💡 Pro Tips

- **Stealth Mode:** Toggle Stealth Mode from the Account Switcher in the UI. This strips your session cookies from requests, ensuring your view remains completely anonymous.
- **HEVC Support:** TikTok often provides higher quality streams in HEVC (H.265). If your browser doesn't support HEVC, the app will automatically transcode it to H.264 on-the-fly (using GPU acceleration if available).
- **Auto-Record:** Add creators to your Watchlist and check "Auto-record". The app will monitor their status and immediately start saving the stream when they go live.
- **Clipping Highlights:** After a recording finishes, go to the **Replay** tab. The system analyzes the chat logs and suggests moments where chat/gift activity spiked. Click **"✂ Cut Clip"** to instantly extract that segment.

---

## 📝 Disclaimer & License

**MIT License**

This is a personal, educational project. It is not affiliated with, endorsed by, or connected to TikTok or ByteDance.

> [!CAUTION]
> Please respect the TikTok Terms of Service and the content creators. Do not use this tool for commercial purposes, mass scraping, or re-uploading copyrighted content without permission.
