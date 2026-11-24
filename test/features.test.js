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
  assert.equal(settings.isValidTelegramBotToken(['123456789', 'AA' + 'x'.repeat(33)].join(':')), true);
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

test('Pin/protect, notes/title, sprite sheet, faststart remux, pk-split 9:16, schedule, and proxy failover', async () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const { cutClip, CLIPS_DIR, highlightsEvents } = require('../lib/highlights');
  const watcher = require('../lib/watcher');
  const accounts = require('../lib/accounts');

  // 1. Proxy failover list parsing, validation, and masking
  assert.equal(settings.isValidProxyUrl('http://a:b@p1.example:8080, socks5://p2.example:1080'), true);
  assert.equal(settings.isValidProxyUrl('http://p1.example:8080, ftp://bad.example:21'), false);
  assert.equal(settings.parseProxyList('http://p1:80\nsocks5://p2:1080').length, 2);
  const maskedList = settings.maskProxyUrl('http://alice:secret@p1.example:8080, socks5://p2.example:1080');
  assert.equal(maskedList.includes('secret'), false);
  assert.match(maskedList, /p1\.example:8080/);
  assert.match(maskedList, /p2\.example:1080/);

  // 2. Schedule helper (daytime and overnight wrap)
  const d10 = new Date(2026, 10, 17, 10, 30);
  const d23 = new Date(2026, 10, 17, 23, 0);
  const d02 = new Date(2026, 10, 18, 2, 0);
  const d04 = new Date(2026, 10, 18, 4, 0);
  assert.equal(watcher.isWithinSchedule(d10, '09:00', '17:00'), true);
  assert.equal(watcher.isWithinSchedule(d23, '09:00', '17:00'), false);
  assert.equal(watcher.isWithinSchedule(d23, '18:00', '03:00'), true);
  assert.equal(watcher.isWithinSchedule(d02, '18:00', '03:00'), true);
  assert.equal(watcher.isWithinSchedule(d04, '18:00', '03:00'), false);

  // 3. Per-channel anonymous credentials lookup
  assert.deepEqual(accounts.getCredentialsById('anon'), { id: 'anon', sessionId: '', ttTargetIdc: '' });

  // 4. Meta protection, faststart remux, sprite sheet, and pk-split 9:16 cut + progress
  const base = `v2quick_${Date.now()}`;
  const recName = `${base}.mp4`;
  const recPath = path.join(storage.RECORDINGS_DIR, recName);
  let pkClipPath = null;
  try {
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', recPath,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    const remuxOk = await storage.remuxFaststart(recName);
    assert.equal(remuxOk, true);

    const updated = storage.updateRecordingMeta(recName, {
      protected: true,
      displayTitle: 'My Special Live',
      notes: 'PK battle highlight',
    });
    assert.equal(updated.protected, true);
    assert.equal(updated.displayTitle, 'My Special Live');
    assert.equal(updated.notes, 'PK battle highlight');

    const metaAfter = await storage.ensureThumbnailAndMeta(recName, { force: true });
    assert.equal(metaAfter.protected, true);
    assert.equal(metaAfter.displayTitle, 'My Special Live');
    assert.ok(metaAfter.spriteUrl);
    assert.ok(metaAfter.spriteMeta && metaAfter.spriteMeta.cols === 8);

    // Retention cleanup must NOT delete protected file even if aged
    const oldMs = Date.now() - 100 * 24 * 60 * 60 * 1000;
    fs.utimesSync(recPath, oldMs / 1000, oldMs / 1000);
    const prevSettings = settings.getSettings();
    try {
      settings.updateSettings({ retentionDays: 1 });
      const clean = storage.enforceRetention(new Set());
      assert.equal(clean.deleted.includes(recName), false);
      assert.equal(fs.existsSync(recPath), true);
    } finally {
      settings.updateSettings({ retentionDays: prevSettings.retentionDays });
    }

    // pk-split 9:16 clip cut + progress events
    const progressEvents = [];
    const onProg = (ev) => { if (ev.recording === recName) progressEvents.push(ev.percent); };
    highlightsEvents.on('cut_progress', onProg);
    try {
      const pkRes = await cutClip(recName, 0, 2, { vertical: 'pk-split' });
      pkClipPath = path.join(CLIPS_DIR, pkRes.name);
      assert.match(pkRes.name, /_916pk\.mp4$/);
      assert.equal(fs.existsSync(pkClipPath), true);
      assert.ok(progressEvents.includes(100));

      const dimOut = spawnSync(ffmpeg.resolveFfprobe(), [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', pkClipPath,
      ], { encoding: 'utf8' }).stdout.trim();
      assert.equal(dimOut, '1080,1920');
    } finally {
      highlightsEvents.off('cut_progress', onProg);
    }
  } finally {
    storage.deleteRecordingBundle(recName);
    if (pkClipPath) fs.rmSync(pkClipPath, { force: true });
  }
});

