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
    assert.equal(utils.resolveInsideDir(tmpDir, '../../secret.mp4', '.mp4'), null); // rejects path separators outright
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
  const os = require('node:os');
  const port = 39123;
  const token = 'test-secret-token-xyz';
  const root = path.resolve(__dirname, '..');
  const tempSettingsFile = path.join(os.tmpdir(), `tlr-sec-settings-${process.pid}-${Date.now()}.json`);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      APP_TOKEN: token,
      QUIET_LOGS: '1',
      TLR_SETTINGS_FILE: tempSettingsFile,
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
    assert.match(healthRes.headers.get('content-security-policy'), /worker-src 'self' blob:/);
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

    // 9. SSE stream survives GET with JSON body drained by express.json() (H24)
    const sseData = await new Promise((resolve, reject) => {
      const sseReq = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/events/stream?channels=jobs',
        headers: {
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
          'Content-Length': '2',
        },
      }, (sseRes) => {
        let buf = '';
        const timer = setTimeout(() => {
          sseReq.destroy();
          resolve({ status: sseRes.statusCode, contentType: sseRes.headers['content-type'], buf });
        }, 500);
        sseRes.setEncoding('utf8');
        sseRes.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes('event: jobs')) {
            clearTimeout(timer);
            sseReq.destroy();
            resolve({ status: sseRes.statusCode, contentType: sseRes.headers['content-type'], buf });
          }
        });
        sseRes.on('error', () => {
          clearTimeout(timer);
          resolve({ status: sseRes.statusCode, contentType: sseRes.headers['content-type'], buf });
        });
      });
      sseReq.on('error', reject);
      sseReq.write('{}');
      sseReq.end();
    });
    assert.equal(sseData.status, 200);
    assert.match(String(sseData.contentType || ''), /text\/event-stream/i);
    assert.match(sseData.buf, /event: jobs/);

    // 10. Unified Stealth & Anonymous HTTP API (GET/POST /api/accounts/stealth + invalid platform/accountId)
    const accBefore = await (await fetch(`${baseUrl}/api/accounts`, { headers: { Cookie: cookieHeader } })).json();
    assert.equal(typeof accBefore.stealthPlatforms?.soop, 'boolean');
    assert.equal(typeof accBefore.effectiveAnonByPlatform?.tiktok, 'boolean');
    assert.equal(typeof accBefore.active?.hasSessionByPlatform?.youtube, 'boolean');

    const badPlatStealth = await fetch(`${baseUrl}/api/accounts/stealth`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'evil', enabled: true }),
    });
    assert.equal(badPlatStealth.status, 400);

    const perPlatStealth = await fetch(`${baseUrl}/api/accounts/stealth`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'youtube', enabled: true }),
    });
    assert.equal(perPlatStealth.status, 200);
    const perPlatJson = await perPlatStealth.json();
    assert.equal(perPlatJson.stealthPlatforms.youtube, true);

    // Turning 1 platform OFF from Global Stealth (payload used by AccountSwitcher) drops global stealth cleanly
    await fetch(`${baseUrl}/api/accounts/stealth`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const optOutRes = await fetch(`${baseUrl}/api/accounts/stealth`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        stealthPlatforms: {
          tiktok: true,
          twitch: true,
          youtube: true,
          kick: true,
          soop: false,
        },
      }),
    });
    assert.equal(optOutRes.status, 200);
    const optOutJson = await optOutRes.json();
    assert.equal(optOutJson.stealth, false);
    assert.equal(optOutJson.stealthPlatforms.soop, false);
    assert.equal(optOutJson.stealthPlatforms.tiktok, true);

    const badCheckAcct = await fetch(`${baseUrl}/api/check?u=tester&platform=twitch&accountId=doesnotexist`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(badCheckAcct.status, 400);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    });
    fs.rmSync(tempSettingsFile, { force: true });
  }
});

