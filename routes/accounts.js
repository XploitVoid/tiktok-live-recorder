// routes/accounts.js — API routes for multi-account management.
const { Router } = require('express');
const accounts = require('../lib/accounts');
const { getStealthMode, setStealthMode } = require('../lib/room');
const router = Router();

// List all saved accounts (masks sessionId for security)
router.get('/api/accounts', (_req, res) => {
  const list = accounts.getAll().map((a) => ({
    id: a.id,
    label: a.label,
    hasSession: !!a.sessionId,
    sessionPreview: a.sessionId ? a.sessionId.slice(0, 8) + '...' : '',
  }));
  const active = accounts.getActive();
  res.json({
    accounts: list,
    active: {
      id: active.id || null,
      sessionPreview: active.sessionId ? active.sessionId.slice(0, 8) + '...' : '',
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
  const safeLabel = typeof label === 'string' ? label.slice(0, 64) : '';
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
    res.json({ ok: true, hasSession: !!result.sessionId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Toggle stealth (anonymous) mode
router.post('/api/accounts/stealth', (req, res) => {
  const { enabled } = req.body || {};
  setStealthMode(!!enabled);
  console.log(`[accounts] stealth mode ${enabled ? 'ON' : 'OFF'}`);
  res.json({ ok: true, stealth: getStealthMode() });
});

module.exports = router;
