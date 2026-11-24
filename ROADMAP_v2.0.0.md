# 🎥 แผนการพัฒนา Live Stream Recorder — Version 2.0.0 (Multi-Platform)

> **แนวคิดหลัก (Core Identity):**  
> ยกระดับจาก **`TikTok LIVE Recorder v1.6.0`** สู่ระบบอัดไลฟ์สดแบบ **Multi-Platform (TikTok LIVE · Twitch · YouTube Live · Kick)** ที่ยังคงทำงานในเครื่อง (**Local-First**), เบา, เร็ว, พึ่งพาตัวเองได้ (Node.js + FFmpeg + SQLite + React)  
> โดยต่อยอดโครงสร้าง Recorder Engine, Watchlist, Replay, Auto-Highlights, Live Instant Clip, SQLite FTS5 Search และ Webhooks ที่มีอยู่แล้วใน `v1.6.0` ให้ใช้งานข้ามทุกแพลตฟอร์มได้ในหน้าจอเดียว

---

## 🔍 1. สถาปัตยกรรมใหม่ใน `v2.0.0`: Provider Abstraction Layer

ใน `v1.6.0` ส่วนการจัดการไฟล์/อัดวิดีโอ/รีเพลย์/ไฮไลต์/ค้นหาแชทแยกออกจากส่วนดึงข้อมูล TikTok อยู่แล้ว ใน `v2.0.0` จะสร้างชั้น **`lib/providers/`** เพื่อให้ทุกแพลตฟอร์มใช้มาตรฐานเดียวกัน:

| ไฟล์ / โมดูล | หน้าที่หลัก |
| :--- | :--- |
| `lib/providers/index.js` | Registry แยกแพลตฟอร์ม (`tiktok`, `twitch`, `youtube`, `kick`) + ตัวช่วยตรวจจับแพลตฟอร์มและชื่อช่องจาก URL อัตโนมัติ |
| `lib/providers/tiktok.js` | ห่อหุ้ม `lib/room.js` และ `lib/chat.js` เดิมให้ใช้ interface กลาง (รองรับ H.264/HEVC, PK battles, Gifts/Likes/SuperFan) |
| `lib/providers/twitch.js` | ดึงสถานะ + Usher HLS (`.m3u8`) ผ่าน Twitch GQL และเชื่อมต่อแชทสดผ่าน **IRC WebSocket** (รองรับ Chat, Sub, Bits) |
| `lib/providers/youtube.js` | ดึง HLS จาก `/@handle/live` + `youtubei` (พร้อมตัวเลือก `yt-dlp` fallback) และเก็บ **Live Chat / Super Chat / Membership** |
| `lib/providers/kick.js` | ดึง `playback_url` (`.m3u8`) ผ่าน Kick API + เชื่อมต่อแชทสดผ่าน **Pusher WebSocket** (รองรับ Proxy / Fallback เมื่อติด Cloudflare) |

### Interface มาตรฐานของทุก Provider
1. `normalizeInput(raw)` → แปลง URL หรือ `@username` เป็น `{ platform, username }`
2. `fetchLiveStatus(username, opts)` → คืนค่า `{ live, title, viewerCount, coverUrl, owner, roomId, streams }` รูปแบบเดียวกัน
3. `extractStreamUrls(statusData)` → คืนค่า HLS/FLV/CMAF qualities สำหรับส่งต่อให้ `ffmpeg` และตัวเล่นเว็บ
4. `createChatSession(username, opts)` → ส่ง event มาตรฐาน (`chat`, `gift`/`superchat`/`bits`, `subscribe`, `member`, `roomUser`) เขียนลง `.events.jsonl` และเข้า **SQLite FTS5** ทันที

---

## 🌐 2. รายละเอียดเฉพาะของแต่ละแพลตฟอร์ม

### 1) Twitch (`twitch.js`)
- **Stream Pull:** ยิง Twitch GraphQL + Usher `api/channel/hls/{login}.m3u8` ตรงจาก Node.js (ไม่ต้องใช้ API Key; หากผู้ใช้ใส่ OAuth Token เสริมใน Accounts จะช่วยลดโอกาสเจอโฆษณาคั่น)
- **Chat Capture:** เชื่อมต่อ `wss://irc-ws.chat.twitch.tv:443` แบบ read-only (`justinfan...`) แปลง `PRIVMSG`, `USERNOTICE` (Sub/Resub/GiftSub), และ `bits` เป็น Schema `.events.jsonl` เดียวกัน
- **Highlights:** ใช้ `Auto-Highlights` เดิมจับช่วงแชทพุ่ง (Pog/LUL spam) และช่วง Sub/Bits Bomb อัตโนมัติ

### 2) YouTube Live (`youtube.js`)
- **Stream Pull:** ดึง metadata จาก `https://www.youtube.com/@handle/live` / `watch?v=...` ด้วย `youtubei` player API เพื่อดึง HLS manifest; เพิ่มตัวเลือกเรียก `yt-dlp` (หากติดตั้งในเครื่อง/Docker) เป็น fallback อัตโนมัติเมื่อ YouTube เปลี่ยน signature
- **Chat Capture:** ใช้ `youtubei/v1/live_chat/get_live_chat` polling ตาม `timeoutMs` ของเซิร์ฟเวอร์ แปลงข้อความแชท, **Super Chat** (มูลค่าเทียบเพชร/คะแนนใน Highlights), และ **Membership**
- **VOD/Live Sync:** ใช้ `startedAt` + timestamp ของแชทซิงก์บนหน้า `/replay` ได้แม่นยำ

