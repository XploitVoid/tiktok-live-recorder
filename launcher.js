// launcher.js — Smart cross-platform launcher for Live Stream Recorder.
// Starts the server if not already running and opens the UI in the default browser.

const { spawn } = require('child_process');
const path = require('path');

function resolveUrls(env = process.env) {
  const rawPort = Number(env.PORT);
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 3000;
  const host = String(env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  const isV6Local = host === '::' || host === '::1';
  const isLocalBind = isV6Local || host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost';
  const probeHost = isV6Local ? '::1' : (isLocalBind ? '127.0.0.1' : host);
  const formattedHost = probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;
  const displayHost = isLocalBind ? 'localhost' : formattedHost;
  return {
    port,
    host,
    probeHost,
    healthUrl: `http://${formattedHost}:${port}/api/health`,
    openUrl: `http://${displayHost}:${port}`,
  };
}

async function checkHealth(healthUrl, timeoutMs = 800) {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return false;
    }
    const data = await res.json();
    return Boolean(data && data.ok === true);
  } catch {
    return false;
  }
}

function openBrowser(url, platform = process.platform, spawnImpl = spawn) {
  if (typeof url !== 'string' || /[\r\n\0]/.test(url)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const safeHref = parsed.href;
  try {
    let child;
    if (platform === 'win32') {
      child = spawnImpl('rundll32.exe', ['url.dll,FileProtocolHandler', safeHref], {
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
    } else if (platform === 'darwin') {
      child = spawnImpl('open', [safeHref], {
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
    } else {
      child = spawnImpl('xdg-open', [safeHref], {
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
    }
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForHealthAndOpen(healthUrl, openUrl) {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    if (await checkHealth(healthUrl, 800)) {
      openBrowser(openUrl);
      return true;
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 250);
      if (typeof t.unref === 'function') t.unref();
    });
  }
  return false;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const { healthUrl, openUrl } = resolveUrls(process.env);
  const noBrowser = process.env.NO_BROWSER === '1';

  if (await checkHealth(healthUrl, 800)) {
    console.log(`Live Stream Recorder is already running at ${openUrl}`);
    if (!noBrowser) openBrowser(openUrl);
    return;
  }

  require('./server.js');

  if (!noBrowser) {
    waitForHealthAndOpen(healthUrl, openUrl).catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[launcher] failed:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { resolveUrls, checkHealth, openBrowser };
