// lib/highlights.js — Detect chat/gift spikes in `.events.jsonl` sidecar files
// and cut them into standalone .mp4 clips via ffmpeg stream-copy.
//
// Detection is post-process only (runs after the recorder exits). It is cheap
// (≈ a few ms per recording) so it always runs unless DISABLE_AUTO_HIGHLIGHTS=1.
// Cutting clips, on the other hand, only happens on explicit user request.

const { EventEmitter } = require('node:events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveFfmpeg } = require('./ffmpeg');
const { getEncoder } = require('./transcode');
const { getDiskStatus, invalidateDirBytesCache, acquireHeavyMediaSlot, releaseHeavyMediaSlot } = require('./storage');
const { parseStartTimeFromName, assertPathInsideRealDir, resolveInsideDir, resolveRecordingPath, readEvents, atomicWriteFileSync } = require('./utils');

const highlightsEvents = new EventEmitter();
highlightsEvents.setMaxListeners(100);

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');
const CLIPS_DIR = path.join(RECORDINGS_DIR, 'highlights');

fs.mkdirSync(CLIPS_DIR, { recursive: true });

// ── Tunables ──
const BUCKET_SEC = 5;           // fine-grained 5-second buckets for accurate onset
const CONTEXT_RADIUS_BUCKETS = 24; // ±2 min centered sliding baseline window
const EXCLUDE_RADIUS_BUCKETS = 2;  // exclude ±10s around candidate so spikes don't mask themselves
const SPIKE_RATIO = 2.0;        // balanced default ratio threshold
const ABSOLUTE_FLOOR = 3;       // balanced hard minimum score
const MIN_BUCKET_EVENTS = 2;    // require ≥N events so a single fluke doesn't count
const MERGE_GAP_SEC = 18;       // merge spikes within 18s of each other
const MIN_CLIP_SEC = 15;
const MAX_CLIP_SEC = 90;
const MAX_HIGHLIGHTS = 30;      // cap candidates per recording
const FALLBACK_TOP_N = 5;       // if primary detection finds nothing, take top-N busiest buckets

const SENSITIVITY_PRESETS = {
  strict: {
    name: 'strict',
    spikeRatio: 2.6,
    zThreshold: 3.2,
    absoluteFloor: 5,
    minEvents: 3,
    audioDbDelta: 7.5,
    audioZ: 3.0,
  },
  balanced: {
    name: 'balanced',
    spikeRatio: SPIKE_RATIO,
    zThreshold: 2.1,
    absoluteFloor: ABSOLUTE_FLOOR,
    minEvents: MIN_BUCKET_EVENTS,
    audioDbDelta: 5.5,
    audioZ: 2.3,
  },
  sensitive: {
    name: 'sensitive',
    spikeRatio: 1.55,
    zThreshold: 1.4,
    absoluteFloor: 2.5,
    minEvents: MIN_BUCKET_EVENTS,
    audioDbDelta: 4.0,
    audioZ: 1.7,
  },
};

function getSensitivityPreset(name) {
  return SENSITIVITY_PRESETS[name] || SENSITIVITY_PRESETS.balanced;
}

// Score weights per event.
const W_CHAT = 1;
const W_GIFT_BASE = 8;
const W_DIAMOND = 0.5;
const W_LIKE = 0.1;             // likeCount is per-batch (often 5-15)
const W_FOLLOW = 3;
const W_SHARE = 2;
const W_SUBSCRIBE = 20;         // paid subscriber — very high value
const W_ENVELOPE = 15;          // treasure box / red envelope — high engagement moment
const W_QUESTION = 2;           // Q&A / poll / shopping signal
const W_CLIP_CALLOUT = 3.0;     // explicit "clip it / ตัดคลิป" viewer callout
const W_REACTION_BONUS = 0.6;   // funny / hype / shock / love reaction signal
const W_EMPHASIS_BONUS = 0.25;  // !!!, ???, ALLCAPS shouting, 55555+
// member events excluded — too noisy and not really a "highlight" signal

const KNOWN_BOTS = new Set([
  'nightbot', 'streamelements', 'moobot', 'fossabot',
  'streamlabs', 'kickbot', 'botrix', 'wizebot', 'sery_bot',
]);

const REACTION_RULES = [
  { mood: 'funny', re: /(555+|ฮ่า+|ก๊าก|ขำ|ลั่น|ปั่น|ฮา+|lmao|lmfao|rofl|kekw|lulw?|omegalul|icant|pepelaugh|\bxd+\b|[😂🤣💀])/giu },
  { mood: 'hype', re: /(โหด|ตึง|สุดยอด|เทพ|ปัง|จีจี|ชนะแล้ว|เก่งมาก|\bpog(?:gers|champ)?\b|\bclutch\b|\binsane\b|\bgoat\b|let'?s\s*go|\bgg\b|\bez\b|\bholy\b|[🔥🐐👑⚡🎉💪])/giu },
  { mood: 'shock', re: /(เห้ย|เฮ้ย|ช็อก|ว้าย|อ้าว|จริงดิ|ไม่จริง|ฉิบหาย|ชิบหาย|บ้าไปแล้ว|\bwtf\b|\bomg\b|no\s*way|bro\s+what|\bbruh\b|[😱🤯😳])/giu },
  { mood: 'love', re: /(น่ารัก|ซึ้ง|ร้องไห้|รักมาก|สวยมาก|หล่อมาก|\baww+\b|\bwholesome\b|peepolove|biblethump|[❤️🥺💖])/giu },
];
const CLIP_CALLOUT_RE = /(clip\s*(?:it|that|this)|\bclipped\b|ตัดคลิป|เก็บคลิป|ไฮไลท์|\bhighlight\b)/iu;
const EMPHASIS_RE = /([!?]{2,}|5{4,}|\b[A-Z]{3,}\b)/u;
const CUSTOM_EMOTE_RE = /:([a-z0-9_]{2,24}):/gi;

function isBotOrCommand(ev) {
  if (!ev || ev.type !== 'chat') return false;
  const text = typeof ev.comment === 'string' ? ev.comment.trim() : '';
  if (text.startsWith('!') && /^![a-z0-9_]+/i.test(text)) return true;
  const uid = String(ev.user?.uniqueId || '').trim().toLowerCase();
  const nick = String(ev.user?.nickname || '').trim().toLowerCase();
  return KNOWN_BOTS.has(uid) || KNOWN_BOTS.has(nick);
}

function classifyChatReaction(comment) {
  const text = typeof comment === 'string' ? comment.trim() : '';
  if (!text) return { mood: null, clipCallout: false, emphasis: false, tokens: [] };

  let bestMood = null;
  let bestHits = 0;
  const tokenSet = new Set();

  for (const rule of REACTION_RULES) {
    const matches = text.match(rule.re);
    if (matches && matches.length > 0) {
      if (matches.length > bestHits) {
        bestHits = matches.length;
        bestMood = rule.mood;
      }
      for (const m of matches.slice(0, 2)) {
        const clean = m.trim().toLowerCase();
        if (clean.length <= 24) {
          tokenSet.add(/^5+$/.test(clean) ? '555' : clean);
        }
      }
    }
  }

  let mEmote;
  CUSTOM_EMOTE_RE.lastIndex = 0;
  while ((mEmote = CUSTOM_EMOTE_RE.exec(text)) !== null) {
    tokenSet.add(mEmote[1].toLowerCase());
    if (tokenSet.size >= 4) break;
  }

  const clipCallout = CLIP_CALLOUT_RE.test(text);
  if (clipCallout) tokenSet.add('clip');
  const emphasis = EMPHASIS_RE.test(text);

  return {
    mood: bestMood,
    clipCallout,
    emphasis,
    tokens: [...tokenSet].slice(0, 4),
  };
}

// PK / link-mic battle padding: windows are derived directly from pkStart →
// pkEnd events, so we don't need much extra context around them. A small lead
// captures the "battle starting" overlay and a small tail catches the punish
// reaction shot.
const PK_PRE_PAD_SEC = 5;
const PK_POST_PAD_SEC = 8;
const PK_MIN_DUR_SEC = 30;        // very short matches probably aren't worth a clip
const PK_MAX_DUR_SEC = 240;       // keep PK clips bounded so they're shareable
const MAX_CUT_SEC = Math.max(MAX_CLIP_SEC, PK_MAX_DUR_SEC); // allow cutting full PK battle windows

// ── File helpers ──

function resolveRec(recordingName) {
  const resolved = resolveRecordingPath(RECORDINGS_DIR, recordingName, '.mp4');
  if (!resolved) throw new Error('invalid recording name');
  return resolved;
}

function highlightsJsonPath(recordingName) {
  return resolveRec(recordingName).full.replace(/\.mp4$/i, '.highlights.json');
}

function eventsJsonlPath(recordingName) {
  return resolveRec(recordingName).full.replace(/\.mp4$/i, '.events.jsonl');
}

function recordingPath(recordingName) {
  return resolveRec(recordingName).full;
}

function readRecordingStartMs(recordingName) {
  const parsed = parseStartTimeFromName(recordingName);
  if (parsed) return parsed;
  try {
    const metaFile = resolveRec(recordingName).full.replace(/\.mp4$/i, '.meta.json');
    if (assertPathInsideRealDir(RECORDINGS_DIR, metaFile) && fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (Number.isFinite(Number(meta?.startedAt)) && Number(meta.startedAt) > 0) return Number(meta.startedAt);
    }
  } catch {}
  return null;
}

function nonNegNum(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Median of an array of numbers (returns 0 if empty).
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Analysis ──

function eventScore(ev) {
  switch (ev.type) {
    case 'chat':        return W_CHAT;
    case 'gift':        return W_GIFT_BASE + nonNegNum(ev.diamondCount, 0) * Math.max(1, nonNegNum(ev.repeatCount, 1)) * W_DIAMOND;
    case 'like':        return Math.max(1, nonNegNum(ev.likeCount, 1)) * W_LIKE;
    case 'follow':      return W_FOLLOW;
    case 'social':      return W_FOLLOW;
    case 'share':       return W_SHARE;
    case 'subscribe':   return W_SUBSCRIBE;
    case 'superFan':    return W_SUBSCRIBE;
    case 'superFanBox': return W_ENVELOPE;
    case 'envelope':    return W_ENVELOPE;
    case 'question':    return W_QUESTION;
    case 'poll':        return W_QUESTION;
    case 'shopping':    return W_QUESTION;
    default:            return 0;
  }
}

const MAX_ANALYSIS_DUR_SEC = 24 * 3600;
const MAX_ANALYSIS_BUCKETS = Math.ceil(MAX_ANALYSIS_DUR_SEC / BUCKET_SEC);

function userDiminishingMultiplier(countInBucket) {
  if (countInBucket <= 1) return 1.0;
  if (countInBucket === 2) return 0.65;
  if (countInBucket === 3) return 0.35;
  return 0.15;
}

// Build per-bucket aggregate from a sorted list of events with anti-spam,
// bilingual reaction extraction, and crowd-diversity weighting.
function bucketize(events, startMs, durationSec) {
  const safeDur = Number.isFinite(durationSec) && durationSec > 0 ? Math.min(MAX_ANALYSIS_DUR_SEC, durationSec) : 60;
  const bucketCount = Math.max(1, Math.min(MAX_ANALYSIS_BUCKETS, Math.ceil(safeDur / BUCKET_SEC)));
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      startSec: i * BUCKET_SEC,
      endSec: (i + 1) * BUCKET_SEC,
      score: 0,
      rawScore: 0,
      chats: 0, gifts: 0, likes: 0, diamonds: 0, follows: 0, shares: 0, subscribes: 0,
      eventCount: 0,
      clipCallouts: 0,
      moodCounts: { funny: 0, hype: 0, shock: 0, love: 0 },
      keywordCounts: new Map(),
      uniqueUsers: new Set(),
      userChatCounts: new Map(),
      userLastText: new Map(),
      eventsInBucket: [],
    });
  }

  for (const ev of events) {
    if (!ev.ts) continue;
    const tSec = (ev.ts - startMs) / 1000;
    if (tSec < 0 || tSec >= bucketCount * BUCKET_SEC) continue;
    const idx = Math.floor(tSec / BUCKET_SEC);
    const b = buckets[idx];
    if (!b) continue;

    if (ev.type === 'chat' && isBotOrCommand(ev)) continue;

    const baseScore = eventScore(ev);
    if (baseScore <= 0) continue;

    const uname = ev.user?.uniqueId || ev.user?.nickname || null;
    if (uname) b.uniqueUsers.add(uname);

    let effectiveScore = baseScore;
    let reaction = null;

    if (ev.type === 'chat') {
      const comment = typeof ev.comment === 'string' ? ev.comment.trim() : '';
      reaction = classifyChatReaction(comment);

      let mult = 1.0;
      if (uname) {
        const count = (b.userChatCounts.get(uname) || 0) + 1;
        b.userChatCounts.set(uname, count);
        mult = userDiminishingMultiplier(count);
        const normText = comment.toLowerCase();
        if (normText && b.userLastText.get(uname) === normText) {
          mult *= 0.1;
        }
        if (normText) b.userLastText.set(uname, normText);
      }

      const reactionBonus =
        (reaction.mood ? W_REACTION_BONUS : 0) +
        (reaction.emphasis ? W_EMPHASIS_BONUS : 0) +
        (reaction.clipCallout ? W_CLIP_CALLOUT : 0);

      effectiveScore = (baseScore + reactionBonus) * mult;

      // Only count meaningful reaction keywords with the first 3 msgs from a user in this bucket
      if (mult >= 0.35) {
        if (reaction.mood) b.moodCounts[reaction.mood] = (b.moodCounts[reaction.mood] || 0) + 1;
        if (reaction.clipCallout) b.clipCallouts++;
        for (const tok of reaction.tokens) {
          b.keywordCounts.set(tok, (b.keywordCounts.get(tok) || 0) + 1);
        }
      }
      b.chats++;
    } else if (ev.type === 'gift') {
      b.gifts++;
      b.diamonds += nonNegNum(ev.diamondCount, 0) * Math.max(1, nonNegNum(ev.repeatCount, 1));
    } else if (ev.type === 'like') {
      b.likes += Math.max(1, nonNegNum(ev.likeCount, 1));
    } else if (ev.type === 'follow' || ev.type === 'social') {
      b.follows++;
    } else if (ev.type === 'share') {
      b.shares++;
    } else if (ev.type === 'subscribe' || ev.type === 'superFan') {
      b.subscribes++;
    }

    b.rawScore += baseScore;
    b.score += effectiveScore;
    b.eventCount++;

    const wrapped = reaction ? { ...ev, _reaction: reaction, _effScore: effectiveScore } : { ...ev, _effScore: effectiveScore };
    if (b.eventsInBucket.length < 400) {
      b.eventsInBucket.push(wrapped);
    } else if (ev.type === 'gift' || ev.type === 'subscribe' || ev.type === 'superFan' || reaction?.clipCallout) {
      b.eventsInBucket.push(wrapped);
    }
  }

  for (const b of buckets) {
    if (b.chats > 0 && b.gifts === 0 && b.subscribes === 0) {
      const uniq = b.uniqueUsers.size;
      if (uniq <= 1 && b.chats >= 3) {
        b.score *= 0.75;
      } else if (uniq >= 3) {
        b.score *= 1 + Math.min(0.65, Math.log2(uniq) * 0.16);
      }
    }
  }

  return buckets;
}

// Centered Median + MAD spike detector with neighbor smoothing across 5s boundaries.
function findSpikeBuckets(buckets, preset = SENSITIVITY_PRESETS.balanced) {
  const n = buckets.length;
  const smoothed = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const s = buckets[i].score;
    if (s <= 0) continue;
    const prev = i > 0 ? buckets[i - 1].score : 0;
    const next = i + 1 < n ? buckets[i + 1].score : 0;
    smoothed[i] = s + prev * 0.35 + next * 0.35;
  }

  const activeSmoothed = smoothed.filter((s) => s > 0);
  const globalMedian = median(activeSmoothed);
  const globalMad = median(activeSmoothed.map((s) => Math.abs(s - globalMedian)));

  const spikes = [];
  for (let i = 0; i < n; i++) {
    const b = buckets[i];
    if (b.score < preset.absoluteFloor) continue;
    if (b.eventCount < 1) continue;
    const neighborEvents = b.eventCount + (i + 1 < n ? buckets[i + 1].eventCount : 0);
    if (b.eventCount < preset.minEvents && neighborEvents < preset.minEvents) continue;

    // Build centered context excluding ±EXCLUDE_RADIUS_BUCKETS around i
    const ctx = [];
    const leftStart = Math.max(0, i - CONTEXT_RADIUS_BUCKETS);
    const leftEnd = i - EXCLUDE_RADIUS_BUCKETS;
    for (let j = leftStart; j < leftEnd; j++) ctx.push(smoothed[j]);
    const rightStart = i + EXCLUDE_RADIUS_BUCKETS + 1;
    const rightEnd = Math.min(n - 1, i + CONTEXT_RADIUS_BUCKETS);
    for (let j = rightStart; j <= rightEnd; j++) ctx.push(smoothed[j]);

    const localMedian = median(ctx);
    const localMad = median(ctx.map((x) => Math.abs(x - localMedian)));
    const baselineEff = Math.max(
      localMedian,
      globalMedian * 0.5,
      preset.absoluteFloor / preset.spikeRatio,
    );
    const ratio = smoothed[i] / baselineEff;
    const madEff = Math.max(localMad, globalMad * 0.5, 1.5);
    const zScore = (0.6745 * (smoothed[i] - localMedian)) / madEff;

    const passesBalanced = ratio >= preset.spikeRatio && zScore >= preset.zThreshold;
    const passesExtreme = ratio >= preset.spikeRatio * 1.45 && b.score >= preset.absoluteFloor * 2;
    if (!passesBalanced && !passesExtreme) continue;

    spikes.push({
      idx: i,
      score: b.score,
      smoothedScore: smoothed[i],
      baseline: localMedian,
      ratio,
      zScore,
    });
  }
  return spikes;
}

