const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  TikTokLiveConnection,
  RouteConfig,
  WebcastEvent,
  ControlEvent,
} = require('tiktok-live-connector');

const room = require('../lib/room');
const { ChatSession } = require('../lib/chat');

test('TikTokLiveConnection constructs cleanly with anonymous and cookie session options', async () => {
  const anon = new TikTokLiveConnection('tv_asahi_news', {
    processInitialData: false,
    enableExtendedGiftInfo: false,
    fetchRoomInfoOnConnect: false,
    authenticateWs: false,
  });
  assert.ok(anon.webClient);
  assert.equal(await anon.webClient.cookieJar.getAnonymousCookieString(), '');

  const authed = new TikTokLiveConnection('tv_asahi_news', {
    processInitialData: false,
    enableExtendedGiftInfo: false,
    fetchRoomInfoOnConnect: false,
    authenticateWs: true,
    session: {
      cookie: {
        type: 'cookie',
        value: { sessionId: 'dummy_session_id_123456', ttTargetIdc: 'useast5' },
      },
    },
  });
  assert.ok(authed.webClient);
  const cookieStr = await authed.webClient.cookieJar.getCookieString();
  assert.match(cookieStr, /sessionid=dummy_session_id_123456/);
  assert.match(cookieStr, /tt-target-idc=useast5/);
});

test('room.fetchApiLive uses RouteConfig.fetchRoomInfoFromApiLive and falls back to anonymous on auth failure', async () => {
  const origRoute = RouteConfig.fetchRoomInfoFromApiLive;
  const accounts = require('../lib/accounts');
  const origGetActive = accounts.getActiveCredentials;

  let calls = 0;
  try {
    accounts.getActiveCredentials = () => ({ sessionId: 'bad_cookie_1234567890', ttTargetIdc: 'useast5' });
    RouteConfig.fetchRoomInfoFromApiLive = async ({ uniqueId, webClient }) => {
      calls++;
      assert.equal(uniqueId, 'test_fallback_user');
      assert.ok(webClient);
      const cookieStr = await webClient.cookieJar.getCookieString();
      if (calls === 1) {
        assert.match(cookieStr, /sessionid=bad_cookie/);
        throw new Error('simulated auth failure');
      }
      assert.equal(cookieStr.includes('sessionid=bad_cookie'), false);
      return {
        data: {
          user: { roomId: '12345', nickname: 'Tester', uniqueId: 'test_fallback_user' },
          liveRoom: { status: 2, title: 'Live Test', liveRoomStats: { userCount: 42 } },
        },
      };
    };

    room.invalidateApiCache('test_fallback_user');
    const data = await room.fetchApiLive('test_fallback_user', { noCache: true });
    assert.equal(calls, 2);
    assert.equal(room.isLiveFromApi(data), true);
    assert.equal(data.liveRoom.title, 'Live Test');
  } finally {
    RouteConfig.fetchRoomInfoFromApiLive = origRoute;
    accounts.getActiveCredentials = origGetActive;
  }
});

