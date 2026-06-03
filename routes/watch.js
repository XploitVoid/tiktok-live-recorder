// routes/watch.js — /api/watch/* endpoints.

const { Router } = require('express');
const {
  normalizeUsername,
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  hasStreamUrls,
} = require('../lib/room');
const watcher = require('../lib/watcher');
const { safeError } = require('../lib/utils');

const router = Router();

// Whitelist of accepted quality strings (h264 keys + hevc:keys + auto/null).
// Keeps stored watchlist sane and prevents arbitrary user input from flowing
// into ffmpeg arguments via the recorder.
const QUALITY_RE = /^(?:hevc:)?(?:origin|uhd|hd|sd|ld|md|ao)$/;
function sanitizeQuality(q) {
  if (q == null || q === '' || q === 'auto') return null;
  if (typeof q !== 'string') return null;
  return QUALITY_RE.test(q) ? q : null;
}

router.get('/api/watch', (_req, res) => {
  res.json(watcher.getWatchlist());
});

router.post('/api/watch', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) return res.status(400).json({ error: 'missing username' });
  const result = watcher.addToWatchlist(username, {
    autoRecord: !!req.body?.autoRecord,
    quality: sanitizeQuality(req.body?.quality),
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

router.patch('/api/watch/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);
  const result = watcher.updateWatchEntry(username, {
    autoRecord: typeof req.body?.autoRecord === 'boolean' ? req.body.autoRecord : undefined,
    quality: req.body?.quality !== undefined ? sanitizeQuality(req.body.quality) : undefined,
  });
  if (!result) return res.status(404).json({ error: 'not in watchlist' });
  res.json(result);
});

router.delete('/api/watch/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (!watcher.removeFromWatchlist(username)) {
    return res.status(404).json({ error: 'not in watchlist' });
  }
  res.json({ ok: true });
});

router.post('/api/watch/poll-seconds', (req, res) => {
  const n = Number(req.body?.seconds);
  if (!Number.isFinite(n) || n < 10) return res.status(400).json({ error: 'min 10s' });
  const pollSeconds = watcher.setPollSeconds(n);
  res.json({ ok: true, pollSeconds });
});

router.get('/api/watch/events', (req, res) => {
  const sinceId = Number(req.query.sinceId) || 0;
  res.json(watcher.getEvents(sinceId));
});

router.post('/api/watch/poll-now', async (_req, res) => {
  try {
    await watcher.pollAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// Bulk: return stream URLs for all live users in the watchlist.
// Used by the grid view. Cached briefly in-memory so multiple grid clients
// (or rapid refreshes) reuse one fan-out instead of stampeding TikTok.
let liveStreamsCache = { ts: 0, data: null, inflight: null };
const LIVE_STREAMS_TTL_MS = 8000;
const LIVE_STREAMS_CONCURRENCY = 4;

router.get('/api/watch/live-streams', async (_req, res) => {
  const now = Date.now();
  if (liveStreamsCache.data && now - liveStreamsCache.ts < LIVE_STREAMS_TTL_MS) {
    return res.json(liveStreamsCache.data);
  }
  if (liveStreamsCache.inflight) {
    try {
      const data = await liveStreamsCache.inflight;
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: safeError(e) });
    }
  }

  liveStreamsCache.inflight = (async () => {
    const usernames = watcher.getWatchlistRaw().map((e) => e.username);
    const out = [];
    let i = 0;
    // Worker pool: process up to N usernames in parallel. Each call hits the
    // shared apiCache in lib/room.js so duplicate queries within the TTL
    // window collapse into one upstream request.
    async function worker() {
      while (i < usernames.length) {
        const username = usernames[i++];
        try {
          const apiData = await fetchApiLive(username);
          if (!isLiveFromApi(apiData)) continue;
          const streams = extractStreamUrls(apiData);
          if (!hasStreamUrls(streams)) continue;
          out.push({
            username,
            title: apiData?.liveRoom?.title || null,
            viewerCount: apiData?.liveRoom?.liveRoomStats?.userCount ?? null,
            coverUrl: apiData?.liveRoom?.coverUrl || null,
            nickname: apiData?.user?.nickname || null,
            streams: { hls: streams.hls, flv: streams.flv },
          });
        } catch {
          // ignore individual failures so one bad user doesn't kill the response
        }
      }
    }
    const workers = Array.from(
      { length: Math.min(LIVE_STREAMS_CONCURRENCY, usernames.length) },
      () => worker()
    );
    await Promise.all(workers);
    out.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
    return out;
  })();

  try {
    const data = await liveStreamsCache.inflight;
    liveStreamsCache = { ts: Date.now(), data, inflight: null };
    res.json(data);
  } catch (e) {
    liveStreamsCache.inflight = null;
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
