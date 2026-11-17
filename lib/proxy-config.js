// lib/proxy-config.js — Build HTTP/HTTPS/SOCKS5 proxy agent options with failover rotation.

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getSettings, parseProxyList, isValidProxyUrl } = require('./settings');

const agentCache = new Map();
let activeProxyIdx = 0;

function getProxyList() {
  return parseProxyList(getSettings().proxyUrl || '');
}

function getActiveProxyUrl() {
  const list = getProxyList();
  if (list.length === 0) return '';
  return list[activeProxyIdx % list.length] || '';
}

function rotateProxy() {
  const list = getProxyList();
  if (list.length <= 1) return null;
  activeProxyIdx = (activeProxyIdx + 1) % list.length;
  const next = list[activeProxyIdx];
  console.warn(`[proxy] rotated to failover proxy #${activeProxyIdx + 1}/${list.length}`);
  return next;
}

function getProxyAgent(overrideUrl) {
  const url = (overrideUrl !== undefined ? overrideUrl : getActiveProxyUrl()) || '';
  if (!url || !isValidProxyUrl(url)) return null;
  if (agentCache.has(url)) return agentCache.get(url);

  const parsed = new URL(url);
  const agent = parsed.protocol.startsWith('socks')
    ? new SocksProxyAgent(url)
    : new HttpsProxyAgent(url);
  agentCache.set(url, agent);
  return agent;
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
  const url = getActiveProxyUrl();
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
  getProxyList,
  getActiveProxyUrl,
  rotateProxy,
  getProxyAgent,
  getTikTokClientProxyOptions,
  getFfmpegProxyArgs,
};
