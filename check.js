// check.js — Check whether a TikTok user is currently live.
// Usage: node check.js <username>
//   e.g. node check.js tv_asahi_news
//
// Exit codes:
//   0 = live
//   1 = not live
//   2 = error / user not found

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
if (!process.env.QUIET_LOGS) process.env.QUIET_LOGS = '1';
const { normalizeUsername, fetchApiLive, buildSummary } = require('./lib/room');
const { safeError } = require('./lib/utils');

async function main() {
  const username = normalizeUsername(process.argv[2]);
  if (!username) {
    console.error('Usage: node check.js <username>');
    process.exitCode = 2;
    return;
  }

  try {
    const apiData = await fetchApiLive(username);
    const summary = buildSummary(username, apiData /* no streams */);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.live ? 0 : 1;
  } catch (err) {
    console.error('Error:', safeError(err));
    process.exitCode = 2;
  }
}

main();
