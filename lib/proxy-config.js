// lib/proxy-config.js — Build HTTP/HTTPS/SOCKS5 proxy agent options with failover rotation.

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getSettings, parseProxyList, isValidProxyUrl } = require('./settings');

const agentCache = new Map();
const MAX_AGENT_CACHE = 32;
let activeProxyIdx = 0;

let lastSocksWarnAt = 0;

function getProxyList() {
  return parseProxyList(getSettings().proxyUrl || '');
}

function getActiveProxyUrl() {
  const list = getProxyList();
  if (list.length === 0) return '';
  return list[activeProxyIdx % list.length] || '';
}

function rotateProxy(failedUrl = null) {
  const list = getProxyList();
  if (list.length <= 1) return null;
  const curIdx = activeProxyIdx % list.length;
  if (failedUrl && list[curIdx] !== failedUrl) {
    return list[curIdx];
  }
  activeProxyIdx = (curIdx + 1) % list.length;
  const next = list[activeProxyIdx];
  console.warn(`[proxy] rotated to failover proxy #${activeProxyIdx + 1}/${list.length}`);
  return next;
}

function getProxyAgent(overrideUrl) {
  const raw = overrideUrl !== undefined ? overrideUrl : getActiveProxyUrl();
  const url = typeof raw === 'string' ? (parseProxyList(raw)[0] || '') : '';
  if (!url || !isValidProxyUrl(url)) return null;
  if (agentCache.has(url)) {
    const cached = agentCache.get(url);
    agentCache.delete(url);
    agentCache.set(url, cached);
    return cached;
  }

  try {
    const parsed = new URL(url);
    const agent = parsed.protocol.startsWith('socks')
      ? new SocksProxyAgent(url)
      : new HttpsProxyAgent(url);
    if (agentCache.size >= MAX_AGENT_CACHE) {
      const oldestKey = agentCache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestAgent = agentCache.get(oldestKey);
        agentCache.delete(oldestKey);
        try { oldestAgent?.destroy?.(); } catch {}
      }
    }
    agentCache.set(url, agent);
    return agent;
  } catch {
    return null;
  }
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

function getFfmpegProxyEnv() {
  const url = getActiveProxyUrl();
  if (!url || !isValidProxyUrl(url)) return {};
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return {
        http_proxy: url,
        https_proxy: url,
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
      };
    }
    if (parsed.protocol.startsWith('socks')) {
      const now = Date.now();
      if (now - lastSocksWarnAt > 60_000) {
        lastSocksWarnAt = now;
        console.warn('[proxy] SOCKS proxy configured, but FFmpeg does not support SOCKS natively — media traffic will connect directly without SOCKS proxy');
      }
    }
  } catch { /* ignore */ }
  return {};
}

module.exports = {
  getProxyList,
  getActiveProxyUrl,
  rotateProxy,
  getProxyAgent,
  getTikTokClientProxyOptions,
  getFfmpegProxyArgs,
  getFfmpegProxyEnv,
};
