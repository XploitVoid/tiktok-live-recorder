// routes/watch.js — /api/watch/* endpoints.

const { Router } = require('express');
const {
  getProvider,
  normalizePlatform,
  parseChannelInput,
} = require('../lib/providers');
const watcher = require('../lib/watcher');
const accounts = require('../lib/accounts');
const { safeError, sanitizeQuality, sanitizeAudioBitrate } = require('../lib/utils');

function validateWatchAccountId(raw, platform) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '' || raw === 'default') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid accountId' };
  const id = raw.trim();
  if (id === 'anon') return { ok: true, value: 'anon' };
  if (!/^[A-Za-z0-9]{1,32}$/.test(id)) return { ok: false, error: 'invalid accountId' };
  const exists = accounts.getAll().some(
    (a) => a.id === id && accounts.normalizeAccountPlatform(a.platform) === platform,
  );
  if (!exists) return { ok: false, error: 'invalid accountId' };
  return { ok: true, value: id };
}

const router = Router();

router.get('/api/watch', (_req, res) => {
  res.json(watcher.getWatchlist());
});

router.post('/api/watch', (req, res) => {
  const { platform, username } = parseChannelInput(req.body?.username, req.body?.platform);
  if (!username) return res.status(400).json({ error: 'missing username' });
  const acctCheck = validateWatchAccountId(req.body?.accountId, platform);
  if (!acctCheck.ok) return res.status(400).json({ error: acctCheck.error });
  const result = watcher.addToWatchlist(username, {
    platform,
    autoRecord: !!req.body?.autoRecord,
    quality: sanitizeQuality(req.body?.quality),
    audioOnly: !!req.body?.audioOnly,
    audioBitrate: sanitizeAudioBitrate(req.body?.audioBitrate, null),
    recordChat: req.body?.recordChat !== false,
    priority: req.body?.priority,
    accountId: acctCheck.value,
    minViewers: req.body?.minViewers,
    scheduleStart: req.body?.scheduleStart,
    scheduleEnd: req.body?.scheduleEnd,
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

router.patch('/api/watch/:username', (req, res) => {
  const platform = normalizePlatform(req.query.platform || req.body?.platform, 'tiktok');
  const username = getProvider(platform).normalizeUsername(req.params.username);
  const acctCheck = validateWatchAccountId(req.body?.accountId, platform);
  if (!acctCheck.ok) return res.status(400).json({ error: acctCheck.error });
  const result = watcher.updateWatchEntry(username, {
    platform,
    autoRecord: typeof req.body?.autoRecord === 'boolean' ? req.body.autoRecord : undefined,
    quality: req.body?.quality !== undefined ? sanitizeQuality(req.body.quality) : undefined,
    audioOnly: typeof req.body?.audioOnly === 'boolean' ? req.body.audioOnly : undefined,
    audioBitrate: req.body?.audioBitrate !== undefined ? sanitizeAudioBitrate(req.body.audioBitrate, null) : undefined,
    recordChat: typeof req.body?.recordChat === 'boolean' ? req.body.recordChat : undefined,
    priority: req.body?.priority,
    accountId: acctCheck.value,
    minViewers: req.body?.minViewers,
    scheduleStart: req.body?.scheduleStart,
    scheduleEnd: req.body?.scheduleEnd,
  });
  if (!result) return res.status(404).json({ error: 'not in watchlist' });
  res.json(result);
});

router.delete('/api/watch/:username', (req, res) => {
  const platform = normalizePlatform(req.query.platform || req.body?.platform, 'tiktok');
  const username = getProvider(platform).normalizeUsername(req.params.username);
  if (!watcher.removeFromWatchlist(username, platform)) {
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
let liveStreamsEpoch = 0;
const LIVE_STREAMS_TTL_MS = 8000;
const LIVE_STREAMS_CONCURRENCY = 4;

function invalidateLiveStreamsCache() {
  liveStreamsEpoch++;
  liveStreamsCache = { ts: 0, data: null, inflight: null };
}
watcher.watchEventsEmitter.on('list', invalidateLiveStreamsCache);

function extractAvatarThumb(user) {
  if (!user) return undefined;
  if (typeof user.profilePictureUrl === 'string' && user.profilePictureUrl) return user.profilePictureUrl;
  const list = user.avatarThumb?.urlList || user.avatarMedium?.urlList || user.avatarLarge?.urlList;
  if (Array.isArray(list) && list.length > 0) {
    return list.find((u) => typeof u === 'string' && u.startsWith('https:')) || list[0];
  }
  return undefined;
}

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

  const epoch = liveStreamsEpoch;
  const p = (async () => {
    const entries = watcher.getWatchlistRaw().map((e) => ({
      platform: normalizePlatform(e.platform, 'tiktok'),
      username: e.username,
      accountId: e.accountId || undefined,
    }));
    const out = [];
    let i = 0;
    // Worker pool: process up to N entries in parallel. Each call hits the
    // shared apiCache so duplicate queries within the TTL window collapse.
    async function worker() {
      while (i < entries.length) {
        const { platform, username, accountId } = entries[i++];
        try {
          const provider = getProvider(platform);
          const apiData = await provider.fetchLiveStatus(username, { accountId });
          if (!provider.isLive(apiData)) continue;
          const streams = provider.extractStreamUrls(apiData);
          if (!provider.hasStreamUrls(streams)) continue;
          const summary = provider.buildSummary(username, apiData, streams);
          out.push({
            platform,
            username,
            live: true,
            title: summary.title || null,
            viewerCount: summary.viewerCount ?? null,
            coverUrl: summary.coverUrl || null,
            owner: summary.owner ? {
              nickname: summary.owner.nickname || undefined,
              uniqueId: summary.owner.uniqueId || undefined,
              avatarThumb: summary.owner.avatarThumb || extractAvatarThumb(apiData?.user),
            } : undefined,
            streams: { hls: streams.hls, hlsByQuality: streams.hlsByQuality, flv: streams.flv, cmaf: streams.cmaf },
          });
        } catch {
          // ignore individual failures so one bad user doesn't kill the response
        }
      }
    }
    const workers = Array.from(
      { length: Math.min(LIVE_STREAMS_CONCURRENCY, entries.length) },
      () => worker()
    );
    await Promise.all(workers);
    out.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
    return out;
  })();
  liveStreamsCache.inflight = p;

  try {
    const data = await p;
    if (epoch === liveStreamsEpoch) {
      liveStreamsCache = { ts: Date.now(), data, inflight: null };
    } else if (liveStreamsCache.inflight === p) {
      liveStreamsCache.inflight = null;
    }
    res.json(data);
  } catch (e) {
    if (liveStreamsCache.inflight === p) {
      liveStreamsCache.inflight = null;
    }
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
module.exports.invalidateLiveStreamsCache = invalidateLiveStreamsCache;
