// lib/analytics.js — Gift economy stats, chat heatmap, word frequency analysis.
// All computations are read-only from .events.jsonl — no caching needed.

const fs = require('fs');
const path = require('path');
const { parseStartTimeFromName } = require('./utils');

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');

// ── Helpers ──

function eventsJsonlPath(recordingName) {
  const base = recordingName.replace(/\.mp4$/i, '');
  return path.join(RECORDINGS_DIR, `${base}.events.jsonl`);
}

function readEvents(eventsFile) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(eventsFile, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

// ── Gift Economy ──

const HEATMAP_BUCKET_SEC = 30; // 30-second buckets for heatmap

function buildGiftEconomy(recordingName) {
  const eventsFile = eventsJsonlPath(recordingName);
  if (!fs.existsSync(eventsFile)) return { ok: false, error: 'no events sidecar' };
  const startMs = parseStartTimeFromName(recordingName);
  if (!startMs) return { ok: false, error: 'cannot parse start time' };

  const events = readEvents(eventsFile);
  if (events.length === 0) return { ok: false, error: 'no events' };

  const lastTs = events[events.length - 1]?.ts || startMs;
  const durationSec = Math.max(60, (lastTs - startMs) / 1000);
  const bucketCount = Math.ceil(durationSec / HEATMAP_BUCKET_SEC);

  // Gift heatmap: diamonds per bucket
  const giftBuckets = new Array(bucketCount).fill(0);
  // Chat heatmap: messages per bucket
  const chatBuckets = new Array(bucketCount).fill(0);

  let totalDiamonds = 0;
  let totalGifts = 0;
  let peakDiamondBucket = 0;
  let peakDiamondValue = 0;
  const giftBreakdown = new Map(); // giftName -> { count, diamonds }
  const gifterTotals = new Map(); // uniqueId -> diamonds

  for (const ev of events) {
    if (!ev.ts) continue;
    const tSec = (ev.ts - startMs) / 1000;
    if (tSec < 0) continue;
    const idx = Math.min(Math.floor(tSec / HEATMAP_BUCKET_SEC), bucketCount - 1);

    if (ev.type === 'chat') {
      chatBuckets[idx]++;
    } else if (ev.type === 'gift') {
      const diamonds = (Number(ev.diamondCount) || 0) * (Number(ev.repeatCount) || 1);
      giftBuckets[idx] += diamonds;
      totalDiamonds += diamonds;
      totalGifts++;
      if (giftBuckets[idx] > peakDiamondValue) {
        peakDiamondValue = giftBuckets[idx];
        peakDiamondBucket = idx;
      }
      // breakdown
      const name = ev.giftName || 'unknown';
      const cur = giftBreakdown.get(name) || { name, count: 0, diamonds: 0 };
      cur.count += Number(ev.repeatCount) || 1;
      cur.diamonds += diamonds;
      giftBreakdown.set(name, cur);
      // per-gifter
      const uid = ev.user?.uniqueId || ev.user?.nickname || '?';
      gifterTotals.set(uid, (gifterTotals.get(uid) || 0) + diamonds);
    }
  }

  const avgDiamondPerMin = durationSec > 0 ? Math.round((totalDiamonds / (durationSec / 60)) * 10) / 10 : 0;

  return {
    ok: true,
    recording: recordingName,
    durationSec: Math.round(durationSec),
    bucketSec: HEATMAP_BUCKET_SEC,
    giftHeatmap: giftBuckets,
    chatHeatmap: chatBuckets,
    totals: {
      diamonds: totalDiamonds,
      gifts: totalGifts,
      avgDiamondPerMin,
      peakMomentSec: peakDiamondBucket * HEATMAP_BUCKET_SEC,
      peakDiamonds: peakDiamondValue,
    },
    giftBreakdown: [...giftBreakdown.values()]
      .sort((a, b) => b.diamonds - a.diamonds)
      .slice(0, 15),
  };
}

// ── Word Frequency / Trending Phrases ──

// Common stop words (Thai + English) to filter out
const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up',
  'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my',
  'your', 'his', 'her', 'our', 'their', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'am', 'im', 'dont', 'cant', 'wont',
  // Thai common particles/stop words
  'ครับ', 'ค่ะ', 'คะ', 'นะ', 'จ้า', 'จ๊ะ', 'ๆ', 'ก็', 'แล้ว', 'ด้วย',
  'ที่', 'ของ', 'ใน', 'จะ', 'ได้', 'ไม่', 'มี', 'เป็น', 'ให้', 'กับ',
  'อยู่', 'คือ', 'แต่', 'หรือ', 'ถ้า', 'เลย', 'มาก', 'ดี', 'แล้ว',
  'ไป', 'มา', 'อัน', 'ว่า', 'กัน', 'เอา', 'ทำ', 'อะ', 'เนี่ย', 'นะคะ',
  'นะครับ', 'จ้ะ', 'ฮะ', 'ฮ่ะ', 'อ่ะ', 'เหรอ', 'หรอ', 'ป่ะ', 'มั้ย',
  'ไหม', 'บ้าง', 'ด้วยนะ', 'สิ', 'ซิ', 'เถอะ', 'ละ', 'ล่ะ', 'น่ะ',
  // Common chat noise
  'haha', 'lol', 'lmao', 'omg', 'wow', 'yes', 'no', 'ok', 'okay',
  '555', '5555', '55555', 'hahaha', 'hihi', 'kk', 'gg',
]);

