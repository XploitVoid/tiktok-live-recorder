const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const security = require('../lib/security');
const utils = require('../lib/utils');

test('hostAllowed prevents DNS rebinding including 10.evil.com bypass', () => {
  const allowed = security.buildAllowedHosts(3000, '127.0.0.1', 'myhost.local:3000');

  assert.equal(security.hostAllowed('localhost:3000', { port: 3000, host: '127.0.0.1', allowedHosts: allowed }), true);
  assert.equal(security.hostAllowed('127.0.0.1:3000', { port: 3000, host: '127.0.0.1', allowedHosts: allowed }), true);
  assert.equal(security.hostAllowed('[::1]:3000', { port: 3000, host: '127.0.0.1', allowedHosts: allowed }), true);
  assert.equal(security.hostAllowed('myhost.local:3000', { port: 3000, host: '127.0.0.1', allowedHosts: allowed }), true);

  // DNS rebinding / spoofed hostnames must be rejected
  assert.equal(security.hostAllowed('10.evil.com:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), false);
  assert.equal(security.hostAllowed('192.168.attacker.com:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), false);
  assert.equal(security.hostAllowed('172.32.0.1:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), false);
  assert.equal(security.hostAllowed('192.168.999.1:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), false);
  assert.equal(security.hostAllowed('localhost:3000/evil', { port: 3000, host: '127.0.0.1', allowedHosts: allowed }), false);

  // LAN IPs rejected when bound to loopback without proxy, allowed when bound to 0.0.0.0
  assert.equal(security.hostAllowed('192.168.1.25:3000', { port: 3000, host: '127.0.0.1', allowedHosts: allowed }), false);
  assert.equal(security.hostAllowed('192.168.1.25:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), true);
  assert.equal(security.hostAllowed('10.0.0.5:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), true);
  assert.equal(security.hostAllowed('172.16.0.5:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), true);
  assert.equal(security.hostAllowed('[fe80::1]:3000', { port: 3000, host: '0.0.0.0', allowedHosts: allowed }), true);
});

test('tokenEquals and session cookie signing/verification', () => {
  assert.equal(security.tokenEquals('secret-123', 'secret-123'), true);
  assert.equal(security.tokenEquals('secret-123', 'secret-124'), false);
  assert.equal(security.tokenEquals('secret-123', 'short'), false);
  assert.equal(security.tokenEquals('', ''), false);

  const now = 1_700_000_000_000;
  const cookie = security.createSessionCookieValue('my-app-token', now);
  assert.equal(security.verifySessionCookieValue(cookie, 'my-app-token', now + 1000), true);
  assert.equal(security.verifySessionCookieValue(cookie, 'wrong-token', now + 1000), false);
  assert.equal(security.verifySessionCookieValue(cookie, 'my-app-token', now + 8 * 24 * 60 * 60 * 1000), false);

  const tampered = cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0');
  assert.equal(security.verifySessionCookieValue(tampered, 'my-app-token', now + 1000), false);
});

test('parseCookies ignores prototype pollution keys', () => {
  const parsed = security.parseCookies('tlr_session=abc.123; __proto__=evil; constructor=bad; ok=yes');
  assert.equal(parsed.tlr_session, 'abc.123');
  assert.equal(parsed.ok, 'yes');
  assert.equal(Object.getPrototypeOf(parsed), null);
});

test('isCrossSiteRequest blocks cross-site Sec-Fetch-Site, Origin, and Referer', () => {
  assert.equal(security.isCrossSiteRequest({
    method: 'POST',
    headers: { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' },
  }), true);

  assert.equal(security.isCrossSiteRequest({
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'https://evil.com' },
  }), true);

  assert.equal(security.isCrossSiteRequest({
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'null' },
  }), true);

  assert.equal(security.isCrossSiteRequest({
    method: 'POST',
    headers: { host: 'localhost:3000', referer: 'https://evil.com/page' },
  }), true);

  assert.equal(security.isCrossSiteRequest({
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
  }), false);

  assert.equal(security.isCrossSiteRequest({
    method: 'POST',
    headers: { host: 'localhost:3000' },
  }), false);
});

test('stripProto removes prototype-pollution keys recursively', () => {
  const payload = JSON.parse('{"name":"ok","__proto__":{"polluted":true},"nested":[{"constructor":{"prototype":{"x":1}},"ok":2}]}');
  security.stripProto(payload);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.nested[0], 'constructor'), false);
  assert.equal(payload.name, 'ok');
  assert.equal(payload.nested[0].ok, 2);
});

test('SSRF IP and URL validators block private/loopback/IPv6-mapped addresses', () => {
  assert.equal(utils.isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(utils.isPrivateOrReservedIp('10.0.0.1'), true);
  assert.equal(utils.isPrivateOrReservedIp('100.64.0.1'), true);
  assert.equal(utils.isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(utils.isPrivateOrReservedIp('172.16.0.1'), true);
  assert.equal(utils.isPrivateOrReservedIp('192.168.1.1'), true);
  assert.equal(utils.isPrivateOrReservedIp('[::1]'), true);
  assert.equal(utils.isPrivateOrReservedIp('[::ffff:127.0.0.1]'), true);
  assert.equal(utils.isPrivateOrReservedIp('::ffff:7f00:1'), true);
  assert.equal(utils.isPrivateOrReservedIp('fe80::1%eth0'), true);
  assert.equal(utils.isPrivateOrReservedIp('fc00::1'), true);
  assert.equal(utils.isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(utils.isPrivateOrReservedIp('2606:4700:4700::1111'), false);

  // Stream URLs must block bracketed IPv6 loopback and mapped IPv4
  assert.equal(utils.isValidStreamUrl('http://[::1]:8080/live.flv'), false);
  assert.equal(utils.isValidStreamUrl('http://[::ffff:127.0.0.1]/live.flv'), false);
  assert.equal(utils.isValidStreamUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(utils.isValidStreamUrl('file:///etc/passwd'), false);
  assert.equal(utils.isValidStreamUrl('https://user:pass@pull-f5.tiktokcdn.com/live.flv'), false);
  assert.equal(utils.isValidStreamUrl('https://pull-f5.tiktokcdn.com/live.flv'), true);

  // CDN allowlist requires HTTPS + known TikTok CDN domains
  assert.equal(utils.isAllowedCdnUrl('https://pull-f5.tiktokcdn.com/stage/stream.m3u8'), true);
  assert.equal(utils.isAllowedCdnUrl('http://pull-f5.tiktokcdn.com/stage/stream.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('https://tiktokcdn.com.evil.com/stream.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('https://user:pass@pull-f5.tiktokcdn.com/stream.m3u8'), false);
});

test('resolveInsideDir prevents path traversal and dotfile access', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-sec-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'user_20260101_120000.mp4'), 'ok');

    assert.equal(utils.resolveInsideDir(tmpDir, '', '.mp4'), null);
    assert.equal(utils.resolveInsideDir(tmpDir, '..', '.mp4'), null);
    assert.equal(utils.resolveInsideDir(tmpDir, '.', '.mp4'), null);
    assert.equal(utils.resolveInsideDir(tmpDir, '.env', null), null);
    assert.equal(utils.resolveInsideDir(tmpDir, '../../secret.mp4', '.mp4')?.name, 'secret.mp4'); // basename sanitized inside tmpDir
    assert.equal(utils.resolveInsideDir(tmpDir, 'notes.txt', '.mp4'), null);

    const ok = utils.resolveInsideDir(tmpDir, 'user_20260101_120000.mp4', '.mp4');
    assert.equal(ok?.name, 'user_20260101_120000.mp4');
    assert.equal(ok?.full, path.join(tmpDir, 'user_20260101_120000.mp4'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('safeError redacts filesystem paths and sensitive query/cookie/proxy/webhook params', () => {
  const err = new Error('ENOENT at C:\\Users\\Alice\\secret\\file.txt with sessionid=abc123&signApiKey=xyz999');
  const safe = utils.safeError(err);
  assert.equal(safe.includes('Alice'), false);
  assert.equal(safe.includes('abc123'), false);
  assert.equal(safe.includes('xyz999'), false);
  assert.match(safe, /\[path\]/);
  assert.match(safe, /sessionid=\[redacted\]/);
  assert.match(safe, /\[redacted\]/);

  const proxyErr = new Error('connect failed via socks5://myuser:s3cr3tp4ss@1.2.3.4:1080/test');
  const safeProxy = utils.safeError(proxyErr);
  assert.equal(safeProxy.includes('myuser'), false);
  assert.equal(safeProxy.includes('s3cr3tp4ss'), false);
  assert.match(safeProxy, /socks5:\/\/\*\*\*@1\.2\.3\.4:1080/);

  const hookErr = new Error('POST https://discord.com/api/webhooks/123456/secret_hook_token failed');
  assert.equal(utils.safeError(hookErr).includes('secret_hook_token'), false);
  assert.match(utils.safeError(hookErr), /\/webhooks\/123456\/\[redacted\]/);

  const tgErr = new Error('GET https://api.telegram.org/bot998877:AAHsecretBotToken/sendMessage failed');
  assert.equal(utils.safeError(tgErr).includes('AAHsecretBotToken'), false);
  assert.match(utils.safeError(tgErr), /\/bot\[redacted\]/);
});

test('parseTrustProxy and buildAllowedHosts handle numeric, boolean, uppercase, IPv6, and ports 80/443', () => {
  assert.equal(security.parseTrustProxy(''), false);
  assert.equal(security.parseTrustProxy('0'), false);
  assert.equal(security.parseTrustProxy('false'), false);
  assert.equal(security.parseTrustProxy('true'), true);
  assert.equal(security.parseTrustProxy('1'), 1);
  assert.equal(security.parseTrustProxy('2'), 2);
  assert.equal(security.parseTrustProxy('loopback'), 'loopback');

  const h80 = security.buildAllowedHosts(80, 'MYHOST.LOCAL');
  assert.equal(security.hostAllowed('myhost.local', { port: 80, host: 'MYHOST.LOCAL', allowedHosts: h80 }), true);
  assert.equal(security.hostAllowed('localhost', { port: 80, host: 'MYHOST.LOCAL', allowedHosts: h80 }), true);

  const hV6 = security.buildAllowedHosts(3000, 'fd00::1');
  assert.equal(security.hostAllowed('[fd00::1]:3000', { port: 3000, host: 'fd00::1', allowedHosts: hV6 }), true);
});

test('accounts module encrypts credentials at rest', () => {
  const root = path.resolve(__dirname, '..');
  const accFile = path.join(root, 'accounts.json');
  const keyFile = path.join(root, '.accounts.key');
  const hadAcc = fs.existsSync(accFile);
  const hadKey = fs.existsSync(keyFile);
  const origAcc = hadAcc ? fs.readFileSync(accFile) : null;
  const origKey = hadKey ? fs.readFileSync(keyFile) : null;

  try {
    process.env.ACCOUNTS_SECRET = 'unit-test-secret-key';
    const accounts = require('../lib/accounts');
    const created = accounts.add('TestUser', 'super_secret_session_value_12345', 'us-east');
    const rawDisk = fs.readFileSync(accFile, 'utf8');

    // Plaintext cookie must NOT appear on disk
    assert.equal(rawDisk.includes('super_secret_session_value_12345'), false);
    assert.equal(rawDisk.includes('enc:v1:'), true);

    const loaded = accounts.getAll().find((a) => a.id === created.id);
    assert.equal(loaded?.sessionId, 'super_secret_session_value_12345');
    assert.equal(loaded?.ttTargetIdc, 'us-east');
    accounts.remove(created.id);
  } finally {
    delete process.env.ACCOUNTS_SECRET;
    if (hadAcc && origAcc) fs.writeFileSync(accFile, origAcc);
    else fs.rmSync(accFile, { force: true });
    if (hadKey && origKey) fs.writeFileSync(keyFile, origKey);
    else fs.rmSync(keyFile, { force: true });
  }
});

test('server HTTP integration: auth cookie, DNS rebinding, CSRF, traversal, and headers', async () => {
  const port = 39123;
  const token = 'test-secret-token-xyz';
  const root = path.resolve(__dirname, '..');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      APP_TOKEN: token,
      QUIET_LOGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    // Wait until /api/health responds
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(ready, true, 'server failed to become healthy');

    // 1. Security headers + no X-Powered-By
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.headers.get('x-powered-by'), null);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(healthRes.headers.get('content-security-policy'));
    assert.ok(healthRes.headers.get('permissions-policy'));

    // 2. DNS rebinding Host header rejected with 421 (test using raw http.request since fetch forbids Host override)
    const http = require('node:http');
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/health',
        headers: { Host: `10.evil.com:${port}` },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHostStatus, 421);

    // 3. Protected endpoint requires auth (including case-insensitive Express path variants)
    const unauth = await fetch(`${baseUrl}/api/recordings`);
    assert.equal(unauth.status, 401);
    const unauthUpperApi = await fetch(`${baseUrl}/API/accounts`);
    assert.equal(unauthUpperApi.status, 401);
    const unauthUpperFiles = await fetch(`${baseUrl}/FILES/secret.mp4`);
    assert.equal(unauthUpperFiles.status, 401);

    // 4. Auth status & login sets HttpOnly SameSite=Strict cookie
    const statusBefore = await (await fetch(`${baseUrl}/api/auth/status`)).json();
    assert.deepEqual(statusBefore, { authRequired: true, authenticated: false });

    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(goodLogin.status, 200);
    const setCookie = goodLogin.headers.get('set-cookie') || '';
    assert.match(setCookie, /tlr_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookieHeader = setCookie.split(';')[0];

    // 5. Authenticated access with cookie works
    const authed = await fetch(`${baseUrl}/api/recordings`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(authed.status, 200);

    // 6. Cross-site mutation & sensitive GET blocked (including trailing slash & uppercase) even with valid cookie
    const csrfBlocked = await fetch(`${baseUrl}/api/watch`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'content-type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ username: 'testuser' }),
    });
    assert.equal(csrfBlocked.status, 403);

    const csrfGetSlash = await fetch(`${baseUrl}/api/transcode/?url=https://pull.tiktokcdn.com/live.flv`, {
      headers: { Cookie: cookieHeader, 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(csrfGetSlash.status, 403);

    const csrfGetUpper = await fetch(`${baseUrl}/API/accounts`, {
      headers: { Cookie: cookieHeader, 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(csrfGetUpper.status, 403);

    // 7. Path traversal & non-mp4 extension rejected
    const badName = await fetch(`${baseUrl}/api/recordings/..%2fpackage.json`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(badName.status, 400);

    // 8. SSRF proxy blocked
    const ssrf = await fetch(`${baseUrl}/api/proxy?url=${encodeURIComponent(`http://127.0.0.1:${port}/api/health`)}`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(ssrf.status, 400);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    });
  }
});