test('Compressed _balanced/_compact recordings preserve startMs, highlights, and gift economy; ChatSession reconnect continues on failure', async () => {
  const utils = require('../lib/utils');
  const { analyzeRecording } = require('../lib/highlights');
  const { buildGiftEconomy } = require('../lib/analytics');

  const tBase = utils.parseStartTimeFromName('creator_20261117_120000.mp4');
  const tBal = utils.parseStartTimeFromName('creator_20261117_120000_balanced.mp4');
  const tComp = utils.parseStartTimeFromName('creator_20261117_120000_p2_compact.mp4');
  assert.ok(tBase && tBase > 0);
  assert.equal(tBal, tBase);
  assert.equal(tComp, tBase);

  const base = `compreplay${Date.now()}_20261117_120000_balanced`;
  const mp4Path = path.join(storage.RECORDINGS_DIR, `${base}.mp4`);
  const evPath = path.join(storage.RECORDINGS_DIR, `${base}.events.jsonl`);
  const hlPath = path.join(storage.RECORDINGS_DIR, `${base}.highlights.json`);
  try {
    fs.writeFileSync(mp4Path, 'mp4');
    const evs = [
      { id: 1, ts: tBase + 1000, type: 'chat', user: { uniqueId: 'u1' }, comment: 'one' },
      { id: 2, ts: tBase + 2000, type: 'chat', user: { uniqueId: 'u2' }, comment: 'two' },
      { id: 3, ts: tBase + 3000, type: 'gift', user: { uniqueId: 'u1' }, giftName: 'Rose', diamondCount: 10, repeatCount: 2 },
      { id: 4, ts: tBase + 4000, type: 'chat', user: { uniqueId: 'u3' }, comment: 'three' },
      { id: 5, ts: tBase + 5000, type: 'chat', user: { uniqueId: 'u4' }, comment: 'four' },
    ];
    fs.writeFileSync(evPath, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const hl = analyzeRecording(`${base}.mp4`);
    assert.equal(hl.ok, true);
    assert.ok(hl.candidates.length >= 1);

    const ge = buildGiftEconomy(`${base}.mp4`);
    assert.equal(ge.ok, true);
    assert.equal(ge.totals.diamonds, 20);
  } finally {
    fs.rmSync(mp4Path, { force: true });
    fs.rmSync(evPath, { force: true });
    fs.rmSync(hlPath, { force: true });
  }

  // ChatSession._scheduleReconnect retries after failed connect() when consumers exist
  const s = new ChatSession('retry_tester');
  s.uiActive = true;
  let attempts = 0;
  s.connect = async () => {
    attempts++;
    if (attempts < 2) throw new Error('temp network error');
    s.state = 'connected';
  };
  const origSetTimeout = global.setTimeout;
  try {
    global.setTimeout = (fn) => origSetTimeout(fn, 5);
    s._scheduleReconnect();
    await new Promise((r) => origSetTimeout(r, 60));
    assert.equal(attempts, 2);
    assert.equal(s.state, 'connected');
  } finally {
    global.setTimeout = origSetTimeout;
    s.disconnect();
  }
});

test('Env parsers, storage bundle isolation, meta race safety, analytics repeatCount, and ChatSession timer/manualClose fixes', async () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const utils = require('../lib/utils');
  const { buildGiftEconomy } = require('../lib/analytics');
  const { cutClip } = require('../lib/highlights');

  // 1. Env var parsing: '0' stays 0, DISABLE_AUTO_RETRY=0 keeps retry enabled
  assert.equal(settings.parseEnvNumber('0', 25), 0);
  assert.equal(settings.parseEnvNumber('', 25), 25);
  assert.equal(settings.parseEnvBoolFlag('0'), false);
  assert.equal(settings.parseEnvBoolFlag('false'), false);
  assert.equal(settings.parseEnvBoolFlag('1'), true);

  // 2. deleteRecordingBundle must NOT delete _balanced/_p2 audio, and compressRecording rejects double compression
  const base = `isoltest_${Date.now()}`;
  const origMp4 = `${base}.mp4`;
  const balMp4 = `${base}_balanced.mp4`;
  const origMp4Path = path.join(storage.RECORDINGS_DIR, origMp4);
  const balMp4Path = path.join(storage.RECORDINGS_DIR, balMp4);
  const balAudioPath = path.join(storage.AUDIO_DIR, `${base}_balanced.m4a`);
  try {
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', origMp4Path,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    await storage.compressRecording(origMp4, 'balanced');
    fs.writeFileSync(balAudioPath, 'm4a-balanced');

    // Re-compressing _balanced with compact produces _compact.mp4 AND _compact.events.jsonl (not _balanced_compact.events.jsonl)
    const balEvPath = path.join(storage.RECORDINGS_DIR, `${base}_balanced.events.jsonl`);
    const compMp4 = `${base}_compact.mp4`;
    const compEvPath = path.join(storage.RECORDINGS_DIR, `${base}_compact.events.jsonl`);
    const badCompEvPath = path.join(storage.RECORDINGS_DIR, `${base}_balanced_compact.events.jsonl`);
    fs.writeFileSync(balEvPath, '{"id":1,"ts":1000,"type":"chat","comment":"hi"}\n');
    try {
      const reComp = await storage.compressRecording(balMp4, 'compact');
      assert.equal(reComp.name, compMp4);
      assert.equal(fs.existsSync(compEvPath), true);
      assert.equal(fs.existsSync(badCompEvPath), false);
    } finally {
      try { storage.deleteRecordingBundle(compMp4); } catch {}
      try { fs.unlinkSync(balEvPath); } catch {}
      try { fs.unlinkSync(compEvPath); } catch {}
      try { fs.unlinkSync(badCompEvPath); } catch {}
    }

    // Compressing already-balanced with balanced rejects with ALREADY_COMPRESSED
    await assert.rejects(() => storage.compressRecording(balMp4, 'balanced'), { code: 'ALREADY_COMPRESSED' });

    // Deleting original must leave _balanced.m4a intact
    storage.deleteRecordingBundle(origMp4);
    assert.equal(fs.existsSync(balAudioPath), true);

    // Concurrent meta update during ensureThumbnailAndMeta is preserved
    const meta = await storage.ensureThumbnailAndMeta(balMp4, { force: true });
    assert.ok(meta?.hasMeta);
    storage.updateRecordingMeta(balMp4, { protected: true, displayTitle: 'Keep Me' });
    const meta2 = await storage.ensureThumbnailAndMeta(balMp4, { force: true });
    assert.equal(meta2.protected, true);
    assert.equal(meta2.displayTitle, 'Keep Me');
  } finally {
    try { storage.deleteRecordingBundle(origMp4); } catch {}
    try { storage.deleteRecordingBundle(balMp4); } catch {}
    try { fs.unlinkSync(balAudioPath); } catch {}
  }

  // 3. Analytics: malformed ts does not throw RangeError, totals.gifts sums repeatCount, cutClip rejects bad name asynchronously
  const abase = `anatest_20261117_120000`;
  const amp4 = `${abase}.mp4`;
  const amp4Path = path.join(storage.RECORDINGS_DIR, amp4);
  const aevPath = path.join(storage.RECORDINGS_DIR, `${abase}.events.jsonl`);
  const t0 = utils.parseStartTimeFromName(amp4);
  try {
    fs.writeFileSync(amp4Path, 'mp4');
    fs.writeFileSync(aevPath, [
      JSON.stringify({ id: 1, ts: t0 + 1000, type: 'gift', giftName: 'Rose', diamondCount: 2, repeatCount: 5 }),
      JSON.stringify({ id: 2, ts: 'bad-ts', type: 'chat', comment: 'oops' }),
    ].join('\n') + '\n');
    const ge = buildGiftEconomy(amp4);
    assert.equal(ge.ok, true);
    assert.equal(ge.totals.gifts, 5);
    assert.equal(ge.totals.diamonds, 10);
    await assert.rejects(() => cutClip('bad.txt', 0, 5), { code: 'BAD_NAME' });
    await assert.rejects(() => cutClip(amp4, -10, -5), { code: 'BAD_RANGE' });
  } finally {
    fs.rmSync(amp4Path, { force: true });
    fs.rmSync(aevPath, { force: true });
  }

  // 4. ChatSession clears stale reconnectTimer when fallback connect() succeeds, and respects manualClose
  const cs = new ChatSession('timer_test_user');
  cs.uiActive = true;
  let connectCount = 0;
  cs._createConnection = () => {
    const conn = new EventEmitter();
    conn.disconnect = async () => {};
    conn.connect = async () => {
      connectCount++;
      if (connectCount === 1) {
        conn.emit('disconnected'); // would arm reconnectTimer if not ignored/cleared
        throw new Error('Error connecting to WebSocket with message: DEVICE_BLOCKED');
      }
      return { roomId: '999' };
    };
    return conn;
  };
  await cs.connect();
  assert.equal(cs.state, 'connected');
  assert.equal(cs.reconnectTimer, null);
  cs.disconnect();

  const cs2 = new ChatSession('manual_close_test');
  cs2.uiActive = true;
  cs2._createConnection = () => {
    const conn = new EventEmitter();
    conn.disconnect = async () => {};
    conn.connect = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { roomId: '123' };
    };
    return conn;
  };
  const p = cs2.connect();
  cs2.disconnect();
  await assert.rejects(() => p, /connection closed/);
  assert.equal(cs2.state, 'closed');
});

