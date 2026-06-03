// routes/check.js — /api/check and /api/stream endpoints.

const { Router } = require('express');
const {
  normalizeUsername,
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  hasStreamUrls,
  buildSummary,
} = require('../lib/room');
const { safeError } = require('../lib/utils');

const router = Router();

router.get('/api/check', async (req, res) => {
  const username = normalizeUsername(req.query.u);
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const apiData = await fetchApiLive(username);
    res.json(buildSummary(username, apiData));
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/api/stream', async (req, res) => {
  const username = normalizeUsername(req.query.u);
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const apiData = await fetchApiLive(username);
    if (!isLiveFromApi(apiData)) {
      return res.status(404).json({ ...buildSummary(username, apiData), error: 'not live' });
    }
    const streams = extractStreamUrls(apiData);
    const summary = buildSummary(username, apiData, streams);
    summary.streamsAvailable = hasStreamUrls(streams);
    if (!summary.streamsAvailable) {
      summary.streamsBlockedReason =
        'TikTok did not return stream URLs for this room (likely region/login-restricted). ' +
        'Try setting TIKTOK_SESSIONID env var with your account cookie.';
    }
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
