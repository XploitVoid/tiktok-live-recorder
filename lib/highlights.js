// lib/highlights.js — Detect chat/gift spikes in `.events.jsonl` sidecar files
// and cut them into standalone .mp4 clips via ffmpeg stream-copy.
//
// Detection is post-process only (runs after the recorder exits). It is cheap
// (≈ a few ms per recording) so it always runs unless DISABLE_AUTO_HIGHLIGHTS=1.
// Cutting clips, on the other hand, only happens on explicit user request.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveFfmpeg } = require('./ffmpeg');
const { parseStartTimeFromName, safeFilename } = require('./utils');

const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');
const CLIPS_DIR = path.join(RECORDINGS_DIR, 'highlights');

fs.mkdirSync(CLIPS_DIR, { recursive: true });

// ── Tunables ──
const BUCKET_SEC = 10;          // group events into 10-second buckets
const BASELINE_BUCKETS = 30;    // ≈5 min trailing window for baseline median
const SPIKE_RATIO = 2.0;        // bucket score must exceed baseline × this
const ABSOLUTE_FLOOR = 3;       // hard minimum score for any candidate (~3 chats or 1 small gift)
const MIN_BUCKET_EVENTS = 2;    // require ≥N events so a single fluke doesn't count
const MERGE_GAP_SEC = 20;       // merge spikes within 20s of each other
const PRE_PAD_SEC = 8;          // include this much *before* the spike
const POST_PAD_SEC = 15;        // include this much *after* the spike
const MIN_CLIP_SEC = 15;
const MAX_CLIP_SEC = 90;
const MAX_HIGHLIGHTS = 30;      // cap candidates per recording
const FALLBACK_TOP_N = 5;       // if primary detection finds nothing, take the
                                // top-N busiest buckets as "best moments"

// Score weights per event (kept conservative — can be tuned later).
const W_CHAT = 1;
const W_GIFT_BASE = 8;
const W_DIAMOND = 0.5;
const W_LIKE = 0.1;             // likeCount is per-batch (often 5-15)
const W_FOLLOW = 3;
const W_SHARE = 2;
const W_SUBSCRIBE = 20;        // paid subscriber — very high value
const W_ENVELOPE = 15;         // treasure box / red envelope — high engagement moment
const W_QUESTION = 2;          // Q&A question — mild signal
// member events excluded — too noisy and not really a "highlight" signal

// PK / link-mic battle padding: windows are derived directly from pkStart →
// pkEnd events, so we don't need much extra context around them. A small lead
// captures the "battle starting" overlay and a small tail catches the punish
// reaction shot.
const PK_PRE_PAD_SEC = 5;
const PK_POST_PAD_SEC = 8;
const PK_MIN_DUR_SEC = 30;        // very short matches probably aren't worth a clip
const PK_MAX_DUR_SEC = 240;       // keep PK clips bounded so they're shareable

// ── File helpers ──

function highlightsJsonPath(recordingName) {
  const base = recordingName.replace(/\.mp4$/i, '');
  return path.join(RECORDINGS_DIR, `${base}.highlights.json`);
}

function eventsJsonlPath(recordingName) {
  const base = recordingName.replace(/\.mp4$/i, '');
  return path.join(RECORDINGS_DIR, `${base}.events.jsonl`);
}

function recordingPath(recordingName) {
  return path.join(RECORDINGS_DIR, recordingName);
}

// Read .events.jsonl line-by-line. Returns events sorted by ts.
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
    case 'chat':      return W_CHAT;
    case 'gift':      return W_GIFT_BASE + (Number(ev.diamondCount) || 0) * W_DIAMOND;
    case 'like':      return (Number(ev.likeCount) || 1) * W_LIKE;
    case 'follow':    return W_FOLLOW;
    case 'social':    return W_FOLLOW;
    case 'share':     return W_SHARE;
    case 'subscribe': return W_SUBSCRIBE;
    case 'envelope':  return W_ENVELOPE;
    case 'question':  return W_QUESTION;
    default: return 0;
  }
}