test('recorder.createStderrParser buffers split progress chunks and shouldExposeStderrOnExit filters clean exits', () => {
  const { createStderrParser, shouldExposeStderrOnExit } = require('../lib/recorder');

  const statsEvents = [];
  const errorLines = [];
  const parser = createStderrParser({
    onStats: (s) => statsEvents.push(s),
    onErrorLine: (line) => errorLines.push(line),
  });

  // Chunk-split FFmpeg progress line (exact split across tokens like Windows pipe reads)
  parser.push(Buffer.from('frame=20388 fps= 60 q=-1.'));
  parser.push(Buffer.from('0 size= 171008KiB t'));
  parser.push(Buffer.from('ime=00:05:40.18 bitrate=4120.5kbits/s speed=1.01x elapsed=0:05:39.50\r'));

  assert.equal(statsEvents.length, 1);
  assert.deepEqual(statsEvents[0], {
    outTime: '00:05:40',
    bitrate: '4120.5kbits/s',
    speed: '1.01x',
    fps: 60,
  });
  assert.deepEqual(errorLines, []);

  // Final muxing summary and trailing truncated progress fragment must not be flagged as errors
  parser.push('video:165000kB audio:6000kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.12%\n');
  parser.push('frame=20758 fps= 60 q=-1.0');
  parser.flush();
  assert.deepEqual(errorLines, []);

  // Real FFmpeg errors (terminated by newline or flushed without trailing newline) ARE captured
  parser.push('Server returned 403 Forbidden\n');
  parser.push('Connection reset by peer');
  parser.flush();
  assert.deepEqual(errorLines, [
    'Server returned 403 Forbidden',
    'Connection reset by peer',
  ]);

  assert.equal(shouldExposeStderrOnExit({ code: 0, manualStop: false, errMsg: null }), false);
  assert.equal(shouldExposeStderrOnExit({ code: null, manualStop: true, errMsg: null }), false);
  assert.equal(shouldExposeStderrOnExit({ code: 1, manualStop: false, errMsg: null }), true);
  assert.equal(shouldExposeStderrOnExit({ code: -1, manualStop: false, errMsg: 'ENOENT' }), true);
});

test('mergeRecordingParts combines mp4s, events.jsonl, protected flag, and deletes unprotected sources', async () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const utils = require('../lib/utils');

  const stamp = `mergetest_${Date.now()}_20261124_120000`;
  const p1 = `${stamp}_p1.mp4`;
  const p2 = `${stamp}_p2.mp4`;
  const p1Path = path.join(storage.RECORDINGS_DIR, p1);
  const p2Path = path.join(storage.RECORDINGS_DIR, p2);
  const ev1Path = path.join(storage.RECORDINGS_DIR, `${stamp}_p1.events.jsonl`);
  const ev2Path = path.join(storage.RECORDINGS_DIR, `${stamp}_p2.events.jsonl`);
  let mergedName = null;

  try {
    const ffBin = ffmpeg.resolveFfmpeg();
    const fpBin = ffmpeg.resolveFfprobe();
    for (const out of [p1Path, p2Path]) {
      const gen = spawnSync(ffBin, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
      ], { encoding: 'utf8' });
      assert.equal(gen.status, 0);
    }

    const baseTs = utils.parseStartTimeFromName(p1);
    fs.writeFileSync(ev1Path, JSON.stringify({ id: 1, ts: baseTs + 500, type: 'chat', user: { uniqueId: 'u1' }, comment: 'p1' }) + '\n');
    fs.writeFileSync(ev2Path, [
      JSON.stringify({ id: 1, ts: baseTs + 500, type: 'chat', user: { uniqueId: 'u1' }, comment: 'p1' }),
      JSON.stringify({ id: 2, ts: baseTs + 1500, type: 'chat', user: { uniqueId: 'u2' }, comment: 'p2' }),
    ].join('\n') + '\n');

    storage.updateRecordingMeta(p1, { protected: true });

    await assert.rejects(() => storage.mergeRecordingParts(['../evil.mp4', p1]), { code: 'BAD_INPUT' });
    await assert.rejects(() => storage.mergeRecordingParts(['..\\evil.mp4', p1]), { code: 'BAD_INPUT' });
    await assert.rejects(() => storage.mergeRecordingParts([p1]), { code: 'BAD_INPUT' });
    await assert.rejects(() => storage.mergeRecordingParts([p1, p2], { activeFiles: new Set([p1Path]) }), { code: 'ACTIVE_RECORDING' });

    const res = await storage.mergeRecordingParts([p1, p2], { deleteSources: true });
    mergedName = res.name;
    assert.match(mergedName, /_merged\.mp4$/);
    assert.equal(res.hasEvents, true);
    assert.deepEqual(res.deletedSources, [p2]);
    assert.equal(fs.existsSync(p1Path), true);
    assert.equal(fs.existsSync(p2Path), false);

    assert.equal(utils.parseStartTimeFromName(mergedName), baseTs);
    assert.equal(utils.parseStartTimeFromName(`${stamp}_balanced_merged.mp4`), baseTs);
    assert.equal(storage.readMeta(mergedName)?.protected, true);

    const durOut = spawnSync(fpBin, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1',
      path.join(storage.RECORDINGS_DIR, mergedName),
    ], { encoding: 'utf8' }).stdout.trim();
    assert.ok(Number(durOut) >= 1.8 && Number(durOut) <= 2.5, `expected ~2s duration, got ${durOut}`);

    const mergedEvents = utils.readEvents(path.join(storage.RECORDINGS_DIR, mergedName.replace(/\.mp4$/i, '.events.jsonl')));
    assert.equal(mergedEvents.length, 2);
    assert.equal(mergedEvents[0].comment, 'p1');
    assert.equal(mergedEvents[1].comment, 'p2');
  } finally {
    try { storage.deleteRecordingBundle(p1); } catch {}
    try { storage.deleteRecordingBundle(p2); } catch {}
    if (mergedName) try { storage.deleteRecordingBundle(mergedName); } catch {}
  }
});

