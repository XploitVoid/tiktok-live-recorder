// lib/providers/tiktok.js — TikTok LIVE provider adapter wrapping lib/room.js.

const room = require('../room');

module.exports = {
  id: 'tiktok',
  label: 'TikTok LIVE',
  referer: 'https://www.tiktok.com/',

  normalizeUsername(raw) {
    return room.normalizeUsername(raw);
  },

  fetchLiveStatus(rawUsername, opts = {}) {
    const username = room.normalizeUsername(rawUsername);
    if (!username) throw new Error('invalid tiktok username');
    return room.fetchApiLive(username, opts);
  },

  isLive(data) {
    return room.isLiveFromApi(data);
  },

  extractStreamUrls(data) {
    return room.extractStreamUrls(data);
  },

  pickPreferredStream(streams) {
    return room.pickPreferredStream(streams);
  },

  hasStreamUrls(streams) {
    return room.hasStreamUrls(streams);
  },

  buildSummary(username, data, streams) {
    return {
      platform: 'tiktok',
      ...room.buildSummary(username, data, streams),
    };
  },

  invalidateCache(username) {
    room.invalidateApiCache(username);
  },
};
