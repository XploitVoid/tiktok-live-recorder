// lib/proxy-config.js — Build HTTP/HTTPS/SOCKS5 proxy agent options for TikTok API and WebSocket.

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getSettings, isValidProxyUrl } = require('./settings');

let cachedUrl = null;
let cachedAgent = null;

function getProxyAgent(overrideUrl) {
  const url = (overrideUrl !== undefined ? overrideUrl : getSettings().proxyUrl) || '';
  if (!url || !isValidProxyUrl(url)) return null;
  if (cachedAgent && cachedUrl === url) return cachedAgent;

  const parsed = new URL(url);
  if (parsed.protocol.startsWith('socks')) {
    cachedAgent = new SocksProxyAgent(url);
  } else {
    cachedAgent = new HttpsProxyAgent(url);
  }
  cachedUrl = url;
  return cachedAgent;
}

function getTikTokClientProxyOptions() {
  const agent = getProxyAgent();
  if (!agent) return {};
  return {
    webClientOptions: {
      agent: { https: agent, http: agent },
    },
    wsClientOptions: {
      agent,
    },
  };
}

function getFfmpegProxyArgs() {
  const url = getSettings().proxyUrl || '';
  if (!url || !isValidProxyUrl(url)) return [];
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return ['-http_proxy', url];
    }
  } catch { /* ignore */ }
  return [];
}

module.exports = {
  getProxyAgent,
  getTikTokClientProxyOptions,
  getFfmpegProxyArgs,
};
