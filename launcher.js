// launcher.js — Smart cross-platform launcher for TikTok LIVE Recorder.
// Starts the server if not already running and opens the UI in the default browser.

const { spawn } = require('child_process');
const path = require('path');

function resolveUrls(env = process.env) {
  const rawPort = Number(env.PORT);
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 3000;
  const host = String(env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  const isLocalBind = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const probeHost = isLocalBind ? '127.0.0.1' : host;
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
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.ok === true);
  } catch {
    return false;
  }
}

function openBrowser(url, platform = process.platform) {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s\r\n\0]+$/.test(url)) {
    return false;
  }
  try {
    let child;
    if (platform === 'win32') {
      child = spawn('cmd.exe', ['/c', 'start', '', url], {
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
    } else if (platform === 'darwin') {
      child = spawn('open', [url], {
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
    } else {
      child = spawn('xdg-open', [url], {
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
    console.log(`TikTok LIVE Recorder is already running at ${openUrl}`);
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
