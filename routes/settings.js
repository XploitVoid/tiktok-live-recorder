// routes/settings.js — /api/settings and /api/storage/* endpoints.

const { Router } = require('express');
const { getPublicSettings, updateSettings } = require('../lib/settings');
const { getDiskStatus, enforceRetention } = require('../lib/storage');
const { invalidateApiCache } = require('../lib/room');
const { activeFilePaths } = require('../lib/recorder');
const { invalidateRecordingsCache } = require('./record');
const { invalidateLiveStreamsCache } = require('./watch');
const { safeError } = require('../lib/utils');

const router = Router();

router.get('/api/settings', (_req, res) => {
  res.json({
    settings: getPublicSettings(),
    disk: getDiskStatus(),
  });
});

router.post('/api/settings', (req, res) => {
  try {
    const body = req.body || {};
    const prevHadProxy = getPublicSettings().hasProxy;
    const settings = updateSettings(body);
    if (body.proxyUrl !== undefined || prevHadProxy !== settings.hasProxy) {
      invalidateApiCache();
      invalidateLiveStreamsCache();
    }
    res.json({ ok: true, settings, disk: getDiskStatus() });
  } catch (e) {
    res.status(400).json({ error: safeError(e) });
  }
});

router.post('/api/storage/cleanup', (_req, res) => {
  try {
    const result = enforceRetention(activeFilePaths());
    if (result.deleted.length > 0) invalidateRecordingsCache();
    res.json({ ok: true, ...result, disk: getDiskStatus() });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

module.exports = router;
