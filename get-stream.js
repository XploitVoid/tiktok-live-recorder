// get-stream.js — Print HLS / FLV pull URLs for a live TikTok user.
// Usage: node get-stream.js <username>
//   e.g. node get-stream.js tv_asahi_news
//
// Output is JSON on stdout. Exits non-zero if user is not live.

require('dotenv').config();
const {
  normalizeUsername,
  fetchApiLive,
  isLiveFromApi,
  extractStreamUrls,
  buildSummary,
} = require('./lib/room');

async function main() {
  const username = normalizeUsername(process.argv[2]);
  if (!username) {
    console.error('Usage: node get-stream.js <username>');
    process.exit(2);
  }

  try {
    const apiData = await fetchApiLive(username);
    if (!isLiveFromApi(apiData)) {
      console.error(`@${username} is not live right now.`);
      process.exit(1);
    }
    const streams = extractStreamUrls(apiData);
    const out = buildSummary(username, apiData, streams);
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('Error:', err?.message || err);
    process.exit(2);
  }
}

main();