// Build per-bucket aggregate from a sorted list of events.
// Returns array of { startSec, endSec, score, chats, gifts, likes, diamonds, follows, shares, eventsInBucket, eventCount }
function bucketize(events, startMs, durationSec) {
  const bucketCount = Math.max(1, Math.ceil(durationSec / BUCKET_SEC));
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      startSec: i * BUCKET_SEC,
      endSec: (i + 1) * BUCKET_SEC,
      score: 0,
      chats: 0, gifts: 0, likes: 0, diamonds: 0, follows: 0, shares: 0,
      eventCount: 0,
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
    const score = eventScore(ev);
    b.score += score;
    b.eventCount++;
    if (ev.type === 'chat') b.chats++;
    else if (ev.type === 'gift') {
      b.gifts++;
      b.diamonds += Number(ev.diamondCount) || 0;
    }
    else if (ev.type === 'like') b.likes += Number(ev.likeCount) || 1;
    else if (ev.type === 'follow' || ev.type === 'social') b.follows++;
    else if (ev.type === 'share') b.shares++;
    if (b.eventsInBucket.length < 100) b.eventsInBucket.push(ev);
  }
  return buckets;
}

// Walk buckets and return indices that are "spikes" relative to trailing baseline.
function findSpikeBuckets(buckets) {
  const spikes = [];
  // Compute global mean score so we can use it as a sanity floor when the
  // trailing window is very small/quiet (e.g. the first 5 minutes of a stream).
  const globalScores = buckets.map((b) => b.score).filter((s) => s > 0);
  const globalMean = globalScores.length
    ? globalScores.reduce((a, b) => a + b, 0) / globalScores.length
    : 0;

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.score < ABSOLUTE_FLOOR) continue;
    if (b.eventCount < MIN_BUCKET_EVENTS) continue;
    // Trailing window of previous buckets (excludes current)
    const start = Math.max(0, i - BASELINE_BUCKETS);
    const window = buckets.slice(start, i).map((x) => x.score);
    const baseline = median(window);
    // Effective baseline floor: max(actual baseline, half the global mean,
    // ABSOLUTE_FLOOR/SPIKE_RATIO). This prevents tiny baselines from
    // making everything a "spike" while still letting genuinely busy moments
    // pop out of quiet streams.
    const baselineEff = Math.max(
      baseline,
      globalMean * 0.5,
      ABSOLUTE_FLOOR / SPIKE_RATIO,
    );
    const ratio = b.score / baselineEff;
    if (ratio < SPIKE_RATIO) continue;
    spikes.push({ idx: i, score: b.score, baseline, ratio });
  }
  return spikes;
}

// Fallback: if normal spike detection finds nothing, just take the busiest
// buckets by absolute score so the user always has *something* to look at.
// Used for very quiet streams or short recordings. Looser eligibility
// than primary detection — only requires MIN_BUCKET_EVENTS, no score floor.
function topMomentBuckets(buckets) {
  const eligible = buckets
    .map((b, idx) => ({ idx, score: b.score, eventCount: b.eventCount }))
    .filter((x) => x.score > 0 && x.eventCount >= MIN_BUCKET_EVENTS);
  eligible.sort((a, b) => b.score - a.score);
  return eligible.slice(0, FALLBACK_TOP_N).map((x) => ({
    idx: x.idx,
    score: x.score,
    baseline: 0,
    ratio: 1,
  }));
}

