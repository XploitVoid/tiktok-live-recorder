# TikTok LIVE Tools

เครื่องมือ Node.js + React สำหรับเช็คสถานะไลฟ์ TikTok ดูสตรีม จับแชท และบันทึกไลฟ์เป็นไฟล์ MP4 — ใช้งานบนเครื่องตัวเอง ไม่เป็นทางการ

ใช้ไลบรารี [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector) (unofficial, ฟรี, ไม่ต้องใช้ API key) บวกกับ `ffmpeg` สำหรับบันทึก/ทรานสโค้ด

---

## ฟีเจอร์

### Web UI ที่ `http://localhost:3000`
- 🔍 **เช็ค + ดูพรีวิว** ไลฟ์ของผู้ใช้คนใดก็ได้ พร้อม HLS/FLV ทุกความละเอียด (รวม HEVC/1080p)
- 💬 **จับแชท + ของขวัญ + ไลก์ + ผู้เข้าร่วม** แบบเรียลไทม์ ผ่าน WebSocket — auto-reconnect
- 🔴 **บันทึกไลฟ์** เป็น `.mp4` ผ่าน `ffmpeg` (ไม่ re-encode = เบามาก) พร้อม sidecar `.events.jsonl` ของแชท
- 👁 **Watchlist** — เพิ่มผู้ใช้เข้าหน้าจอเฝ้าดู ระบบ poll ทุก N วินาที และ **อัดอัตโนมัติ** เมื่อขึ้นไลฟ์
- 📺 **Live Grid** — ดูหลายสตรีมพร้อมกันแบบ multi-cam (เลือกจำนวนคอลัมน์ได้)
- ▶ **Replay** — เปิดไฟล์ที่อัดไว้แล้วดูแชทย้อนเวลาตาม `currentTime` ของวิดีโอ
- ⭐ **Auto-Highlight** — ระบบหาช่วงไฮไลต์อัตโนมัติจากแชท/ของขวัญที่พุ่งสูง พร้อมปุ่มตัดคลิป `.mp4` (stream-copy ไม่ re-encode = เร็วมาก)
- 👤 **Multi-account** — เก็บหลาย session cookie สลับใช้ได้ + มี **Stealth Mode** สำหรับดูแบบ anonymous
- 🎮 **Hardware-accelerated transcoding** — auto-detect NVENC / Quick Sync / AMF / libx264 (กรณีต้องทรานสโค้ด HEVC → H.264 ให้ browser เล่น)

### CLI tools (ทางเลือก)
- `check.js` — เช็คสถานะไลฟ์ของ user
- `get-stream.js` — ดึง HLS/FLV pull URLs
- `record.js` — บันทึกไลฟ์ผ่าน ffmpeg

---

## ติดตั้ง

### สิ่งที่ต้องมี
- **Node.js** ≥ 18 (แนะนำ 20+)
- **ffmpeg** อยู่บน PATH (จำเป็นเฉพาะตอนบันทึก/ทรานสโค้ด)
  - Windows: `winget install Gyan.FFmpeg` หรือดาวน์โหลดจาก https://ffmpeg.org/download.html

### ติดตั้ง dependencies (server + client)

```powershell
npm run install:all
```

หรือทำทีละตัว:

```powershell
npm install
npm --prefix client install
```

---

## ใช้งาน

### โหมดที่ใช้บ่อยสุด: build + start

```powershell
npm run build:start
```

จะ build React client หนึ่งครั้งแล้วเปิด server ที่ `http://localhost:3000`

### หลังจาก build แล้วครั้งหนึ่ง สั่ง start อย่างเดียว

```powershell
npm start
```

### โหมด Dev (hot reload)

เปิด 2 terminal:

```powershell
# Terminal 1: backend
npm start

# Terminal 2: Vite dev server (hot reload)
npm run client:dev
```

แล้วใช้ที่ `http://localhost:5173` แทน

หรือบน Windows ใช้สคริปต์สำเร็จรูป:

```powershell
.\dev.bat
```

---

## CLI tools

### เช็คว่ามี user live หรือไม่

```powershell
npm run check -- tv_asahi_news
# หรือ
node check.js tv_asahi_news
```

ผลลัพธ์เป็น JSON บน stdout — exit code: `0` = live, `1` = offline, `2` = error

### ดึง stream URL

```powershell
node get-stream.js tv_asahi_news
```

ได้ JSON มี `streams.hls`, `streams.flv` (แยกตามคุณภาพ `origin` / `uhd` / `hd` / `sd` / `ld`) เอาไปเปิดด้วย VLC / mpv / hls.js / ffmpeg ได้เลย

### บันทึกไลฟ์

```powershell
node record.js tv_asahi_news
# ระบุโฟลเดอร์ปลายทาง (default: ./recordings)
node record.js tv_asahi_news ./my-recordings
```

ไฟล์ตั้งชื่อ `<username>_YYYYMMDD_HHMMSS.mp4` กด **Ctrl+C** เพื่อหยุดอย่างปลอดภัย

---

## ตั้งค่า (ไฟล์ `.env`)

ทุกค่าเป็น optional — ระบบทำงานได้แบบ anonymous กับ public room ทันที