test('cutLiveClipFromFile cuts fragmented MP4 and cutLiveClip rejects missing job', async () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const { cutLiveClip, cutLiveClipFromFile } = require('../lib/recorder');
  const { CLIPS_DIR } = require('../lib/highlights');

  await assert.rejects(() => cutLiveClip(999999, 30), { code: 'NOT_FOUND' });

  const base = `livecliptest_${Date.now()}`;
  const recPath = path.join(storage.RECORDINGS_DIR, `${base}.mp4`);
  let clipPath = null;
  try {
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-movflags', '+empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '1000000',
      recPath,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    const res = await cutLiveClipFromFile(recPath, 5, 2);
    assert.equal(res.ok, true);
    assert.match(res.name, /_clip_\d+_\d+s_live\.mp4$/);
    clipPath = path.join(CLIPS_DIR, res.name);
    assert.equal(fs.existsSync(clipPath), true);
    assert.ok(res.sizeBytes > 0);
  } finally {
    fs.rmSync(recPath, { force: true });
    if (clipPath) fs.rmSync(clipPath, { force: true });
  }
});

test('accounts.validateCookie, settings.autoMergeParts, and v2 notifications work properly', async () => {
  const accounts = require('../lib/accounts');
  const { formatMessage } = require('../lib/notifications');

  const valid = await accounts.validateCookie(
    { sessionId: 'dummy_session_value_1234' },
    { requestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ message: 'success', data: { user_id_str: '123', username: 'alice' } }) }) },
  );
  assert.equal(valid.status, 'valid');
  assert.equal(valid.username, 'alice');

  const expired = await accounts.validateCookie(
    { sessionId: 'dummy_session_value_1234' },
    { requestImpl: async () => ({ statusCode: 200, body: JSON.stringify({ message: 'error', data: { error_code: 10009, description: 'Session expired' } }) }) },
  );
  assert.equal(expired.status, 'expired');

  const unknown = await accounts.validateCookie(
    { sessionId: 'dummy_session_value_1234' },
    { requestImpl: async () => { throw new Error('network down'); } },
  );
  assert.equal(unknown.status, 'unknown');

  const rateLimited = await accounts.validateCookie(
    { sessionId: 'dummy_session_value_1234' },
    { requestImpl: async () => ({ statusCode: 429, body: '' }) },
  );
  assert.equal(rateLimited.status, 'unknown');

  const missing = await accounts.validateCookie({ sessionId: '' });
  assert.equal(missing.status, 'expired');

  const prev = settings.getSettings();
  try {
    const pub = settings.updateSettings({ autoMergeParts: false });
    assert.equal(pub.autoMergeParts, false);
    assert.equal(settings.getSettings().autoMergeParts, false);
  } finally {
    settings.updateSettings({ autoMergeParts: prev.autoMergeParts });
  }

  const mCookie = formatMessage('cookie_expired', { label: 'Main', reason: 'Session expired' });
  assert.match(mCookie.title, /expired/i);
  assert.match(mCookie.body, /Main/);

  const mMerge = formatMessage('parts_merged', { username: 'creator', partsCount: 3, file: 'a_merged.mp4', sizeMb: '12.5' });
  assert.match(mMerge.title, /@creator/);
  assert.match(mMerge.body, /3 parts/);
});

