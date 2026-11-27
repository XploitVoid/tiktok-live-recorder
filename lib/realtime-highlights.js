// lib/realtime-highlights.js — Lightweight realtime spike detector.
// Runs during recording to mark timestamps of big moments. After the recorder
// exits, these marks are used to auto-cut clips without waiting for user input.
//
// This is NOT a replacement for the post-process analyzer in highlights.js —
// it's a complementary "hot" detector that catches obvious spikes in real-time.

const { cutClip, classifyChatReaction, isBotOrCommand } = require('./highlights');

// ── Tunables ──
const WINDOW_SEC = 15;          // sliding window for score accumulation
const BIG_GIFT_THRESHOLD = 100; // single gift ≥ this many diamonds = instant mark
const SPIKE_THRESHOLD = 50;     // base accumulated score in window to trigger
const SUB_BOMB_THRESHOLD = 3;   // ≥ N subscribe/superFan events in window = sub_bomb
const CALLOUT_THRESHOLD = 3;    // ≥ N unique users asking for a clip in window = clip_callout
const COOLDOWN_SEC = 30;        // don't trigger again within this period
const AUTO_CUT_PAD_PRE = 8;     // seconds before the spike to include
const AUTO_CUT_PAD_POST = 15;   // seconds after the spike to include
const MAX_AUTO_CLIPS = 10;      // cap auto-clips per recording

// Score weights (aligned with highlights.js)
const W_CHAT = 1;
const W_GIFT = 8;
const W_DIAMOND = 0.5;
const W_LIKE = 0.1;
const W_SUBSCRIBE = 20;

