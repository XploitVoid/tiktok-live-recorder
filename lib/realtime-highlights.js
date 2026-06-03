// lib/realtime-highlights.js — Lightweight realtime spike detector.
// Runs during recording to mark timestamps of big moments. After the recorder
// exits, these marks are used to auto-cut clips without waiting for user input.
//
// This is NOT a replacement for the post-process analyzer in highlights.js —
// it's a complementary "hot" detector that catches obvious spikes in real-time.

const { cutClip } = require('./highlights');

// ── Tunables ──
const WINDOW_SEC = 15;          // sliding window for score accumulation
const BIG_GIFT_THRESHOLD = 100; // single gift ≥ this many diamonds = instant mark
const SPIKE_THRESHOLD = 50;     // accumulated score in window to trigger
const COOLDOWN_SEC = 30;        // don't trigger again within this period
const AUTO_CUT_PAD_PRE = 8;    // seconds before the spike to include
const AUTO_CUT_PAD_POST = 15;  // seconds after the spike to include
const MAX_AUTO_CLIPS = 10;     // cap auto-clips per recording

// Score weights (same as highlights.js)
const W_CHAT = 1;
const W_GIFT = 8;
const W_DIAMOND = 0.5;
const W_LIKE = 0.1;
const W_SUBSCRIBE = 20;

function eventScore(ev) {
  switch (ev.type) {
    case 'chat':      return W_CHAT;
    case 'gift':      return W_GIFT + (Number(ev.diamondCount) || 0) * W_DIAMOND;
    case 'like':      return (Number(ev.likeCount) || 1) * W_LIKE;
    case 'subscribe': return W_SUBSCRIBE;
    default:          return 0;
  }
}

class RealtimeHighlightDetector {
  constructor(username) {
    this.username = username;
    this.events = [];       // recent events within the sliding window
    this.marks = [];        // { ts, reason, score }
    this.lastTriggerTs = 0;
    this.startedAt = Date.now();
  }

  // Called for every event pushed to the chat session.
  onEvent(ev) {
    if (!ev || !ev.ts) return;
    const score = eventScore(ev);
    if (score <= 0) return;

    this.events.push({ ts: ev.ts, score, type: ev.type, diamondCount: ev.diamondCount });

    // Prune events outside the sliding window
    const cutoff = ev.ts - WINDOW_SEC * 1000;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }

    // Check for instant big-gift trigger
    if (ev.type === 'gift' && (Number(ev.diamondCount) || 0) >= BIG_GIFT_THRESHOLD) {
      this._trigger(ev.ts, 'big_gift', Number(ev.diamondCount));
      return;
    }

    // Check for PK start (always mark)
    if (ev.type === 'pkStart') {
      this._trigger(ev.ts, 'pk_start', 0);
      return;
    }

    // Check accumulated window score
    const windowScore = this.events.reduce((sum, e) => sum + e.score, 0);
    if (windowScore >= SPIKE_THRESHOLD) {
      this._trigger(ev.ts, 'spike', windowScore);
    }
  }

  _trigger(ts, reason, score) {
    // Cooldown check
    if (ts - this.lastTriggerTs < COOLDOWN_SEC * 1000) return;
    this.lastTriggerTs = ts;
    this.marks.push({ ts, reason, score });
    console.log(`[realtime-hl] @${this.username} spike detected: ${reason} score=${score} at +${Math.round((ts - this.startedAt) / 1000)}s`);
  }

  // Called after recording ends. Returns array of { startSec, endSec, reason }.
  getClipWindows(recordingStartMs) {
    return this.marks.slice(0, MAX_AUTO_CLIPS).map((m) => {
      const centerSec = (m.ts - recordingStartMs) / 1000;
      return {
        startSec: Math.max(0, centerSec - AUTO_CUT_PAD_PRE),
        endSec: centerSec + AUTO_CUT_PAD_POST,
        reason: m.reason,
        score: m.score,
      };
    });
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