test('Phase 1 security regressions: C1 Telegram/safeError, H1 SSRF, H2 cross-platform creds, H3 launcher, H4 maskDiscord, H5 YouTube cookie', async () => {
  const { EventEmitter } = require('node:events');
  const notifications = require('../lib/notifications');
  const settings = require('../lib/settings');
  const launcher = require('../launcher');
  const youtube = require('../lib/providers/youtube');

  // C1: safeError redacts both ':' and '%3A' in Telegram URLs, and postTelegram does not encode ':'
  const tgToken = ['99887766', 'AA' + 'x'.repeat(33)].join(':');
  const tgEncodedErr = new Error(`POST https://api.telegram.org/bot${encodeURIComponent(tgToken)}/sendMessage failed`);
  const redactedTg = utils.safeError(tgEncodedErr);
  assert.equal(redactedTg.includes('AAx'), false);
  assert.match(redactedTg, /\/bot\[redacted\]/);

  let seenUrl = '';
  await notifications.postTelegram(tgToken, '-100123456', { title: 'Hi', body: '' }, async (u) => {
    seenUrl = u;
    return { ok: true, status: 200 };
  });
  assert.equal(seenUrl, `https://api.telegram.org/bot${tgToken}/sendMessage`);
  assert.equal(seenUrl.includes('%3A'), false);
  await assert.rejects(() => notifications.postTelegram('bad/../../token', '123', { title: 'x' }), /Invalid Telegram bot token/);

  // H1: SSRF trailing dot and non-canonical IPv6 bypasses blocked
  assert.equal(utils.isValidStreamUrl('http://localhost./live.flv'), false);
  assert.equal(utils.isValidStreamUrl('http://metadata.google.internal./latest'), false);
  assert.equal(utils.isValidStreamUrl('http://[::127.0.0.1]:3000/live.flv'), false);
  assert.equal(utils.isPrivateOrReservedIp('0:0:0:0:0:0:0:1'), true);
  assert.equal(utils.isPrivateOrReservedIp('0:0:0:0:0:ffff:127.0.0.1'), true);
  assert.equal(utils.isPrivateOrReservedIp('::ffff:0:127.0.0.1'), true);
  assert.equal(utils.isPrivateOrReservedIp('2002:7f00:1::1'), true);
  assert.equal(utils.isPrivateOrReservedIp('fec0::1'), true);
  assert.equal(utils.isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(utils.isPrivateOrReservedIp('2606:4700:4700::1111'), false);

  // H2: getCredentialsById isolates credentials by platform
  const root = path.resolve(__dirname, '..');
  const accFile = path.join(root, 'accounts.json');
  const keyFile = path.join(root, '.accounts.key');
  const hadAcc = fs.existsSync(accFile);
  const hadKey = fs.existsSync(keyFile);
  const origAcc = hadAcc ? fs.readFileSync(accFile) : null;
  const origKey = hadKey ? fs.readFileSync(keyFile) : null;
  try {
    process.env.ACCOUNTS_SECRET = 'phase1-cred-test-secret';
    const accounts = require('../lib/accounts');
    const twitchAcc = accounts.add('MyTwitch', 'twitch_oauth_secret_val', '', 'twitch');
    const crossLook = accounts.getCredentialsById(twitchAcc.id, 'tiktok');
    assert.notEqual(crossLook.sessionId, 'twitch_oauth_secret_val');
    const sameLook = accounts.getCredentialsById(twitchAcc.id, 'twitch');
    assert.equal(sameLook.id, twitchAcc.id);
    assert.equal(sameLook.sessionId, 'twitch_oauth_secret_val');
    accounts.remove(twitchAcc.id);
  } finally {
    delete process.env.ACCOUNTS_SECRET;
    if (hadAcc && origAcc) fs.writeFileSync(accFile, origAcc);
    else fs.rmSync(accFile, { force: true });
    if (hadKey && origKey) fs.writeFileSync(keyFile, origKey);
    else fs.rmSync(keyFile, { force: true });
  }

  // H3: openBrowser on win32 avoids cmd.exe /c start and rejects unsafe protocols
  const calls = [];
  const mockSpawn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  };
  assert.equal(launcher.openBrowser('http://localhost:3000/?a=1&b=2&calc', 'win32', mockSpawn), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'rundll32.exe');
  assert.equal(calls[0].opts.shell, false);
  assert.equal(launcher.openBrowser('javascript:alert(1)', 'win32', mockSpawn), false);
  assert.equal(launcher.openBrowser('file:///etc/passwd', 'win32', mockSpawn), false);

  // H4: maskDiscordWebhook handles trailing slash, query params, and userinfo
  const maskedHook = settings.maskDiscordWebhook('https://user:pass@discord.com/api/webhooks/123456/secret_hook_token/?wait=true');
  assert.equal(maskedHook.includes('secret_hook_token'), false);
  assert.equal(maskedHook.includes('pass'), false);
  assert.equal(maskedHook.includes('wait=true'), false);
  assert.match(maskedHook, /\/webhooks\/123456\/secr\*\*\*oken$/);

  // H5: YouTube Cookie is not attached for non-youtube.com hosts (e.g. googlevideo.com)
  const ytHeaders = youtube.buildYouTubeHeaders({}, 'www.youtube.com');
  const cdnHeaders = youtube.buildYouTubeHeaders({}, 'rr1---sn-abc.googlevideo.com');
  assert.ok(ytHeaders.Cookie);
  assert.equal('Cookie' in cdnHeaders, false);
});

