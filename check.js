// check.js — Check whether a TikTok user is currently live.
// Usage: node check.js <username>
//   e.g. node check.js tv_asahi_news
//
// Exit codes:
//   0 = live
//   1 = not live
//   2 = error / user not found

require('dotenv').config();
const { normalizeUsername, fetchApiLive, buildSummary } = require('./lib/room');

async function main() {
  const username = normalizeUsername(process.argv[2]);
  if (!username) {
    console.error('Usage: node check.js <username>');
    process.exit(2);
  }

  try {
    const apiData = await fetchApiLive(username);
    const summary = buildSummary(username, apiData /* no streams */);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.live ? 0 : 1);
  } catch (err) {
    console.error('Error:', err?.message || err);
    process.exit(2);
  }
}

main();
