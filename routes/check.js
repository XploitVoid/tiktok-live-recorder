// routes/check.js — /api/check and /api/stream endpoints.

const { Router } = require('express');
const { getProvider, parseChannelInput } = require('../lib/providers');
const { safeError } = require('../lib/utils');

const router = Router();

router.get('/api/check', async (req, res) => {
  const { platform, username } = parseChannelInput(req.query.u, req.query.platform);
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const provider = getProvider(platform);
    const apiData = await provider.fetchLiveStatus(username);
    res.json(provider.buildSummary(username, apiData));
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

router.get('/api/stream', async (req, res) => {
  const { platform, username } = parseChannelInput(req.query.u, req.query.platform);
  if (!username) return res.status(400).json({ error: 'missing username' });
  try {
    const provider = getProvider(platform);
    const apiData = await provider.fetchLiveStatus(username);
    if (!provider.isLive(apiData)) {
      return res.status(404).json({ ...provider.buildSummary(username, apiData), error: 'not live' });
    }
    const streams = provider.extractStreamUrls(apiData);
    const summary = provider.buildSummary(username, apiData, streams);
    summary.streamsAvailable = provider.hasStreamUrls(streams);
    if (!summary.streamsAvailable) {
      summary.streamsBlockedReason = platform === 'tiktok'
        ? 'TikTok did not return stream URLs for this room (likely region/login-restricted). ' +
          'Try setting TIKTOK_SESSIONID env var with your account cookie.'
        : `${provider.label} did not return stream URLs for this channel.`;
    }
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