test('resolveRecordingPath, renderRecordingFilename, and TS capture + remuxTsToMp4 work safely', async () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const utils = require('../lib/utils');

  // 1. resolveRecordingPath accepts flat & 1-level creator folders, rejects traversal/reserved/nested
  const flat = utils.resolveRecordingPath(storage.RECORDINGS_DIR, 'alice_20261124_120000.mp4', '.mp4');
  assert.equal(flat?.name, 'alice_20261124_120000.mp4');
  assert.equal(flat?.folder, null);
  assert.equal(flat?.artifactStem, 'alice_20261124_120000');

  const sub = utils.resolveRecordingPath(storage.RECORDINGS_DIR, 'alice/alice_20261124_120000.mp4', '.mp4');
  assert.equal(sub?.name, 'alice/alice_20261124_120000.mp4');
  assert.equal(sub?.folder, 'alice');
  assert.equal(sub?.artifactStem, 'alice__alice_20261124_120000');

  for (const bad of [
    '../evil.mp4',
    '..\\evil.mp4',
    'alice\\file.mp4',
    'a/b/c.mp4',
    'thumbs/a.mp4',
    'audio/a.mp4',
    'highlights/a.mp4',
    '.hidden/a.mp4',
    'alice/.secret.mp4',
  ]) {
    assert.equal(utils.resolveRecordingPath(storage.RECORDINGS_DIR, bad, '.mp4'), null, `expected null for ${bad}`);
  }

  // 2. renderRecordingFilename + parseStartTimeFromName
  const dt = new Date(2026, 10, 24, 15, 30, 45);
  const f1 = utils.renderRecordingFilename('{username}_{date}_{time}_{title}', {
    username: 'alice',
    title: 'PK Night!! #1',
    dateObj: dt,
    part: 2,
  });
  assert.equal(f1, 'alice_20261124_153045_PK_Night_1_p2');
  assert.equal(utils.parseStartTimeFromName(`${f1}.mp4`), dt.getTime());

  const f2 = utils.renderRecordingFilename('{username}_{date_iso}_{time_hms}', {
    username: 'bob',
    dateObj: dt,
  });
  assert.equal(f2, 'bob_2026-11-24_15-30-45');
  assert.equal(utils.parseStartTimeFromName(`${f2}.mp4`), dt.getTime());

  // 3. buildRecordArgs({ format: 'ts' }) + remuxTsToMp4
  const tsArgs = ffmpeg.buildRecordArgs({ url: 'https://example.com/live.flv', quality: 'hd', format: 'ts' }, 'out.ts');
  assert.ok(tsArgs.includes('-f'));
  assert.ok(tsArgs.includes('mpegts'));
  assert.equal(tsArgs.includes('aac_adtstoasc'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-remux-test-'));
  try {
    const ffBin = ffmpeg.resolveFfmpeg();
    const fpBin = ffmpeg.resolveFfprobe();
    const tsPath = path.join(dir, 'sample.ts');
    const mp4Path = path.join(dir, 'sample.mp4');
    const gen = spawnSync(ffBin, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-f', 'mpegts', tsPath,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    const ok = await storage.remuxTsToMp4(tsPath, mp4Path);
    assert.equal(ok, true);
    assert.equal(fs.existsSync(tsPath), false);
    assert.equal(fs.existsSync(mp4Path), true);
    const probe = spawnSync(fpBin, ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'default=noprint_wrappers=1:nokey=1', mp4Path], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.match(probe.stdout, /mp4/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Subfolder recording lifecycle, SQLite FTS5 search index, settings v2, and watcher recordChat', async () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const db = require('../lib/db');
  const bookmarks = require('../lib/bookmarks');
  const watcher = require('../lib/watcher');

  const creator = `subtest_${Date.now()}`;
  const fileName = `${creator}_20261124_180000.mp4`;
  const relName = `${creator}/${fileName}`;
  const creatorDir = path.join(storage.RECORDINGS_DIR, creator);
  const mp4Path = path.join(creatorDir, fileName);
  const evPath = path.join(creatorDir, `${creator}_20261124_180000.events.jsonl`);
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-db-test-'));
  const prevDbEnv = process.env.RECORDER_DB_PATH;
  const prevSettings = settings.getSettings();

  try {
    fs.mkdirSync(creatorDir, { recursive: true });
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4Path,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    const baseTs = Date.now();
    fs.writeFileSync(evPath, [
      JSON.stringify({ id: 1, ts: baseTs + 1000, type: 'chat', user: { uniqueId: 'u1' }, comment: 'สวัสดีครับทุกคน' }),
      JSON.stringify({ id: 2, ts: baseTs + 2000, type: 'chat', user: { uniqueId: 'u2' }, comment: 'GG nice play' }),
      JSON.stringify({ id: 3, ts: baseTs + 3000, type: 'chat', user: { uniqueId: 'u3' }, comment: 'ok' }),
    ].join('\n') + '\n');

    assert.ok(storage.listRecordingFiles().includes(relName));
    storage.updateRecordingMeta(relName, { protected: true, displayTitle: 'Subfolder Live' });
    const meta = await storage.ensureThumbnailAndMeta(relName, { force: true });
    assert.equal(meta.protected, true);
    assert.equal(meta.displayTitle, 'Subfolder Live');
    assert.match(meta.thumbUrl || '', new RegExp(`${creator}__`));

    // SQLite FTS5 indexing & search
    if (db.isAvailable()) {
      process.env.RECORDER_DB_PATH = path.join(dbDir, 'test.db');
      db.closeDb();
      assert.equal(db.indexRecording(relName), true);
      const stats = db.getIndexStats();
      assert.equal(stats.available, true);
      assert.ok(stats.recordingsIndexed >= 1);
      assert.ok(stats.chatMessagesIndexed >= 3);

      const thaiHits = bookmarks.searchChat('สวัสดี');
      assert.ok(thaiHits.some((r) => r.recording === relName && r.comment.includes('สวัสดี')));

      const enHits = bookmarks.searchChat('nice');
      assert.ok(enHits.some((r) => r.recording === relName && r.user === 'u2'));

      const shortHits = bookmarks.searchChat('ok');
      assert.ok(shortHits.some((r) => r.recording === relName && r.comment === 'ok'));

      // Adversarial FTS5 / LIKE queries must not throw syntax errors
      for (const adv of ['"quoted"', 'a*b', 'OR AND NEAR', 'comment:foo', '50%', 'a_b']) {
        assert.ok(Array.isArray(db.searchChatIndexed(adv)));
      }

      db.removeRecording(relName);
      assert.equal(db.searchChatIndexed('สวัสดี').some((r) => r.recording === relName), false);
    }

    // mergeRecordingParts preserves startedAt & username from first source meta.json for dateless templates
    const m1 = `${creator}_title_one.mp4`;
    const m2 = `${creator}_title_two.mp4`;
    const m1Full = path.join(creatorDir, m1);
    const m2Full = path.join(creatorDir, m2);
    let mergedDateless = null;
    try {
      fs.copyFileSync(mp4Path, m1Full);
      fs.copyFileSync(mp4Path, m2Full);
      storage.updateRecordingMeta(`${creator}/${m1}`, { startedAt: baseTs, username: creator });
      const mRes = await storage.mergeRecordingParts([`${creator}/${m1}`, `${creator}/${m2}`], { deleteSources: true });
      mergedDateless = mRes.name;
      const mergedMeta = storage.readMeta(mergedDateless);
      assert.equal(mergedMeta.startedAt, baseTs);
      assert.equal(mergedMeta.username, creator);
    } finally {
      try { storage.deleteRecordingBundle(`${creator}/${m1}`); } catch {}
      try { storage.deleteRecordingBundle(`${creator}/${m2}`); } catch {}
      if (mergedDateless) try { storage.deleteRecordingBundle(mergedDateless); } catch {}
    }

    // Orphaned .ts cleanup in enforceRetention
    const orphanTs = path.join(creatorDir, `${creator}_orphan.ts`);
    fs.writeFileSync(orphanTs, 'ts-data');
    const oldTsMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(orphanTs, oldTsMs / 1000, oldTsMs / 1000);
    const prevRet = settings.getSettings().retentionDays;
    try {
      settings.updateSettings({ retentionDays: 1 });
      const retRes = storage.enforceRetention(new Set());
      assert.ok(retRes.deletedTs.includes(`${creator}/${creator}_orphan.ts`));
      assert.equal(fs.existsSync(orphanTs), false);
    } finally {
      settings.updateSettings({ retentionDays: prevRet });
      try { fs.rmSync(orphanTs, { force: true }); } catch {}
    }

    // Delete removes bundle + empty creator folder
    assert.equal(storage.deleteRecordingBundle(relName), true);
    assert.equal(fs.existsSync(creatorDir), false);

    // Settings v2 persistence
    const updated = settings.updateSettings({
      organizeByCreator: true,
      filenameTemplate: '{username}_{date_iso}_{time_hms}',
      recordFormat: 'ts',
    });
    assert.equal(updated.organizeByCreator, true);
    assert.equal(updated.filenameTemplate, '{username}_{date_iso}_{time_hms}');
    assert.equal(updated.recordFormat, 'ts');

    // Watcher recordChat flag
    const wUser = `wchat_${Date.now()}`;
    const added = watcher.addToWatchlist(wUser, { autoRecord: false, recordChat: false });
    assert.equal(added.ok, true);
    assert.equal(watcher.getWatchlist().list.find((e) => e.username === wUser)?.recordChat, false);
    watcher.updateWatchEntry(wUser, { recordChat: true });
    assert.equal(watcher.getWatchlist().list.find((e) => e.username === wUser)?.recordChat, true);
    watcher.removeFromWatchlist(wUser);
  } finally {
    db.closeDb();
    if (prevDbEnv === undefined) delete process.env.RECORDER_DB_PATH;
    else process.env.RECORDER_DB_PATH = prevDbEnv;
    settings.updateSettings({
      organizeByCreator: prevSettings.organizeByCreator,
      filenameTemplate: prevSettings.filenameTemplate,
      recordFormat: prevSettings.recordFormat,
    });
    try { storage.deleteRecordingBundle(relName); } catch {}
    fs.rmSync(creatorDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test('Multi-platform Provider Registry and Twitch HLS/IRC/GQL adapter work cleanly', async () => {
  const providers = require('../lib/providers');
  const twitch = require('../lib/providers/twitch');
  const utils = require('../lib/utils');
  const ffmpeg = require('../lib/ffmpeg');
  const watcher = require('../lib/watcher');

  // 1. parseChannelInput & sessionKey
  assert.deepEqual(providers.parseChannelInput('https://www.twitch.tv/Shroud'), { platform: 'twitch', username: 'shroud' });
  assert.deepEqual(providers.parseChannelInput('twitch:TenZ'), { platform: 'twitch', username: 'tenz' });
  assert.deepEqual(providers.parseChannelInput('https://www.tiktok.com/@Alice/live'), { platform: 'tiktok', username: 'Alice' });
  assert.deepEqual(providers.parseChannelInput('shroud', 'twitch'), { platform: 'twitch', username: 'shroud' });
  assert.equal(providers.sessionKey('tiktok', 'alice'), 'alice');
  assert.equal(providers.sessionKey('twitch', 'shroud'), 'twitch:shroud');

  // 2. parseTwitchMasterM3u8
  const sampleM3u8 = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO,URI="https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/ao.m3u8"',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=6500000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO="chunked"',
    'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/source.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO="720p60"',
    'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/720p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=852x480,FRAME-RATE=30.000,VIDEO="480p30"',
    'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/480p30.m3u8',
  ].join('\n');
  const parsedM3u8 = twitch.parseTwitchMasterM3u8(sampleM3u8);
  assert.equal(parsedM3u8.hls, 'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/source.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.origin, 'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/source.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.hd_60, 'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/720p60.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.sd, 'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/480p30.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.ao, 'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/ao.m3u8');

  // 3. parseTwitchIrcLine
  const chatMsg = twitch.parseTwitchIrcLine('@badge-info=;bits=500;display-name=Alice;user-id=42 :alice!alice@alice.tmi.twitch.tv PRIVMSG #shroud :PogChamp hello!');
  assert.equal(chatMsg.events.length, 2);
  assert.equal(chatMsg.events[0].type, 'chat');
  assert.equal(chatMsg.events[0].comment, 'PogChamp hello!');
  assert.equal(chatMsg.events[0].user.uniqueId, 'alice');
  assert.equal(chatMsg.events[1].type, 'gift');
  assert.equal(chatMsg.events[1].giftName, 'Bits');
  assert.equal(chatMsg.events[1].diamondCount, 500);

  const subMsg = twitch.parseTwitchIrcLine('@display-name=Bob;msg-id=resub;system-msg=Bob\\ssubscribed\\sfor\\s3\\smonths!;user-id=99 :tmi.twitch.tv USERNOTICE #shroud :love the stream');
  assert.equal(subMsg.events.length, 1);
  assert.equal(subMsg.events[0].type, 'subscribe');
  assert.match(subMsg.events[0].label, /subscribed for 3 months/);
  assert.equal(subMsg.events[0].comment, 'love the stream');

  const pingMsg = twitch.parseTwitchIrcLine('PING :tmi.twitch.tv');
  assert.equal(pingMsg.command, 'PING');

  // 4. fetchLiveStatus + buildSummary with mocked fetchImpl
  const liveData = await twitch.fetchLiveStatus('shroud', {
    fetchImpl: async (url) => {
      if (url.includes('gql.twitch.tv')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            data: {
              user: {
                id: '100',
                login: 'shroud',
                displayName: 'shroud',
                profileImageURL: 'https://static-cdn.jtvnw.net/jtv_user_pictures/shroud.png',
                roles: { isPartner: true },
                followers: { totalCount: 1000000 },
                stream: {
                  id: '999',
                  title: 'Ranked FPS',
                  type: 'live',
                  viewersCount: 12345,
                  createdAt: '2026-11-24T10:00:00Z',
                  previewImageURL: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_shroud-{width}x{height}.jpg',
                  game: { name: 'VALORANT' },
                },
              },
              streamPlaybackAccessToken: { value: '{"adblock":false}', signature: 'sig123' },
            },
          }),
        };
      }
      return { ok: true, status: 200, text: sampleM3u8 };
    },
  });
  assert.equal(twitch.isLive(liveData), true);
  const summary = twitch.buildSummary('shroud', liveData, twitch.extractStreamUrls(liveData));
  assert.equal(summary.platform, 'twitch');
  assert.equal(summary.viewerCount, 12345);
  assert.equal(summary.owner.verified, true);
  assert.equal(summary.streams.hlsByQuality.origin, 'https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/source.m3u8');

  // 5. CDN allowlist, filename prefix, and HLS FFmpeg args
  assert.equal(utils.isAllowedCdnUrl('https://usher.ttvnw.net/api/channel/hls/shroud.m3u8'), true);
  assert.equal(utils.isAllowedCdnUrl('https://video-weaver.sjc05.hls.ttvnw.net/v1/playlist/a.m3u8'), true);
  assert.equal(utils.isAllowedCdnUrl('https://127.0.0.1/a.m3u8'), false);
  const dt = new Date(2026, 10, 24, 15, 30, 45);
  assert.equal(utils.renderRecordingFilename('{username}_{date}_{time}', { platform: 'twitch', username: 'shroud', dateObj: dt }), 'twitch_shroud_20261124_153045');
  assert.equal(utils.renderRecordingFilename('{username}_{date}_{time}', { platform: 'tiktok', username: 'shroud', dateObj: dt }), 'shroud_20261124_153045');
  const hlsRecArgs = ffmpeg.buildRecordArgs({ url: 'https://video-weaver.sjc05.hls.ttvnw.net/a.m3u8', kind: 'hls', quality: 'origin', referer: 'https://www.twitch.tv/' }, 'out.mp4');
  assert.equal(hlsRecArgs.includes('h264_mp4toannexb'), false);
  assert.ok(hlsRecArgs.includes('Referer: https://www.twitch.tv/\r\n'));

  // 6. Multi-platform Watchlist isolation
  const sharedName = `multi_${Date.now()}`;
  try {
    assert.equal(watcher.addToWatchlist(sharedName, { platform: 'tiktok', autoRecord: false }).ok, true);
    assert.equal(watcher.addToWatchlist(sharedName, { platform: 'twitch', autoRecord: false }).ok, true);
    assert.equal(watcher.addToWatchlist(sharedName, { platform: 'twitch', autoRecord: false }).status, 409);
    assert.equal(watcher.removeFromWatchlist(sharedName, 'twitch'), true);
    assert.ok(watcher.getWatchlist().list.some((e) => e.username === sharedName && e.platform === 'tiktok'));
  } finally {
    watcher.removeFromWatchlist(sharedName, 'tiktok');
    watcher.removeFromWatchlist(sharedName, 'twitch');
  }

  // 7. TwitchChatSession disconnect() mid-connect rejects cleanly without hanging or leaking timer
  const fakeWs = new EventEmitter();
  fakeWs.readyState = 0; // CONNECTING
  fakeWs.close = () => { fakeWs.readyState = 3; };
  fakeWs.terminate = () => { fakeWs.readyState = 3; };
  fakeWs.send = () => {};
  const ts = new twitch.TwitchChatSession('shroud', { wsFactory: () => fakeWs });
  ts.uiActive = true;
  const connectP = ts.connect();
  ts.disconnect();
  await assert.rejects(() => connectP, /connection closed/);
  assert.equal(ts.state, 'closed');
  assert.equal(ts._connectTimer, null);

  // 8. Negative SSRF checks on Twitch domains & Referer header-injection stripping
  assert.equal(utils.isAllowedCdnUrl('http://usher.ttvnw.net/a.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('https://user:pass@usher.ttvnw.net/a.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('https://evilttvnw.net/a.m3u8'), false);
  const safeArgs = ffmpeg.buildRecordArgs({
    url: 'https://video-weaver.sjc05.hls.ttvnw.net/a.m3u8',
    kind: 'hls',
    quality: 'origin',
    referer: 'https://www.twitch.tv/\r\nX-Injected: 1',
  }, 'out.mp4');
  assert.ok(safeArgs.includes('Referer: https://www.twitch.tv/X-Injected: 1\r\n'));
});

test('YouTube Live provider (URL parser, InnerTube/HTML HLS, Live Chat/Super Chat, yt-dlp fallback)', async () => {
  const providers = require('../lib/providers');
  const youtube = require('../lib/providers/youtube');
  const utils = require('../lib/utils');
  const ffmpeg = require('../lib/ffmpeg');
  const chat = require('../lib/chat');

  // 1. URL & handle normalization + parseChannelInput
  assert.deepEqual(providers.parseChannelInput('https://www.youtube.com/@Hololive/live'), { platform: 'youtube', username: 'hololive' });
  assert.deepEqual(providers.parseChannelInput('https://youtube.com/watch?v=dQw4w9WgXcQ'), { platform: 'youtube', username: 'v_dQw4w9WgXcQ' });
  assert.deepEqual(providers.parseChannelInput('https://youtu.be/dQw4w9WgXcQ'), { platform: 'youtube', username: 'v_dQw4w9WgXcQ' });
  assert.deepEqual(providers.parseChannelInput('https://www.youtube.com/live/AbCdEf12345'), { platform: 'youtube', username: 'v_AbCdEf12345' });
  assert.deepEqual(providers.parseChannelInput('https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx/live'), {
    platform: 'youtube',
    username: 'UCxxxxxxxxxxxxxxxxxxxxxx',
  });
  assert.deepEqual(providers.parseChannelInput('yt:@NewsTH'), { platform: 'youtube', username: 'newsth' });
  assert.equal(youtube.normalizeUsername('watch'), '');
  assert.equal(providers.sessionKey('youtube', 'hololive'), 'youtube:hololive');
  assert.equal(youtube.buildChannelUrl('v_dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(youtube.buildChannelUrl('hololive'), 'https://www.youtube.com/@hololive/live');

  // 2. Balanced JSON object extraction & HLS master playlist parsing
  const sampleHtml = [
    '<script>',
    'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"LiveVid1234","title":"Chilled {Beats}","channelId":"UC1234567890123456789012","author":"Lofi Girl","isLive":true,"thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/LiveVid1234/maxresdefault.jpg"}]}},"playabilityStatus":{"status":"OK"},"streamingData":{"hlsManifestUrl":"https://manifest.googlevideo.com/api/manifest/hls_variant/id/LiveVid1234/master.m3u8"}};',
    'var ytInitialData = {"contents":{"twoColumnWatchNextResults":{"results":{"results":{"contents":[{"videoPrimaryInfoRenderer":{"viewCount":{"videoViewCountRenderer":{"originalViewCount":"24,500"}}}}]}},"conversationBar":{"liveChatRenderer":{"continuations":[{"reloadContinuationData":{"continuation":"CONT_INIT_1"}}]}}}},"metadata":{"channelMetadataRenderer":{"avatar":{"thumbnails":[{"url":"https://yt3.ggpht.com/avatar.jpg"}]}}}};</script>',
    '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_YT_KEY","INNERTUBE_CLIENT_VERSION":"2.20260101.00.00"});</script>',
  ].join('\n');

  const ytM3u8 = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="https://rr1---sn.googlevideo.com/audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60',
    'https://rr1---sn.googlevideo.com/1080p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=30',
    'https://rr1---sn.googlevideo.com/720p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=30',
    'https://rr1---sn.googlevideo.com/360p.m3u8',
  ].join('\n');

  const parsedM3u8 = youtube.parseYouTubeMasterM3u8(ytM3u8);
  assert.equal(parsedM3u8.hlsByQuality.uhd_60, 'https://rr1---sn.googlevideo.com/1080p60.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.hd, 'https://rr1---sn.googlevideo.com/720p.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.ld, 'https://rr1---sn.googlevideo.com/360p.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.ao, 'https://rr1---sn.googlevideo.com/audio.m3u8');
  assert.equal(youtube.pickPreferredStream(parsedM3u8).quality, 'uhd_60');

  // 3. fetchLiveStatus via HTML/InnerTube + summary + InnerTube player fallback + yt-dlp fallback
  const statusFromHtml = await youtube.fetchLiveStatus('LofiGirl', {
    fetchImpl: async (url) => {
      if (url.includes('youtube.com/@lofigirl/live')) return { ok: true, status: 200, text: sampleHtml };
      if (url.includes('manifest.googlevideo.com')) return { ok: true, status: 200, text: ytM3u8 };
      return { ok: false, status: 404, text: '' };
    },
  });
  assert.equal(youtube.isLive(statusFromHtml), true);
  assert.equal(statusFromHtml.liveChatContinuation, 'CONT_INIT_1');
  const ytSummary = youtube.buildSummary('lofigirl', statusFromHtml, youtube.extractStreamUrls(statusFromHtml));
  assert.equal(ytSummary.platform, 'youtube');
  assert.equal(ytSummary.viewerCount, 24500);
  assert.equal(ytSummary.owner.nickname, 'Lofi Girl');
  assert.equal(ytSummary.streams.hlsByQuality.uhd_60, 'https://rr1---sn.googlevideo.com/1080p60.m3u8');

  // yt-dlp fallback when web page yields no manifest
  const statusFromYtDlp = await youtube.fetchLiveStatus('fallbackchan', {
    fetchImpl: async () => ({ ok: true, status: 200, text: '<html>offline placeholder</html>' }),
    ytDlpExec: async (_bin, args) => {
      assert.ok(args.includes('https://www.youtube.com/@fallbackchan/live'));
      return JSON.stringify({
        id: 'YtDlp123456',
        is_live: true,
        title: 'Fallback Live',
        uploader: 'Fallback Creator',
        concurrent_view_count: 777,
        manifest_url: 'https://manifest.googlevideo.com/ytdlp/master.m3u8',
      });
    },
  });
  assert.equal(youtube.isLive(statusFromYtDlp), true);
  assert.equal(statusFromYtDlp.videoId, 'YtDlp123456');
  assert.equal(statusFromYtDlp.viewerCount, 777);

  // 4. parseYouTubeChatAction (chat, Super Chat, Super Sticker, Membership) + YouTubeChatSession polling
  const actions = [
    {
      addChatItemAction: {
        item: {
          liveChatTextMessageRenderer: {
            id: 'msg-1',
            timestampUsec: '1700000000000000',
            authorName: { simpleText: 'ViewerA' },
            authorExternalChannelId: 'UCviewerA',
            message: { runs: [{ text: 'Hello ' }, { emoji: { shortcuts: [':wave:'] } }] },
          },
        },
      },
    },
    {
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id: 'sc-1',
            timestampUsec: '1700000001000000',
            authorName: { simpleText: 'DonorB' },
            purchaseAmountText: { simpleText: '$5.00' },
            message: { runs: [{ text: 'Keep going!' }] },
          },
        },
      },
    },
    {
      addChatItemAction: {
        item: {
          liveChatPaidStickerRenderer: {
            id: 'st-1',
            timestampUsec: '1700000002000000',
            authorName: { simpleText: 'StickerC' },
            purchaseAmountText: { simpleText: '฿100.00' },
            sticker: { accessibility: { accessibilityData: { label: 'GG sticker' } } },
          },
        },
      },
    },
    {
      addChatItemAction: {
        item: {
          liveChatMembershipItemRenderer: {
            id: 'mem-1',
            timestampUsec: '1700000003000000',
            authorName: { simpleText: 'MemberD' },
            headerSubtext: { runs: [{ text: 'Welcome to Membership!' }] },
          },
        },
      },
    },
  ];
  const parsedActions = actions.map((a) => youtube.parseYouTubeChatAction(a));
  assert.equal(parsedActions[0].event.type, 'chat');
  assert.equal(parsedActions[0].event.comment, 'Hello :wave:');
  assert.equal(parsedActions[1].event.type, 'gift');
  assert.equal(parsedActions[1].event.giftName, 'Super Chat ($5.00)');
  assert.equal(parsedActions[1].event.diamondCount, 500);
  assert.equal(parsedActions[2].event.type, 'gift');
  assert.equal(parsedActions[2].event.diamondCount, 300);
  assert.equal(parsedActions[3].event.type, 'subscribe');
  assert.equal(parsedActions[3].event.label, 'Welcome to Membership!');

  const emitted = [];
  const chatBus = new EventEmitter();
  chatBus.on('event', (ev) => emitted.push(ev));
  let pollCalls = 0;
  const ytChat = new youtube.YouTubeChatSession('lofigirl', {
    chatEvents: chatBus,
    fetchImpl: async (url) => {
      if (url.includes('@lofigirl/live')) return { ok: true, status: 200, text: sampleHtml };
      if (url.includes('get_live_chat')) {
        pollCalls++;
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            continuationContents: {
              liveChatContinuation: {
                actions: pollCalls === 1 ? actions : [],
                continuations: [{ timedContinuationData: { continuation: 'CONT_NEXT', timeoutMs: 3000 } }],
              },
            },
          }),
        };
      }
      return { ok: false, status: 404, text: '' };
    },
  });
  ytChat.uiActive = true;
  await ytChat.connect();
  assert.equal(ytChat.state, 'connected');
  // Poll loop is scheduled asynchronously at +50ms; trigger deterministically and wait for delivery
  await ytChat._pollOnce();
  // Deduplicate exact same action batch
  await ytChat._pollOnce();
  assert.equal(ytChat.events.length, 4);
  assert.equal(emitted.length, 4);
  assert.equal(emitted[0].platform, 'youtube');
  ytChat.disconnect();
  assert.equal(ytChat.state, 'closed');
  assert.equal(ytChat._pollTimer, null);

  // 5. CDN SSRF checks, filename prefix, and derivePlatformFromFilename
  assert.equal(utils.isAllowedCdnUrl('https://manifest.googlevideo.com/api/manifest/hls_variant/a.m3u8'), true);
  assert.equal(utils.isAllowedCdnUrl('https://i.ytimg.com/vi/abc/maxresdefault.jpg'), true);
  assert.equal(utils.isAllowedCdnUrl('https://evilgooglevideo.com/a.m3u8'), false);
  assert.equal(utils.isAllowedCdnUrl('http://manifest.googlevideo.com/a.m3u8'), false);
  const dt = new Date(2026, 10, 24, 15, 30, 45);
  assert.equal(utils.renderRecordingFilename('{username}_{date}_{time}', { platform: 'youtube', username: 'lofigirl', dateObj: dt }), 'youtube_lofigirl_20261124_153045');
  assert.equal(providers.derivePlatformFromFilename('youtube_lofigirl_20261124_153045.mp4'), 'youtube');
  assert.equal(providers.stripPlatformPrefix('youtube_lofigirl'), 'lofigirl');
  const ytArgs = ffmpeg.buildRecordArgs({ url: 'https://manifest.googlevideo.com/a.m3u8', kind: 'hls', quality: 'uhd_60', referer: 'https://www.youtube.com/' }, 'out.mp4');
  assert.equal(ytArgs.includes('h264_mp4toannexb'), false);
  assert.ok(ytArgs.includes('Referer: https://www.youtube.com/\r\n'));
  assert.ok(chat.chatEvents);
});