```ini
# Session cookie (ใช้กับ user ที่ region/login-restricted)
# วิธีหา: เปิด tiktok.com → F12 → Application → Cookies → tiktok.com
TIKTOK_SESSIONID=
TIKTOK_TT_TARGET_IDC=

# Euler Stream signing key (กัน rate-limit ตอนต่อ chat WebSocket)
# สมัครฟรี: https://www.eulerstream.com
EULER_API_KEY=

# Server config (ค่า default ตามนี้)
# PORT=3000
# HOST=127.0.0.1     # ตั้งเป็น 0.0.0.0 ถ้าต้องการเข้าถึงจาก LAN
# WATCH_POLL_SECONDS=30

# Path ของ ffmpeg (ถ้า auto-detect ไม่เจอ)
# FFMPEG_PATH=C:\path\to\ffmpeg.exe

# ปิด auto-highlight detection หลังอัดเสร็จ (default = เปิด)
# DISABLE_AUTO_HIGHLIGHTS=1
```

> **หมายเหตุเรื่อง session:** ต้องตั้งทั้ง `TIKTOK_SESSIONID` และ `TIKTOK_TT_TARGET_IDC` คู่กันเสมอ ถ้าตั้งแค่ตัวเดียวระบบจะ ignore ทั้งคู่และเตือนใน console

> นอกจาก `.env` ระบบยัง support **multi-account** ผ่าน UI — เก็บลง `accounts.json` (อยู่ใน `.gitignore`) สลับ active account ได้จากปุ่มใน Header

---

## โครงสร้างโปรเจกต์

```
.
├── server.js                # Express server + security middleware
├── check.js / get-stream.js / record.js   # CLI tools
├── lib/
│   ├── room.js              # ห่อ tiktok-live-connector + extract stream URLs
│   ├── recorder.js          # จัดการ ffmpeg jobs
│   ├── chat.js              # WebSocket chat session + auto-reconnect
│   ├── watcher.js           # Polling watchlist + auto-record
│   ├── transcode.js         # HEVC→H.264 transcoding (auto encoder detection)
│   ├── highlights.js        # Auto-detect chat/gift spikes + cut clips
│   ├── accounts.js          # Multi-account credentials store
│   ├── ffmpeg.js            # ffmpeg path resolver
│   └── utils.js             # safeError, isAllowedCdnUrl, parseStartTimeFromName
├── routes/
│   ├── check.js             # /api/check  /api/stream
│   ├── record.js            # /api/record/*  /api/recordings/*
│   ├── chat.js              # /api/chat/*
│   ├── watch.js             # /api/watch/*
│   ├── proxy.js             # /api/proxy  /api/transcode (CDN proxy)
│   ├── highlights.js        # /api/highlights/*
│   └── accounts.js          # /api/accounts/*
├── client/                  # React + Vite frontend
│   └── src/
│       ├── pages/           # HomePage / GridPage / ReplayPage
│       ├── components/      # SearchSection, StreamPlayer, ChatPanel, …
│       └── lib/             # api, i18n, types, history, format
├── recordings/              # ไฟล์ที่อัดไว้ (สร้างอัตโนมัติ)
│   └── highlights/          # คลิปไฮไลต์ที่ตัดจาก recordings (auto)
├── accounts.json            # multi-account store (gitignored)
├── watchlist.json           # watchlist persistence (gitignored)
└── .env                     # secrets (gitignored)
```

---

## ความปลอดภัย / ข้อควรระวัง

- ไฟล์ `accounts.json`, `watchlist.json`, `.env`, และโฟลเดอร์ `recordings/` อยู่ใน `.gitignore` — **ห้าม commit**
- Server bind ที่ `127.0.0.1` เป็น default ถ้าจะเปิดให้เครื่องอื่นใน LAN เข้าได้ ตั้ง `HOST=0.0.0.0` ใน `.env` (ระบบมี same-origin guard ป้องกัน CSRF อยู่แล้ว)
- `tiktok-live-connector` เป็น **unofficial** TikTok เปลี่ยน endpoint ได้ตลอด ถ้าอยู่ๆ พังให้ลอง update package
- ถ้าโดน rate-limit เวลาต่อ chat → ใส่ `EULER_API_KEY` (ฟรี)
- ตรวจสอบ ToS ของ TikTok ก่อนใช้ในเชิงพาณิชย์ และเคารพเจ้าของไลฟ์

---

## Tips

- **ภาษา UI** — สลับ TH ↔ EN ได้จากปุ่ม globe ใน Header (จำลง `localStorage`)
- **Stealth Mode** — เปิดในเมนูบัญชี เพื่อให้ทุก request ออกแบบ anonymous (ไม่เปิดเผย session) สำหรับห้องที่ไม่อยากให้รู้ว่ามีใครเข้า
- **HEVC/1080p** — TikTok บางห้องจะมี HEVC quality สูงกว่า H.264 เลือกจาก dropdown ใน player ระบบจะทรานสโค้ดเป็น H.264 ให้ browser เล่นโดยอัตโนมัติ (ใช้ GPU ถ้ามี)
- **อัดอัตโนมัติ** — เพิ่ม user เข้า Watchlist แล้วเปิดเช็คบ็อกซ์ "auto-record" — เมื่อขึ้นไลฟ์ระบบจะเริ่มอัดให้เอง
- **Replay** — ไฟล์ที่อัดมาพร้อม `.events.jsonl` จะมีปุ่ม "▶ Replay" → เปิดดูพร้อมแชทย้อนเวลา
- **Auto-Highlight** — หลังอัดเสร็จระบบสแกน `.events.jsonl` หาช่วงที่ chat/gift พุ่งสูงกว่าค่าพื้นฐาน เปิดในหน้า Replay → กด **✂ ตัดคลิป** เพื่อ export `.mp4` (stream-copy ใช้ I/O เกือบศูนย์ คลิปออกมาในไม่กี่วินาที)

---

## License / Disclaimer

โปรเจกต์ส่วนตัว — ใช้บนเครื่องตัวเองเท่านั้น โปรดเคารพ TikTok Terms of Service และเจ้าของคอนเทนต์
