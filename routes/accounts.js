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
    hasSession: !!a.sessionId,
    sessionPreview: maskSession(a.sessionId),
  }));
  const active = accounts.getActive();
  res.json({
    accounts: list,
    active: {
      id: active.id || null,
      sessionPreview: maskSession(active.sessionId),
      hasSession: !!active.sessionId,
    },
    stealth: getStealthMode(),
  });
});

// Add a new account
router.post('/api/accounts', (req, res) => {
  const { label, sessionId, ttTargetIdc } = req.body || {};
  if (typeof sessionId !== 'string' || sessionId.length < 16 || sessionId.length > 256) {
    return res.status(400).json({ error: 'sessionId must be a string between 16 and 256 chars' });
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'sessionId contains invalid characters' });
  }
  if (ttTargetIdc !== undefined && (typeof ttTargetIdc !== 'string' || ttTargetIdc.length > 64 || !/^[A-Za-z0-9_-]*$/.test(ttTargetIdc))) {
    return res.status(400).json({ error: 'ttTargetIdc invalid' });
  }
  const safeLabel = stripControlChars(label, 64);
  const account = accounts.add(safeLabel, sessionId, ttTargetIdc || '');
  res.json({ ok: true, id: account.id, label: account.label });
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
    const { id } = req.body || {};
    if (id !== undefined && id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id) || id.length > 32)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const result = accounts.switchTo(id || null);
    invalidateApiCache();
    invalidateLiveStreamsCache();
    res.json({ ok: true, hasSession: !!result.sessionId });
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