function nonNegNum(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function eventScore(ev) {
  switch (ev.type) {
    case 'chat':        return W_CHAT;
    case 'gift':        return W_GIFT + nonNegNum(ev.diamondCount, 0) * Math.max(1, nonNegNum(ev.repeatCount, 1)) * W_DIAMOND;
    case 'like':        return Math.max(1, nonNegNum(ev.likeCount, 1)) * W_LIKE;
    case 'subscribe':
    case 'superFan':    return W_SUBSCRIBE;
    case 'envelope':
    case 'superFanBox': return 15;
    default:            return 0;
  }
}

class RealtimeHighlightDetector {
  constructor(username) {
    this.username = username;
    this.events = [];       // recent events within the sliding window
    this.marks = [];        // { ts, reason, score }
    this.lastTriggerTs = 0;
    this.startedAt = Date.now();
    this.baselineEma = 0;
    this._lastEmaTs = 0;
  }

  // Called for every event pushed to the chat session.
  onEvent(ev) {
    if (!ev || !ev.ts) return;

    // Check for PK start first (has 0 activity score, so must precede score <= 0 guard)
    if (ev.type === 'pkStart') {
      this._trigger(ev.ts, 'pk_start', BIG_GIFT_THRESHOLD);
      return;
    }

    if (ev.type === 'chat' && isBotOrCommand(ev)) return;

    const baseScore = eventScore(ev);
    if (baseScore <= 0) return;

    // Prune events outside the sliding window (also reject out-of-order stale timestamps)
    const cutoff = ev.ts - WINDOW_SEC * 1000;
    if (this.events.length > 0 && ev.ts < this.events[this.events.length - 1].ts - WINDOW_SEC * 1000) {
      return;
    }
    this.events = this.events.filter((e) => e.ts >= cutoff);

    const uname = ev.user?.uniqueId || ev.user?.nickname || null;
    let effScore = baseScore;
    let isCallout = false;
    if (ev.type === 'chat') {
      const prevByUser = uname ? this.events.filter((e) => e.userKey === uname && e.type === 'chat').length : 0;
      const mult = prevByUser === 0 ? 1 : prevByUser === 1 ? 0.65 : prevByUser === 2 ? 0.35 : 0.15;
      const reaction = classifyChatReaction(ev.comment);
      isCallout = reaction.clipCallout;
      effScore = (baseScore + (reaction.mood ? 0.6 : 0) + (isCallout ? 3 : 0)) * mult;
    }

    this.events.push({
      ts: ev.ts,
      score: effScore,
      type: ev.type,
      diamondCount: ev.diamondCount,
      userKey: uname,
      isCallout,
    });

    // Update rolling baseline EMA every WINDOW_SEC without letting the current spike contaminate it
    const windowScore = this.events.reduce((sum, e) => sum + e.score, 0);
    if (ev.ts - this._lastEmaTs >= WINDOW_SEC * 1000) {
      this._lastEmaTs = ev.ts;
      const sample = Math.min(windowScore, Math.max(SPIKE_THRESHOLD * 1.5, this.baselineEma * 2 || SPIKE_THRESHOLD));
      this.baselineEma = this.baselineEma === 0 ? sample * 0.5 : this.baselineEma * 0.8 + sample * 0.2;
    }

    // 1. Instant big-gift trigger (diamondCount * repeatCount)
    if (ev.type === 'gift') {
      const totalDiamonds = nonNegNum(ev.diamondCount, 0) * Math.max(1, nonNegNum(ev.repeatCount, 1));
      if (totalDiamonds >= BIG_GIFT_THRESHOLD) {
        this._trigger(ev.ts, 'big_gift', totalDiamonds);
        return;
      }
    }

    // 2. Instant Sub Bomb trigger (≥ 3 subscribe/superFan in 15s window)
    const subCount = this.events.filter((e) => e.type === 'subscribe' || e.type === 'superFan').length;
    if (subCount >= SUB_BOMB_THRESHOLD) {
      this._trigger(ev.ts, 'sub_bomb', subCount * W_SUBSCRIBE);
      return;
    }

    // 3. Instant Clip Callout trigger (≥ 3 unique users saying "clip it / ตัดคลิป")
    if (isCallout) {
      const calloutUsers = new Set(this.events.filter((e) => e.isCallout && e.userKey).map((e) => e.userKey));
      if (calloutUsers.size >= CALLOUT_THRESHOLD) {
        this._trigger(ev.ts, 'clip_callout', calloutUsers.size * 15);
        return;
      }
    }

    // 4. Adaptive window score threshold (scales up slightly in busy streams)
    const adaptiveThreshold = Math.max(SPIKE_THRESHOLD, this.baselineEma * 2.5);
    if (windowScore >= adaptiveThreshold) {
      this._trigger(ev.ts, 'spike', Math.round(windowScore * 10) / 10);
    }
  }

  _trigger(ts, reason, score) {
    // Cooldown check
    if (ts - this.lastTriggerTs < COOLDOWN_SEC * 1000) return;
    this.lastTriggerTs = ts;
    this.marks.push({ ts, reason, score });
    console.log(`[realtime-hl] @${this.username} spike detected: ${reason} score=${score} at +${Math.round((ts - this.startedAt) / 1000)}s`);
  }

  // Called after recording ends. Merges close marks, picks top MAX_AUTO_CLIPS by score,
  // and returns chronologically sorted { startSec, endSec, reason, score } windows.
  getClipWindows(recordingStartMs) {
    if (this.marks.length === 0) return [];
    const raw = this.marks
      .map((m) => {
        const centerSec = (m.ts - recordingStartMs) / 1000;
        const startSec = Math.max(0, centerSec - AUTO_CUT_PAD_PRE);
        const endSec = centerSec + AUTO_CUT_PAD_POST;
        if (!(endSec > startSec)) return null;
        return {
          startSec,
          endSec,
          reason: m.reason,
          score: m.score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startSec - b.startSec);

    const merged = [];
    for (const w of raw) {
      const prev = merged[merged.length - 1];
      if (prev && w.startSec - prev.endSec <= 10 && Math.max(prev.endSec, w.endSec) - prev.startSec <= 90) {
        prev.endSec = Math.max(prev.endSec, w.endSec);
        if (w.score > prev.score) prev.reason = w.reason;
        prev.score = Math.max(prev.score, w.score);
      } else {
        merged.push({ ...w });
      }
    }

    return merged
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_AUTO_CLIPS)
      .sort((a, b) => a.startSec - b.startSec);
  }

  // Auto-cut all marked clips. Returns a promise that resolves with results.
  async autoCut(recordingName, recordingStartMs) {
    const windows = this.getClipWindows(recordingStartMs);
    if (windows.length === 0) return [];
    const results = [];
    for (const w of windows) {
      try {
        const clip = await cutClip(recordingName, w.startSec, w.endSec);
        results.push({ ...w, clip, ok: true });
        console.log(`[realtime-hl] auto-cut: ${clip.name} (${w.reason})`);
      } catch (e) {
        results.push({ ...w, ok: false, error: e?.message || String(e) });
      }
    }
    return results;
  }
}

// Registry: username -> detector (active during recording)
const detectors = new Map();

function getOrCreate(username) {
  let d = detectors.get(username);
  if (!d) {
    d = new RealtimeHighlightDetector(username);
    detectors.set(username, d);
  }
  return d;
}

function get(username) {
  return detectors.get(username) || null;
}

function remove(username) {
  detectors.delete(username);
}

module.exports = {
  RealtimeHighlightDetector,
  getOrCreate,
  get,
  remove,
};