test('ChatSession._bindEvents normalizes v3 TikTokLiveConnection events cleanly', () => {
  const session = new ChatSession('streamer');
  const fakeConn = new EventEmitter();
  fakeConn.disconnect = async () => {};
  session._bindEvents(fakeConn);

  const sampleUser = {
    id: '9001',
    displayId: 'alice_id',
    nickname: 'Alice',
    avatarLarge: { urlList: ['https://p16.tiktokcdn.com/100x100.webp'] },
  };

  fakeConn.emit(WebcastEvent.CHAT, { user: sampleUser, content: 'hello v3' });
  fakeConn.emit(WebcastEvent.GIFT, {
    user: sampleUser,
    gift: { name: 'Rose', diamondCount: 1, type: 1 },
    repeatCount: 5,
  });
  fakeConn.emit(WebcastEvent.LIKE, { user: sampleUser, count: 15, total: '1500' });
  fakeConn.emit(WebcastEvent.MEMBER, { user: sampleUser });
  fakeConn.emit(WebcastEvent.SOCIAL, { user: sampleUser, common: { displayText: { defaultPattern: 'shared the LIVE' } } });
  fakeConn.emit(WebcastEvent.FOLLOW, { user: sampleUser });
  fakeConn.emit(WebcastEvent.SHARE, { user: sampleUser });
  fakeConn.emit(WebcastEvent.SUB_NOTIFY, { user: sampleUser });
  fakeConn.emit(WebcastEvent.QUESTION_NEW, { data: { user: sampleUser, content: 'How are you?' } });
  fakeConn.emit(WebcastEvent.LIVE_INTRO, { user: sampleUser, content: 'Welcome!' });
  fakeConn.emit(WebcastEvent.EMOTE, {
    user: sampleUser,
    emoteList: [{ emoteId: 'e1', image: { urlList: ['https://p16.tiktokcdn.com/emote.png'] } }],
  });
  fakeConn.emit(WebcastEvent.CAPTION_MESSAGE, {
    content: [{ lang: 'en', content: 'Testing captions' }],
    timestampMs: '1000',
    durationMs: '500',
    definite: true,
  });
  fakeConn.emit(WebcastEvent.ROOM_PIN, {
    action: 1,
    chatMessage: { user: sampleUser, content: 'Pinned msg' },
    pinMsgId: 'pin1',
    displayDuration: '30',
  });
  fakeConn.emit(WebcastEvent.RANK_UPDATE, {
    updates: [{ rankType: 1, ownRank: '3', showEntranceAnimation: true }],
  });
  fakeConn.emit(WebcastEvent.LINK_MIC_BATTLE, {
    battleId: 'b1',
    anchorsInfo: [{ key: '1', value: { user: { userId: '1', displayId: 'host1', nickName: 'Host 1' } } }],
  });
  fakeConn.emit(WebcastEvent.LINK_MIC_ARMIES, {
    battleId: 'b1',
    triggerReason: 1,
    totalDiamondCount: 200,
    teamArmies: [{ teamId: '1', teamTotalScore: '200', hostRank: '1' }],
  });
  fakeConn.emit(WebcastEvent.LINK_MIC_ARMIES, {
    battleId: 'b1',
    triggerReason: 2,
    totalDiamondCount: 500,
    teamArmies: [{ teamId: '1', teamTotalScore: '500', hostRank: '1' }],
  });
  fakeConn.emit(WebcastEvent.ROOM_USER, { total: '321' });
  fakeConn.emit(ControlEvent.ERROR, { info: 'Socket fail', exception: new Error('boom') });

  const byType = (t) => session.events.find((e) => e.type === t);

  assert.equal(byType('chat').comment, 'hello v3');
  assert.equal(byType('chat').user.uniqueId, 'alice_id');
  assert.equal(byType('chat').user.profilePictureUrl, 'https://p16.tiktokcdn.com/100x100.webp');
  assert.equal(byType('gift').giftName, 'Rose');
  assert.equal(byType('gift').diamondCount, 1);
  assert.equal(byType('gift').repeatCount, 5);
  assert.equal(byType('like').likeCount, 15);
  assert.equal(byType('like').totalLikeCount, 1500);
  assert.equal(byType('social').label, 'shared the LIVE');
  assert.equal(byType('subscribe').user.uniqueId, 'alice_id');
  assert.equal(byType('question').comment, 'How are you?');
  assert.equal(byType('liveIntro').introText, 'Welcome!');
  assert.equal(byType('liveIntro').host.uniqueId, 'alice_id');
  assert.equal(byType('emote').emotes[0].imageUrl, 'https://p16.tiktokcdn.com/emote.png');
  assert.equal(byType('caption').text, 'Testing captions');
  assert.equal(byType('roomPin').pinnedText, 'Pinned msg');
  assert.equal(byType('roomPin').pinnedUser.uniqueId, 'alice_id');
  assert.equal(byType('rankUpdate').updates[0].ownerRank, '3');
  assert.equal(byType('pkStart').battleUsers[0].nickname, 'Host 1');
  assert.equal(byType('pkUpdate').totalDiamondCount, 200);
  assert.equal(byType('pkEnd').totalDiamondCount, 500);
  assert.equal(session.viewerCount, 321);
  assert.equal(session.error, 'boom');
});

test('room.normalizeUsername extracts username from /live paths and TikTok URLs safely', () => {
  assert.equal(room.normalizeUsername('garenarovthailand'), 'garenarovthailand');
  assert.equal(room.normalizeUsername('@garenarovthailand'), 'garenarovthailand');
  assert.equal(room.normalizeUsername('garenarovthailand/live'), 'garenarovthailand');
  assert.equal(room.normalizeUsername('@garenarovthailand/live?foo=1'), 'garenarovthailand');
  assert.equal(room.normalizeUsername('https://www.tiktok.com/@garenarovthailand/live?enter_from=1'), 'garenarovthailand');
  assert.equal(room.normalizeUsername('tiktok.com/@garenarovthailand'), 'garenarovthailand');

  assert.equal(room.normalizeUsername('https://evil.com/@garenarovthailand/live'), '');
  assert.equal(room.normalizeUsername('..'), '');
  assert.equal(room.normalizeUsername('.'), '');
  assert.equal(room.normalizeUsername('bad/path'), '');
});

test('transcode args and 60fps quality validation', () => {
  const utils = require('../lib/utils');
  const transcode = require('../lib/transcode');

  assert.equal(utils.sanitizeQuality('hevc:uhd_60'), 'hevc:uhd_60');
  assert.equal(utils.sanitizeQuality('hd_60'), 'hd_60');
  assert.equal(utils.sanitizeQuality('invalid;rm -rf'), null);

  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']) {
    const args = transcode.buildTranscodeArgs('https://pull-hls-f16-sg01.tiktokcdn.com/stream/index.m3u8', enc);
    assert.ok(args.includes('-probesize'));
    assert.ok(args.includes('-bf'));
    assert.ok(args.includes('0'));
    assert.ok(args.includes('flv'));
  }
});
