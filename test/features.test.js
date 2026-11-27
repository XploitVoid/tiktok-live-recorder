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
  assert.ok(hlsRecArgs.includes('aac_adtstoasc'));
  assert.ok(hlsRecArgs.includes('Referer: https://www.twitch.tv/\r\n'));
  const hlsTsArgs = ffmpeg.buildRecordArgs({ url: 'https://video-weaver.sjc05.hls.ttvnw.net/a.m3u8', kind: 'hls', quality: 'origin', format: 'ts', referer: 'https://www.twitch.tv/' }, 'out.ts');
  assert.equal(hlsTsArgs.includes('aac_adtstoasc'), false);
  const hlsAoMp4Args = ffmpeg.buildRecordArgs({ url: 'https://video-weaver.sjc05.hls.ttvnw.net/ao.m3u8', kind: 'hls', quality: 'ao', audioOnly: true, format: 'mp4' }, 'out.mp4');
  assert.ok(hlsAoMp4Args.includes('aac_adtstoasc'));
  assert.equal(twitch.parseTwitchIrcLine(':tmi.twitch.tv RECONNECT').command, 'RECONNECT');

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
  assert.equal(ts._pingTimer, null);

  // Open WS creates _pingTimer and clears it cleanly on disconnect
  const openWs = new EventEmitter();
  openWs.readyState = 1;
  openWs.close = () => { openWs.readyState = 3; };
  openWs.terminate = () => { openWs.readyState = 3; };
  openWs.send = () => {};
  const tsOpen = new twitch.TwitchChatSession('shroud', { wsFactory: () => openWs });
  tsOpen.uiActive = true;
  const openP = tsOpen.connect();
  openWs.emit('open');
  await openP;
  assert.ok(tsOpen._pingTimer);
  tsOpen.disconnect();
  assert.equal(tsOpen._pingTimer, null);

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

  // 3b. InnerTube ANDROID player fallback when web HTML omits hlsManifestUrl + prefer continuations[0] over subMenuItems
  const htmlNeedAndroid = [
    '<script>',
    'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"LiveVid1234","title":"Chilled Live","channelId":"UC1234567890123456789012","author":"Lofi Girl","isLive":true},"playabilityStatus":{"status":"OK"},"streamingData":{"adaptiveFormats":[]}};',
    'var ytInitialData = {"contents":{"twoColumnWatchNextResults":{"conversationBar":{"liveChatRenderer":{"header":{"liveChatHeaderRenderer":{"viewSelector":{"sortFilterSubMenuRenderer":{"subMenuItems":[{"continuation":{"reloadContinuationData":{"continuation":"SUBMENU_BAD_400"}}}]}}}},"continuations":[{"reloadContinuationData":{"continuation":"CONT_GOOD_200"}}]}}}}};',
    '</script>',
    '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_YT_KEY","VISITOR_DATA":"VISITOR_123"});</script>',
  ].join('\n');
  let playerClientUsed = null;
  const statusAndroidFallback = await youtube.fetchLiveStatus('LofiGirl', {
    fetchImpl: async (url, init) => {
      if (url.includes('youtube.com/@lofigirl/live')) return { ok: true, status: 200, text: htmlNeedAndroid };
      if (url.includes('/youtubei/v1/player')) {
        const body = JSON.parse(init.body);
        playerClientUsed = body?.context?.client?.clientName;
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            streamingData: { hlsManifestUrl: 'https://manifest.googlevideo.com/android/master.m3u8' },
          }),
        };
      }
      if (url.includes('manifest.googlevideo.com')) return { ok: true, status: 200, text: ytM3u8 };
      return { ok: false, status: 404, text: '' };
    },
  });
  assert.equal(playerClientUsed, 'ANDROID');
  assert.equal(youtube.isLive(statusAndroidFallback), true);
  assert.equal(statusAndroidFallback.liveChatContinuation, 'CONT_GOOD_200');

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

test('Kick LIVE provider (HLS, Pusher WS chat, yt-dlp fallback) & multi-platform accounts work cleanly', async () => {
  const providers = require('../lib/providers');
  const kick = require('../lib/providers/kick');
  const utils = require('../lib/utils');
  const ffmpeg = require('../lib/ffmpeg');
  const accounts = require('../lib/accounts');

  // 1. parseChannelInput & kick.normalizeUsername
  assert.deepEqual(providers.parseChannelInput('https://kick.com/xQc'), { platform: 'kick', username: 'xqc' });
  assert.deepEqual(providers.parseChannelInput('kick:WestCOL'), { platform: 'kick', username: 'westcol' });
  assert.equal(kick.normalizeUsername('browse'), '');
  assert.equal(providers.sessionKey('kick', 'xqc'), 'kick:xqc');

  // 2. parseKickMasterM3u8 & fetchLiveStatus (v2 API + Cloudflare 403 -> yt-dlp fallback)
  const kickM3u8 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60',
    'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/source.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,FRAME-RATE=30',
    'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/720p.m3u8',
  ].join('\n');
  const parsedM3u8 = kick.parseKickMasterM3u8(kickM3u8);
  assert.equal(parsedM3u8.hlsByQuality.uhd_60, 'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/source.m3u8');
  assert.equal(parsedM3u8.hlsByQuality.hd, 'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/720p.m3u8');
  assert.equal(kick.pickPreferredStream(parsedM3u8).quality, 'uhd_60');

  const liveData = await kick.fetchLiveStatus('xqc', {
    fetchImpl: async (url) => {
      if (url.includes('/api/v2/channels/xqc')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            id: 668,
            slug: 'xqc',
            verified: true,
            followers_count: 900000,
            playback_url: 'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/master.m3u8',
            chatroom: { id: 668123 },
            user: { username: 'xQc', profile_pic: 'https://kick.com/avatar.jpg' },
            livestream: {
              id: 777111,
              session_title: 'Varieties & Chill',
              viewer_count: 32100,
              is_live: true,
              created_at: '2026-11-24T12:00:00Z',
              categories: [{ name: 'Just Chatting' }],
              thumbnail: { url: 'https://kick.com/thumb.jpg' },
            },
          }),
        };
      }
      return { ok: true, status: 200, text: kickM3u8 };
    },
  });
  assert.equal(kick.isLive(liveData), true);
  const summary = kick.buildSummary('xqc', liveData, kick.extractStreamUrls(liveData));
  assert.equal(summary.platform, 'kick');
  assert.equal(summary.viewerCount, 32100);
  assert.equal(summary.liveRoomMode, 'Just Chatting');
  assert.equal(summary.roomId, '668123');

  // Cloudflare 403 -> yt-dlp fallback
  const cfFallback = await kick.fetchLiveStatus('westcol', {
    fetchImpl: async (url) => {
      if (url.includes('kick.com/api/')) return { ok: false, status: 403, text: '<html>Just a moment...</html>' };
      return { ok: true, status: 200, text: kickM3u8 };
    },
    ytDlpExec: async (_bin, args) => {
      assert.ok(args.includes('https://kick.com/westcol'));
      return JSON.stringify({
        id: 'cf-1',
        is_live: true,
        title: 'CF Bypassed Stream',
        uploader: 'WestCOL',
        concurrent_view_count: 15000,
        manifest_url: 'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/master.m3u8',
      });
    },
  });
  assert.equal(kick.isLive(cfFallback), true);
  assert.equal(cfFallback.livestream.viewer_count, 15000);

  // 3. parseKickPusherMessage
  const chatFrame = kick.parseKickPusherMessage(JSON.stringify({
    event: 'App\\Events\\ChatMessageEvent',
    data: JSON.stringify({
      content: 'Hello [emote:12345:KEKW] world',
      sender: { id: 10, username: 'ChatterOne', slug: 'chatterone' },
    }),
  }));
  assert.equal(chatFrame.events[0].type, 'chat');
  assert.equal(chatFrame.events[0].comment, 'Hello :KEKW: world');
  assert.equal(chatFrame.events[0].user.uniqueId, 'chatterone');

  const subFrame = kick.parseKickPusherMessage(JSON.stringify({
    event: 'App\\Events\\SubscriptionEvent',
    data: JSON.stringify({ username: 'SubUser', months: 6 }),
  }));
  assert.equal(subFrame.events[0].type, 'subscribe');
  assert.match(subFrame.events[0].label, /6 months/);

  const giftFrame = kick.parseKickPusherMessage(JSON.stringify({
    event: 'App\\Events\\GiftedSubscriptionsEvent',
    data: JSON.stringify({ gifter_username: 'BigGifter', gifted_usernames: ['u1', 'u2'] }),
  }));
  assert.equal(giftFrame.events[0].type, 'gift');
  assert.equal(giftFrame.events[0].repeatCount, 2);
  assert.equal(giftFrame.events[0].diamondCount, 500);
  assert.equal(kick.parseKickPusherMessage(JSON.stringify({ event: 'pusher:ping' })).command, 'PING');

  // 4. KickChatSession Centrifugo connect, subscribe, message push, {} ping/pong, and clean mid-connect disconnect
  const sentFrames = [];
  const fakeWs = new EventEmitter();
  fakeWs.readyState = 1;
  fakeWs.send = (msg) => sentFrames.push(JSON.parse(msg));
  fakeWs.close = () => { fakeWs.readyState = 3; };
  fakeWs.terminate = () => { fakeWs.readyState = 3; };
  const bus = new EventEmitter();
  const busEvents = [];
  bus.on('event', (ev) => busEvents.push(ev));
  const ks = new kick.KickChatSession('xqc', { chatroomId: '668123', chatEvents: bus, wsFactory: () => fakeWs });
  ks.uiActive = true;
  const kp = ks.connect();
  await new Promise((r) => setImmediate(r));
  fakeWs.emit('open');
  assert.equal(sentFrames[0].connect.name, 'js');
  fakeWs.emit('message', JSON.stringify({ id: 1, connect: { client: 'c1', version: '6.9.7' } }));
  await kp;
  assert.equal(ks.state, 'connected');
  assert.equal(sentFrames[1].subscribe.channel, 'chatrooms.668123.v2');
  fakeWs.emit('message', '{}');
  assert.deepEqual(sentFrames[2], {});
  fakeWs.emit('message', JSON.stringify({
    push: {
      channel: 'chatrooms.668123.v2',
      pub: {
        data: {
          event: 'App\\Events\\ChatMessageEvent',
          data: JSON.stringify({ content: 'GGs', sender: { id: 1, username: 'Fan', slug: 'fan' } }),
        },
      },
    },
  }));
  assert.equal(ks.events.length, 1);
  assert.equal(busEvents[0].platform, 'kick');
  ks.disconnect();
  assert.equal(ks.state, 'closed');
  assert.equal(ks._pingTimer, null);

  // Mid-connect disconnect terminates safely without crashing on ws pre-open error
  const hangWs = new EventEmitter();
  hangWs.readyState = 0;
  hangWs.send = () => {};
  hangWs.close = () => { hangWs.readyState = 3; };
  hangWs.terminate = () => {
    hangWs.readyState = 3;
    hangWs.emit('error', new Error('WebSocket was closed before the connection was established'));
  };
  const ks2 = new kick.KickChatSession('xqc', { chatroomId: '668123', wsFactory: () => hangWs });
  ks2.uiActive = true;
  const kp2 = ks2.connect();
  await new Promise((r) => setImmediate(r));
  ks2.disconnect();
  await assert.rejects(() => kp2, /connection closed/);
  assert.equal(ks2._connectTimer, null);

  // 5. CDN SSRF checks, filename prefix & referer
  assert.equal(utils.isAllowedCdnUrl('https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/source.m3u8'), true);
  assert.equal(utils.isAllowedCdnUrl('https://kick.com/thumb.jpg'), true);
  assert.equal(utils.isAllowedCdnUrl('https://evilkick.com/a.m3u8'), false);
  const dt = new Date(2026, 10, 24, 15, 30, 45);
  assert.equal(utils.renderRecordingFilename('{username}_{date}_{time}', { platform: 'kick', username: 'xqc', dateObj: dt }), 'kick_xqc_20261124_153045');
  assert.equal(providers.derivePlatformFromFilename('kick_xqc_20261124_153045.mp4'), 'kick');
  const kickArgs = ffmpeg.buildRecordArgs({ url: 'https://playback.live-video.net/a.m3u8', kind: 'hls', quality: 'uhd_60', referer: 'https://kick.com/' }, 'out.mp4');
  assert.ok(kickArgs.includes('Referer: https://kick.com/\r\n'));

  // 6. Multi-platform accounts save/switch + safe non-TikTok health check
  const root = path.resolve(__dirname, '..');
  const accFile = path.join(root, 'accounts.json');
  const keyFile = path.join(root, '.accounts.key');
  const hadAcc = fs.existsSync(accFile);
  const hadKey = fs.existsSync(keyFile);
  const origAcc = hadAcc ? fs.readFileSync(accFile) : null;
  const origKey = hadKey ? fs.readFileSync(keyFile) : null;
  const prevSecret = process.env.ACCOUNTS_SECRET;
  try {
    process.env.ACCOUNTS_SECRET = 'phase3-test-secret';
    const kAcc = accounts.add('KickMain', 'kick_secret_token_987654', '', 'kick');
    assert.equal(kAcc.platform, 'kick');
    accounts.switchTo(kAcc.id);
    assert.equal(accounts.getActivePlatformCredential('kick'), 'kick_secret_token_987654');
    assert.equal(accounts.getActiveByPlatform().kick, kAcc.id);
    const nonTtHealth = await accounts.checkAccountHealth(kAcc.id, {
      requestImpl: () => { throw new Error('must not call TikTok passport endpoint'); },
    });
    assert.equal(nonTtHealth.status, 'unknown');
    accounts.remove(kAcc.id);
    assert.equal(accounts.getActiveByPlatform().kick, null);
  } finally {
    if (prevSecret === undefined) delete process.env.ACCOUNTS_SECRET;
    else process.env.ACCOUNTS_SECRET = prevSecret;
    if (hadAcc && origAcc) fs.writeFileSync(accFile, origAcc);
    else fs.rmSync(accFile, { force: true });
    if (hadKey && origKey) fs.writeFileSync(keyFile, origKey);
    else fs.rmSync(keyFile, { force: true });
  }
});

