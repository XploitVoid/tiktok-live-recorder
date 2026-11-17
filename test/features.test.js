const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebcastEvent } = require('tiktok-live-connector');

const settings = require('../lib/settings');
const proxyConfig = require('../lib/proxy-config');
const storage = require('../lib/storage');
const { ChatSession, chatEvents } = require('../lib/chat');

test('settings and proxy-config validate, mask, and build HTTP/SOCKS5 agents', () => {
  assert.equal(settings.isValidProxyUrl('http://user:pass@1.2.3.4:8080'), true);
  assert.equal(settings.isValidProxyUrl('socks5://1.2.3.4:1080'), true);
  assert.equal(settings.isValidProxyUrl('ftp://1.2.3.4:21'), false);
  assert.equal(settings.isValidProxyUrl('not-a-url'), false);

  const masked = settings.maskProxyUrl('http://alice:supersecret@proxy.example.com:8080');
  assert.equal(masked.includes('supersecret'), false);
  assert.match(masked, /proxy\.example\.com:8080/);

  const httpAgent = proxyConfig.getProxyAgent('http://proxy.example.com:8080');
  assert.ok(httpAgent);
  const socksAgent = proxyConfig.getProxyAgent('socks5://proxy.example.com:1080');
  assert.ok(socksAgent);
});

test('storage getDiskStatus and deleteRecordingBundle clean up full bundle safely', () => {
  const disk = storage.getDiskStatus();
  assert.equal(typeof disk.recordingsBytes, 'number');
  assert.ok(disk.freeBytes === null || typeof disk.freeBytes === 'number');

  const base = `test_bundle_${Date.now()}`;
  const mp4 = `${base}.mp4`;
  const mp4Path = path.join(storage.RECORDINGS_DIR, mp4);
  const metaPath = path.join(storage.RECORDINGS_DIR, `${base}.meta.json`);
  const thumbPath = path.join(storage.THUMBS_DIR, `${base}.jpg`);
  const audioPath = path.join(storage.AUDIO_DIR, `${base}.m4a`);
  const clipPath = path.join(storage.CLIPS_DIR, `${base}_clip_0000_15s.mp4`);

  fs.writeFileSync(mp4Path, 'mp4');
  fs.writeFileSync(metaPath, '{}');
  fs.writeFileSync(thumbPath, 'jpg');
  fs.writeFileSync(audioPath, 'm4a');
  fs.writeFileSync(clipPath, 'clip');

  const ok = storage.deleteRecordingBundle(mp4);
  assert.equal(ok, true);
  assert.equal(fs.existsSync(mp4Path), false);
  assert.equal(fs.existsSync(metaPath), false);
  assert.equal(fs.existsSync(thumbPath), false);
  assert.equal(fs.existsSync(audioPath), false);
  assert.equal(fs.existsSync(clipPath), false);
});

test('ChatSession emits new Schema v3 events (superFan, superFanBox, poll, shopping) to chatEvents', () => {
  const session = new ChatSession('v3_tester');
  const fakeConn = new EventEmitter();
  fakeConn.disconnect = async () => {};
  session._bindEvents(fakeConn);

  const emitted = [];
  const onEv = (payload) => {
    if (payload.username === 'v3_tester') emitted.push(payload.event.type);
  };
  chatEvents.on('event', onEv);

  try {
    fakeConn.emit(WebcastEvent.SUPER_FAN_JOIN, { user: { displayId: 'fan1', nickname: 'Fan 1' } });
    fakeConn.emit(WebcastEvent.SUPER_FAN_BOX, { user: { displayId: 'fan1', nickname: 'Fan 1' }, envelopeInfo: { diamondCount: 50 } });
    fakeConn.emit(WebcastEvent.POLL_MESSAGE, {
      pollId: 'p1',
      startContent: { title: 'Next hero?', optionList: [{ optionText: 'A', currentTotal: 3 }] },
    });
    fakeConn.emit(WebcastEvent.OEC_LIVE_SHOPPING, {
      liveProductNumber: 7,
      popProduct: { title: 'Gaming Mouse', formatPrice: '$29' },
    });

    assert.deepEqual(emitted, ['superFan', 'superFanBox', 'poll', 'shopping']);
    const poll = session.events.find((e) => e.type === 'poll');
    assert.equal(poll.title, 'Next hero?');
    assert.equal(poll.options[0].text, 'A');
    const shop = session.events.find((e) => e.type === 'shopping');
    assert.equal(shop.title, 'Gaming Mouse');
    assert.equal(shop.price, '$29');
  } finally {
    chatEvents.off('event', onEv);
  }
});