// Fallback: if normal spike detection finds nothing, take the busiest buckets.
function topMomentBuckets(buckets) {
  const eligible = buckets
    .map((b, idx) => ({ idx, score: b.score, eventCount: b.eventCount }))
    .filter((x) => x.score > 0 && x.eventCount >= MIN_BUCKET_EVENTS);
  eligible.sort((a, b) => b.score - a.score);
  return eligible
    .slice(0, FALLBACK_TOP_N)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => ({
      idx: x.idx,
      score: x.score,
      smoothedScore: x.score,
      baseline: 0,
      ratio: 1,
      zScore: 0,
    }));
}

function summarizeEventsForWindow(eventsList) {
  let chats = 0, gifts = 0, likes = 0, diamonds = 0, follows = 0, shares = 0, subscribes = 0;
  let totalScore = 0;
  let clipCallouts = 0;
  const moodCounts = { funny: 0, hype: 0, shock: 0, love: 0 };
  const keywordCounts = new Map();
  const giftCounts = new Map();
  const userScores = new Map();
  const userAvatars = new Map();
  const uniqueUsers = new Set();
  const quoteCandidates = [];
  const seenQuotes = new Set();

  for (const ev of eventsList) {
    if (ev.type === 'chat' && isBotOrCommand(ev)) continue;
    const score = Number.isFinite(ev._effScore) ? ev._effScore : eventScore(ev);
    totalScore += score;

    if (ev.type === 'chat') {
      chats++;
      const reaction = ev._reaction || classifyChatReaction(ev.comment);
      if (reaction.mood) moodCounts[reaction.mood] = (moodCounts[reaction.mood] || 0) + 1;
      if (reaction.clipCallout) clipCallouts++;
      for (const tok of reaction.tokens) {
        keywordCounts.set(tok, (keywordCounts.get(tok) || 0) + 1);
      }
      const rawText = typeof ev.comment === 'string' ? ev.comment.trim() : '';
      const normText = rawText.toLowerCase();
      if (rawText.length >= 2 && !seenQuotes.has(normText)) {
        seenQuotes.add(normText);
        const priority = (reaction.clipCallout ? 3 : 0) + (reaction.mood ? 2 : 0) + (reaction.emphasis ? 1 : 0);
        const userLabel = ev.user?.nickname || ev.user?.uniqueId || 'viewer';
        quoteCandidates.push({ priority, user: userLabel, text: rawText.slice(0, 80), len: rawText.length });
      }
    } else if (ev.type === 'gift') {
      const cnt = Math.max(1, nonNegNum(ev.repeatCount, 1));
      gifts++;
      diamonds += nonNegNum(ev.diamondCount, 0) * cnt;
      if (ev.giftName) {
        giftCounts.set(ev.giftName, (giftCounts.get(ev.giftName) || 0) + cnt);
      }
    } else if (ev.type === 'like') {
      likes += Math.max(1, nonNegNum(ev.likeCount, 1));
    } else if (ev.type === 'follow' || ev.type === 'social') {
      follows++;
    } else if (ev.type === 'share') {
      shares++;
    } else if (ev.type === 'subscribe' || ev.type === 'superFan') {
      subscribes++;
    }

    const uname = ev.user?.uniqueId || ev.user?.nickname;
    if (uname) {
      uniqueUsers.add(uname);
      userScores.set(uname, (userScores.get(uname) || 0) + score);
      if (ev.user?.profilePictureUrl && !userAvatars.has(uname)) {
        userAvatars.set(uname, ev.user.profilePictureUrl);
      }
    }
  }

  const topGift = [...giftCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topUser = [...userScores.entries()].sort((a, b) => b[1] - a[1])[0];
  const topKeywords = [...keywordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  quoteCandidates.sort((a, b) => b.priority - a.priority || b.len - a.len);
  const sampleQuotes = quoteCandidates.slice(0, 2).map(({ user, text }) => ({ user, text }));

  return {
    chats, gifts, likes, diamonds, follows, shares, subscribes,
    uniqueUsers: uniqueUsers.size,
    totalScore,
    clipCallouts,
    moodCounts,
    topGift: topGift ? { name: topGift[0], count: topGift[1] } : null,
    topUser: topUser ? {
      name: topUser[0],
      score: Math.round(topUser[1] * 10) / 10,
      avatar: userAvatars.get(topUser[0]) || null,
    } : null,
    topKeywords,
    sampleQuotes,
  };
}

function computeAudioStats(audioRmsBySec) {
  if (!Array.isArray(audioRmsBySec) || audioRmsBySec.length === 0) return null;
  const active = audioRmsBySec.filter((db) => Number.isFinite(db) && db > -70);
  if (active.length < 5) return null;
  const med = median(active);
  const mad = Math.max(median(active.map((db) => Math.abs(db - med))), 1.2);
  return { med, mad, activeCount: active.length };
}

function findAudioPeakInWindow(audioRmsBySec, fromSec, toSec, preset, precomputedStats = null) {
  if (!Array.isArray(audioRmsBySec) || audioRmsBySec.length === 0) return null;
  const stats = precomputedStats || computeAudioStats(audioRmsBySec);
  if (!stats) return null;
  const { med, mad } = stats;

  const start = Math.max(0, Math.floor(fromSec));
  const end = Math.min(audioRmsBySec.length - 1, Math.ceil(toSec));
  let bestSec = -1;
  let bestDb = -Infinity;
  for (let s = start; s <= end; s++) {
    const db = audioRmsBySec[s];
    if (!Number.isFinite(db) || db <= -26) continue;
    const z = (0.6745 * (db - med)) / mad;
    if (db >= med + preset.audioDbDelta && z >= preset.audioZ && db > bestDb) {
      bestDb = db;
      bestSec = s;
    }
  }
  return bestSec >= 0 ? { sec: bestSec, db: bestDb } : null;
}

// Merge consecutive/close spike buckets into highlight windows with 1-second
// peak/onset boundary alignment and optional audio peak latency compensation.
function mergeSpikes(spikeBuckets, buckets, opts = {}) {
  if (!spikeBuckets.length) return [];
  const durationSec = Number.isFinite(opts.durationSec) && opts.durationSec > 0 ? opts.durationSec : MAX_ANALYSIS_DUR_SEC;
  const startMs = opts.startMs || 0;
  const preset = opts.preset || SENSITIVITY_PRESETS.balanced;
  const audioRmsBySec = opts.audioRmsBySec || null;
  const audioStats = opts.audioStats || computeAudioStats(audioRmsBySec);

  const sortedSpikes = [...spikeBuckets].sort((a, b) => a.idx - b.idx);
  const groups = [];
  let cur = null;
  const gapBuckets = Math.ceil(MERGE_GAP_SEC / BUCKET_SEC);
  for (const s of sortedSpikes) {
    if (!cur || s.idx - cur.lastIdx > gapBuckets) {
      cur = { firstIdx: s.idx, lastIdx: s.idx, members: [s] };
      groups.push(cur);
    } else {
      cur.lastIdx = Math.max(cur.lastIdx, s.idx);
      cur.members.push(s);
    }
  }

  return groups.map((g) => {
    const windowEvents = [];
    for (let idx = g.firstIdx; idx <= g.lastIdx; idx++) {
      for (const ev of buckets[idx].eventsInBucket) {
        windowEvents.push(ev);
      }
    }

    const stats = summarizeEventsForWindow(windowEvents);

    // 1-second energy histogram inside cluster for accurate onset & peakSec
    const minSec = Math.floor(buckets[g.firstIdx].startSec);
    const maxSec = Math.ceil(buckets[g.lastIdx].endSec);
    const spanLen = Math.max(1, maxSec - minSec);
    const secScores = new Array(spanLen).fill(0);
    for (const ev of windowEvents) {
      if (!ev.ts || !startMs) continue;
      const rel = Math.floor((ev.ts - startMs) / 1000) - minSec;
      if (rel >= 0 && rel < spanLen) {
        secScores[rel] += Number.isFinite(ev._effScore) ? ev._effScore : eventScore(ev);
      }
    }

    let bestRoll = -1;
    let bestOffset = 0;
    let maxSingleSecScore = 0;
    for (let s = 0; s < spanLen; s++) {
      if (secScores[s] > maxSingleSecScore) maxSingleSecScore = secScores[s];
      const roll = (secScores[s - 1] || 0) + secScores[s] + (secScores[s + 1] || 0);
      if (roll > bestRoll) {
        bestRoll = roll;
        bestOffset = s;
      }
    }

    let onsetSec = buckets[g.firstIdx].startSec;
    let tailSec = buckets[g.lastIdx].endSec;
    let peakSec = minSec + bestOffset;

    if (maxSingleSecScore > 0) {
      const activeThresh = maxSingleSecScore * 0.25;
      const firstActive = secScores.findIndex((v) => v >= activeThresh);
      if (firstActive >= 0) onsetSec = minSec + firstActive;
      let lastActive = spanLen - 1;
      while (lastActive > 0 && secScores[lastActive] === 0) lastActive--;
      tailSec = minSec + lastActive + 1;
    } else {
      const peakMember = g.members.reduce((p, c) => (c.score > p.score ? c : p), g.members[0]);
      peakSec = Math.round((buckets[peakMember.idx].startSec + buckets[peakMember.idx].endSec) / 2);
    }

    const peak = g.members.reduce((p, c) => (c.score > p.score ? c : p), g.members[0]);
    const peakBaseline = peak.baseline;
    const peakRatio = peak.ratio;
    const peakZ = peak.zScore || 0;

    // Reason + Mood classification
    const giftScore = stats.gifts * W_GIFT_BASE + stats.diamonds * W_DIAMOND;
    const subScore = stats.subscribes * W_SUBSCRIBE;
    const chatScore = stats.chats * W_CHAT;
    const totalMoodHits = Object.values(stats.moodCounts).reduce((a, b) => a + b, 0);

    let reason;
    if (giftScore > stats.totalScore * 0.45) reason = 'gift_spike';
    else if (subScore > stats.totalScore * 0.45 || stats.subscribes >= 3) reason = 'sub_spike';
    else if (chatScore >= stats.totalScore * 0.4 || totalMoodHits >= 3) reason = 'chat_spike';
    else reason = 'activity_spike';

    let mood = 'activity';
    if (reason === 'gift_spike') mood = 'gift';
    else if (reason === 'sub_spike') mood = 'sub';
    else {
      const topMood = Object.entries(stats.moodCounts).sort((a, b) => b[1] - a[1])[0];
      if (topMood && topMood[1] >= 2) mood = topMood[0];
    }

    // Chat latency compensation + audio peak fusion
    const audioMatch = findAudioPeakInWindow(audioRmsBySec, onsetSec - 10, peakSec + 2, preset, audioStats);
    const hasAudioPeak = !!audioMatch;
    if (audioMatch) {
      onsetSec = Math.min(onsetSec, audioMatch.sec);
    }

    const prePad = reason === 'chat_spike' ? 9 : (reason === 'gift_spike' || reason === 'sub_spike' ? 6 : 7);
    const postPad = reason === 'chat_spike' ? 11 : 13;

    let startSec = Math.max(0, onsetSec - prePad);
    let rawEnd = Math.min(durationSec, tailSec + postPad);
    if (rawEnd - startSec > MAX_CLIP_SEC) {
      // Anchor window around peakSec so clipping never cuts off the climax
      if (peakSec > startSec + MAX_CLIP_SEC - 5) {
        startSec = Math.max(0, Math.min(peakSec - Math.floor(MAX_CLIP_SEC * 0.65), rawEnd - MAX_CLIP_SEC));
      }
      rawEnd = Math.min(durationSec, startSec + MAX_CLIP_SEC);
    }
    let endSec = Math.min(durationSec, Math.max(startSec + MIN_CLIP_SEC, rawEnd));
    if (endSec - startSec < MIN_CLIP_SEC && durationSec >= MIN_CLIP_SEC) {
      startSec = Math.max(0, endSec - MIN_CLIP_SEC);
    }

    const confidence = Math.min(
      99,
      Math.round(
        25 +
        Math.min(35, peakRatio * 7) +
        Math.min(20, Math.max(0, peakZ) * 4) +
        Math.min(12, stats.uniqueUsers * 1.5) +
        (hasAudioPeak ? 12 : 0) +
        (stats.clipCallouts > 0 ? 10 : 0),
      ),
    );

    return {
      id: `h_${Math.floor(startSec)}`,
      startSec: Math.round(startSec * 10) / 10,
      endSec: Math.round(endSec * 10) / 10,
      peakSec: Math.round(peakSec * 10) / 10,
      score: Math.round(stats.totalScore * 10) / 10,
      peakScore: Math.round(peak.score * 10) / 10,
      baseline: Math.round(peakBaseline * 10) / 10,
      ratio: Math.round(peakRatio * 10) / 10,
      confidence,
      reason,
      mood,
      hasAudioPeak,
      summary: {
        chats: stats.chats,
        gifts: stats.gifts,
        likes: stats.likes,
        diamonds: stats.diamonds,
        follows: stats.follows,
        shares: stats.shares,
        subscribes: stats.subscribes,
        uniqueUsers: stats.uniqueUsers,
        topGift: stats.topGift,
        topUser: stats.topUser,
        topKeywords: stats.topKeywords,
        sampleQuotes: stats.sampleQuotes,
      },
    };
  })
  .sort((a, b) => b.score - a.score)  // sort highest score first
  .slice(0, MAX_HIGHLIGHTS)
  .sort((a, b) => a.startSec - b.startSec); // then back to chronological for display
}

// ── Public: analyze a single recording ──

function findPkWindows(events, startMs, audioRmsBySec = null, preset = SENSITIVITY_PRESETS.balanced, audioStats = null, durationSec = MAX_ANALYSIS_DUR_SEC) {
  const opens = [];
  const windows = [];

  const closeWindow = (open, endTs, opts) => {
    const duration = (endTs - open.ts) / 1000;
    if (!Number.isFinite(duration) || duration <= 0) return;
    windows.push({
      startTs: open.ts,
      endTs,
      battleId: open.battleId,
      battleUsers: open.battleUsers || [],
      durationSec: duration,
      explicitEnd: !!opts?.explicitEnd,
    });
  };

  for (const ev of events) {
    if (!ev.ts) continue;
    if (ev.type === 'pkStart') {
      opens.push({
        ts: ev.ts,
        battleId: ev.battleId || null,
        battleUsers: Array.isArray(ev.battleUsers) ? ev.battleUsers : [],
      });
    } else if (ev.type === 'pkEnd') {
      let matchIdx = -1;
      if (ev.battleId) {
        matchIdx = opens.findIndex((o) => o.battleId === ev.battleId);
      }
      if (matchIdx === -1 && opens.length > 0) matchIdx = opens.length - 1;
      if (matchIdx >= 0) {
        const open = opens.splice(matchIdx, 1)[0];
        closeWindow(open, ev.ts, { explicitEnd: true });
      }
    }
  }
  if (opens.length > 0) {
    const lastTs = events[events.length - 1]?.ts || Date.now();
    for (const open of opens) closeWindow(open, lastTs, { explicitEnd: false });
  }

  const candidates = [];
  for (const w of windows) {
    const startSecRaw = (w.startTs - startMs) / 1000;
    const endSecRaw = (w.endTs - startMs) / 1000;
    if (!Number.isFinite(startSecRaw) || !Number.isFinite(endSecRaw)) continue;

    const padStart = Math.max(0, startSecRaw - PK_PRE_PAD_SEC);
    let padEnd = Math.min(durationSec, endSecRaw + PK_POST_PAD_SEC);
    const dur = padEnd - padStart;
    if (dur < PK_MIN_DUR_SEC) continue;
    if (dur > PK_MAX_DUR_SEC) padEnd = padStart + PK_MAX_DUR_SEC;

    const winEvents = events.filter((ev) => ev.ts && ev.ts >= w.startTs && ev.ts <= w.endTs);
    const stats = summarizeEventsForWindow(winEvents);
    const opponents = (w.battleUsers || [])
      .map((u) => u?.nickname || u?.uniqueId)
      .filter(Boolean);
    const audioMatch = findAudioPeakInWindow(audioRmsBySec, padStart, padEnd, preset, audioStats);

    candidates.push({
      id: `pk_${Math.floor(padStart)}`,
      startSec: Math.round(padStart * 10) / 10,
      endSec: Math.round(padEnd * 10) / 10,
      peakSec: Math.round(((padStart + padEnd) / 2) * 10) / 10,
      score: Math.round(stats.totalScore * 10) / 10,
      peakScore: Math.round(stats.totalScore * 10) / 10,
      baseline: 0,
      ratio: 0,
      confidence: Math.min(99, Math.round(70 + Math.min(20, Math.sqrt(stats.totalScore) * 1.5) + (audioMatch ? 8 : 0))),
      reason: 'pk_battle',
      mood: 'pk',
      hasAudioPeak: !!audioMatch,
      pk: {
        battleId: w.battleId,
        opponents,
        durationSec: Math.round(w.durationSec * 10) / 10,
        explicitEnd: w.explicitEnd,
      },
      summary: {
        chats: stats.chats,
        gifts: stats.gifts,
        likes: stats.likes,
        diamonds: stats.diamonds,
        follows: stats.follows,
        shares: stats.shares,
        subscribes: stats.subscribes,
        uniqueUsers: stats.uniqueUsers,
        topGift: stats.topGift,
        topUser: stats.topUser,
        topKeywords: stats.topKeywords,
        sampleQuotes: stats.sampleQuotes,
      },
    });
  }
  return candidates;
}

function dedupeSpikesAgainstPks(spikeCandidates, pkCandidates) {
  if (pkCandidates.length === 0) return spikeCandidates;
  return spikeCandidates.filter((s) => {
    return !pkCandidates.some((p) => s.startSec >= p.startSec && s.endSec <= p.endSec);
  });
}

function findAudioOnlyCandidates(audioRmsBySec, existingCandidates, durationSec, preset = SENSITIVITY_PRESETS.balanced, precomputedStats = null) {
  const stats = precomputedStats || computeAudioStats(audioRmsBySec);
  if (!stats || stats.activeCount < 10) return [];

  const { med, mad } = stats;
  const thresholdDb = med + preset.audioDbDelta;

  const loudSecs = [];
  for (let s = 0; s < audioRmsBySec.length; s++) {
    const db = audioRmsBySec[s];
    if (!Number.isFinite(db) || db <= -26) continue;
    const z = (0.6745 * (db - med)) / mad;
    if (db >= thresholdDb && z >= preset.audioZ) {
      loudSecs.push({ sec: s, db, delta: db - med, z });
    }
  }
  if (loudSecs.length === 0) return [];

  const clusters = [];
  let cur = null;
  for (const item of loudSecs) {
    if (!cur || item.sec - cur.lastSec > 15) {
      cur = { firstSec: item.sec, lastSec: item.sec, items: [item] };
      clusters.push(cur);
    } else {
      cur.lastSec = item.sec;
      cur.items.push(item);
    }
  }

  const out = [];
  for (const cl of clusters) {
    const peak = cl.items.reduce((p, c) => (c.db > p.db ? c : p), cl.items[0]);
    let startSec = Math.max(0, cl.firstSec - 5);
    let rawEnd = Math.min(durationSec, cl.lastSec + 10);
    if (rawEnd - startSec > MAX_CLIP_SEC) {
      if (peak.sec > startSec + MAX_CLIP_SEC - 5) {
        startSec = Math.max(0, Math.min(peak.sec - Math.floor(MAX_CLIP_SEC * 0.65), rawEnd - MAX_CLIP_SEC));
      }
      rawEnd = Math.min(durationSec, startSec + MAX_CLIP_SEC);
    }
    let endSec = Math.min(durationSec, Math.max(startSec + MIN_CLIP_SEC, rawEnd));
    if (endSec - startSec < MIN_CLIP_SEC && durationSec >= MIN_CLIP_SEC) {
      startSec = Math.max(0, endSec - MIN_CLIP_SEC);
    }

    const overlapsExisting = existingCandidates.some((c) => {
      const ov = Math.min(endSec, c.endSec) - Math.max(startSec, c.startSec);
      return ov >= 5;
    });
    if (overlapsExisting) continue;

    const score = Math.round(peak.delta * 3 + cl.items.length * 2);
    const ratio = Math.round((peak.delta / Math.max(2, preset.audioDbDelta)) * 10) / 10;
    const confidence = Math.min(95, Math.round(45 + peak.delta * 3.5 + Math.min(18, peak.z * 3)));

    out.push({
      id: `a_${Math.floor(startSec)}`,
      startSec: Math.round(startSec * 10) / 10,
      endSec: Math.round(endSec * 10) / 10,
      peakSec: peak.sec,
      score,
      peakScore: Math.round(peak.delta * 10) / 10,
      baseline: Math.round(med * 10) / 10,
      ratio: Math.max(1.5, ratio),
      confidence,
      reason: 'audio_spike',
      mood: 'audio',
      hasAudioPeak: true,
      summary: {
        chats: 0, gifts: 0, likes: 0, diamonds: 0, follows: 0, shares: 0, subscribes: 0,
        uniqueUsers: 0,
        topGift: null,
        topUser: null,
        topKeywords: [`+${Math.round(peak.delta * 10) / 10}dB`],
        sampleQuotes: [],
      },
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

// ── Public: analyze a single recording ──

function analyzeRecording(recordingName, opts = {}) {
  const preset = getSensitivityPreset(opts.sensitivity);
  const audioRmsBySec = Array.isArray(opts.audioRmsBySec) ? opts.audioRmsBySec : null;

  const recPath = recordingPath(recordingName);
  const eventsFile = eventsJsonlPath(recordingName);
  const hasEventsFile = assertPathInsideRealDir(RECORDINGS_DIR, eventsFile) && fs.existsSync(eventsFile);
  if (!hasEventsFile && (!audioRmsBySec || audioRmsBySec.length < 5)) {
    return { ok: false, error: 'no events sidecar' };
  }

  let st;
  try {
    st = fs.statSync(recPath);
  } catch {
    return { ok: false, error: 'recording file missing' };
  }

  let metaDurSec = 0;
  try {
    const metaFile = recPath.replace(/\.mp4$/i, '.meta.json');
    if (assertPathInsideRealDir(RECORDINGS_DIR, metaFile) && fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (Number.isFinite(meta?.durationSec) && meta.durationSec > 0) metaDurSec = meta.durationSec;
    }
  } catch {}

  const events = hasEventsFile ? readEvents(eventsFile) : [];
  let firstEventTs = 0;
  for (let i = 0; i < events.length; i++) {
    if (typeof events[i]?.ts === 'number' && Number.isFinite(events[i].ts) && events[i].ts > 0) {
      firstEventTs = events[i].ts;
      break;
    }
  }

  let startMs = readRecordingStartMs(recordingName);
  if (!startMs) {
    if (metaDurSec > 0) {
      startMs = Math.round(st.mtimeMs - metaDurSec * 1000);
    } else if (firstEventTs > 0) {
      startMs = firstEventTs;
    } else {
      startMs = Math.round(st.mtimeMs);
    }
  }

  let mtimeDurSec = 0;
  const rawMtimeDur = (st.mtimeMs - startMs) / 1000;
  if (Number.isFinite(rawMtimeDur) && rawMtimeDur > 0) {
    mtimeDurSec = Math.min(MAX_ANALYSIS_DUR_SEC, rawMtimeDur);
  }

  let lastEventTs = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (typeof events[i]?.ts === 'number' && Number.isFinite(events[i].ts)) {
      lastEventTs = events[i].ts;
      break;
    }
  }
  const lastEventSec = lastEventTs > startMs ? Math.min(MAX_ANALYSIS_DUR_SEC, (lastEventTs - startMs) / 1000) : 0;
  const audioDurSec = audioRmsBySec?.length ? audioRmsBySec.length : 0;
  const baseDur = metaDurSec > 0
    ? metaDurSec
    : (audioDurSec > 0 ? audioDurSec : Math.max(60, mtimeDurSec));
  const durationSec = Math.min(MAX_ANALYSIS_DUR_SEC, Math.max(audioDurSec, baseDur, lastEventSec));

  const audioStats = computeAudioStats(audioRmsBySec);
  if (events.length < 5) {
    const audioCandidates = audioRmsBySec
      ? findAudioOnlyCandidates(audioRmsBySec, [], durationSec, preset, audioStats)
      : [];
    if (audioCandidates.length > 0) {
      const sortedAudio = [...audioCandidates].sort((a, b) => a.startSec - b.startSec);
      const stats = {
        totalEvents: events.length,
        durationSec: Math.round(durationSec),
        bucketCount: 0,
        spikeBuckets: 0,
        pkWindows: 0,
        audioPeaksCount: sortedAudio.length,
        audioAnalyzed: true,
        sensitivity: preset.name,
        usedFallback: false,
      };
      saveHighlights(recordingName, sortedAudio, stats);
      return { ok: true, candidates: sortedAudio, usedFallback: false, audioOnly: true, stats };
    }
    saveHighlights(recordingName, [], { totalEvents: events.length, durationSec, sensitivity: preset.name, audioAnalyzed: !!audioRmsBySec });
    return { ok: true, candidates: [], reason: 'too few events' };
  }

  const buckets = bucketize(events, startMs, durationSec);
  let spikes = findSpikeBuckets(buckets, preset);
  let usedFallback = false;
  if (spikes.length === 0) {
    spikes = topMomentBuckets(buckets);
    usedFallback = spikes.length > 0;
  }
  const spikeCandidates = mergeSpikes(spikes, buckets, { durationSec, startMs, preset, audioRmsBySec, audioStats });

  const pkCandidates = findPkWindows(events, startMs, audioRmsBySec, preset, audioStats, durationSec);
  const dedupedSpikes = dedupeSpikesAgainstPks(spikeCandidates, pkCandidates);
  const baseCandidates = [...pkCandidates, ...dedupedSpikes];
  const audioCandidates = audioRmsBySec
    ? findAudioOnlyCandidates(audioRmsBySec, baseCandidates, durationSec, preset, audioStats)
    : [];

  const rawCandidates = [...baseCandidates, ...audioCandidates]
    .sort((a, b) => a.startSec - b.startSec);
  const seenIds = new Set();
  const candidates = rawCandidates.map((c) => {
    let id = c.id;
    let n = 2;
    while (seenIds.has(id)) {
      id = `${c.id}_${n++}`;
    }
    seenIds.add(id);
    return id === c.id ? c : { ...c, id };
  });

  const stats = {
    totalEvents: events.length,
    durationSec: Math.round(durationSec),
    bucketCount: buckets.length,
    spikeBuckets: spikes.length,
    pkWindows: pkCandidates.length,
    audioPeaksCount: audioCandidates.length,
    audioAnalyzed: !!audioRmsBySec,
    sensitivity: preset.name,
    usedFallback,
  };
  saveHighlights(recordingName, candidates, stats);

  return { ok: true, candidates, usedFallback, stats };
}

function saveHighlights(recordingName, candidates, stats) {
  const out = {
    version: 2,
    analyzedAt: Date.now(),
    recordingName,
    candidates,
    stats: stats || null,
  };
  const file = highlightsJsonPath(recordingName);
  try {
    atomicWriteFileSync(file, JSON.stringify(out, null, 2));
  } catch (e) {
    console.warn('[highlights] save failed:', e.message);
  }
}

function readHighlights(recordingName) {
  const file = highlightsJsonPath(recordingName);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Clip cutting ──

function clipFilename(recordingName, startSec, endSec, opts = {}) {
  const base = resolveRec(recordingName).artifactStem;
  const dur = Math.max(1, Math.round(endSec - startSec));
  const startInt = Math.floor(startSec);
  const mm = String(Math.floor(startInt / 60)).padStart(3, '0');
  const ss = String(startInt % 60).padStart(2, '0');
  const vTag = opts.vertical === 'crop'
    ? '_916crop'
    : opts.vertical === 'blur'
      ? '_916blur'
      : opts.vertical === 'pk-split'
        ? '_916pk'
        : '';
  const sTag = opts.burnSubtitles ? '_sub' : '';
  return `${base}_clip_${mm}${ss}_${dur}s${vTag}${sTag}.mp4`;
}

function fmtSrtTime(sec) {
  const s = Math.max(0, sec);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.floor((s % 1) * 1000)).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

function sanitizeSrtText(raw, maxLen = 100) {
  return String(raw ?? '')
    .replace(/-->/g, ' ')
    .replace(/[\x00-\x1f\x7f<>]+/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\\[nNh]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function buildSrtForWindow(recordingName, startSec, dur) {
  const startMs = readRecordingStartMs(recordingName);
  const evFile = eventsJsonlPath(recordingName);
  if (!startMs || !assertPathInsideRealDir(RECORDINGS_DIR, evFile) || !fs.existsSync(evFile)) return null;

  let events = [];
  try { events = readEvents(evFile); } catch { return null; }

  const winStartMs = startMs + startSec * 1000;
  const winEndMs = winStartMs + dur * 1000;
  const captions = events.filter((ev) => ev.type === 'caption' && ev.text && ev.ts >= winStartMs && ev.ts <= winEndMs);
  const source = captions.length > 0
    ? captions.map((ev) => ({
        t: (ev.ts - winStartMs) / 1000,
        d: Math.min(4, Math.max(1.5, (ev.durationMs || 2500) / 1000)),
        text: sanitizeSrtText(ev.text, 100),
      }))
    : events
        .filter((ev) => ev.type === 'chat' && ev.comment && ev.ts >= winStartMs && ev.ts <= winEndMs)
        .slice(0, 40)
        .map((ev) => {
          const u = sanitizeSrtText(ev.user?.nickname || ev.user?.uniqueId || '', 40);
          const msg = sanitizeSrtText(ev.comment, 80);
          return { t: (ev.ts - winStartMs) / 1000, d: 2.5, text: u ? `${u}: ${msg}` : msg };
        });

  const filtered = source.filter((item) => item.text);
  if (filtered.length === 0) return null;
  const lines = [];
  for (let i = 0; i < filtered.length; i++) {
    const cur = filtered[i];
    const nextStart = i + 1 < filtered.length ? filtered[i + 1].t : dur;
    const endT = Math.min(dur, Math.max(cur.t + 0.8, Math.min(cur.t + cur.d, nextStart - 0.05)));
    if (endT <= cur.t) continue;
    lines.push(`${lines.length + 1}\n${fmtSrtTime(cur.t)} --> ${fmtSrtTime(endT)}\n${cur.text}\n`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function encodeArgsFor(encoder) {
  if (encoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-pix_fmt', 'yuv420p'];
  }
  if (encoder === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-pix_fmt', 'yuv420p'];
  }
  if (encoder === 'h264_amf') {
    return ['-c:v', 'h264_amf', '-quality', 'balanced', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p'];
}

const inflightCuts = new Map();
const inflightAnalyses = new Map();
const cutProcs = new Set();
const CUT_TIMEOUT_MS = 10 * 60_000;

function shutdownCutProcs() {
  for (const proc of cutProcs) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  cutProcs.clear();
}

// Cut a clip with stream-copy (fast) or optional 9:16 vertical export + burned subtitles.
function cutClip(recordingName, rawStartSec, rawEndSec, opts = {}) {
  const vertical = ['crop', 'blur', 'pk-split'].includes(opts.vertical) ? opts.vertical : 'none';
  const burnSubtitles = !!opts.burnSubtitles;

  let recPath;
  try {
    recPath = recordingPath(recordingName);
  } catch (err) {
    err.code = 'BAD_NAME';
    return Promise.reject(err);
  }
  if (!fs.existsSync(recPath)) {
    const e = new Error('recording not found');
    e.code = 'NOT_FOUND'; return Promise.reject(e);
  }
  const startSec = Number.isFinite(rawStartSec) ? Math.max(0, rawStartSec) : NaN;
  const endSec = Number.isFinite(rawEndSec) ? rawEndSec : NaN;
  if (!(endSec > startSec)) {
    const e = new Error('endSec must be > startSec');
    e.code = 'BAD_RANGE'; return Promise.reject(e);
  }
  const dur = Math.min(MAX_CUT_SEC, endSec - startSec);
  const srtContent = burnSubtitles ? buildSrtForWindow(recordingName, startSec, dur) : null;
  const effectiveBurnSubtitles = Boolean(burnSubtitles && srtContent);
  const outName = clipFilename(recordingName, startSec, startSec + dur, { vertical, burnSubtitles: effectiveBurnSubtitles });
  const outPath = path.join(CLIPS_DIR, outName);

  if (fs.existsSync(outPath)) {
    const st = fs.statSync(outPath);
    if (st.size > 0) {
      return Promise.resolve({ name: outName, sizeBytes: st.size, reused: true });
    }
    try { fs.unlinkSync(outPath); } catch {}
  }
  if (inflightCuts.has(outName)) {
    return inflightCuts.get(outName);
  }
  if (getDiskStatus().lowSpace) {
    const e = new Error('low disk space');
    e.code = 'DISK_FULL';
    return Promise.reject(e);
  }

  const p = (async () => {
    await acquireHeavyMediaSlot();
    try {
      return await new Promise((resolve, reject) => {
        const ffmpegBin = resolveFfmpeg();
        const needsEncode = vertical !== 'none' || effectiveBurnSubtitles;
        let srtBasename = null;
        let srtFullPath = null;

        if (effectiveBurnSubtitles && srtContent) {
          srtBasename = `${outName.replace(/\.mp4$/i, '')}_${process.pid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.srt`;
          srtFullPath = path.join(CLIPS_DIR, srtBasename);
          try { fs.writeFileSync(srtFullPath, srtContent, 'utf8'); } catch { srtBasename = null; srtFullPath = null; }
        }

        const tmpOutPath = path.join(CLIPS_DIR, `.tmp_${process.pid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${outName}`);
        const args = [
          '-hide_banner', '-loglevel', 'warning', '-y',
          '-progress', 'pipe:1',
          '-ss', String(startSec),
          '-i', recPath,
          '-t', String(dur),
        ];

        if (!needsEncode || (vertical === 'none' && !srtBasename)) {
          args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', tmpOutPath);
        } else {
          const subFilter = srtBasename
            ? `subtitles=${srtBasename}:force_style='FontSize=14,Outline=2,Shadow=1'`
            : null;
          if (vertical === 'crop') {
            const chain = ['scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', subFilter].filter(Boolean).join(',');
            args.push('-vf', chain);
          } else if (vertical === 'blur') {
            const bgFg = 'split[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[b];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[f];[b][f]overlay=(W-w)/2:(H-h)/2';
            const chain = subFilter ? `${bgFg},${subFilter}` : bgFg;
            args.push('-filter_complex', chain);
          } else if (vertical === 'pk-split') {
            const pkFilter = 'split[l][r];[l]crop=iw/2:ih:0:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[top];[r]crop=iw/2:ih:iw/2:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[bot];[top][bot]vstack=inputs=2';
            const chain = subFilter ? `${pkFilter},${subFilter}` : pkFilter;
            args.push('-filter_complex', chain);
          } else if (subFilter) {
            args.push('-vf', subFilter);
          }
          args.push(
            ...encodeArgsFor(getEncoder()),
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            tmpOutPath,
          );
        }

        const cleanupTmp = () => {
          if (srtFullPath) { try { fs.unlinkSync(srtFullPath); } catch {} }
        };

        let stderr = '';
        let lastPct = -1;
        const totalUs = Math.max(1, dur * 1_000_000);
        const emitPct = (pct) => {
          const clamped = Math.max(0, Math.min(100, pct));
          if (clamped !== lastPct) {
            lastPct = clamped;
            highlightsEvents.emit('cut_progress', { recording: recordingName, outName, percent: clamped, done: clamped >= 100 });
          }
        };
        emitPct(0);

        const proc = spawn(ffmpegBin, args, {
          cwd: CLIPS_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        cutProcs.add(proc);
        let settled = false;
        const killTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cutProcs.delete(proc);
          proc.once('close', () => {
            cleanupTmp();
            try { fs.unlinkSync(tmpOutPath); } catch {}
          });
          try { proc.kill('SIGKILL'); } catch {}
          cleanupTmp();
          try { fs.unlinkSync(tmpOutPath); } catch {}
          const msg = 'clip cut timed out';
          highlightsEvents.emit('cut_progress', { recording: recordingName, outName, percent: 0, done: true, error: msg });
          const e = new Error(msg);
          e.code = 'FFMPEG_TIMEOUT';
          reject(e);
        }, CUT_TIMEOUT_MS);
        killTimer.unref?.();

        proc.stdout.on('data', (b) => {
          const lines = b.toString().split(/[\r\n]+/);
          for (const line of lines) {
            const m = line.match(/^out_time_us=(\d+)/);
            if (m) {
              const pct = Math.floor((Number(m[1]) / totalUs) * 100);
              emitPct(Math.min(99, pct));
            } else if (line === 'progress=end') {
              emitPct(99);
            }
          }
        });
        proc.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-4096); });
        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          cutProcs.delete(proc);
          cleanupTmp();
          try { fs.unlinkSync(tmpOutPath); } catch {}
          highlightsEvents.emit('cut_progress', { recording: recordingName, outName, percent: 0, done: true, error: err.message });
          reject(err);
        });
        proc.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          cutProcs.delete(proc);
          cleanupTmp();
          let outSize = 0;
          try { outSize = fs.existsSync(tmpOutPath) ? fs.statSync(tmpOutPath).size : 0; } catch {}
          if (code === 0 && outSize > 0) {
            try {
              fs.renameSync(tmpOutPath, outPath);
              const st = fs.statSync(outPath);
              invalidateDirBytesCache();
              emitPct(100);
              resolve({ name: outName, sizeBytes: st.size, reused: false });
            } catch (err) {
              try { fs.unlinkSync(tmpOutPath); } catch {}
              highlightsEvents.emit('cut_progress', { recording: recordingName, outName, percent: 0, done: true, error: err.message });
              reject(err);
            }
          } else {
            try { fs.unlinkSync(tmpOutPath); } catch {}
            const msg = code === 0 ? 'clip output file was empty' : `ffmpeg exited ${code}: ${stderr.slice(-300)}`;
            highlightsEvents.emit('cut_progress', { recording: recordingName, outName, percent: 0, done: true, error: msg });
            const e = new Error(msg);
            e.code = 'FFMPEG_FAIL';
            reject(e);
          }
        });
      });
    } finally {
      releaseHeavyMediaSlot();
    }
  })().finally(() => {
    inflightCuts.delete(outName);
  });

  inflightCuts.set(outName, p);
  return p;
}

function listClipsFor(recordingName) {
  const base = resolveRec(recordingName).artifactStem;
  const prefix = `${base}_clip_`;
  let files;
  try { files = fs.readdirSync(CLIPS_DIR); } catch { return []; }
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.mp4'))
    .map((f) => {
      let st;
      try { st = fs.statSync(path.join(CLIPS_DIR, f)); } catch { return null; }
      // Parse start/duration from filename pattern: <base>_clip_<MMSS|MMMSS>_<dur>s[_variant].mp4
      const m = f.match(/_clip_(\d+)_(\d+)s(?:_[^.]+)?\.mp4$/);
      let startSec = null, durSec = null;
      if (m) {
        const mm = m[1];
        // Last 2 digits = seconds, rest = minutes
        const sec = Number(mm.slice(-2));
        const min = Number(mm.slice(0, -2) || '0');
        startSec = min * 60 + sec;
        durSec = Number(m[2]);
      }
      return { name: f, sizeBytes: st.size, mtime: st.mtimeMs, startSec, durSec };
    })
    .filter(Boolean)
    .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
}

function deleteClip(clipName) {
  const resolved = resolveInsideDir(CLIPS_DIR, clipName, '.mp4');
  if (!resolved) throw new Error('bad name');
  fs.unlinkSync(resolved.full);
  return true;
}

function analyzeAudioPeaks(recPath, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve) => {
    if (!recPath || !fs.existsSync(recPath)) {
      resolve(null);
      return;
    }
    const ffmpegBin = resolveFfmpeg();
    const args = [
      '-hide_banner', '-nostats', '-vn',
      '-i', recPath,
      '-af', 'asetpts=PTS-STARTPTS,aresample=16000,asetnsamples=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ];

    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }

    cutProcs.add(proc);
    let settled = false;
    let stdout = '';
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cutProcs.delete(proc);
      resolve(val);
    };

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    proc.stdout.on('data', (chunk) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => {
      if (code !== 0 || !stdout) {
        finish(null);
        return;
      }
      const rmsBySec = [];
      let curSec = -1;
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        const ptsMatch = line.match(/pts_time:(\d+(?:\.\d+)?)/);
        if (ptsMatch) {
          const rawSec = Math.floor(Number(ptsMatch[1]));
          curSec = Number.isFinite(rawSec) ? Math.min(MAX_ANALYSIS_DUR_SEC, Math.max(0, rawSec)) : -1;
          continue;
        }
        const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=([^\s]+)/);
        if (rmsMatch) {
          const val = rmsMatch[1] === '-inf' ? -90 : Number(rmsMatch[1]);
          const db = Number.isFinite(val) ? val : -90;
          const idx = curSec >= 0 ? curSec : rmsBySec.length;
          if (idx <= MAX_ANALYSIS_DUR_SEC) {
            while (rmsBySec.length < idx) rmsBySec.push(-90);
            rmsBySec[idx] = db;
          }
          curSec = -1;
        }
      }
      finish(rmsBySec.length > 0 ? rmsBySec : null);
    });
  });
}

async function analyzeRecordingAsync(recordingName, opts = {}) {
  const key = `${recordingName}:${opts?.sensitivity || 'balanced'}:${opts?.includeAudio !== false}`;
  if (inflightAnalyses.has(key)) {
    return inflightAnalyses.get(key);
  }
  const p = (async () => {
    const includeAudio = opts.includeAudio !== false;
    let audioRmsBySec = Array.isArray(opts.audioRmsBySec) ? opts.audioRmsBySec : null;
    if (includeAudio && !audioRmsBySec) {
      await acquireHeavyMediaSlot();
      try {
        const recPath = recordingPath(recordingName);
        audioRmsBySec = await analyzeAudioPeaks(recPath).catch(() => null);
      } catch {
        audioRmsBySec = null;
      } finally {
        releaseHeavyMediaSlot();
      }
    }
    return analyzeRecording(recordingName, { ...opts, audioRmsBySec });
  })().finally(() => {
    inflightAnalyses.delete(key);
  });
  inflightAnalyses.set(key, p);
  return p;
}

module.exports = {
  CLIPS_DIR,
  highlightsEvents,
  analyzeRecording,
  analyzeRecordingAsync,
  analyzeAudioPeaks,
  topMomentBuckets,
  mergeSpikes,
  classifyChatReaction,
  isBotOrCommand,
  sanitizeSrtText,
  buildSrtForWindow,
  readHighlights,
  saveHighlights,
  cutClip,
  listClipsFor,
  deleteClip,
  shutdownCutProcs,
};