### 3) Kick (`kick.js`)
- **Stream Pull:** เรียก Kick channel endpoint เพื่อดึง `livestream.playback_url` (`.m3u8`) พร้อมรองรับ proxy rotation และ optional Official Kick API / `yt-dlp` fallback เมื่อเจอ Cloudflare
- **Chat Capture:** เชื่อมต่อ **Pusher WebSocket** ของห้องแชท Kick แปลง `ChatMessageEvent`, `GiftedSubscriptionsEvent`, และ `SubscriptionEvent` ลง `.events.jsonl`

---

## 🛠️ 3. การอัปเกรดระบบจัดการไฟล์, Watchlist, บัญชี และ UI

1. **Storage & Filename Template (`lib/storage.js`, `lib/utils.js`)**
   - เพิ่ม token `{platform}` ใน `filenameTemplate` (เช่น `{platform}_{username}_{date}_{time}`)
   - รองรับโครงสร้างโฟลเดอร์ `recordings/<platform>/<creator>/...` (หรือ `<creator>/...` เดิมสำหรับ TikTok เพื่อความเข้ากันได้ย้อนหลัง 100%)
   - ปรับ `resolveRecordingPath` ให้รองรับความลึกปลอดภัยทั้งแบบเดิมและแบบมี `<platform>/`

2. **Watchlist & Accounts 2.0 (`lib/watcher.js`, `lib/accounts.js`)**
   - เพิ่มฟิลด์ `platform` (`'tiktok' | 'twitch' | 'youtube' | 'kick'`) ใน `watchlist.json` (ค่าเริ่มต้นเป็น `'tiktok'` สำหรับรายการเดิมจาก `v1.x`)
   - รองรับบัญชี/Token แยกตามแพลตฟอร์มใน `accounts.json` (เข้ารหัส AES-256-GCM เหมือนเดิม):
     - TikTok: `sessionid` + `tt-target-idc`
     - Twitch: OAuth Token (optional)
     - YouTube: Cookie / OAuth (optional สำหรับสตรีมสมาชิก/18+)
     - Kick: Client Token / Cookie (optional)

3. **SQLite Index & Multi-Platform UI (`lib/db.js`, `client/`)**
   - เพิ่มคอลัมน์ `platform` ในตาราง `recordings` ของ `recorder.db` เพื่อกรองค้นหาแชทและคลังวิดีโอแยกตามแพลตฟอร์ม
   - **หน้า Search & Watchlist:** เลือกแพลตฟอร์ม หรือวางลิงก์ (เช่น `twitch.tv/shroud`, `youtube.com/@abc/live`, `kick.com/xqc`) แล้วระบบตรวจจับแพลตฟอร์มให้อัตโนมัติ พร้อมไอคอน/ป้ายสีประจำแพลตฟอร์ม
   - **Multi-View Grid (`/grid`):** ดูและอัดไลฟ์พร้อมกันข้ามแพลตฟอร์มในหน้าเดียว (TikTok + Twitch + YouTube + Kick)

---

## 🗓️ 4. ลำดับขั้นตอนการพัฒนา (Implementation Roadmap)

### 🟢 เฟสที่ 1: Provider Architecture + Twitch (`v2.0.0-alpha`)
- [x] ออกแบบและสร้าง `lib/providers/index.js` และย้าย TikTok เข้า `lib/providers/tiktok.js` โดยไม่กระทบฟีเจอร์ `v1.6.0`
- [x] พัฒนา `lib/providers/twitch.js` (HLS stream + IRC WebSocket chat)
- [x] เพิ่ม `platform` ใน `watcher.js`, `recorder.js`, `db.js`, API routes และ UI

### 🟡 เฟสที่ 2: YouTube Live (`v2.0.0-beta.1`)
- [x] พัฒนา `lib/providers/youtube.js` (`/@handle/live` + `youtubei` HLS & Live Chat/Super Chat)
- [x] เพิ่ม optional `yt-dlp` fallback และรองรับใน `Dockerfile`

### 🟠 เฟสที่ 3: Kick & Multi-Platform UI (`v2.0.0-beta.2`)
- [x] พัฒนา `lib/providers/kick.js` (HLS + Pusher WebSocket + Cloudflare/proxy fallback)
- [x] อัปเกรด `AccountSwitcher`, `Watchlist`, `SavedRecordings`, `GridPage` และ `SearchSection` ให้เลือก/กรองตามแพลตฟอร์มและวาง URL ข้ามแพลตฟอร์มได้

### 🔵 เฟสที่ 4: ความเข้ากันได้ย้อนหลัง, ทดสอบ & ปล่อยเวอร์ชันจริง (`v2.0.0 Stable`)
- [ ] ทดสอบ backward compatibility กับ `watchlist.json`, `accounts.json`, `settings.json`, `recordings/` และ `recorder.db` จาก `v1.6.0`
- [ ] เพิ่ม unit/integration tests ของแต่ละ Provider, อัปเดต `CHANGELOG.md`, `Dockerfile`, และคำแปลภาษาไทย/อังกฤษ (`client/src/lib/i18n.tsx`) ให้ครบทุกแพลตฟอร์ม
