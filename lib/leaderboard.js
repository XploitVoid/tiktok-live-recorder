// lib/leaderboard.js — Aggregate per-recording user contributions from the
// `.events.jsonl` sidecar produced by lib/chat.js. Used by the Replay page to
// show top supporters (gifters / chatters / likers / followers).
//
// This is a pure read-only computation — no caching, no writes. The sidecar
// is small enough (a few MB max for a long stream) that re-aggregating on
// demand is < 50ms even for the largest recordings.

const fs = require('fs');
const path = require('path');
const { parseStartTimeFromName } = require('./utils');

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');

const TOP_LIMIT = 10;          // how many entries to keep per category
const TOP_LIMIT_OVERALL = 15;  // overall (combined-score) leaderboard

// Same scoring weights as highlights.js so "score" stays consistent across the
// app. Kept locally to avoid pulling all of highlights.js for two constants.
const W_CHAT   = 1;
const W_GIFT   = 8;
const W_DIAMD  = 0.5;
const W_LIKE   = 0.1;
const W_FOLLOW = 3;
const W_SHARE  = 2;

function eventScore(ev) {
  switch (ev.type) {
    case 'chat':   return W_CHAT;
    case 'gift':   return W_GIFT + (Number(ev.diamondCount) || 0) * W_DIAMD;
    case 'like':   return (Number(ev.likeCount) || 1) * W_LIKE;
    case 'follow': return W_FOLLOW;
    case 'social': return W_FOLLOW;
    case 'share':  return W_SHARE;
    default:       return 0;
  }
}

function eventsJsonlPath(recordingName) {
  const base = recordingName.replace(/\.mp4$/i, '');
  return path.join(RECORDINGS_DIR, `${base}.events.jsonl`);
}

// Read .events.jsonl line-by-line. Returns events sorted by ts.
// Mirrors lib/highlights.js#readEvents but kept independent so the two
// modules don't take a hard dependency on each other.
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

// Build a per-user aggregate record. Keyed by uniqueId when available so the
// same user across nickname changes still merges cleanly. Falls back to
// nickname for events that don't include uniqueId (rare, but defensive).
function aggregate(events) {
  const users = new Map();

  for (const ev of events) {
    const u = ev.user || {};
    const key = u.uniqueId || u.nickname;
    if (!key) continue;

    let entry = users.get(key);
    if (!entry) {
      entry = {
        uniqueId: u.uniqueId || null,
        nickname: u.nickname || u.uniqueId || '?',
        avatar: u.profilePictureUrl || null,
        chats: 0,
        gifts: 0,
        diamonds: 0,
        likes: 0,
        follows: 0,
        shares: 0,
        score: 0,
        firstSeen: ev.ts || 0,
        lastSeen: ev.ts || 0,
        topGiftName: null,
        _giftCounts: new Map(),
      };
      users.set(key, entry);
    }
    // Refresh metadata if a later event has fresher info
    if (u.profilePictureUrl) entry.avatar = u.profilePictureUrl;
    if (u.nickname) entry.nickname = u.nickname;
    if (u.uniqueId && !entry.uniqueId) entry.uniqueId = u.uniqueId;
    if (ev.ts) entry.lastSeen = Math.max(entry.lastSeen, ev.ts);

    switch (ev.type) {
      case 'chat':
        entry.chats++;
        break;
      case 'gift': {
        entry.gifts += 1;
        const diamonds = (Number(ev.diamondCount) || 0) * (Number(ev.repeatCount) || 1);
        entry.diamonds += diamonds;
        if (ev.giftName) {
          const next = (entry._giftCounts.get(ev.giftName) || 0) + (Number(ev.repeatCount) || 1);
          entry._giftCounts.set(ev.giftName, next);
        }
        break;
      }
      case 'like':
        entry.likes += Number(ev.likeCount) || 1;
        break;
      case 'follow':
      case 'social':
        entry.follows++;
        break;
      case 'share':
        entry.shares++;
        break;
      default:
        continue; // skip control events for scoring
    }
    entry.score += eventScore(ev);
  }

  // Resolve top gift per user, drop the inner Map
  for (const e of users.values()) {
    if (e._giftCounts.size > 0) {
      let top = null;
      for (const [name, cnt] of e._giftCounts) {
        if (!top || cnt > top.count) top = { name, count: cnt };
      }
      e.topGiftName = top;
    }
    delete e._giftCounts;
    e.score = Math.round(e.score * 10) / 10;
  }

  return [...users.values()];
}

function topBy(entries, sortKey, limit = TOP_LIMIT) {
  return entries
    .filter((e) => (e[sortKey] || 0) > 0)
    .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0))
    .slice(0, limit)
    .map((e) => stripped(e));
}

// Drop fields a client doesn't need (firstSeen/lastSeen are useful internally
// only; nothing in the UI binds to them yet).
function stripped(e) {
  return {
    uniqueId: e.uniqueId,
    nickname: e.nickname,
    avatar: e.avatar,
    chats: e.chats,
    gifts: e.gifts,
    diamonds: e.diamonds,
    likes: e.likes,
    follows: e.follows,
    shares: e.shares,
    score: e.score,
    topGiftName: e.topGiftName,
  };
}

// Public: compute leaderboard for a single recording.
function buildLeaderboard(recordingName) {
  const eventsFile = eventsJsonlPath(recordingName);
  if (!fs.existsSync(eventsFile)) {
    return { ok: false, error: 'no events sidecar' };
  }
  const startMs = parseStartTimeFromName(recordingName);
  const events = readEvents(eventsFile);

  const entries = aggregate(events);

  // Stream-wide totals (cheap to compute alongside per-user stats).
  let totals = {
    diamonds: 0,
    chats: 0,
    gifts: 0,
    likes: 0,
    follows: 0,
    shares: 0,
    uniqueUsers: entries.length,
    eventCount: events.length,
  };
  const giftBreakdown = new Map();
  for (const e of entries) {
    totals.diamonds += e.diamonds;
    totals.chats += e.chats;
    totals.gifts += e.gifts;
    totals.likes += e.likes;
    totals.follows += e.follows;
    totals.shares += e.shares;
  }
  // Per-gift breakdown (top 8 gifts by count) — useful summary for the panel.
  for (const ev of events) {
    if (ev.type === 'gift' && ev.giftName) {
      const cnt = (Number(ev.repeatCount) || 1);
      const dmd = (Number(ev.diamondCount) || 0) * cnt;
      const cur = giftBreakdown.get(ev.giftName) || { name: ev.giftName, count: 0, diamonds: 0 };
      cur.count += cnt;
      cur.diamonds += dmd;
      giftBreakdown.set(ev.giftName, cur);
    }
  }
  const giftSummary = [...giftBreakdown.values()]
    .sort((a, b) => b.diamonds - a.diamonds || b.count - a.count)
    .slice(0, 8);

  return {
    ok: true,
    recording: recordingName,
    startMs,
    totals,
    giftSummary,
    overall: topBy(entries, 'score', TOP_LIMIT_OVERALL),
    topGifters: topBy(entries, 'diamonds'),
    topChatters: topBy(entries, 'chats'),
    topLikers: topBy(entries, 'likes'),
    topFollowers: topBy(entries, 'follows'),
  };
}

module.exports = {
  buildLeaderboard,
};