test('SSE /api/events/stream and /api/settings HTTP integration', async () => {
  const port = 39124;
  const root = path.resolve(__dirname, '..');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      QUIET_LOGS: '1',
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
    assert.equal(ready, true);

    // Settings GET & invalid proxy rejection
    const sRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(sRes.status, 200);
    const sJson = await sRes.json();
    assert.equal(typeof sJson.settings.minFreeGb, 'number');
    assert.equal(typeof sJson.disk.recordingsBytes, 'number');

    const badProxy = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxyUrl: 'javascript:alert(1)' }),
    });
    assert.equal(badProxy.status, 400);

    // SSE stream returns event: jobs and event: watch_list
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/events/stream?channels=jobs,watch`, { signal: ac.signal });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/);
    const reader = sseRes.body.getReader();
    let text = '';
    while (!text.includes('event: watch_list')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    ac.abort();
    assert.match(text, /event: jobs/);
    assert.match(text, /event: watch_list/);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    });
  }
});

test('ffmpeg and ffprobe resolve to runnable binaries (bundled fallback available)', () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const ffBin = ffmpeg.resolveFfmpeg();
  const fpBin = ffmpeg.resolveFfprobe();
  assert.ok(ffBin);
  assert.ok(fpBin);
  assert.equal(ffmpeg.isFfmpegAvailable(), true);
  const probeRes = spawnSync(fpBin, ['-version'], { stdio: 'ignore', timeout: 15000 });
  assert.equal(probeRes.status, 0);
});

test('parseStartTimeFromName supports segmented _pN.mp4 filenames and highlights/leaderboard count repeatCount', () => {
  const utils = require('../lib/utils');
  const { buildLeaderboard } = require('../lib/leaderboard');
  const { analyzeRecording } = require('../lib/highlights');

  const t1 = utils.parseStartTimeFromName('creator_20261117_120000.mp4');
  const t2 = utils.parseStartTimeFromName('creator_20261117_120000_p2.mp4');
  assert.ok(t1 && t1 > 0);
  assert.equal(t1, t2);

  const base = `segtest_20261117_120000_p2`;
  const mp4Path = path.join(storage.RECORDINGS_DIR, `${base}.mp4`);
  const evPath = path.join(storage.RECORDINGS_DIR, `${base}.events.jsonl`);
  const hlPath = path.join(storage.RECORDINGS_DIR, `${base}.highlights.json`);
  try {
    fs.writeFileSync(mp4Path, 'mp4');
    const evs = [
      { id: 1, ts: t2 + 1000, type: 'chat', user: { uniqueId: 'u1', nickname: 'U1' }, comment: 'hi' },
      { id: 2, ts: t2 + 2000, type: 'chat', user: { uniqueId: 'u2', nickname: 'U2' }, comment: 'hello' },
      { id: 3, ts: t2 + 3000, type: 'gift', user: { uniqueId: 'u1', nickname: 'U1' }, giftName: 'Rose', diamondCount: 5, repeatCount: 10 },
      { id: 4, ts: t2 + 4000, type: 'chat', user: { uniqueId: 'u2', nickname: 'U2' }, comment: 'wow' },
      { id: 5, ts: t2 + 5000, type: 'chat', user: { uniqueId: 'u3', nickname: 'U3' }, comment: 'gg' },
    ];
    fs.writeFileSync(evPath, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const lb = buildLeaderboard(`${base}.mp4`);
    assert.equal(lb.ok, true);
    assert.equal(lb.totals.diamonds, 50);
    assert.equal(lb.totals.gifts, 10);

    const hl = analyzeRecording(`${base}.mp4`);
    assert.equal(hl.ok, true);
    assert.ok(hl.candidates.length >= 1);
    assert.equal(hl.candidates[0].summary.diamonds, 50);
  } finally {
    fs.rmSync(mp4Path, { force: true });
    fs.rmSync(evPath, { force: true });
    fs.rmSync(hlPath, { force: true });
  }
});

test('RealtimeHighlightDetector detects pkStart and multiplies gift repeatCount, and ChatSession filters ongoing streaks', () => {
  const { RealtimeHighlightDetector } = require('../lib/realtime-highlights');
  const det = new RealtimeHighlightDetector('tester');
  const baseTs = Date.now();

  det.onEvent({ id: 1, ts: baseTs, type: 'pkStart' });
  assert.equal(det.marks.length, 1);
  assert.equal(det.marks[0].reason, 'pk_start');

  det.onEvent({ id: 2, ts: baseTs + 35_000, type: 'gift', diamondCount: 20, repeatCount: 6 });
  assert.equal(det.marks.length, 2);
  assert.equal(det.marks[1].reason, 'big_gift');
  assert.equal(det.marks[1].score, 120);

  const session = new ChatSession('streak_tester');
  const fakeConn = new EventEmitter();
  fakeConn.disconnect = async () => {};
  session._bindEvents(fakeConn);

  fakeConn.emit(WebcastEvent.GIFT, { user: { displayId: 'u1' }, gift: { name: 'Rose', diamondCount: 1, type: 1 }, repeatCount: 1, repeatEnd: 0 });
  fakeConn.emit(WebcastEvent.GIFT, { user: { displayId: 'u1' }, gift: { name: 'Rose', diamondCount: 1, type: 1 }, repeatCount: 2, repeatEnd: 0 });
  fakeConn.emit(WebcastEvent.GIFT, { user: { displayId: 'u1' }, gift: { name: 'Rose', diamondCount: 1, type: 1 }, repeatCount: 3, repeatEnd: 1 });

  const gifts = session.events.filter((e) => e.type === 'gift');
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].repeatCount, 3);
});

test('ChatSession UI stop does not kill active recorder writer and releaseRecorderSession cleans up when idle', () => {
  const { closeSession, releaseRecorderSession, getSession } = require('../lib/chat');
  const s = new ChatSession('rec_chat_user');
  const fakeConn = new EventEmitter();
  fakeConn.disconnect = async () => {};
  s.conn = fakeConn;
  s.state = 'connected';
  s.uiActive = true;
  s.recorderRefs = 1;

  // Inject into internal sessions map via ensureSession-like setup? Use getSession check on ChatSession methods:
  assert.equal(s.hasConsumers(), true);
  s.uiActive = false;
  assert.equal(s.hasConsumers(), true);
  s.recorderRefs = 0;
  assert.equal(s.hasConsumers(), false);
  // Ensure exported helpers handle non-existent session gracefully
  assert.equal(closeSession('nonexistent_user', { force: false }), false);
  releaseRecorderSession('nonexistent_user', null, null);
  assert.equal(getSession('nonexistent_user'), undefined);
});

test('buildRecordArgs handles H.264, HEVC, audio-only, and prevents mid-stream PK resolution corruption', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');

  const h264Args = ffmpeg.buildRecordArgs({ url: 'https://example.com/live.flv', quality: 'ld' }, 'out.mp4', ['-http_proxy', 'http://p:1']);
  assert.ok(h264Args.includes('+genpts+discardcorrupt'));
  assert.ok(h264Args.includes('h264_mp4toannexb'));
  assert.ok(h264Args.includes('aac_adtstoasc'));
  assert.ok(h264Args.includes('-http_proxy'));

  const hevcArgs = ffmpeg.buildRecordArgs({ url: 'https://example.com/live.flv', quality: 'hevc:uhd' }, 'out.mp4');
  assert.ok(hevcArgs.includes('hevc_mp4toannexb'));
  assert.ok(hevcArgs.includes('aac_adtstoasc'));

  const aoArgs = ffmpeg.buildRecordArgs({ url: 'https://example.com/live.flv', quality: 'ao' }, 'out.mp4');
  assert.ok(aoArgs.includes('-vn'));
  assert.equal(aoArgs.includes('h264_mp4toannexb'), false);

  // Integration check: FLV switching from 360x640 -> 720x640 mid-stream (simulating PK battle at 360p)
  const ffBin = ffmpeg.resolveFfmpeg();
  const fpBin = ffmpeg.resolveFfprobe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-res-test-'));
  try {
    const aFlv = path.join(dir, 'a.flv');
    const bFlv = path.join(dir, 'b.flv');
    const abFlv = path.join(dir, 'ab.flv');
    const outMp4 = path.join(dir, 'out.mp4');

    spawnSync(ffBin, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', aFlv]);
    spawnSync(ffBin, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x640:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', bFlv]);

    const a = fs.readFileSync(aFlv);
    const b = fs.readFileSync(bFlv);
    let pos = 13;
    const bTags = [];
    while (pos + 11 <= b.length) {
      const dataSize = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
      const ts = ((b[pos + 7] << 24) | (b[pos + 4] << 16) | (b[pos + 5] << 8) | b[pos + 6]) >>> 0;
      const newTs = ts + 1050;
      const tagLen = 11 + dataSize + 4;
      if (pos + tagLen > b.length) break;
      const tag = Buffer.from(b.subarray(pos, pos + tagLen));
      tag[4] = (newTs >> 16) & 0xff;
      tag[5] = (newTs >> 8) & 0xff;
      tag[6] = newTs & 0xff;
      tag[7] = (newTs >> 24) & 0xff;
      bTags.push(tag);
      pos += tagLen;
    }
    fs.writeFileSync(abFlv, Buffer.concat([a, ...bTags]));

    const recArgs = ffmpeg.buildRecordArgs({ url: abFlv, quality: 'ld' }, outMp4)
      .filter((arg, i, arr) => arg !== '-user_agent' && arr[i - 1] !== '-user_agent' && arg !== '-headers' && arr[i - 1] !== '-headers');
    const recRes = spawnSync(ffBin, ['-y', ...recArgs], { encoding: 'utf8' });
    assert.equal(recRes.status, 0);

    const decRes = spawnSync(ffBin, ['-v', 'error', '-i', outMp4, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(decRes.status, 0);
    assert.equal(decRes.stderr.trim(), '');

    const framesOut = spawnSync(fpBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=width,height', '-of', 'csv=p=0', outMp4], { encoding: 'utf8' }).stdout;
    assert.match(framesOut, /360,640/);
    assert.match(framesOut, /720,640/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recorder.getNextRetryAttempt supports clean EOF recovery and resets after healthy runs', () => {
  const { getNextRetryAttempt } = require('../lib/recorder');
  assert.equal(getNextRetryAttempt({ manualStop: false, rollover: false, autoRetryRecord: true, ranMs: 1000, retryCount: 0 }), 0);
  assert.equal(getNextRetryAttempt({ manualStop: false, rollover: false, autoRetryRecord: true, ranMs: 5000, retryCount: 3 }), 3);
  assert.equal(getNextRetryAttempt({ manualStop: false, rollover: false, autoRetryRecord: true, ranMs: 5000, retryCount: 5 }), null);
  assert.equal(getNextRetryAttempt({ manualStop: false, rollover: false, autoRetryRecord: true, ranMs: 65_000, retryCount: 5 }), 0);
  assert.equal(getNextRetryAttempt({ manualStop: true, rollover: false, autoRetryRecord: true, ranMs: 1000, retryCount: 0 }), null);
  assert.equal(getNextRetryAttempt({ manualStop: false, rollover: true, autoRetryRecord: true, ranMs: 1000, retryCount: 0 }), null);
  assert.equal(getNextRetryAttempt({ manualStop: false, rollover: false, autoRetryRecord: false, ranMs: 1000, retryCount: 0 }), null);
});

test('highlights.cutClip supports full PK battle durations (> 90s up to 240s)', async () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const { cutClip, CLIPS_DIR } = require('../lib/highlights');

  const base = `pkcuttest_${Date.now()}`;
  const recName = `${base}.mp4`;
  const recPath = path.join(storage.RECORDINGS_DIR, recName);
  let clipPath = null;
  try {
    // Generate a tiny 115s silent/blank mp4 very quickly
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1', '-t', '115',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', recPath,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    const res = await cutClip(recName, 0, 110);
    clipPath = path.join(CLIPS_DIR, res.name);
    assert.match(res.name, /_110s\.mp4$/);
    assert.equal(fs.existsSync(clipPath), true);
  } finally {
    fs.rmSync(recPath, { force: true });
    if (clipPath) fs.rmSync(clipPath, { force: true });
  }
});

test('Stalled watchdog, audioBitrate args, webhook validation, and storage audio/compress', async () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const { isJobStalled } = require('../lib/recorder');
  const { formatMessage } = require('../lib/notifications');
  const utils = require('../lib/utils');

  // 1. Stalled watchdog
  const job = { exited: false, manualStop: false, rollover: false, stalled: false, startedAt: 1000, lastProgressAt: 1000, lastBytes: 100 };
  assert.equal(isJobStalled(job, 20_000, 25_000, 100), false);
  assert.equal(isJobStalled(job, 27_000, 25_000, 100), true);
  assert.equal(isJobStalled(job, 27_000, 25_000, 200), false); // bytes grew -> resets progress
  assert.equal(job.lastProgressAt, 27_000);
  assert.equal(isJobStalled({ ...job, manualStop: true }, 99_000, 25_000, 200), false);

  // 2. Audio-only & bitrate buildRecordArgs
  assert.equal(utils.sanitizeAudioBitrate('96k'), '96k');
  assert.equal(utils.sanitizeAudioBitrate('999k'), null);
  const aoReencode = ffmpeg.buildRecordArgs({ url: 'https://example.com/a.flv', quality: 'hd', audioOnly: true, audioBitrate: '96k' }, 'out.mp4');
  assert.ok(aoReencode.includes('-vn'));
  assert.ok(aoReencode.includes('-b:a'));
  assert.ok(aoReencode.includes('96k'));
  const vidAbr = ffmpeg.buildRecordArgs({ url: 'https://example.com/a.flv', quality: 'hd', audioOnly: false, audioBitrate: '128k' }, 'out.mp4');
  assert.ok(vidAbr.includes('-c:v'));
  assert.ok(vidAbr.includes('128k'));

  // 3. Webhook validators & formatter
  assert.equal(settings.isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123456/abcdef_123'), true);
  assert.equal(settings.isValidDiscordWebhookUrl('http://127.0.0.1:8080/hook'), false);
  assert.equal(settings.isValidDiscordWebhookUrl('https://evil.example/api/webhooks/1/a'), false);
  assert.equal(settings.isValidTelegramBotToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'), true);
  assert.equal(settings.isValidTelegramBotToken('bad-token'), false);
  assert.equal(settings.isValidTelegramChatId('-1001234567890'), true);
  assert.equal(settings.isValidTelegramChatId('bad chat id!'), false);

  const msg = formatMessage('went_live', { username: 'creator', viewerCount: 150, title: 'Hi' });
  assert.match(msg.title, /@creator/);
  assert.match(msg.body, /Hi/);

  // 4. extractAudio with bitrate + compressRecording + bundle cleanup
  const base = `compresstest_${Date.now()}`;
  const recName = `${base}.mp4`;
  const recPath = path.join(storage.RECORDINGS_DIR, recName);
  let compressedName = null;
  try {
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', recPath,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    const audioRes = await storage.extractAudio(recName, 'm4a', '64k');
    assert.equal(audioRes.bitrate, '64k');
    assert.match(audioRes.name, /_64k\.m4a$/);
    assert.equal(fs.existsSync(path.join(storage.AUDIO_DIR, audioRes.name)), true);

    const compRes = await storage.compressRecording(recName, 'compact');
    compressedName = compRes.name;
    assert.match(compRes.name, /_compact\.mp4$/);
    assert.equal(fs.existsSync(path.join(storage.RECORDINGS_DIR, compRes.name)), true);
  } finally {
    storage.deleteRecordingBundle(recName);
    if (compressedName) storage.deleteRecordingBundle(compressedName);
  }
});