test('Phase 2 account & settings isolation: H7 switchTo(null, platform), M13 clampNum & no env secret persist', () => {
  const settings = require('../lib/settings');
  const root = path.resolve(__dirname, '..');
  const accFile = path.join(root, 'accounts.json');
  const keyFile = path.join(root, '.accounts.key');
  const settingsFile = path.join(root, 'settings.json');
  const hadAcc = fs.existsSync(accFile);
  const hadKey = fs.existsSync(keyFile);
  const hadSet = fs.existsSync(settingsFile);
  const origAcc = hadAcc ? fs.readFileSync(accFile) : null;
  const origKey = hadKey ? fs.readFileSync(keyFile) : null;
  const origSet = hadSet ? fs.readFileSync(settingsFile) : null;
  const prevKickEnv = process.env.KICK_TOKEN;
  const prevSettingsSnapshot = settings.getSettings();

  try {
    // H7: clearing non-TikTok credential returns empty without leaking TikTok sessionId or falling back to env
    process.env.ACCOUNTS_SECRET = 'phase2-h7-test-secret';
    process.env.KICK_TOKEN = 'env_kick_fallback_token';
    const accounts = require('../lib/accounts');
    const ttAcc = accounts.add('TTAcc', 'tiktok_session_12345678', '', 'tiktok');
    const kAcc = accounts.add('KickAcc', 'kick_saved_tok_123456', '', 'kick');
    accounts.switchTo(ttAcc.id);
    accounts.switchTo(kAcc.id);
    assert.equal(accounts.getActivePlatformCredential('kick'), 'kick_saved_tok_123456');

    const cleared = accounts.switchTo(null, 'kick');
    assert.equal(cleared.platform, 'kick');
    assert.equal(cleared.sessionId, '');
    assert.equal(accounts.getActivePlatformCredential('kick'), '');

    accounts.remove(ttAcc.id);
    accounts.remove(kAcc.id);

    // M13: clampNum ignores empty string instead of turning into 0
    const updated = settings.updateSettings({ minFreeGb: 7 });
    assert.equal(updated.minFreeGb, 7);
    const afterEmpty = settings.updateSettings({ minFreeGb: '' });
    assert.equal(afterEmpty.minFreeGb, 7);
  } finally {
    if (prevKickEnv === undefined) delete process.env.KICK_TOKEN;
    else process.env.KICK_TOKEN = prevKickEnv;
    delete process.env.ACCOUNTS_SECRET;
    try { settings.updateSettings({ minFreeGb: prevSettingsSnapshot.minFreeGb }); } catch {}
    if (hadAcc && origAcc) fs.writeFileSync(accFile, origAcc);
    else fs.rmSync(accFile, { force: true });
    if (hadKey && origKey) fs.writeFileSync(keyFile, origKey);
    else fs.rmSync(keyFile, { force: true });
    if (hadSet && origSet) fs.writeFileSync(settingsFile, origSet);
    else fs.rmSync(settingsFile, { force: true });
  }
});