test('proxy.wrapFetchResponse reads m3u8 manifest without locking ReadableStream', async () => {
  const proxyRouter = require('../routes/proxy');
  const m3u8Body = '#EXTM3U\n#EXTINF:2.0,\nhttps://b2f45bec2a55.j.cloudfront.hls.ttvnw.net/v1/segment/1.ts\n';
  const res1 = new Response(m3u8Body, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
  });
  const wrapped1 = proxyRouter.wrapFetchResponse(res1, 'https://aps13.playlist.ttvnw.net/v1/playlist/master.m3u8');
  const buf = await wrapped1.readBuffer(1024 * 1024);
  assert.equal(buf.toString('utf8'), m3u8Body);

  const res2 = new Response(Buffer.from([0x47, 0x40, 0x00, 0x10]), {
    status: 200,
    headers: { 'content-type': 'binary/octet-stream' },
  });
  const wrapped2 = proxyRouter.wrapFetchResponse(res2, 'https://b2f45bec2a55.j.cloudfront.hls.ttvnw.net/v1/segment/1.ts');
  const stream = wrapped2.getNodeStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0x47, 0x40, 0x00, 0x10]));
});

test('Kick and YouTube Live regression fixes (offline yt-dlp skip, proxy header leak, followers coerce, token refresh, reconnect)', async () => {
  const { EventEmitter } = require('node:events');
  const kick = require('../lib/providers/kick');
  const youtube = require('../lib/providers/youtube');

  // 1. Kick cleanly offline channel skips yt-dlp fallback and coerces string followers_count
  let kickYtDlpCalls = 0;
  const kickOffline = await kick.fetchLiveStatus('xqc', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({
        id: 668,
        slug: 'xqc',
        followers_count: '1857578',
        livestream: null,
        chatroom: { id: 668123 },
        user: { username: 'xQc' },
      }),
    }),
    ytDlpExec: async () => {
      kickYtDlpCalls++;
      return '{}';
    },
  });
  assert.equal(kickYtDlpCalls, 0);
  assert.equal(kick.isLive(kickOffline), false);
  const kickOfflineSummary = kick.buildSummary('xqc', kickOffline, null);
  assert.strictEqual(kickOfflineSummary.owner.followers, 1857578);

  // 2. Kick proxy retry on 403 does not leak __retriedProxy into outbound headers
  const prevProxyUrl = settings.getSettings().proxyUrl || '';
  const seenHeaderKeys = [];
  let proxyTryCalls = 0;
  try {
    settings.updateSettings({ proxyUrl: 'http://127.0.0.1:8001,http://127.0.0.1:8002' });
    const proxyRes = await kick.fetchLiveStatus('xqc', {
      fetchImpl: async (_url, opts) => {
        proxyTryCalls++;
        seenHeaderKeys.push(...Object.keys(opts?.headers || {}));
        if (proxyTryCalls === 1) return { ok: false, status: 403, text: 'cf' };
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ id: 1, slug: 'xqc', livestream: null, chatroom: { id: 1 } }),
        };
      },
    });
    assert.equal(proxyTryCalls, 2);
    assert.equal(proxyRes.channel?.id, 1);
    assert.equal(seenHeaderKeys.includes('__retriedProxy'), false);
  } finally {
    settings.updateSettings({ proxyUrl: prevProxyUrl });
  }

  // 3. KickChatSession sets state='error' on pre-WS failure (no chatroomId)
  const failKickChat = new kick.KickChatSession('offlinechan', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({ id: 2, slug: 'offlinechan', livestream: null }),
    }),
    useYtDlpFallback: false,
  });
  failKickChat.uiActive = true;
  await assert.rejects(() => failKickChat.connect(), /Kick chatroom unavailable/);
  assert.equal(failKickChat.state, 'error');
  assert.equal(failKickChat.health.errorsCount, 1);
  assert.match(failKickChat.error || '', /Kick chatroom unavailable/);

  // 4. KickChatSession arms _refreshTimer when connect grants expiring TTL and clears it on disconnect()
  const wsRefresh = new EventEmitter();
  wsRefresh.readyState = 1;
  wsRefresh.send = () => {};
  wsRefresh.close = () => { wsRefresh.readyState = 3; };
  wsRefresh.terminate = () => { wsRefresh.readyState = 3; };
  const refreshSession = new kick.KickChatSession('xqc', { chatroomId: '668123', wsFactory: () => wsRefresh });
  refreshSession.uiActive = true;
  const rp = refreshSession.connect();
  await new Promise((r) => setImmediate(r));
  wsRefresh.emit('open');
  wsRefresh.emit('message', JSON.stringify({ id: 1, connect: { client: 'c1', expires: true, ttl: 2699 } }));
  await rp;
  assert.ok(refreshSession._refreshTimer);
  refreshSession.disconnect();
  assert.equal(refreshSession._refreshTimer, null);

  // 5. YouTube offline page skips yt-dlp fallback and populates author from channelMetadataRenderer.title
  let ytDlpCalls = 0;
  const offlineYtHtml = [
    '<script>',
    'var ytInitialData = {"metadata":{"channelMetadataRenderer":{"title":"Veritasium","avatar":{"thumbnails":[{"url":"https://yt3.ggpht.com/v.jpg"}]}}}};',
    '</script>',
  ].join('\n');
  const ytOffline = await youtube.fetchLiveStatus('Veritasium', {
    fetchImpl: async () => ({ ok: true, status: 200, text: offlineYtHtml }),
    ytDlpExec: async () => {
      ytDlpCalls++;
      return '{}';
    },
  });
  assert.equal(ytDlpCalls, 0);
  assert.equal(youtube.isLive(ytOffline), false);
  assert.equal(ytOffline.author, 'Veritasium');
  assert.equal(youtube.buildSummary('veritasium', ytOffline, null).owner.nickname, 'Veritasium');

  // 6. YouTube parseYouTubeChatAction supports giftMessageViewModel & liveChatSponsorshipsGiftRedemptionAnnouncementRenderer
  const giftVm = youtube.parseYouTubeChatAction({
    addChatItemAction: {
      item: {
        giftMessageViewModel: {
          id: 'gvm-1',
          timestampUsec: '1700000005000000',
          authorName: { content: 'JewelSender' },
          authorPhoto: { image: { sources: [{ url: 'https://yt3.ggpht.com/j.jpg' }] } },
          text: { content: 'Sent 1x Galaxy' },
          jewelsCount: 250,
        },
      },
    },
  });
  assert.equal(giftVm.event.type, 'gift');
  assert.equal(giftVm.event.user.nickname, 'JewelSender');
  assert.equal(giftVm.event.giftName, 'Sent 1x Galaxy');
  assert.equal(giftVm.event.diamondCount, 250);

  const redeemed = youtube.parseYouTubeChatAction({
    addChatItemAction: {
      item: {
        liveChatSponsorshipsGiftRedemptionAnnouncementRenderer: {
          id: 'red-1',
          timestampUsec: '1700000006000000',
          authorName: { simpleText: 'LuckyViewer' },
          message: { runs: [{ text: 'was gifted a membership!' }] },
        },
      },
    },
  });
  assert.equal(redeemed.event.type, 'subscribe');
  assert.equal(redeemed.event.label, 'was gifted a membership!');

  // 7. YouTubeChatSession clears stale continuation on 5 consecutive poll errors before reconnect
  const staleChat = new youtube.YouTubeChatSession('lofigirl', {
    apiKey: 'KEY',
    continuation: 'STALE_CONT',
    fetchImpl: async () => ({ ok: false, status: 400, text: '{}' }),
  });
  staleChat.uiActive = true;
  await staleChat.connect();
  staleChat._clearPollTimer();
  for (let i = 0; i < 5; i++) {
    await staleChat._pollOnce();
  }
  assert.equal(staleChat.continuation, null);
  assert.equal(staleChat.state, 'reconnecting');
  staleChat.disconnect();
});