// Minimum word length to consider
const MIN_WORD_LEN = 2;
const MAX_PHRASES = 50;

function buildWordFrequency(recordingName) {
  const eventsFile = eventsJsonlPath(recordingName);
  if (!fs.existsSync(eventsFile)) return { ok: false, error: 'no events sidecar' };

  const events = readEvents(eventsFile);
  const wordCounts = new Map();
  let totalMessages = 0;

  for (const ev of events) {
    if (ev.type !== 'chat' || !ev.comment) continue;
    totalMessages++;
    const text = ev.comment.toLowerCase().trim();
    // Split on whitespace and common punctuation
    const words = text.split(/[\s,!?.;:()[\]{}"'`~@#$%^&*+=|\\/<>]+/)
      .filter((w) => w.length >= MIN_WORD_LEN && !STOP_WORDS.has(w));

    // Count unique words per message (avoid one spammer inflating counts)
    const seen = new Set();
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
  }

  // Filter: must appear in at least 2 messages
  const phrases = [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PHRASES)
    .map(([word, count]) => ({ word, count, pct: totalMessages > 0 ? Math.round((count / totalMessages) * 1000) / 10 : 0 }));

  return {
    ok: true,
    recording: recordingName,
    totalMessages,
    phrases,
  };
}

// ── Spam Detection Heuristics ──

// Returns a "spam score" 0-100 for a single chat message.
// Higher = more likely spam. Threshold is up to the client.
function spamScore(comment) {
  if (!comment) return 0;
  let score = 0;
  const len = comment.length;

  // Very short repetitive messages
  if (len <= 3 && /^(.)\1+$/.test(comment)) score += 40;

  // Excessive emoji ratio (>70% emoji characters)
  const emojiMatches = comment.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu) || [];
  const emojiRatio = emojiMatches.length / Math.max(1, [...comment].length);
  if (emojiRatio > 0.7 && len > 4) score += 30;

  // Repeated characters (e.g. "aaaaaaa", "!!!!!!")
  if (/(.)\1{5,}/.test(comment)) score += 25;

  // All caps (English) and long
  if (len > 10 && comment === comment.toUpperCase() && /[A-Z]/.test(comment)) score += 15;

  // Looks like a bot link
  if (/https?:\/\//i.test(comment)) score += 50;
  if (/\b(follow|subscribe|check|click|link|bio)\b/i.test(comment) && /https?:\/\//i.test(comment)) score += 30;

  // Repeated word pattern (e.g. "hi hi hi hi")
  const words = comment.split(/\s+/);
  if (words.length >= 4) {
    const unique = new Set(words.map((w) => w.toLowerCase()));
    if (unique.size <= 2) score += 35;
  }

  return Math.min(100, score);
}

// Batch: annotate events with spam scores (for client-side filtering)
function annotateSpam(events, threshold = 40) {
  let spamCount = 0;
  for (const ev of events) {
    if (ev.type === 'chat' && ev.comment) {
      ev._spamScore = spamScore(ev.comment);
      if (ev._spamScore >= threshold) spamCount++;
    }
  }
  return { spamCount, total: events.filter((e) => e.type === 'chat').length };
}

module.exports = {
  buildGiftEconomy,
  buildWordFrequency,
  spamScore,
  annotateSpam,
};
