// routes/accounts.js — API routes for multi-account management.
const { Router } = require('express');
const accounts = require('../lib/accounts');
const { getStealthMode, setStealthMode, invalidateApiCache } = require('../lib/room');
const { invalidateLiveStreamsCache } = require('./watch');
const { safeError, stripControlChars } = require('../lib/utils');
const router = Router();

function maskSession(sessionId) {
  if (!sessionId) return '';
  return sessionId.length > 4 ? `••••${sessionId.slice(-4)}` : '••••';
}

// List all saved accounts (masks sessionId for security)
router.get('/api/accounts', (_req, res) => {
  const list = accounts.getAll().map((a) => ({
    id: a.id,
    label: a.label,
    platform: a.platform || 'tiktok',
    hasSession: !!a.sessionId,
    sessionPreview: maskSession(a.sessionId),
    health: accounts.getAccountHealth(a.id),
  }));
  const active = accounts.getActive();
  res.json({
    accounts: list,
    active: {
      id: active.id || null,
      sessionPreview: maskSession(active.sessionId),
      hasSession: !!active.sessionId,
      byPlatform: accounts.getActiveByPlatform(),
    },
    stealth: getStealthMode(),
  });
});

// Add a new account
router.post('/api/accounts', (req, res) => {
  const { label, sessionId, ttTargetIdc, platform } = req.body || {};
  const rawPlat = platform === undefined || platform === null || platform === ''
    ? 'tiktok'
    : String(platform).trim().toLowerCase();
  if (!accounts.ACCOUNT_PLATFORMS.has(rawPlat)) {
    return res.status(400).json({ error: 'unsupported account platform' });
  }
  if (rawPlat === 'tiktok') {
    if (typeof sessionId !== 'string' || sessionId.length < 16 || sessionId.length > 256) {
      return res.status(400).json({ error: 'sessionId must be a string between 16 and 256 chars' });
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'sessionId contains invalid characters' });
    }
    if (ttTargetIdc !== undefined && (typeof ttTargetIdc !== 'string' || ttTargetIdc.length > 64 || !/^[A-Za-z0-9_-]*$/.test(ttTargetIdc))) {
      return res.status(400).json({ error: 'ttTargetIdc invalid' });
    }
  } else {
    if (typeof sessionId !== 'string' || sessionId.trim().length < 8 || sessionId.length > 2048 || /[\x00-\x1f\x7f]/.test(sessionId)) {
      return res.status(400).json({ error: 'token/cookie must be between 8 and 2048 valid characters' });
    }
  }
  const safeLabel = stripControlChars(label, 64);
  const account = accounts.add(safeLabel, sessionId.trim(), ttTargetIdc || '', rawPlat);
  res.json({ ok: true, id: account.id, label: account.label, platform: account.platform });
});

// Check health of all saved accounts (must be registered before :id route)
router.post('/api/accounts/check-all', async (_req, res) => {
  try {
    const results = await accounts.checkAllAccountsHealth();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// Check health of a single saved account
router.post('/api/accounts/:id/check', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9]+$/.test(id) || id.length > 32) {
    return res.status(400).json({ error: 'invalid id' });
  }
  try {
    const health = await accounts.checkAccountHealth(id);
    if (!health) return res.status(404).json({ error: 'account not found' });
    res.json({ ok: true, id, health });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// Delete an account
router.delete('/api/accounts/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9]+$/.test(id) || id.length > 32) {
    return res.status(400).json({ error: 'invalid id' });
  }
  accounts.remove(id);
  invalidateApiCache();
  invalidateLiveStreamsCache();
  res.json({ ok: true });
});

// Switch active account
router.post('/api/accounts/switch', (req, res) => {
  try {
    const { id, platform } = req.body || {};
    if (id !== undefined && id !== null && id !== '' && (typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id) || id.length > 32)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const result = accounts.switchTo(id || null, platform || null);
    invalidateApiCache();
    invalidateLiveStreamsCache();
    res.json({ ok: true, hasSession: !!result.sessionId, platform: result.platform });
  } catch (e) {
    res.status(400).json({ error: safeError(e) });
  }
});

// Toggle stealth (anonymous) mode
router.post('/api/accounts/stealth', (req, res) => {
  const { enabled } = req.body || {};
  setStealthMode(!!enabled);
  invalidateLiveStreamsCache();
  console.log(`[accounts] stealth mode ${enabled ? 'ON' : 'OFF'}`);
  res.json({ ok: true, stealth: getStealthMode() });
});

module.exports = router;