test('Auto Highlights v2: MAD Z-score, Thai/EN hype & anti-spam, audio peak fusion, and RealtimeHighlightDetector v2', async () => {
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const {
    analyzeRecording,
    analyzeRecordingAsync,
    analyzeAudioPeaks,
    classifyChatReaction,
    isBotOrCommand,
  } = require('../lib/highlights');
  const { RealtimeHighlightDetector } = require('../lib/realtime-highlights');

  // 1. Reaction classifier & bot filter
  const rFunny = classifyChatReaction('555555 KEKW ลั่นมาก');
  assert.equal(rFunny.mood, 'funny');
  assert.ok(rFunny.tokens.includes('555'));
  assert.ok(rFunny.tokens.includes('kekw'));

  const rCallout = classifyChatReaction('clip it! ตัดคลิปด่วน OMG!!');
  assert.equal(rCallout.clipCallout, true);
  assert.equal(rCallout.emphasis, true);

  assert.equal(isBotOrCommand({ type: 'chat', comment: '!socials', user: { uniqueId: 'u1' } }), true);
  assert.equal(isBotOrCommand({ type: 'chat', comment: 'hello!', user: { uniqueId: 'Nightbot' } }), true);
  assert.equal(isBotOrCommand({ type: 'chat', comment: '55555', user: { uniqueId: 'viewer1' } }), false);

  // 2. Smart analyzer: single spammer dampened below diverse crowd, sensitivity presets, sub_spike, quotes/keywords
  const stamp = `hlv2_${Date.now()}_20261124_120000`;
  const mp4Path = path.join(storage.RECORDINGS_DIR, `${stamp}.mp4`);
  const evPath = path.join(storage.RECORDINGS_DIR, `${stamp}.events.jsonl`);
  const hlPath = path.join(storage.RECORDINGS_DIR, `${stamp}.highlights.json`);
  const metaPath = path.join(storage.RECORDINGS_DIR, `${stamp}.meta.json`);
  const startMs = require('../lib/utils').parseStartTimeFromName(`${stamp}.mp4`);

  try {
    fs.writeFileSync(mp4Path, 'mp4');
    fs.writeFileSync(metaPath, JSON.stringify({ durationSec: 240, startedAt: startMs }));

    const evs = [];
    let eid = 1;
    // Steady quiet baseline across 240s (~1 chat every 15s)
    for (let s = 5; s < 240; s += 15) {
      evs.push({ id: eid++, ts: startMs + s * 1000, type: 'chat', user: { uniqueId: `base_${s}` }, comment: 'hi' });
    }
    // Single-user spam at 45s (10 identical repeats from 1 user + bot command — should score much lower)
    for (let k = 0; k < 10; k++) {
      evs.push({ id: eid++, ts: startMs + (45 + k * 0.2) * 1000, type: 'chat', user: { uniqueId: 'spammer' }, comment: 'spam spam' });
    }
    evs.push({ id: eid++, ts: startMs + 46_000, type: 'chat', user: { uniqueId: 'Nightbot' }, comment: 'Follow the channel!' });
    // Real diverse funny/hype crowd spike at 120s (8 unique users + clip callout)
    const crowdComments = ['55555 ลั่นมาก', 'KEKW ตัดคลิปด่วน!', 'OMG insane!!', '5555', 'POG clip it!', 'ฮ่าๆๆ โหดมาก', 'LMAO 💀', '555+ ตึงจัด'];
    for (let k = 0; k < crowdComments.length; k++) {
      evs.push({
        id: eid++,
        ts: startMs + (120 + k * 0.4) * 1000,
        type: 'chat',
        user: { uniqueId: `crowd_${k}`, nickname: `Crowd${k}` },
        comment: crowdComments[k],
      });
    }
    // Sub surge at 195s (3 subscribes)
    for (let k = 0; k < 3; k++) {
      evs.push({ id: eid++, ts: startMs + (195 + k) * 1000, type: 'subscribe', user: { uniqueId: `sub_${k}` }, label: 'Subbed' });
    }
    fs.writeFileSync(evPath, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const balanced = analyzeRecording(`${stamp}.mp4`, { sensitivity: 'balanced' });
    assert.equal(balanced.ok, true);
    assert.equal(balanced.usedFallback, false);

    const crowdCand = balanced.candidates.find((c) => c.peakSec >= 115 && c.peakSec <= 130);
    assert.ok(crowdCand, 'crowd funny spike at ~120s must be detected');
    assert.equal(crowdCand.reason, 'chat_spike');
    assert.equal(crowdCand.mood, 'funny');
    assert.ok(crowdCand.confidence >= 60);
    assert.ok(crowdCand.summary.uniqueUsers >= 8);
    assert.ok(crowdCand.summary.topKeywords.length >= 1);
    assert.ok(crowdCand.summary.sampleQuotes.length >= 1);

    const spamCand = balanced.candidates.find((c) => c.peakSec >= 40 && c.peakSec <= 52);
    if (spamCand) {
      assert.ok(crowdCand.score > spamCand.score * 1.5, 'diverse crowd reaction must outscore 1-person spam');
    }

    const subCand = balanced.candidates.find((c) => c.reason === 'sub_spike');
    assert.ok(subCand, '3 subscribes should emit sub_spike');
    assert.equal(subCand.summary.subscribes, 3);

    const strict = analyzeRecording(`${stamp}.mp4`, { sensitivity: 'strict' });
    const sensitive = analyzeRecording(`${stamp}.mp4`, { sensitivity: 'sensitive' });
    assert.ok(sensitive.candidates.length >= strict.candidates.length);
  } finally {
    fs.rmSync(mp4Path, { force: true });
    fs.rmSync(evPath, { force: true });
    fs.rmSync(hlPath, { force: true });
    fs.rmSync(metaPath, { force: true });
  }

  // 3. Real FFmpeg analyzeAudioPeaks + audio-only fallback when NO .events.jsonl exists
  const aStamp = `hlaudio_${Date.now()}_20261124_120000`;
  const aMp4 = path.join(storage.RECORDINGS_DIR, `${aStamp}.mp4`);
  const aHl = path.join(storage.RECORDINGS_DIR, `${aStamp}.highlights.json`);
  try {
    // 25s synthetic clip: quiet (-40dB / volume 0.01) except loud burst (volume 0.9) at 14s..17s
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=5:duration=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=25',
      '-af', "volume='if(between(t,14,17),0.9,0.01)':eval=frame",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '48k',
      aMp4,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);

    const rms = await analyzeAudioPeaks(aMp4);
    assert.ok(Array.isArray(rms) && rms.length >= 20);
    assert.ok(rms[15] > rms[5] + 15, `expected loud burst at 15s (${rms[15]}dB) >> baseline (${rms[5]}dB)`);

    const audioRes = await analyzeRecordingAsync(`${aStamp}.mp4`, { includeAudio: true });
    assert.equal(audioRes.ok, true);
    assert.equal(audioRes.audioOnly, true);
    assert.ok(audioRes.candidates.length >= 1);
    assert.equal(audioRes.candidates[0].reason, 'audio_spike');
    assert.equal(audioRes.candidates[0].hasAudioPeak, true);
    assert.ok(audioRes.candidates[0].peakSec >= 13 && audioRes.candidates[0].peakSec <= 18);
  } finally {
    fs.rmSync(aMp4, { force: true });
    fs.rmSync(aHl, { force: true });
  }

  // 4. RealtimeHighlightDetector v2: sub_bomb, clip_callout, and overlapping window merge
  const det = new RealtimeHighlightDetector('rt_v2');
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    det.onEvent({ id: i + 1, ts: t0 + i * 500, type: 'subscribe', user: { uniqueId: `s${i}` } });
  }
  assert.equal(det.marks[0].reason, 'sub_bomb');

  for (let i = 0; i < 3; i++) {
    det.onEvent({ id: 10 + i, ts: t0 + 35_000 + i * 500, type: 'chat', user: { uniqueId: `u${i}` }, comment: 'ตัดคลิป!' });
  }
  assert.equal(det.marks[1].reason, 'clip_callout');

  const wins = det.getClipWindows(t0 - 10_000);
  assert.equal(wins.length, 2);
  assert.ok(wins[0].startSec >= 0);
});