test('Phase 3 security: SOOP CDN allowlist, cookie redaction, temp cookie file cleanup, and account isolation', async () => {
  const soop = require('../lib/providers/soop');

  // 1. CDN allowlist accepts HTTPS SOOP domains and blocks spoofed/HTTP/removed Meta hosts
  assert.equal(utils.isAllowedCdnUrl('https://live-global-cdn-01.sooplive.co.kr/live/master.m3u8'), true);
  assert.equal(utils.isAllowedCdnUrl('https://cdn.sooplive.com/hls/live.m3u8'), true);
  assert.equal(utils.isAllowedCdnUrl('http://cdn.sooplive.com/hls/live.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('https://sooplive.com.evil.com/hls/live.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('https://video.xx.fbcdn.net/live/stream.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('https://scontent.cdninstagram.com/hvideo/live.mpd'), false);

  // 2. safeError redacts SOOP cookie values, aid query tokens, and common cookie fields
  const errStr = 'https://cdn.sooplive.co.kr/live.m3u8?aid=soopAidSecret&AuthTicket=soopSec123; c_user=10001; xs=fbSecretXs; fr=fbFrSecret; ds_user_id=999; csrftoken=igCsrfSecret; ig_did=igDidSecret';
  const redacted = utils.safeError(errStr);
  for (const secret of ['soopAidSecret', 'soopSec123', '10001', 'fbSecretXs', 'fbFrSecret', '999', 'igCsrfSecret', 'igDidSecret']) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /aid=\[redacted\]/);
  assert.match(redacted, /AuthTicket=\[redacted\]/);
  assert.match(redacted, /xs=\[redacted\]/);
  assert.match(redacted, /fr=\[redacted\]/);
  assert.match(redacted, /csrftoken=\[redacted\]/);
  assert.match(redacted, /ig_did=\[redacted\]/);

  // 3. withTempCookieFile writes Netscape cookie file and deletes it even on error
  let seenCookiePath = null;
  await assert.rejects(
    () => utils.withTempCookieFile('SID=yt_secret_abc; SAPISID=sapi_123', '.youtube.com', async (filePath) => {
      seenCookiePath = filePath;
      assert.ok(filePath && fs.existsSync(filePath));
      const content = fs.readFileSync(filePath, 'utf8');
      assert.match(content, /\.youtube\.com\tTRUE\t\/\tTRUE\t0\tSID\tyt_secret_abc/);
      throw new Error('simulated yt-dlp failure');
    }),
    /simulated yt-dlp failure/,
  );
  assert.ok(seenCookiePath);
  assert.equal(fs.existsSync(seenCookiePath), false);

  // 4. yt-dlp host validation rejects disallowed URLs
  assert.equal(await soop.fetchViaYtDlp('https://evil.com/live'), null);

  // 5. Account storage supports soop with encryption & isolation
  const root = path.resolve(__dirname, '..');
  const accFile = path.join(root, 'accounts.json');
  const keyFile = path.join(root, '.accounts.key');
  const hadAcc = fs.existsSync(accFile);
  const hadKey = fs.existsSync(keyFile);
  const origAcc = hadAcc ? fs.readFileSync(accFile) : null;
  const origKey = hadKey ? fs.readFileSync(keyFile) : null;
  try {
    process.env.ACCOUNTS_SECRET = 'phase3-cred-test-secret';
    const accounts = require('../lib/accounts');
    for (const plat of ['soop']) {
      assert.equal(accounts.ACCOUNT_PLATFORMS.has(plat), true);
      const acc = accounts.add(`Test_${plat}`, `${plat}_secret_cookie_12345`, '', plat);
      const got = accounts.getCredentialsById(acc.id, plat);
      assert.equal(got.sessionId, `${plat}_secret_cookie_12345`);
      const wrong = accounts.getCredentialsById(acc.id, 'tiktok');
      assert.notEqual(wrong.sessionId, `${plat}_secret_cookie_12345`);
      accounts.remove(acc.id);
    }
  } finally {
    delete process.env.ACCOUNTS_SECRET;
    if (hadAcc && origAcc) fs.writeFileSync(accFile, origAcc);
    else fs.rmSync(accFile, { force: true });
    if (hadKey && origKey) fs.writeFileSync(keyFile, origKey);
    else fs.rmSync(keyFile, { force: true });
  }

  // 6. SOOP never forwards auth Cookie headers to CDN .m3u8 URLs
  const stealth = require('../lib/stealth');
  const prevStealthMode = stealth.getStealthMode();
  const prevStealthPlatforms = stealth.getStealthPlatforms();
  const prevSoopCookie = process.env.SOOP_COOKIE;
  process.env.SOOP_COOKIE = 'AuthTicket=soop_secret';
  try {
    stealth.setStealthMode(false, { persist: false });
    stealth.setPlatformStealth('soop', false, { persist: false });
    await soop.fetchLiveStatus('https://play.sooplive.co.kr/kobj', {
      useYtDlpFallback: false,
      fetchImpl: async (url, opts) => {
        if (url.includes('player_live_api.php') && String(opts?.body || '').includes('type=live')) {
          assert.equal(opts.headers.Cookie, 'AuthTicket=soop_secret');
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({ CHANNEL: { RESULT: 1, BNO: '123', RMD: 'https://livestream-manager.sooplive.co.kr' } }),
          };
        }
        if (url.includes('player_live_api.php')) return { ok: true, status: 200, text: JSON.stringify({ CHANNEL: { AID: 'a1' } }) };
        if (url.includes('broad_stream_assign.html')) {
          return { ok: true, status: 200, text: JSON.stringify({ view_url: 'https://cdn.sooplive-cdn.com/live/master.m3u8' }) };
        }
        if (url.includes('sooplive-cdn.com')) {
          assert.equal(opts?.headers?.Cookie, undefined);
          return { ok: true, status: 200, text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhttps://cdn.sooplive-cdn.com/live/720p.m3u8\n' };
        }
        return { ok: false, status: 404, text: '' };
      },
    });
  } finally {
    stealth.setStealthMode(prevStealthMode, { persist: false });
    stealth.setStealthPlatforms(prevStealthPlatforms, { persist: false });
    if (prevSoopCookie === undefined) delete process.env.SOOP_COOKIE;
    else process.env.SOOP_COOKIE = prevSoopCookie;
  }
});

test('Phase 6 security regressions: auth brute-force limiter, no query token, fail-closed accounts, dangling symlink, SOOP chdomain, SRT injection, and stealth sync', async () => {
  // 1. createAuthFailLimiter unit check
  const failLim = security.createAuthFailLimiter({ windowMs: 60_000, max: 3 });
  assert.equal(failLim.isBlocked('1.2.3.4'), false);
  failLim.recordFailure('1.2.3.4');
  failLim.recordFailure('1.2.3.4');
  assert.equal(failLim.isBlocked('1.2.3.4'), false);
  failLim.recordFailure('1.2.3.4');
  assert.equal(failLim.isBlocked('1.2.3.4'), true);
  failLim.reset('1.2.3.4');
  assert.equal(failLim.isBlocked('1.2.3.4'), false);

  // 2. resolveInsideDir rejects dangling symlinks (when OS allows symlinks)
  const symDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-sym-'));
  try {
    let symCreated = false;
    try {
      fs.symlinkSync(path.join(symDir, 'does_not_exist.mp4'), path.join(symDir, 'dangling.mp4'));
      symCreated = true;
    } catch (e) {
      if (e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e;
    }
    if (symCreated) {
      assert.equal(utils.resolveInsideDir(symDir, 'dangling.mp4', '.mp4'), null);
    }
  } finally {
    fs.rmSync(symDir, { recursive: true, force: true });
  }

  // 3. accounts.add() -> encryptField() fails closed when keyfile is invalid and ACCOUNTS_SECRET is unset
  const accounts = require('../lib/accounts');
  const root = path.resolve(__dirname, '..');
  const keyFile = path.join(root, '.accounts.key');
  const accFile = path.join(root, 'accounts.json');
  const hadKey = fs.existsSync(keyFile);
  const origKey = hadKey ? fs.readFileSync(keyFile) : null;
  const hadAcc = fs.existsSync(accFile);
  const origAcc = hadAcc ? fs.readFileSync(accFile) : null;
  const origEnvSecret = process.env.ACCOUNTS_SECRET;
  delete process.env.ACCOUNTS_SECRET;
  try {
    fs.writeFileSync(keyFile, 'corrupted-not-64-hex\n', 'utf8');
    assert.throws(() => accounts.add('failclosed', 'my-sensitive-cookie-12345', '', 'tiktok'), /encryption key unavailable/i);
  } finally {
    if (origEnvSecret !== undefined) process.env.ACCOUNTS_SECRET = origEnvSecret;
    else delete process.env.ACCOUNTS_SECRET;
    if (hadKey && origKey) fs.writeFileSync(keyFile, origKey);
    else fs.rmSync(keyFile, { force: true });
    if (hadAcc && origAcc) fs.writeFileSync(accFile, origAcc);
    else fs.rmSync(accFile, { force: true });
  }

  // 4. SOOP SoopChatSession validates chdomain strictly (blocks userinfo/non-SOOP/empty hosts)
  const soop = require('../lib/providers/soop');
  for (const [badHost, expectedErr] of [
    ['evil.com@res.sooplive.co.kr', /invalid SOOP chat server host/i],
    ['attacker.example.com', /invalid SOOP chat server host/i],
    ['not a host', /invalid SOOP chat server host/i],
    ['', /SOOP live chat is not available/i],
  ]) {
    const sess = new soop.SoopChatSession('kr_testbj', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          CHANNEL: {
            RESULT: 1,
            CHDOMAIN: badHost,
            CHPT: 8080,
            CHATNO: '123',
            BNO: '456',
            FTK: 'ftk',
            BJID: 'testbj',
          },
        }),
      }),
    });
    await assert.rejects(() => sess.connect(), expectedErr);
    sess.disconnect();
  }

  // 5. highlights SRT sanitization strips -->, <>, {...}, newlines, and ASS escapes
  const highlights = require('../lib/highlights');
  const storage = require('../lib/storage');
  const cleaned = highlights.sanitizeSrtText('99:00:00,000 --> 99:00:05,000\n<b>{\\an8}hi</b>\\Nthere', 100);
  assert.equal(cleaned.includes('-->'), false);
  assert.equal(cleaned.includes('<'), false);
  assert.equal(cleaned.includes('>'), false);
  assert.equal(cleaned.includes('{'), false);
  assert.equal(cleaned.includes('}'), false);
  assert.equal(cleaned.includes('\n'), false);
  assert.equal(cleaned.includes('\\N'), false);

  const srtRec = 'srt_sec_20260101_120000.mp4';
  const srtEv = path.join(storage.RECORDINGS_DIR, srtRec.replace(/\.mp4$/, '.events.jsonl'));
  const startMs = utils.parseStartTimeFromName(srtRec);
  assert.ok(startMs > 0);
  try {
    fs.writeFileSync(
      srtEv,
      [
        JSON.stringify({ type: 'chat', ts: startMs + 1000, user: { nickname: 'Alice\n--><b>' }, comment: '{\\pos(1,1)}Hello\\NWorld' }),
        JSON.stringify({ type: 'chat', ts: startMs + 4000, user: { nickname: '' }, comment: '--> <> {\\an8}' }),
        JSON.stringify({ type: 'chat', ts: startMs + 4500, user: { nickname: 'Bob' }, comment: 'Second normal line' }),
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(path.join(storage.RECORDINGS_DIR, srtRec), 'mp4', 'utf8');
    fs.writeFileSync(path.join(storage.RECORDINGS_DIR, srtRec.replace(/\.mp4$/, '.meta.json')), JSON.stringify({ startMs }), 'utf8');
    const srt = highlights.buildSrtForWindow(srtRec, 0, 20);
    assert.ok(srt);
    assert.match(srt, /^1\n/);
    assert.match(srt, /\n2\n/);
    assert.doesNotMatch(srt, /\n3\n/);
    assert.equal((srt.match(/-->/g) || []).length, 2);
    assert.doesNotMatch(srt, /<script>|\\pos|\\an8|\\N|<b>/);
  } finally {
    fs.rmSync(path.join(storage.RECORDINGS_DIR, srtRec), { force: true });
    fs.rmSync(path.join(storage.RECORDINGS_DIR, srtRec.replace(/\.mp4$/, '.meta.json')), { force: true });
    fs.rmSync(srtEv, { force: true });
  }

  // 6. POST /api/settings syncs stealth.js state immediately
  const express = require('express');
  const http = require('node:http');
  const settings = require('../lib/settings');
  const stealth = require('../lib/stealth');
  const settingsRouter = require('../routes/settings');
  const settingsFile = path.join(root, 'settings.json');
  const hadSettings = fs.existsSync(settingsFile);
  const origSettings = hadSettings ? fs.readFileSync(settingsFile) : null;
  const prevStealthMode = stealth.getStealthMode();
  const prevStealthPlat = stealth.getStealthPlatforms();

  const app = express();
  app.use(express.json());
  app.use(settingsRouter);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const srvPort = srv.address().port;
  try {
    stealth.setStealthMode(false, { persist: false });
    stealth.setStealthPlatforms({ twitch: false, kick: false }, { persist: false });
    const postRes = await fetch(`http://127.0.0.1:${srvPort}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stealthMode: true, stealthPlatforms: { twitch: true, kick: false } }),
    });
    assert.equal(postRes.status, 200);
    assert.equal(stealth.getStealthMode(), true);
    assert.equal(stealth.isPlatformStealth('twitch'), true);
    assert.equal(settings.getPublicSettings().stealthMode, true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    stealth.setStealthMode(prevStealthMode, { persist: false });
    stealth.setStealthPlatforms(prevStealthPlat, { persist: false });
    if (hadSettings && origSettings) fs.writeFileSync(settingsFile, origSettings);
    else fs.rmSync(settingsFile, { force: true });
  }

  // 7. Live server HTTP auth: ?token= query param rejected (401), X-App-Token accepted, brute-force /api/auth/login -> 429
  const port = 34000 + Math.floor(Math.random() * 10000);
  const token = 'test-auth-hardening-token-123';
  const tempSet = path.join(os.tmpdir(), `tlr-sec-p6-${Date.now()}.json`);
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      APP_TOKEN: token,
      QUIET_LOGS: '1',
      TLR_SETTINGS_FILE: tempSet,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(ready, true, 'server failed to become healthy');

    const queryTokRes = await fetch(`${baseUrl}/api/settings?token=${encodeURIComponent(token)}`);
    assert.equal(queryTokRes.status, 401);

    const hdrTokRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { 'X-App-Token': token },
    });
    assert.equal(hdrTokRes.status, 200);

    let got429 = false;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: `wrong-${i}` }),
      });
      if (r.status === 429) {
        got429 = true;
        break;
      }
      assert.equal(r.status, 401);
    }
    assert.equal(got429, true, 'expected 429 rate limit after repeated wrong login attempts');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    });
    fs.rmSync(tempSet, { force: true });
  }
});