// Merge consecutive/close spike buckets into highlight windows.
function mergeSpikes(spikeBuckets, buckets) {
  if (!spikeBuckets.length) return [];
  const groups = [];
  let cur = null;
  const gapBuckets = Math.ceil(MERGE_GAP_SEC / BUCKET_SEC);
  for (const s of spikeBuckets) {
    if (!cur || s.idx - cur.lastIdx > gapBuckets) {
      cur = { firstIdx: s.idx, lastIdx: s.idx, members: [s] };
      groups.push(cur);
    } else {
      cur.lastIdx = s.idx;
      cur.members.push(s);
    }
  }

  return groups.map((g) => {
    const startSec = Math.max(0, buckets[g.firstIdx].startSec - PRE_PAD_SEC);
    const endSecRaw = buckets[g.lastIdx].endSec + POST_PAD_SEC;
    let endSec = Math.min(endSecRaw, startSec + MAX_CLIP_SEC);
    if (endSec - startSec < MIN_CLIP_SEC) endSec = startSec + MIN_CLIP_SEC;

    // Aggregate stats across all buckets in this group
    let chats = 0, gifts = 0, likes = 0, diamonds = 0, follows = 0, shares = 0;
    let totalScore = 0;
    const giftCounts = new Map();
    const userScores = new Map();
    const userAvatars = new Map(); // uniqueId -> profilePictureUrl
    for (const m of g.members) {
      const b = buckets[m.idx];
      chats += b.chats; gifts += b.gifts; likes += b.likes;
      diamonds += b.diamonds; follows += b.follows; shares += b.shares;
      totalScore += b.score;
      for (const ev of b.eventsInBucket) {
        if (ev.type === 'gift' && ev.giftName) {
          giftCounts.set(ev.giftName, (giftCounts.get(ev.giftName) || 0) + (ev.repeatCount || 1));
        }
        const uname = ev.user?.uniqueId || ev.user?.nickname;
        if (uname) {
          userScores.set(uname, (userScores.get(uname) || 0) + eventScore(ev));
          if (ev.user?.profilePictureUrl && !userAvatars.has(uname)) {
            userAvatars.set(uname, ev.user.profilePictureUrl);
          }
        }
      }
    }

    const peak = g.members.reduce((p, c) => (c.score > p.score ? c : p), g.members[0]);
    const peakBaseline = peak.baseline;
    const peakRatio = peak.ratio;

    // Decide reason: gift spike if gift-derived score dominates, else chat/activity
    const giftScore = gifts * W_GIFT_BASE + diamonds * W_DIAMOND;
    const chatScore = chats * W_CHAT;
    let reason;
    if (giftScore > totalScore * 0.5) reason = 'gift_spike';
    else if (chatScore > totalScore * 0.5) reason = 'chat_spike';
    else reason = 'activity_spike';

    const topGift = [...giftCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topUser = [...userScores.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      id: `h_${Math.floor(startSec)}`,
      startSec: Math.round(startSec * 10) / 10,
      endSec: Math.round(endSec * 10) / 10,
      score: Math.round(totalScore * 10) / 10,
      peakScore: Math.round(peak.score * 10) / 10,
      baseline: Math.round(peakBaseline * 10) / 10,
      ratio: Math.round(peakRatio * 10) / 10,
      reason,
      summary: {
        chats, gifts, likes, diamonds, follows, shares,
        topGift: topGift ? { name: topGift[0], count: topGift[1] } : null,
        topUser: topUser ? {
          name: topUser[0],
          score: Math.round(topUser[1] * 10) / 10,
          avatar: userAvatars.get(topUser[0]) || null,
        } : null,
      },
    };
  })
  .sort((a, b) => b.score - a.score)  // sort highest score first
  .slice(0, MAX_HIGHLIGHTS)
  .sort((a, b) => a.startSec - b.startSec); // then back to chronological for display
}

// ── Public: analyze a single recording ──

// Walk events to find PK / link-mic battle windows. A window opens at pkStart
// and closes at the matching pkEnd (matched by battleId when present). If a
// pkStart never sees a matching pkEnd we close it at the next pkStart or at
// the end of the events list. Each window is then padded slightly and its
// summary stats are aggregated from chat/gift/like events that fall inside.
function findPkWindows(events, startMs) {
  const opens = []; // unmatched pkStart entries
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
      // Match by battleId when present, otherwise pop the most recent open.
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
  // Any still-open windows: close at the last event timestamp we have.
  if (opens.length > 0) {
    const lastTs = events[events.length - 1]?.ts || Date.now();
    for (const open of opens) closeWindow(open, lastTs, { explicitEnd: false });
  }

  // Aggregate per-window stats and turn them into highlight candidates.
  const candidates = [];
  for (const w of windows) {
    const startSecRaw = (w.startTs - startMs) / 1000;
    const endSecRaw = (w.endTs - startMs) / 1000;
    if (!Number.isFinite(startSecRaw) || !Number.isFinite(endSecRaw)) continue;

    const padStart = Math.max(0, startSecRaw - PK_PRE_PAD_SEC);
    let padEnd = endSecRaw + PK_POST_PAD_SEC;
    const dur = padEnd - padStart;
    if (dur < PK_MIN_DUR_SEC) continue; // skip trivially short PKs
    if (dur > PK_MAX_DUR_SEC) padEnd = padStart + PK_MAX_DUR_SEC;

    let chats = 0, gifts = 0, likes = 0, diamonds = 0, follows = 0, shares = 0;
    let totalScore = 0;
    const giftCounts = new Map();
    const userScores = new Map();
    const userAvatars = new Map();

    for (const ev of events) {
      if (!ev.ts || ev.ts < w.startTs || ev.ts > w.endTs) continue;
      const score = eventScore(ev);
      totalScore += score;
      if (ev.type === 'chat') chats++;
      else if (ev.type === 'gift') {
        gifts++;
        diamonds += Number(ev.diamondCount) || 0;
        if (ev.giftName) {
          giftCounts.set(ev.giftName, (giftCounts.get(ev.giftName) || 0) + (ev.repeatCount || 1));
        }
      }
      else if (ev.type === 'like') likes += Number(ev.likeCount) || 1;
      else if (ev.type === 'follow' || ev.type === 'social') follows++;
      else if (ev.type === 'share') shares++;
      const uname = ev.user?.uniqueId || ev.user?.nickname;
      if (uname) {
        userScores.set(uname, (userScores.get(uname) || 0) + score);
        if (ev.user?.profilePictureUrl && !userAvatars.has(uname)) {
          userAvatars.set(uname, ev.user.profilePictureUrl);
        }
      }
    }

    const topGift = [...giftCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topUser = [...userScores.entries()].sort((a, b) => b[1] - a[1])[0];
    const opponents = (w.battleUsers || [])
      .map((u) => u?.nickname || u?.uniqueId)
      .filter(Boolean);

    candidates.push({
      id: `pk_${Math.floor(padStart)}`,
      startSec: Math.round(padStart * 10) / 10,
      endSec: Math.round(padEnd * 10) / 10,
      score: Math.round(totalScore * 10) / 10,
      peakScore: Math.round(totalScore * 10) / 10,
      baseline: 0,
      ratio: 0,
      reason: 'pk_battle',
      pk: {
        battleId: w.battleId,
        opponents,
        durationSec: Math.round(w.durationSec * 10) / 10,
        explicitEnd: w.explicitEnd,
      },
      summary: {
        chats, gifts, likes, diamonds, follows, shares,
        topGift: topGift ? { name: topGift[0], count: topGift[1] } : null,
        topUser: topUser ? {
          name: topUser[0],
          score: Math.round(topUser[1] * 10) / 10,
          avatar: userAvatars.get(topUser[0]) || null,
        } : null,
      },
    });
  }
  return candidates;
}

// Drop spike candidates whose [start,end] falls entirely inside a PK window —
// the PK candidate is more descriptive and its summary already includes the
// inner spike. Spikes that only partially overlap are kept (they may be
// pre-/post-battle moments that deserve their own clip).
function dedupeSpikesAgainstPks(spikeCandidates, pkCandidates) {
  if (pkCandidates.length === 0) return spikeCandidates;
  return spikeCandidates.filter((s) => {
    return !pkCandidates.some((p) => s.startSec >= p.startSec && s.endSec <= p.endSec);
  });
}

// ── Public: analyze a single recording ──

function analyzeRecording(recordingName) {
  const recPath = recordingPath(recordingName);
  const eventsFile = eventsJsonlPath(recordingName);
  if (!fs.existsSync(eventsFile)) {
    return { ok: false, error: 'no events sidecar' };
  }
  const startMs = parseStartTimeFromName(recordingName);
  if (!startMs) return { ok: false, error: 'cannot parse start time from filename' };

  let durationSec = 0;
  try {
    const st = fs.statSync(recPath);
    // Approx duration from mtime - startMs (good enough for bucketing).
    // We don't need ffprobe here — bucket boundaries don't have to be exact.
    durationSec = Math.max(60, (st.mtimeMs - startMs) / 1000);
  } catch {
    return { ok: false, error: 'recording file missing' };
  }

  const events = readEvents(eventsFile);
  if (events.length < 5) {
    // Not enough data to find spikes meaningfully
    saveHighlights(recordingName, [], { totalEvents: events.length, durationSec });
    return { ok: true, candidates: [], reason: 'too few events' };
  }

  const buckets = bucketize(events, startMs, durationSec);
  let spikes = findSpikeBuckets(buckets);
  let usedFallback = false;
  if (spikes.length === 0) {
    // No spikes found — fall back to "top moments" so the user always has
    // something useful to review. Common for short or quiet streams.
    spikes = topMomentBuckets(buckets);
    usedFallback = spikes.length > 0;
  }
  const spikeCandidates = mergeSpikes(spikes, buckets);

  // PK battle windows are always emitted as candidates (when present), even
  // if their internal score isn't a "spike" — the battle itself is the
  // narrative anchor. They take priority over overlapping chat spikes.
  const pkCandidates = findPkWindows(events, startMs);
  const dedupedSpikes = dedupeSpikesAgainstPks(spikeCandidates, pkCandidates);

  // Combine and re-sort chronologically for display.
  const candidates = [...pkCandidates, ...dedupedSpikes]
    .sort((a, b) => a.startSec - b.startSec);

  saveHighlights(recordingName, candidates, {
    totalEvents: events.length,
    durationSec: Math.round(durationSec),
    bucketCount: buckets.length,
    spikeBuckets: spikes.length,
    pkWindows: pkCandidates.length,
    usedFallback,
  });

  return { ok: true, candidates, usedFallback };
}

function saveHighlights(recordingName, candidates, stats) {
  const out = {
    version: 1,
    analyzedAt: Date.now(),
    recordingName,
    candidates,
    stats: stats || null,
  };
  const file = highlightsJsonPath(recordingName);
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, file);
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

function clipFilename(recordingName, startSec, endSec) {
  const base = recordingName.replace(/\.mp4$/i, '');
  const dur = Math.max(1, Math.round(endSec - startSec));
  const startInt = Math.floor(startSec);
  const mm = String(Math.floor(startInt / 60)).padStart(3, '0');
  const ss = String(startInt % 60).padStart(2, '0');
  return `${base}_clip_${mm}${ss}_${dur}s.mp4`;
}

// Cut a clip with stream-copy (no re-encode = fast).
// `-ss` is placed BEFORE `-i` for fast seek; ffmpeg will start at the nearest
// keyframe, which can be up to ~2s before the requested time (acceptable).
function cutClip(recordingName, startSec, endSec) {
  return new Promise((resolve, reject) => {
    const recPath = recordingPath(recordingName);
    if (!fs.existsSync(recPath)) {
      const e = new Error('recording not found');
      e.code = 'NOT_FOUND'; return reject(e);
    }
    if (!(endSec > startSec)) {
      const e = new Error('endSec must be > startSec');
      e.code = 'BAD_RANGE'; return reject(e);
    }
    const dur = Math.min(MAX_CLIP_SEC, endSec - startSec);
    const outName = clipFilename(recordingName, startSec, startSec + dur);
    const outPath = path.join(CLIPS_DIR, outName);

    if (fs.existsSync(outPath)) {
      // Already exists — return as-is to avoid double work.
      const st = fs.statSync(outPath);
      return resolve({ name: outName, sizeBytes: st.size, reused: true });
    }

    const ffmpegBin = resolveFfmpeg();
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-ss', String(Math.max(0, startSec)),
      '-i', recPath,
      '-t', String(dur),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outPath,
    ];

    let stderr = '';
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        const st = fs.statSync(outPath);
        resolve({ name: outName, sizeBytes: st.size, reused: false });
      } else {
        try { fs.unlinkSync(outPath); } catch {}
        const e = new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`);
        e.code = 'FFMPEG_FAIL';
        reject(e);
      }
    });
  });
}

function listClipsFor(recordingName) {
  const base = recordingName.replace(/\.mp4$/i, '');
  const prefix = `${base}_clip_`;
  let files;
  try { files = fs.readdirSync(CLIPS_DIR); } catch { return []; }
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.mp4'))
    .map((f) => {
      const st = fs.statSync(path.join(CLIPS_DIR, f));
      // Parse start/duration from filename pattern: <base>_clip_<MMSS|MMMSS>_<dur>s.mp4
      const m = f.match(/_clip_(\d+)_(\d+)s\.mp4$/);
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
    .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
}

function deleteClip(clipName) {
  const safe = safeFilename(clipName);
  const full = path.join(CLIPS_DIR, safe);
  if (!full.startsWith(CLIPS_DIR)) throw new Error('bad name');
  fs.unlinkSync(full);
  return true;
}

module.exports = {
  CLIPS_DIR,
  analyzeRecording,
  readHighlights,
  saveHighlights,
  cutClip,
  listClipsFor,
  deleteClip,
};