test('Phase 1 reliability regressions: C2 YouTube pre-aborted AbortSignal & H25 proxy/readEvents', async () => {
  const os = require('node:os');
  const youtube = require('../lib/providers/youtube');
  const proxyConfig = require('../lib/proxy-config');
  const utils = require('../lib/utils');

  // C2: pre-aborted AbortSignal must reject cleanly without emitting unhandled error on request
  await assert.rejects(
    () => youtube.defaultHttpRequest('https://www.youtube.com/@test/live', { signal: AbortSignal.abort() }),
    /YouTube request aborted/,
  );

  // H25: getProxyAgent handles multi-proxy string without throwing ERR_INVALID_URL
  const agent = proxyConfig.getProxyAgent('http://p1.example:8080, socks5://p2.example:1080');
  assert.ok(agent);

  // H25: readEvents ignores null/primitive JSON lines and returns independent clones
  const tmpFile = path.join(os.tmpdir(), `tlr-events-p1-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, [
      JSON.stringify({ id: 1, ts: 1000, type: 'chat', comment: 'hello' }),
      'null',
      '[1,2,3]',
      '"plain"',
      JSON.stringify({ id: 2, ts: 2000, type: 'chat', comment: 'world' }),
    ].join('\n'), 'utf8');

    const first = utils.readEvents(tmpFile);
    assert.equal(first.length, 2);
    first[0].comment = 'mutated';
    first.push({ id: 99, ts: 9999, type: 'chat', comment: 'injected' });

    const second = utils.readEvents(tmpFile);
    assert.equal(second.length, 2);
    assert.equal(second[0].comment, 'hello');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('Phase 2 reliability regressions: H7-H22, H26, M11, M13', async () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('../lib/ffmpeg');
  const transcode = require('../lib/transcode');
  const room = require('../lib/room');
  const youtube = require('../lib/providers/youtube');
  const kick = require('../lib/providers/kick');
  const twitch = require('../lib/providers/twitch');
  const providers = require('../lib/providers');
  const launcher = require('../launcher');
  const { analyzeRecording, mergeSpikes, topMomentBuckets } = require('../lib/highlights');
  const { buildLeaderboard } = require('../lib/leaderboard');
  const { autoTags } = require('../lib/bookmarks');
  const watcher = require('../lib/watcher');

  // H9: -avoid_negative_ts must be placed AFTER -i in both buildRecordArgs and buildTranscodeArgs
  const recArgs = ffmpeg.buildRecordArgs({ url: 'https://pull.tiktokcdn.com/live.flv', quality: 'hd' }, 'out.mp4');
  assert.ok(recArgs.indexOf('-avoid_negative_ts') > recArgs.indexOf('-i'));
  const txArgs = transcode.buildTranscodeArgs('https://pull.tiktokcdn.com/live.flv', 'libx264');
  assert.ok(txArgs.indexOf('-avoid_negative_ts') > txArgs.indexOf('-i'));

  // H10: Demuxed YouTube Live HLS (AUDIO group + AUDIO="aud") preserves audioByQuality, master hls URL, and FFmpeg dual-input mapping
  const demuxedM3u8 = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="https://rr1---sn.googlevideo.com/audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,AUDIO="aud"',
    'https://rr1---sn.googlevideo.com/1080p60.m3u8',
  ].join('\n');
  const masterUrl = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/master.m3u8';
  const parsedDemux = youtube.parseYouTubeMasterM3u8(demuxedM3u8, masterUrl);
  assert.equal(parsedDemux.hls, masterUrl);
  assert.equal(parsedDemux.audioByQuality.uhd_60, 'https://rr1---sn.googlevideo.com/audio.m3u8');
  const ytPref = youtube.pickPreferredStream(parsedDemux);
  assert.equal(ytPref.audioUrl, 'https://rr1---sn.googlevideo.com/audio.m3u8');
  const demuxArgs = ffmpeg.buildRecordArgs(ytPref, 'out.mp4');
  assert.equal(demuxArgs.filter((x) => x === '-i').length, 2);
  assert.ok(demuxArgs.includes('https://rr1---sn.googlevideo.com/audio.m3u8'));
  assert.ok(demuxArgs.includes('0:v:0') && demuxArgs.includes('1:a:0'));

  // H17: pickPreferredStream handles null safely and prefers HEVC video (incl. custom keys) over audio-only 'ao'
  assert.equal(room.pickPreferredStream(null), null);
  const hevcPick = room.pickPreferredStream({
    flv: { ao: 'https://pull.tiktokcdn.com/ao.flv' },
    cmaf: {},
    hlsByQuality: {},
    hevc: { flv: { custom_hevc: 'https://pull.tiktokcdn.com/hevc.flv' }, hls: {}, cmaf: {} },
  });
  assert.equal(hevcPick?.quality, 'hevc:custom_hevc');

  // H18 & H19: YouTube/Kick fetchLiveStatus throw on network/HTTP error instead of fake offline; Twitch falls back on non-2xx Usher
  await assert.rejects(
    () => youtube.fetchLiveStatus('LofiGirl', { fetchImpl: async () => { throw new Error('network down'); }, useYtDlpFallback: false }),
    /network down/,
  );
  await assert.rejects(
    () => kick.fetchLiveStatus('xqc', { fetchImpl: async () => ({ ok: false, status: 502, text: 'bad gw' }), useYtDlpFallback: false }),
    /Kick API HTTP 502/,
  );
  const twNon2xx = await twitch.fetchLiveStatus('shroud', {
    fetchImpl: async (url) => {
      if (url.includes('gql.twitch.tv')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            data: {
              user: { id: '1', login: 'shroud', stream: { id: 's1', type: 'live' } },
              streamPlaybackAccessToken: { value: 'v', signature: 'sig' },
            },
          }),
        };
      }
      return { ok: false, status: 503, text: '' };
    },
  });
  assert.ok(twNon2xx.streams?.hls && twNon2xx.streams.hls.includes('usher.ttvnw.net'));

  // H20: YouTubeChatSession preserves parsed message timestamps (parsed.ts) instead of Date.now()
  const historicUsec = '1700000123000000';
  const ytChat = new youtube.YouTubeChatSession('LofiGirl', {
    apiKey: 'KEY',
    continuation: 'CONT1',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({
        continuationContents: {
          liveChatContinuation: {
            actions: [{
              addChatItemAction: {
                item: {
                  liveChatTextMessageRenderer: {
                    id: 'yt-ts-1',
                    timestampUsec: historicUsec,
                    authorName: { simpleText: 'Tester' },
                    message: { runs: [{ text: 'old msg' }] },
                  },
                },
              },
            }],
            continuations: [],
          },
        },
      }),
    }),
  });
  ytChat.uiActive = true;
  ytChat.state = 'connected';
  await ytChat._pollOnce();
  assert.equal(ytChat.events.length, 1);
  assert.equal(ytChat.events[0].ts, 1700000123000);
  ytChat.disconnect();

  // H22: fetchViaYtDlp maps null viewerCount/release_timestamp to null rather than 0
  const ytdNull = await youtube.fetchViaYtDlp('https://www.youtube.com/@LofiGirl/live', {
    ytDlpExec: async () => JSON.stringify({
      id: 'vid1',
      is_live: true,
      concurrent_view_count: null,
      release_timestamp: null,
      manifest_url: 'https://manifest.googlevideo.com/a.m3u8',
    }),
  });
  assert.equal(ytdNull.viewerCount, null);
  assert.equal(ytdNull.startedAtUnix, null);

  // H26: resolveUrls keeps IPv6 loopback for ::1 / ::
  const v6 = launcher.resolveUrls({ PORT: '3000', HOST: '::1' });
  assert.equal(v6.probeHost, '::1');
  assert.equal(v6.healthUrl, 'http://[::1]:3000/api/health');

  // H11 & H12: partial .meta.json can still be compressed and compressed file preserves metadata
  const stamp = `p2meta_${Date.now()}`;
  const recName = `${stamp}.mp4`;
  const recPath = path.join(storage.RECORDINGS_DIR, recName);
  const metaPath = recPath.replace(/\.mp4$/i, '.meta.json');
  let compName = null;
  try {
    const gen = spawnSync(ffmpeg.resolveFfmpeg(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', recPath,
    ], { encoding: 'utf8' });
    assert.equal(gen.status, 0);
    // Partial meta (simulates initial .meta.json created at recording start without vcodec)
    fs.writeFileSync(metaPath, JSON.stringify({
      startedAt: 1700000500000,
      username: 'customstreamer',
      platform: 'twitch',
      displayTitle: 'Custom Title',
      notes: 'Keep me',
    }), 'utf8');
    const comp = await storage.compressRecording(recName, 'compact');
    compName = comp.name;
    const compMeta = storage.readMeta(compName);
    assert.equal(compMeta.startedAt, 1700000500000);
    assert.equal(compMeta.username, 'customstreamer');
    assert.equal(compMeta.platform, 'twitch');
    assert.equal(compMeta.displayTitle, 'Custom Title');
    assert.equal(compMeta.notes, 'Keep me');
  } finally {
    storage.deleteRecordingBundle(recName);
    if (compName) storage.deleteRecordingBundle(compName);
  }

  // H13 & H15: topMomentBuckets -> mergeSpikes keeps ascending idx, and analyzeRecording derives startMs from meta duration/events
  const mockBuckets = Array.from({ length: 12 }, (_, idx) => ({
    idx,
    startSec: idx * 5,
    endSec: (idx + 1) * 5,
    score: idx === 10 ? 50 : idx === 2 ? 20 : 0,
    eventCount: idx === 10 || idx === 2 ? 3 : 0,
    eventsInBucket: idx === 10 || idx === 2 ? [{ ts: 1700000000000 + idx * 5000, type: 'chat', comment: 'wow', user: { uniqueId: 'u1' } }] : [],
  }));
  const topSpikes = topMomentBuckets(mockBuckets);
  assert.equal(topSpikes[0].idx < topSpikes[1].idx, true);
  const mergedTop = mergeSpikes(topSpikes, mockBuckets, { durationSec: 60, startMs: 1700000000000 });
  assert.equal(mergedTop.length, 2);

  const hlBase = `p2start_${Date.now()}`;
  const hlMp4 = path.join(storage.RECORDINGS_DIR, `${hlBase}.mp4`);
  const hlEv = hlMp4.replace(/\.mp4$/i, '.events.jsonl');
  const hlMeta = hlMp4.replace(/\.mp4$/i, '.meta.json');
  const hlOut = hlMp4.replace(/\.mp4$/i, '.highlights.json');
  try {
    fs.writeFileSync(hlMp4, 'fake', 'utf8');
    fs.writeFileSync(hlMeta, JSON.stringify({ durationSec: 120 }), 'utf8');
    const approxStart = Math.round(fs.statSync(hlMp4).mtimeMs - 120 * 1000);
    const lines = [];
    for (let i = 0; i < 6; i++) {
      lines.push(JSON.stringify({ id: i + 1, ts: approxStart + 30_000 + i * 500, type: 'chat', user: { uniqueId: `u${i}` }, comment: 'hype lol!' }));
    }
    fs.writeFileSync(hlEv, lines.join('\n') + '\n', 'utf8');
    const hlRes = analyzeRecording(`${hlBase}.mp4`);
    assert.equal(hlRes.ok, true);
    assert.ok(hlRes.candidates.length >= 1);
  } finally {
    fs.rmSync(hlMp4, { force: true });
    fs.rmSync(hlEv, { force: true });
    fs.rmSync(hlMeta, { force: true });
    fs.rmSync(hlOut, { force: true });
  }

  // M11: IRC tag single-pass unescape, host-strict URL parse, YouTube dot handle rejection
  assert.equal(twitch.unescapeIrcTag('hello\\\\:world\\s!'), 'hello\\:world !');
  assert.notEqual(providers.parseChannelInput('https://evil.com/twitch.tv/alice').platform, 'twitch');
  assert.equal(youtube.normalizeUsername('..'), '');
  assert.equal(youtube.normalizeUsername('.env'), '');

  // M13: watcher.setPollSeconds(NaN), bookmarks.autoTags superFan, leaderboard subscribe points & passive member exclusion
  assert.equal(Number.isFinite(watcher.setPollSeconds(NaN)), true);

  const lbBase = `p2lb_${Date.now()}`;
  const lbMp4 = path.join(storage.RECORDINGS_DIR, `${lbBase}.mp4`);
  const lbEv = lbMp4.replace(/\.mp4$/i, '.events.jsonl');
  try {
    fs.writeFileSync(lbMp4, 'fake', 'utf8');
    fs.writeFileSync(lbEv, [
      JSON.stringify({ id: 1, ts: 1000, type: 'member', user: { uniqueId: 'lurker', nickname: 'Lurker' } }),
      JSON.stringify({ id: 2, ts: 2000, type: 'superFan', user: { uniqueId: 'fan1', nickname: 'Fan1' } }),
    ].join('\n') + '\n', 'utf8');
    assert.equal(autoTags(`${lbBase}.mp4`).includes('subscriber'), true);
    const lb = buildLeaderboard(`${lbBase}.mp4`);
    assert.equal(lb.totals.uniqueUsers, 1);
    assert.equal(lb.overall[0].uniqueId, 'fan1');
    assert.equal(lb.overall[0].score, 20);
  } finally {
    fs.rmSync(lbMp4, { force: true });
    fs.rmSync(lbEv, { force: true });
  }
});

test('Phase 4 polish & micro-fixes: L1, L5, L6, L7 regressions', () => {
  const youtube = require('../lib/providers/youtube');
  const twitch = require('../lib/providers/twitch');
  const kick = require('../lib/providers/kick');
  const analytics = require('../lib/analytics');
  const ffmpeg = require('../lib/ffmpeg');
  const utils = require('../lib/utils');
  const storage = require('../lib/storage');

  // L5: buildRecordArgs handles audioOnly + useTs without dead branches
  const aoTsArgs = ffmpeg.buildRecordArgs({ url: 'https://example.com/a.flv', kind: 'flv', audioOnly: true, format: 'ts' }, 'out.mp4');
  assert.ok(aoTsArgs.includes('-vn'));
  assert.ok(aoTsArgs.includes('aac_adtstoasc'));

  // L6: YouTube compact viewer count ("1.2K"), Twitch "source" in name, Kick control char sanitization
  const ytViews = youtube.extractViewerCountFromInitialData({
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { videoPrimaryInfoRenderer: { viewCount: { videoViewCountRenderer: { originalViewCount: '1.2K' } } } },
            ],
          },
        },
      },
    },
  });
  assert.equal(ytViews, 1200);

  const twSrc = twitch.classifyTwitchVariant({ videoGroup: '1080p60', name: '1080p60 (source)', height: 1080, fps: 60 });
  assert.equal(twSrc.sdkKey, 'origin');

  const kickMsg = kick.parseKickPusherMessage({
    event: 'App\\Events\\GiftedSubscriptionsEvent',
    data: JSON.stringify({
      gifter_username: 'Gifter\x07One',
      gifted_usernames: ['Alice\x00', 'Bob\n'],
    }),
  });
  assert.equal(kickMsg.events[0].user.nickname, 'GifterOne');
  assert.equal(kickMsg.events[0].comment, 'Gifted to Alice, Bob');

  // L7: analytics non-string / non-mutation, safeError redaction & dangling symlink guard
  assert.equal(analytics.spamScore(null), 0);
  assert.equal(analytics.spamScore('   '), 0);
  const sampleEv = { type: 'chat', comment: '   ' };
  const spamRes = analytics.annotateSpam([sampleEv]);
  assert.equal(spamRes.spamCount, 0);
  assert.equal('_spamScore' in sampleEv, false);

  assert.equal(utils.safeError('OAuth secretToken123'), '[redacted]');
  assert.equal(utils.safeError('https://api.example.com/?key=superSecretKey99'), 'https://api.example.com/?[redacted]');

  const danglingName = `dangling_${Date.now()}.mp4`;
  const danglingPath = path.join(storage.RECORDINGS_DIR, danglingName);
  try {
    fs.symlinkSync(path.join(storage.RECORDINGS_DIR, `missing_target_${Date.now()}.mp4`), danglingPath);
    assert.equal(utils.resolveRecordingPath(storage.RECORDINGS_DIR, danglingName, '.mp4'), null);
  } catch (err) {
    // Skip symlink creation assertion on locked-down Windows shells without symlink privilege
    if (err?.code !== 'EPERM') throw err;
  } finally {
    try { fs.unlinkSync(danglingPath); } catch {}
  }
});

test('YouTube Live 4K/2K adaptiveFormats extraction, pump segment helpers, and FFmpeg args', async () => {
  const youtube = require('../lib/providers/youtube');
  const ffmpeg = require('../lib/ffmpeg');
  const utils = require('../lib/utils');
  const pump = require('../lib/youtube-live-pump');

  // 1. classifyYouTubeVariant maps 2160p/1440p distinctly
  assert.deepEqual(youtube.classifyYouTubeVariant({ height: 2160, fps: 60 }), {
    sdkKey: 'uhd4k_60',
    level: 120,
    label: '2160p60 (4K)',
  });
  assert.deepEqual(youtube.classifyYouTubeVariant({ height: 2160, fps: 30 }), {
    sdkKey: 'uhd4k',
    level: 115,
    label: '2160p (4K)',
  });
  assert.deepEqual(youtube.classifyYouTubeVariant({ height: 1440, fps: 60 }), {
    sdkKey: 'qhd_60',
    level: 105,
    label: '1440p60 (2K)',
  });
  assert.deepEqual(youtube.classifyYouTubeVariant({ height: 1440, fps: 30 }), {
    sdkKey: 'qhd',
    level: 100,
    label: '1440p (2K)',
  });

  // 2. QUALITY_RE / sanitizeQuality accepts 4K and 2K keys
  assert.equal(utils.sanitizeQuality('uhd4k_60'), 'uhd4k_60');
  assert.equal(utils.sanitizeQuality('uhd4k'), 'uhd4k');
  assert.equal(utils.sanitizeQuality('qhd_60'), 'qhd_60');
  assert.equal(utils.sanitizeQuality('qhd'), 'qhd');

  // 3. fetchLiveStatus queries ANDROID InnerTube when web adaptiveFormats lack direct .url,
  //    preserves H.264 1080p60 HLS for browser preview, and prefers uhd4k_60 (yt_adaptive) for recording
  const html4k = [
    '<script>',
    'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"Live4kVid01","title":"4K Live","channelId":"UC1234567890123456789012","author":"4K Chan","isLive":true},"playabilityStatus":{"status":"OK"},"streamingData":{"hlsManifestUrl":"https://manifest.googlevideo.com/web/master.m3u8","adaptiveFormats":[{"itag":315,"height":2160,"fps":60,"mimeType":"video/webm; codecs=\\"vp9\\""}]}};',
    'var ytInitialData = {};',
    '</script>',
    '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_4K_KEY"});</script>',
  ].join('\n');
  const hls1080 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=60',
    'https://rr1---sn.googlevideo.com/1080p60.m3u8',
  ].join('\n');

  const res4k = await youtube.fetchLiveStatus('v_Live4kVid01', {
    fetchImpl: async (url) => {
      if (url.includes('youtube.com/watch')) return { ok: true, status: 200, text: html4k };
      if (url.includes('/youtubei/v1/player')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            streamingData: {
              adaptiveFormats: [
                {
                  itag: 315,
                  width: 3840,
                  height: 2160,
                  fps: 60,
                  bitrate: 18000000,
                  targetDurationSec: 5,
                  mimeType: 'video/webm; codecs="vp9"',
                  url: 'https://rr4---sn.googlevideo.com/videoplayback?itag=315',
                },
                {
                  itag: 308,
                  width: 2560,
                  height: 1440,
                  fps: 60,
                  bitrate: 9000000,
                  targetDurationSec: 5,
                  mimeType: 'video/webm; codecs="vp9"',
                  url: 'https://rr4---sn.googlevideo.com/videoplayback?itag=308',
                },
                {
                  itag: 140,
                  bitrate: 144000,
                  mimeType: 'audio/mp4; codecs="mp4a.40.2"',
                  url: 'https://rr4---sn.googlevideo.com/videoplayback?itag=140',
                },
              ],
            },
          }),
        };
      }
      if (url.includes('manifest.googlevideo.com')) return { ok: true, status: 200, text: hls1080 };
      return { ok: false, status: 404, text: '' };
    },
  });

  const streams4k = youtube.extractStreamUrls(res4k);
  assert.equal(streams4k.qualities[0].sdkKey, 'uhd4k_60');
  assert.equal(streams4k.qualities[1].sdkKey, 'qhd_60');
  assert.equal(streams4k.hlsByQuality.uhd_60, 'https://rr1---sn.googlevideo.com/1080p60.m3u8');
  assert.equal(streams4k.hlsByQuality.uhd4k_60, undefined);

  const preferred = youtube.pickPreferredStream(streams4k);
  assert.equal(preferred.kind, 'yt_adaptive');
  assert.equal(preferred.quality, 'uhd4k_60');
  assert.equal(preferred.audioUrl, 'https://rr4---sn.googlevideo.com/videoplayback?itag=140');

  // 4. buildRecordArgs handles kind='yt_adaptive' cleanly without H.264/AAC bitstreams or MPEG-TS
  const adaptiveArgs = ffmpeg.buildRecordArgs(
    {
      url: 'http://127.0.0.1:12345/tok/video',
      audioUrl: 'http://127.0.0.1:12345/tok/audio',
      kind: 'yt_adaptive',
      quality: 'uhd4k_60',
      format: 'ts',
      referer: 'https://www.youtube.com/',
    },
    'out_4k.mp4',
    ['-http_proxy', 'http://127.0.0.1:8888'],
  );
  assert.equal(adaptiveArgs.includes('h264_mp4toannexb'), false);
  assert.equal(adaptiveArgs.includes('aac_adtstoasc'), false);
  assert.equal(adaptiveArgs.includes('mpegts'), false);
  assert.equal(adaptiveArgs.includes('-http_proxy'), false);
  assert.ok(adaptiveArgs.includes('-movflags'));

  // 5. prepareWebmSegment & prepareMp4Segment helpers (8-byte EBML VINT 0x01...)
  const webmBuf = Buffer.from([
    0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00,
    0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05,
    0x1F, 0x43, 0xB6, 0x75, 0xAA, 0xBB,
  ]);
  const webmFirst = pump.prepareWebmSegment(webmBuf, true);
  assert.deepEqual([...webmFirst.subarray(10, 18)], [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  assert.deepEqual(pump.prepareWebmSegment(webmBuf, false), Buffer.from([0x1F, 0x43, 0xB6, 0x75, 0xAA, 0xBB]));

  const mp4Buf = Buffer.alloc(24);
  mp4Buf.writeUInt32BE(8, 0);
  mp4Buf.write('ftyp', 4, 'ascii');
  mp4Buf.writeUInt32BE(8, 8);
  mp4Buf.write('moov', 12, 'ascii');
  mp4Buf.writeUInt32BE(8, 16);
  mp4Buf.write('moof', 20, 'ascii');
  assert.equal(pump.prepareMp4Segment(mp4Buf, true).length, 24);
  const mp4Next = pump.prepareMp4Segment(mp4Buf, false);
  assert.equal(mp4Next.toString('ascii', 4, 8), 'moof');
});

test('Multi-platform Phase 3: SOOP Live provider, registry, and watcher intervals', async () => {
  const providers = require('../lib/providers');
  const soop = require('../lib/providers/soop');
  const watcher = require('../lib/watcher');

  // 1. Registry & input parsing
  assert.ok(providers.SUPPORTED_PLATFORMS.includes('soop'));
  assert.equal(providers.SUPPORTED_PLATFORMS.includes('facebook'), false);
  assert.equal(providers.SUPPORTED_PLATFORMS.includes('instagram'), false);
  assert.equal(providers.normalizePlatform('sooplive'), 'soop');
  assert.equal(providers.normalizePlatform('afreecatv'), 'soop');

  assert.deepEqual(providers.parseChannelInput('https://play.sooplive.co.kr/testerkr/12345'), {
    platform: 'soop',
    username: 'kr_testerkr',
  });
  assert.deepEqual(providers.parseChannelInput('https://www.afreecatv.com/station/mybj'), {
    platform: 'soop',
    username: 'kr_mybj',
  });
  assert.deepEqual(providers.parseChannelInput('https://www.sooplive.com/GlobalStreamer'), {
    platform: 'soop',
    username: 'globalstreamer',
  });
  assert.deepEqual(providers.parseChannelInput('https://www.afreeca.tv/mybj2'), {
    platform: 'soop',
    username: 'kr_mybj2',
  });

  assert.equal(providers.derivePlatformFromFilename('soop_kr_bj/soop_kr_bj_20260101.mp4', null, 'soop_kr_bj'), 'soop');
  assert.equal(providers.stripPlatformPrefix('soop_kr_bj'), 'kr_bj');

  // 2. SOOP Korea fetchLiveStatus + packet parser + chat session
  const soopStatus = await soop.fetchLiveStatus('https://play.sooplive.co.kr/kobj', {
    useYtDlpFallback: false,
    fetchImpl: async (url, opts) => {
      if (url.includes('player_live_api.php') && String(opts?.body || '').includes('type=live')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            CHANNEL: {
              RESULT: 1,
              BNO: '998877',
              BJID: 'kobj',
              BJNICK: 'KO BJ',
              TITLE: 'SOOP KR Test',
              CATE: 'Talk',
              RMD: 'https://livestream-manager.sooplive.co.kr',
              CHDOMAIN: 'chat.sooplive.co.kr',
              CHPT: 8000,
              CHATNO: '998877',
              FTK: 'ftk123',
              VIEWPRESET: { total_cnt: 450 },
            },
          }),
        };
      }
      if (url.includes('player_live_api.php') && String(opts?.body || '').includes('type=aid')) {
        return { ok: true, status: 200, text: JSON.stringify({ CHANNEL: { AID: 'aid_tok_1' } }) };
      }
      if (url.includes('broad_stream_assign.html')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ view_url: 'https://live-global-cdn-01.sooplive.co.kr/live/998877/master.m3u8' }),
        };
      }
      if (url.includes('master.m3u8')) {
        return {
          ok: true,
          status: 200,
          text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60\nhttps://live-global-cdn-01.sooplive.co.kr/live/1080p60.m3u8\n',
        };
      }
      return { ok: false, status: 404, text: '' };
    },
  });
  assert.equal(soop.isLive(soopStatus), true);
  const soopStreams = soop.extractStreamUrls(soopStatus);
  assert.equal(soop.hasStreamUrls(soopStreams), true);
  assert.equal(soop.pickPreferredStream(soopStreams).url, 'https://live-global-cdn-01.sooplive.co.kr/live/1080p60.m3u8');
  assert.equal(soop.buildSummary('kr_kobj', soopStatus, soopStreams).roomId, '998877');

  const pktChat = soop.buildSoopPacket('0005', '\x0chello world\x0cviewer1\x0c0\x0c0\x0c0\x0cViewer One\x0c');
  const parsedPkt = soop.parseSoopKoreaPacket(pktChat);
  assert.equal(parsedPkt.events[0].type, 'chat');
  assert.equal(parsedPkt.events[0].comment, 'hello world');
  assert.equal(parsedPkt.events[0].user.nickname, 'Viewer One');

  const pktGift = soop.buildSoopPacket('0018', '\x0ckobj\x0cfan1\x0cSuper Fan\x0c5\x0c');
  const parsedGift = soop.parseSoopKoreaPacket(pktGift);
  assert.equal(parsedGift.events[0].type, 'gift');
  assert.equal(parsedGift.events[0].giftName, 'Star Balloon');
  assert.equal(parsedGift.events[0].repeatCount, 5);

  const fakeSoopWs = new EventEmitter();
  fakeSoopWs.readyState = 1;
  fakeSoopWs.sent = [];
  fakeSoopWs.send = (d) => fakeSoopWs.sent.push(d);
  fakeSoopWs.close = () => { fakeSoopWs.readyState = 3; fakeSoopWs.emit('close'); };
  fakeSoopWs.terminate = () => fakeSoopWs.close();
  const soopChat = new soop.SoopChatSession('kr_kobj', {
    chatMeta: soopStatus.chatMeta,
    wsFactory: () => fakeSoopWs,
  });
  soopChat.uiActive = true;
  const connectSoopP = soopChat.connect();
  fakeSoopWs.emit('open');
  await connectSoopP;
  fakeSoopWs.emit('message', pktChat);
  fakeSoopWs.emit('message', pktGift);
  assert.equal(soopChat.events.some((e) => e.type === 'chat' && e.comment === 'hello world'), true);
  assert.equal(soopChat.events.some((e) => e.type === 'gift' && e.repeatCount === 5), true);
  soopChat.disconnect();
  assert.equal(soopChat.state, 'closed');

  // 3. Watcher poll intervals for SOOP
  assert.equal(watcher.getEffectivePollIntervalMs({ platform: 'soop', priority: 'normal' }, 30), 30_000);
  assert.equal(watcher.getEffectivePollIntervalMs({ platform: 'soop', priority: 'high' }, 30), 15_000);

  // 4. Windows-unsafe / traversal inputs rejected or safely rendered
  const utils = require('../lib/utils');
  assert.equal(providers.parseChannelInput('soop:a:b').username, '');
  assert.equal(providers.parseChannelInput('soop:../etc/passwd').username, '');
  const renderedCon = utils.renderRecordingFilename('{username}_{date}', { platform: 'soop', username: 'con' });
  assert.ok(!renderedCon.includes(':'));

  // 5. SOOP bugfix regressions (C1-C3, H6, M1, L1)
  // C1: base64 tokens with trailing '=' / '==' are NOT treated as cookie headers
  assert.equal(soop.formatSoopCookie('Tok1='), 'AuthTicket=Tok1=');

  // C2: single-rendition media playlists still populate hlsByQuality.origin & qualities
  const mediaPlaylist = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg1.ts\n';
  const soopMedia = await soop.fetchLiveStatus('kr_single', {
    useYtDlpFallback: false,
    fetchImpl: async (url, opts) => {
      if (url.includes('player_live_api.php') && String(opts?.body || '').includes('type=live')) {
        return { ok: true, status: 200, text: JSON.stringify({ CHANNEL: { RESULT: 1, BNO: '111', CATE: '00040001', VIEWPRESET: [{ label: 'org' }] } }) };
      }
      if (url.includes('player_live_api.php')) return { ok: true, status: 200, text: JSON.stringify({ CHANNEL: { AID: 'a1' } }) };
      if (url.includes('broad_stream_assign.html')) {
        return { ok: true, status: 200, text: JSON.stringify({ view_url: 'https://cdn.sooplive.co.kr/live/auth_playlist.m3u8' }) };
      }
      if (url.includes('auth_playlist.m3u8')) return { ok: true, status: 200, text: mediaPlaylist };
      return { ok: false, status: 404, text: '' };
    },
  });
  assert.equal(soop.extractStreamUrls(soopMedia).hlsByQuality.origin, 'https://cdn.sooplive.co.kr/live/auth_playlist.m3u8?aid=a1');
  assert.equal(soop.buildSummary('kr_single', soopMedia).liveRoomMode, 'SOOP KR'); // L1 numeric CATE fallback & M1 VIEWPRESET array

  // C3: multi-packet SOOP Korea binary frames, non-00 status code, and ArrayBuffer input
  const pktMulti1 = soop.buildSoopPacket('0005', '\x0cfirst msg\x0cu1\x0c0\x0c0\x0c0\x0cUser1\x0c');
  const pktMulti2 = Buffer.from(soop.buildSoopPacket('0018', '\x0ckobj\x0cu2\x0cUser2\x0c3\x0c'));
  pktMulti2.write('01', 12, 'ascii'); // non-00 status code
  const combined = Buffer.concat([pktMulti1, pktMulti2]);
  const ab = combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
  const parsedMulti = soop.parseSoopKoreaPacket(ab);
  assert.equal(parsedMulti.packets.length, 2);
  assert.equal(parsedMulti.events.length, 2);
  assert.equal(parsedMulti.events[0].comment, 'first msg');
  assert.equal(parsedMulti.events[1].type, 'gift');
  assert.equal(parsedMulti.events[1].repeatCount, 3);
  assert.equal(parsedMulti.events[1].diamondCount, 10);

  // SoopChatSession 0001 ACK triggers 0002 join immediately, and close clears chatMeta
  const fakeSoopWs2 = new EventEmitter();
  fakeSoopWs2.readyState = 1;
  fakeSoopWs2.sent = [];
  fakeSoopWs2.send = (d) => fakeSoopWs2.sent.push(Buffer.isBuffer(d) ? d.toString('utf8') : String(d));
  fakeSoopWs2.close = () => { fakeSoopWs2.readyState = 3; fakeSoopWs2.emit('close'); };
  fakeSoopWs2.terminate = () => fakeSoopWs2.close();
  const soopAckSession = new soop.SoopChatSession('kr_ack', {
    chatMeta: { chdomain: 'chat.sooplive.co.kr', chpt: 8000, chatno: '111', ftk: 'ftkA', bjId: 'ack' },
    wsFactory: () => fakeSoopWs2,
  });
  soopAckSession.uiActive = true;
  const pAck = soopAckSession.connect();
  fakeSoopWs2.emit('open');
  await pAck;
  assert.equal(fakeSoopWs2.sent.length, 1);
  assert.match(fakeSoopWs2.sent[0], /^\x1b\t0001/);
  fakeSoopWs2.emit('message', soop.buildSoopPacket('0001', '\x0c'));
  assert.equal(fakeSoopWs2.sent.length, 2);
  assert.match(fakeSoopWs2.sent[1], /^\x1b\t0002/);
  fakeSoopWs2.emit('close');
  assert.equal(soopAckSession.chatMeta, null);
  soopAckSession.disconnect();

  // H6: cleanly offline SOOP channels do NOT spawn yt-dlp
  let ytDlpCalled = false;
  await soop.fetchLiveStatus('kr_offline', {
    fetchImpl: async () => ({ ok: true, status: 200, text: JSON.stringify({ CHANNEL: { RESULT: 0 } }) }),
    ytDlpExec: async () => { ytDlpCalled = true; return '{}'; },
  });
  assert.equal(ytDlpCalled, false);

  // H6 & unified SOOP .com + chapi station enrichment + .co.kr fallback
  const soopComStation = await soop.fetchLiveStatus('phonics1', {
    useYtDlpFallback: false,
    fetchImpl: async (url, opts) => {
      if (url.includes('live.sooplive.com/afreeca/player_live_api.php') && String(opts?.body || '').includes('type=live')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            CHANNEL: {
              RESULT: 1,
              BNO: '298846493',
              BJID: 'phonics1',
              BJNICK: 'Minkyo',
              TITLE: 'SOOP Live Test',
              CATE: '40019',
              RMD: 'https://livestream-manager.sooplive.com',
              CHDOMAIN: 'chat-25.sooplive.com',
              CHPT: 9000,
              VIEWPRESET: [{ label: 'org' }],
            },
          }),
        };
      }
      if (url.includes('live.sooplive.com/afreeca/player_live_api.php')) {
        return { ok: true, status: 200, text: JSON.stringify({ CHANNEL: { AID: 'aid_com' } }) };
      }
      if (url.includes('chapi.sooplive.com/api/phonics1/station')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            profile_image: '//profile.img.sooplive.com/LOGO/ph/phonics1/phonics1.jpg',
            station: {
              user_nick: 'MinkyoStation',
              broad_start: '2026-11-25 13:02:25',
              upd: { fan_cnt: 442197 },
            },
            broad: {
              broad_no: 298846493,
              broad_title: 'Station Title',
              current_sum_viewer: 24845,
            },
          }),
        };
      }
      if (url.includes('broad_stream_assign.html')) {
        return { ok: true, status: 200, text: JSON.stringify({ view_url: 'https://live-global-cdn-v02.sooplive.co.kr/live/master.m3u8' }) };
      }
      if (url.includes('master.m3u8')) return { ok: true, status: 200, text: mediaPlaylist };
      return { ok: false, status: 404, text: '' };
    },
  });
  assert.equal(soop.isLive(soopComStation), true);
  assert.equal(soopComStation.viewerCount, 24845);
  assert.equal(soopComStation.followers, 442197);
  assert.equal(soopComStation.avatarThumb, 'https://profile.img.sooplive.com/LOGO/ph/phonics1/phonics1.jpg');
  assert.equal(soopComStation.startedAtUnix, Math.floor(Date.parse('2026-11-25T13:02:25+09:00') / 1000));
  const soopComSummary = soop.buildSummary('phonics1', soopComStation);
  assert.equal(soopComSummary.owner.avatarThumb, 'https://profile.img.sooplive.com/LOGO/ph/phonics1/phonics1.jpg');
  assert.equal(soopComSummary.owner.followers, 442197);

  // Network fallback from live.sooplive.com to live.sooplive.co.kr
  const krFallback = await soop.fetchLiveStatus('fallbackuser', {
    useYtDlpFallback: false,
    fetchImpl: async (url) => {
      if (url.includes('live.sooplive.com')) throw new Error('COM timeout');
      if (url.includes('live.sooplive.co.kr/afreeca/player_live_api.php')) {
        return { ok: true, status: 200, text: JSON.stringify({ CHANNEL: { RESULT: 1, BNO: '555', RMD: 'https://livestream-manager.sooplive.co.kr' } }) };
      }
      if (url.includes('broad_stream_assign.html')) return { ok: true, status: 200, text: JSON.stringify({ view_url: 'https://cdn.sooplive.co.kr/555.m3u8' }) };
      return { ok: true, status: 200, text: mediaPlaylist };
    },
  });
  assert.equal(soop.isLive(krFallback), true);
});

test('Unified 5-platform Stealth & Anonymous Engine: per-platform toggles, persistence, zero cookie leaks, and chat enforcement', async () => {
  const { EventEmitter } = require('node:events');
  const stealth = require('../lib/stealth');
  const settings = require('../lib/settings');
  const accounts = require('../lib/accounts');
  const room = require('../lib/room');
  const chat = require('../lib/chat');
  const twitch = require('../lib/providers/twitch');
  const youtube = require('../lib/providers/youtube');
  const kick = require('../lib/providers/kick');
  const soop = require('../lib/providers/soop');

  const root = path.resolve(__dirname, '..');
  const settingsFile = path.join(root, 'settings.json');
  const hadSet = fs.existsSync(settingsFile);
  const origSet = hadSet ? fs.readFileSync(settingsFile) : null;
  const prevMode = stealth.getStealthMode();
  const prevPlatforms = stealth.getStealthPlatforms();

  const prevEnv = {
    TWITCH_OAUTH_TOKEN: process.env.TWITCH_OAUTH_TOKEN,
    YOUTUBE_COOKIE: process.env.YOUTUBE_COOKIE,
    KICK_TOKEN: process.env.KICK_TOKEN,
    SOOP_COOKIE: process.env.SOOP_COOKIE,
  };

  try {
    stealth.setStealthMode(false, { persist: false });
    stealth.setStealthPlatforms({ tiktok: false, twitch: false, youtube: false, kick: false, soop: false }, { persist: false });
    process.env.TWITCH_OAUTH_TOKEN = 'tw_secret_oauth';
    process.env.YOUTUBE_COOKIE = 'SID=yt_secret_cookie';
    process.env.KICK_TOKEN = 'kick_secret_tok';
    process.env.SOOP_COOKIE = 'AuthTicket=soop_secret';

    // 1. Stealth engine helpers (UA pool, header stripper, yt-dlp args, persistence)
    const ua1 = stealth.getStealthUserAgent(true);
    const ua2 = stealth.getStealthUserAgent(true);
    assert.ok(ua1.startsWith('Mozilla/5.0 ') && ua2.startsWith('Mozilla/5.0 '));
    const stripped = stealth.stripIdentityHeaders({
      Cookie: 'a=b',
      Authorization: 'Bearer x',
      'X-CSRFToken': 'c',
      'X-Goog-Visitor-Id': 'v',
      Accept: 'application/json',
    });
    assert.deepEqual(stripped, { Accept: 'application/json' });
    assert.deepEqual(stealth.getStealthYtDlpArgs(true).slice(0, 2), ['--no-cookies', '--user-agent']);

    stealth.setPlatformStealth('yt', true, { persist: true });
    assert.equal(stealth.isPlatformStealth('youtube'), true);
    assert.equal(stealth.isPlatformStealth('twitch'), false);
    assert.equal(settings.getPublicSettings().stealthPlatforms.youtube, true);

    stealth.setStealthMode(false, { persist: true });
    stealth.setStealthPlatforms({ youtube: true, twitch: true, soop: true, kick: false }, { persist: false });

    // 2. Per-platform independence: Kick allowed when stealth.kick=false, Twitch/YouTube/SOOP masked
    assert.equal(stealth.shouldUseAnonymous('youtube'), true);
    assert.equal(stealth.shouldUseAnonymous('twitch'), true);
    assert.equal(stealth.shouldUseAnonymous('soop'), true);
    assert.equal(stealth.shouldUseAnonymous('kick'), false);
    assert.equal(stealth.shouldUseAnonymous('kick', { forceAnon: true }), true);
    assert.equal(stealth.shouldUseAnonymous('kick', { accountId: 'anon' }), true);

    // 3. YouTube InnerTube player + chat poll must strip X-Goog-Visitor-Id, visitorData, and cookie under stealth/anon
    let innerTubeReqOpts = null;
    const ytHtml = [
      '<script>',
      'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"StealthVid1","title":"YT Stealth","channelId":"UC123","author":"Chan","isLive":true},"playabilityStatus":{"status":"OK"},"streamingData":{}};',
      'var ytInitialData = {};',
      '</script>',
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"YT_KEY","VISITOR_DATA":"SECRET_VISITOR"});</script>',
    ].join('\n');
    const ytRes = await youtube.fetchLiveStatus('StealthChan', {
      useYtDlpFallback: false,
      fetchImpl: async (url, opts) => {
        if (url.includes('/live')) return { ok: true, status: 200, text: ytHtml };
        if (url.includes('/youtubei/v1/player')) {
          innerTubeReqOpts = { url, opts };
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({ streamingData: { hlsManifestUrl: 'https://manifest.googlevideo.com/m.m3u8' } }),
          };
        }
        return { ok: true, status: 200, text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhttps://rr1.googlevideo.com/720.m3u8\n' };
      },
    });
    assert.equal(ytRes.stealth, true);
    assert.equal(ytRes.authenticated, false);
    assert.equal(innerTubeReqOpts.opts.forceAnon, false); // carried arg, while per-platform stealth blocks cookie & visitorData
    assert.equal(innerTubeReqOpts.opts.headers['X-Goog-Visitor-Id'], undefined);
    assert.equal(innerTubeReqOpts.opts.body.includes('SECRET_VISITOR'), false);
    const ytBuiltHeaders = youtube.buildYouTubeHeaders({}, 'www.youtube.com');
    assert.equal(ytBuiltHeaders.Cookie, 'CONSENT=YES+cb'); // no yt_secret_cookie!
    assert.equal(youtube.buildSummary('StealthChan', ytRes).stealth, true);

    let ytPollAccountId = 'unset';
    const ytChat = new youtube.YouTubeChatSession('StealthChan', {
      apiKey: 'YT_KEY',
      continuation: 'CONT1',
      fetchImpl: async (_url, opts) => {
        ytPollAccountId = opts.accountId;
        return { ok: true, status: 200, text: JSON.stringify({ continuationContents: { liveChatContinuation: { actions: [], continuations: [] } } }) };
      },
    });
    ytChat.accountId = 'anon';
    ytChat.uiActive = true;
    ytChat.state = 'connected';
    await ytChat._pollOnce();
    assert.equal(ytPollAccountId, 'anon');
    ytChat.disconnect();

    // 4. Twitch stealth & accountId='anon' omit OAuth header and set summary stealth=true
    let seenTwAuth = 'unset';
    const twSt = await twitch.fetchLiveStatus('shroud', {
      fetchImpl: async (_u, opts) => {
        seenTwAuth = opts.headers.Authorization;
        return { ok: true, status: 200, text: JSON.stringify({ data: { user: { id: '1', login: 'shroud', stream: null } } }) };
      },
    });
    assert.equal(seenTwAuth, undefined);
    assert.equal(twSt.stealth, true);
    assert.equal(twitch.buildSummary('shroud', twSt).stealth, true);

    // 5. Kick accountId='anon' omits Authorization and adds --no-cookies for yt-dlp
    let seenKickAuth = 'unset';
    let seenKickArgs = [];
    await kick.fetchLiveStatus('xqc', {
      accountId: 'anon',
      fetchImpl: async (_u, opts) => {
        seenKickAuth = opts.headers.Authorization;
        return { ok: false, status: 404, text: '' };
      },
      ytDlpExec: async (_bin, args) => {
        seenKickArgs = args;
        return JSON.stringify({ is_live: false });
      },
    });
    assert.equal(seenKickAuth, undefined);
    assert.equal(seenKickArgs.includes('--no-cookies'), true);

    // 6. SOOP skips cookies under stealth
    let seenSoopCookie = 'unset';
    await soop.fetchLiveStatus('kr_off', {
      useYtDlpFallback: false,
      fetchImpl: async (_u, opts) => {
        seenSoopCookie = opts.headers?.Cookie;
        return { ok: true, status: 200, text: JSON.stringify({ CHANNEL: { RESULT: 0 } }) };
      },
    });
    assert.equal(seenSoopCookie, undefined);

    // 7. TikTok ChatSession uses fresh randomized clientPresets in stealth, and enforceStealth skips stealth in background health check
    stealth.setPlatformStealth('tiktok', true);
    const ttChat = new chat.ChatSession('tt_stealth_user');
    const ttOpts = ttChat._buildConnectOpts({ forceAnon: false });
    assert.equal(ttOpts.authenticateWs, false);
    assert.equal(ttOpts.session, undefined);
    assert.ok(ttOpts.clientPresets?.device);

    // 8b. checkAllAccountsHealth({ skipStealth: true }) skips stealth platforms and only checks non-stealth
    const accFile = path.join(root, 'accounts.json');
    const keyFile = path.join(root, '.accounts.key');
    const hadAcc = fs.existsSync(accFile);
    const hadKey = fs.existsSync(keyFile);
    const origAcc = hadAcc ? fs.readFileSync(accFile) : null;
    const origKey = hadKey ? fs.readFileSync(keyFile) : null;
    process.env.ACCOUNTS_SECRET = 'stealth-health-test-secret';
    try {
      const ttAcc = accounts.add('StealthTT', 'tiktok_stealth_sess_123456', '', 'tiktok');
      const twAcc = accounts.add('NonStealthKick', 'kick_saved_tok_12345678', '', 'kick');
      stealth.setPlatformStealth('tiktok', true);
      stealth.setPlatformStealth('kick', false);
      const healthRes = await accounts.checkAllAccountsHealth({
        skipStealth: true,
        requestImpl: () => { throw new Error('must not ping TikTok under stealth'); },
      });
      assert.equal(ttAcc.id in healthRes, false);
      assert.equal(twAcc.id in healthRes, true);
      accounts.remove(ttAcc.id);
      accounts.remove(twAcc.id);
    } finally {
      delete process.env.ACCOUNTS_SECRET;
      if (hadAcc && origAcc) fs.writeFileSync(accFile, origAcc);
      else fs.rmSync(accFile, { force: true });
      if (hadKey && origKey) fs.writeFileSync(keyFile, origKey);
      else fs.rmSync(keyFile, { force: true });
    }

    // 9. accounts.resolveRequestAuthOptions handles anon, invalid ID, and valid state
    assert.deepEqual(accounts.resolveRequestAuthOptions({ anon: '1' }, 'tiktok'), { ok: true, forceAnon: true, accountId: 'anon' });
    assert.deepEqual(accounts.resolveRequestAuthOptions({ accountId: 'anon' }, 'youtube'), { ok: true, forceAnon: true, accountId: 'anon' });
    assert.equal(accounts.resolveRequestAuthOptions({ accountId: 'nonexistent_id' }, 'twitch').ok, false);
    assert.equal(typeof accounts.getHasSessionByPlatform().tiktok, 'boolean');

    // 10. room.getStealthMode syncs with stealth.setStealthMode + chat.enforceStealth aborts in-flight connecting TikTok auth session
    stealth.setStealthMode(true);
    assert.equal(room.getStealthMode(), true);
    stealth.setStealthMode(false);
    stealth.setPlatformStealth('tiktok', false);
    const origGetActive = accounts.getActiveCredentials;
    accounts.getActiveCredentials = () => ({ id: null, sessionId: 'tt_auth_session_for_enforce_test', ttTargetIdc: '' });
    const origProtoAttempt = chat.ChatSession.prototype._attemptConnect;
    let attemptCalls = 0;
    const seenAuthFlags = [];
    chat.ChatSession.prototype._attemptConnect = function patchedAttempt(opts = {}) {
      attemptCalls++;
      const built = this._buildConnectOpts(opts);
      this.usedAuth = !!built.authenticateWs;
      seenAuthFlags.push(this.usedAuth);
      if (attemptCalls === 1) {
        return new Promise(() => {}); // hold first auth attempt in 'connecting'
      }
      return Promise.resolve({ state: { roomId: 'r_anon' }, usedAuth: this.usedAuth });
    };
    try {
      const pEnforce = chat.ensureSession('enforce_user', { platform: 'tiktok', source: 'ui' });
      await new Promise((r) => setImmediate(r));
      stealth.setPlatformStealth('tiktok', true);
      chat.enforceStealth('tiktok');
      await new Promise((r) => setImmediate(r));
      const s = chat.getSession('enforce_user', 'tiktok');
      assert.ok(s);
      assert.equal(seenAuthFlags[0], true);
      assert.equal(seenAuthFlags[1], false);
      assert.equal(s.usedAuth, false);
      assert.equal(s.info().stealth, true);
      chat.closeSession('enforce_user', { force: true, platform: 'tiktok' });
      await Promise.race([pEnforce.catch(() => {}), new Promise((r) => setTimeout(r, 20))]);
    } finally {
      chat.ChatSession.prototype._attemptConnect = origProtoAttempt;
      accounts.getActiveCredentials = origGetActive;
    }
  } finally {
    stealth.setStealthMode(prevMode, { persist: false });
    stealth.setStealthPlatforms(prevPlatforms, { persist: false });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (hadSet && origSet) fs.writeFileSync(settingsFile, origSet);
    else fs.rmSync(settingsFile, { force: true });
  }
});

test('Phase 6 functional regressions: audio-only ffmpeg args, Kick post-connect error reconnect, YouTube VOD/4K, protected DELETE 409, and DB emoji/error safety', async () => {
  const os = require('node:os');
  const http = require('node:http');
  const express = require('express');
  const ffmpeg = require('../lib/ffmpeg');
  const kick = require('../lib/providers/kick');
  const youtube = require('../lib/providers/youtube');
  const db = require('../lib/db');
  const recordRouter = require('../routes/record');

  // 1. Audio-only buildRecordArgs prefers audioUrl and adds -protocol_whitelist only for HTTP(S) URLs
  const aoYtArgs = ffmpeg.buildRecordArgs(
    { url: 'https://video.example.com/v.m3u8', audioUrl: 'https://audio.example.com/a.m4a', kind: 'yt_adaptive', quality: 'yt_adaptive', audioOnly: true },
    'out.mp4'
  );
  assert.ok(aoYtArgs.includes('https://audio.example.com/a.m4a'));
  assert.equal(aoYtArgs.includes('https://video.example.com/v.m3u8'), false);
  assert.ok(aoYtArgs.includes('-protocol_whitelist'));
  assert.ok(aoYtArgs.includes('-vn'));

  const localArgs = ffmpeg.buildRecordArgs({ url: path.join(os.tmpdir(), 'sample.flv'), quality: 'ld' }, 'out.mp4');
  assert.equal(localArgs.includes('-protocol_whitelist'), false);

  // 2. KickChatSession post-connect rawObj.error triggers reconnect scheduling when consumers exist
  const wsErr = new EventEmitter();
  wsErr.readyState = 1;
  wsErr.send = () => {};
  wsErr.close = () => { wsErr.readyState = 3; };
  wsErr.terminate = () => { wsErr.readyState = 3; };
  const errSess = new kick.KickChatSession('xqc', { chatroomId: '668123', wsFactory: () => wsErr });
  errSess.uiActive = true;
  const kp = errSess.connect();
  await new Promise((r) => setImmediate(r));
  wsErr.emit('open');
  wsErr.emit('message', JSON.stringify({ id: 1, connect: { client: 'c1', expires: false } }));
  await kp;
  wsErr.emit('message', JSON.stringify({ error: { code: 102, message: 'token expired' } }));
  assert.equal(errSess.state, 'reconnecting');
  assert.ok(errSess.reconnectTimer);
  errSess.disconnect();

  // 3. YouTube rejects archived VOD (isLive: false) and prefers 4K/2K in parseYouTubeMasterM3u8
  const vodHtml = '<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"Vod1","title":"Archived VOD","author":"Chan","isLive":false},"playabilityStatus":{"status":"OK"},"streamingData":{"hlsManifestUrl":"https://manifest.googlevideo.com/vod.m3u8"}};</script>';
  const vodRes = await youtube.fetchLiveStatus('VodChan', {
    useYtDlpFallback: false,
    fetchImpl: async () => ({ ok: true, status: 200, text: vodHtml }),
  });
  assert.equal(youtube.isLive(vodRes), false);

  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,FRAME-RATE=60',
    'https://cdn.example/1080p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,FRAME-RATE=60',
    'https://cdn.example/2160p60.m3u8',
  ].join('\n');
  const parsedStreams = youtube.parseYouTubeMasterM3u8(m3u8);
  const best = youtube.pickPreferredStream(parsedStreams, 'auto');
  assert.equal(best.quality, 'uhd4k_60');
  assert.equal(best.url, 'https://cdn.example/2160p60.m3u8');

  // 4. DELETE /api/recordings/:name returns HTTP 409 when recording is protected
  const protName = `prot_del_${Date.now()}.mp4`;
  const protMp4 = path.join(storage.RECORDINGS_DIR, protName);
  const protMeta = path.join(storage.RECORDINGS_DIR, protName.replace(/\.mp4$/, '.meta.json'));
  const app = express();
  app.use(express.json());
  app.use(recordRouter);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const srvPort = srv.address().port;
  try {
    fs.writeFileSync(protMp4, 'mp4');
    fs.writeFileSync(protMeta, JSON.stringify({ protected: true, startMs: Date.now() }));
    const delRes = await fetch(`http://127.0.0.1:${srvPort}/api/recordings/${encodeURIComponent(protName)}`, { method: 'DELETE' });
    assert.equal(delRes.status, 409);
    assert.equal(fs.existsSync(protMp4), true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(protMp4, { force: true });
    fs.rmSync(protMeta, { force: true });
  }

  // 5. DB emoji / short Unicode search + preserves prior rows on transient readEvents error
  if (db.isAvailable()) {
    const dbRec = `db_unicode_${Date.now()}.mp4`;
    const dbMp4 = path.join(storage.RECORDINGS_DIR, dbRec);
    const dbEv = path.join(storage.RECORDINGS_DIR, dbRec.replace(/\.mp4$/, '.events.jsonl'));
    try {
      fs.writeFileSync(dbMp4, 'mp4');
      fs.writeFileSync(
        dbEv,
        [
          JSON.stringify({ type: 'chat', ts: 1700000001000, user: { nickname: 'สวัสดี' }, comment: '🔥 fire stream ดี' }),
        ].join('\n') + '\n',
        'utf8'
      );
      db.indexRecording(dbRec);
      const fireHits = db.searchChatIndexed('🔥');
      assert.equal(fireHits.some((h) => h.recording === dbRec), true);
      const thaiHits = db.searchChatIndexed('ดี');
      assert.equal(thaiHits.some((h) => h.recording === dbRec), true);

      // Simulate transient read error by swapping events file with a directory (readFileSync -> EISDIR)
      fs.rmSync(dbEv, { force: true });
      fs.mkdirSync(dbEv);
      db.indexRecording(dbRec);
      const afterErrHits = db.searchChatIndexed('🔥');
      assert.equal(afterErrHits.some((h) => h.recording === dbRec), true);
      db.removeRecording(dbRec);
    } finally {
      fs.rmSync(dbMp4, { force: true });
      fs.rmSync(dbEv, { recursive: true, force: true });
    }
  }
});
