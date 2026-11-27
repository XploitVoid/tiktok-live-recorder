// lib/chat.js — Manage TikTok LIVE chat WebSocket connections per username.
// Used by server.js to capture chat/gift/like events alongside recordings.
// Built on tiktok-live-connector v2.5+ (TikTokLiveConnection + v3 schema).

const { EventEmitter } = require('node:events');
const fs = require('fs');
const {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
  Devices,
  Locations,
  Screens,
  getRandomPresets,
} = require('tiktok-live-connector');
const { isPlatformStealth, shouldUseAnonymous } = require('./stealth');
const { getTikTokClientProxyOptions, getProxyList, getActiveProxyUrl, rotateProxy } = require('./proxy-config');
const { getProvider, normalizePlatform, sessionKey } = require('./providers');
const { safeError } = require('./utils');
const { TwitchChatSession } = require('./providers/twitch');
const { YouTubeChatSession } = require('./providers/youtube');
const { KickChatSession } = require('./providers/kick');
const { SoopChatSession } = require('./providers/soop');

function pickFreshClientPresets() {
  if (
    Array.isArray(Devices) && Devices.length > 0 &&
    Array.isArray(Locations) && Locations.length > 0 &&
    Array.isArray(Screens) && Screens.length > 0
  ) {
    return {
      device: Devices[Math.floor(Math.random() * Devices.length)],
      location: Locations[Math.floor(Math.random() * Locations.length)],
      screen: Screens[Math.floor(Math.random() * Screens.length)],
    };
  }
  return typeof getRandomPresets === 'function' ? getRandomPresets() : undefined;
}

function isDeviceBlockedError(err) {
  return /DEVICE_BLOCKED/i.test(err?.message || '');
}

function isAuthWsError(err) {
  return (
    err?.name === 'AuthenticatedWebSocketConnectionError' ||
    /authenticate_websocket|WHITELIST_AUTHENTICATED_SESSION_ID_HOST|session cookies found/i.test(err?.message || '')
  );
}

const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(100);

const RING_BUFFER_SIZE = 500;

// Reconnect backoff: 2s, 5s, 10s, 20s, 30s (capped)
const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];
const MAX_RECONNECT_ATTEMPTS = 12;

function extractAvatar(u) {
  if (!u) return undefined;
  if (typeof u.profilePictureUrl === 'string' && u.profilePictureUrl) return u.profilePictureUrl;
  const list = u.avatarLarge?.urlList || u.avatarMedium?.urlList || u.avatarThumb?.urlList;
  if (Array.isArray(list) && list.length > 0) {
    return (
      list.find((x) => typeof x === 'string' && x.includes('100x100') && x.includes('.webp')) ||
      list.find((x) => typeof x === 'string' && x.includes('100x100') && x.includes('.jpeg')) ||
      list.find((x) => typeof x === 'string' && !x.includes('shrink')) ||
      list[0]
    );
  }
  return undefined;
}

function extractUser(u) {
  if (!u) return { uniqueId: undefined, nickname: undefined, userId: undefined, profilePictureUrl: undefined };
  return {
    uniqueId: u.displayId || u.uniqueId || undefined,
    nickname: u.nickname || u.nickName || undefined,
    userId: u.id ? String(u.id) : (u.userId ? String(u.userId) : undefined),
    profilePictureUrl: extractAvatar(u),
  };
}

class ChatSession {
  constructor(username) {
    this.username = username;
    this.events = []; // ring buffer of recent events
    this.nextId = 1;
    this.viewerCount = null;
    this.startedAt = null;
    this.state = 'idle'; // idle | connecting | connected | error | closed
    this.error = null;
    this.writers = new Set(); // fs WriteStreams that also receive events
    this.listeners = new Set(); // external event listener callbacks
    this.conn = null;
    this.manualClose = false;  // true when user-initiated disconnect
    this.uiActive = false;     // true when opened by UI (/api/chat/start)
    this.recorderRefs = 0;     // active recording jobs attached or connecting
    this.accountId = null;     // optional per-channel account override
    this.roomId = null;        // optional pre-resolved roomId to skip HTML scrape
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this._connectPromise = null;
    // ── Health metrics ──
    this.health = {
      reconnectCount: 0,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      totalEventsReceived: 0,
      errorsCount: 0,
      lastError: null,
      lastEventAt: null,
    };
  }

  _cleanupConn() {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
    if (!this.conn) return;
    try { this.conn.removeAllListeners?.(); } catch {}
    try { Promise.resolve(this.conn.disconnect()).catch(() => {}); } catch {}
    this.conn = null;
  }

  _scheduleReconnect() {
    if (this.manualClose || !this.hasConsumers()) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[chat] @${this.username} gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      this.state = 'error';
      chatEvents.emit('state', { username: this.username, session: this.info() });
      return;
    }
    const idx = Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[idx];
    this.reconnectAttempts++;
    console.log(`[chat] @${this.username} scheduling reconnect in ${delay}ms (attempt #${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose || !this.hasConsumers() || this.state === 'connected') return;
      this.state = 'reconnecting';
      this.connect().catch((e) => {
        if (this.manualClose || !this.hasConsumers() || this.state === 'connected') return;
        console.warn(`[chat] @${this.username} reconnect failed:`, safeError(e));
        this.state = 'reconnecting';
        chatEvents.emit('state', { username: this.username, session: this.info() });
        this._scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  push(type, payload) {
    const ev = { id: this.nextId++, ts: Date.now(), type, ...payload };
    this.events.push(ev);
    while (this.events.length > RING_BUFFER_SIZE) this.events.shift();
    for (const w of this.writers) {
      try { w.write(JSON.stringify(ev) + '\n'); } catch {}
    }
    // Notify external listeners (e.g. realtime highlight detector)
    for (const fn of this.listeners) {
      try { fn(ev); } catch {}
    }
    // Health tracking
    this.health.totalEventsReceived++;
    this.health.lastEventAt = ev.ts;
    chatEvents.emit('event', { username: this.username, event: ev, session: this.info() });
    return ev;
  }

  attachFile(filePath) {
    try {
      const w = fs.createWriteStream(filePath, { flags: 'a' });
      w.on('error', (err) => {
        this.writers.delete(w);
        try { w.destroy(); } catch {}
        console.warn(`[chat] @${this.username} writer error:`, err?.message || err);
      });
      this.writers.add(w);
      return w;
    } catch {
      return null;
    }
  }

  detachFile(w) {
    if (!w) return;
    this.writers.delete(w);
    try { w.end(); } catch {}
  }

  _bindEvents(conn) {
    conn.on(WebcastEvent.CHAT, (e) => this.push('chat', {
      user: extractUser(e?.user || e),
      comment: e?.content ?? e?.comment ?? '',
    }));

    conn.on(WebcastEvent.GIFT, (e) => {
      const giftType = e?.gift?.type ?? e?.giftType ?? 0;
      // Streakable gifts (giftType === 1) emit intermediate ticks with repeatEnd === 0/false
      // while the combo is ongoing; wait for the final repeatEnd event to avoid double-counting.
      if (giftType === 1 && (e?.repeatEnd === 0 || e?.repeatEnd === false)) return;
      this.push('gift', {
        user: extractUser(e?.user || e),
        giftName: e?.gift?.name ?? e?.giftName ?? '',
        diamondCount: Number(e?.gift?.diamondCount ?? e?.diamondCount ?? 0) || 0,
        repeatCount: Number(e?.repeatCount ?? 1) || 1,
        giftType,
      });
    });

    conn.on(WebcastEvent.LIKE, (e) => this.push('like', {
      user: extractUser(e?.user || e),
      likeCount: Number(e?.count ?? e?.likeCount ?? 1) || 1,
      totalLikeCount: Number(e?.total ?? e?.totalLikeCount ?? 0) || 0,
    }));

    conn.on(WebcastEvent.MEMBER, (e) => this.push('member', {
      user: extractUser(e?.user || e),
    }));

    conn.on(WebcastEvent.SOCIAL, (e) => this.push('social', {
      user: extractUser(e?.user || e),
      label: e?.common?.displayText?.defaultPattern ?? e?.label ?? '',
    }));

    conn.on(WebcastEvent.FOLLOW, (e) => this.push('follow', {
      user: extractUser(e?.user || e),
    }));

    conn.on(WebcastEvent.SHARE, (e) => this.push('share', {
      user: extractUser(e?.user || e),
    }));

    // ── PK / link-mic battle ──
    conn.on(WebcastEvent.LINK_MIC_BATTLE, (e) => {
      let users = [];
      if (Array.isArray(e?.anchorsInfo)) {
        users = e.anchorsInfo
          .map((a) => a?.value?.user || a?.user)
          .filter(Boolean)
          .map((u) => extractUser(u));
      } else if (Array.isArray(e?.battleUsers)) {
        users = e.battleUsers.map((u) => extractUser(u));
      }
      this.push('pkStart', {
        battleUsers: users,
        battleId: e?.battleId ? String(e.battleId) : undefined,
      });
    });

    conn.on(WebcastEvent.LINK_MIC_ARMIES, (e) => {
      const teams = Array.isArray(e?.teamArmies)
        ? e.teamArmies.map((t) => ({
            teamId: String(t?.teamId || ''),
            score: Number(t?.teamTotalScore) || 0,
            hostRank: Number(t?.hostRank) || 0,
          }))
        : [];
      const bs = e?.triggerReason ?? e?.battleStatus;
      const ended =
        bs === 2 ||
        bs === 'BATTLE_END' ||
        bs === 'TRIGGER_REASON_BATTLE_END';
      this.push(ended ? 'pkEnd' : 'pkUpdate', {
        teams,
        totalDiamondCount: Number(e?.totalDiamondCount) || 0,
        battleId: e?.battleId ? String(e.battleId) : undefined,
      });
    });

    // ── Subscribe (paid monthly subscriber) ──
    conn.on(WebcastEvent.SUB_NOTIFY, (e) => this.push('subscribe', {
      user: extractUser(e?.user || e),
    }));

    // ── Envelope (treasure box / red envelope) ──
    conn.on(WebcastEvent.ENVELOPE, (e) => this.push('envelope', {
      treasureBoxData: e?.treasureBoxData || null,
      envelopeInfo: e?.envelopeInfo || null,
    }));

    // ── Question (Q&A mode) ──
    conn.on(WebcastEvent.QUESTION_NEW, (e) => {
      const q = e?.data || e;
      this.push('question', {
        user: extractUser(q?.user || e),
        comment: q?.content || e?.questionText || e?.comment || '',
      });
    });

    // ── Live Intro (host intro message at stream start) ──
    conn.on(WebcastEvent.LIVE_INTRO, (e) => {
      const host = e?.user || e?.host;
      this.push('liveIntro', {
        introText: e?.content || e?.introText || '',
        host: host ? extractUser(host) : null,
      });
    });

    // ── Emote (sticker-only messages) ──
    conn.on(WebcastEvent.EMOTE, (e) => {
      const rawEmotes = Array.isArray(e?.emoteList)
        ? e.emoteList
        : Array.isArray(e?.emotes)
          ? e.emotes
          : [];
      const emotes = rawEmotes.map((em) => ({
        emoteId: em?.emoteId,
        imageUrl: em?.emoteImageUrl || em?.image?.urlList?.[0] || em?.image?.url?.[0] || null,
      }));
      this.push('emote', {
        user: extractUser(e?.user || e),
        emotes,
      });
    });

    // ── Caption / Subtitle (auto-generated by TikTok) ──
    conn.on(WebcastEvent.CAPTION_MESSAGE, (e) => {
      const contents = Array.isArray(e?.content) ? e.content : [];
      const text = contents.map((c) => c?.content || '').filter(Boolean).join(' ');
      if (!text) return;
      this.push('caption', {
        text,
        lang: contents[0]?.lang || null,
        timestampMs: e?.timestampMs ? Number(e.timestampMs) : null,
        durationMs: e?.durationMs ? Number(e.durationMs) : null,
        definite: !!e?.definite,
      });
    });

    // ── Room Pin (host pins a message) ──
    conn.on(WebcastEvent.ROOM_PIN, (e) => {
      const action = e?.action === 2 ? 'unpin' : 'pin';
      let pinnedText = null;
      let pinnedUser = null;
      if (e?.chatMessage) {
        pinnedText = e.chatMessage.content || e.chatMessage.comment || null;
        pinnedUser = extractUser(e.chatMessage.user || e.chatMessage);
      }
      this.push('roomPin', {
        action,
        pinnedText,
        pinnedUser,
        pinId: e?.pinMsgId || e?.pinId || null,
        displayDuration: e?.displayDuration ? Number(e.displayDuration) : null,
      });
    });

    // ── Rank Update (viewer rank / top gifter changes) ──
    conn.on(WebcastEvent.RANK_UPDATE, (e) => {
      const raw = Array.isArray(e?.updates) ? e.updates : (Array.isArray(e?.updatesList) ? e.updatesList : []);
      const updates = raw.map((u) => ({
        rankType: u?.rankType ?? null,
        ownerRank: u?.ownRank ?? u?.ownerRank ?? null,
        showAnimation: !!u?.showEntranceAnimation,
      }));
      if (updates.length === 0) return;
      this.push('rankUpdate', { updates });
    });

    conn.on(WebcastEvent.ROOM_USER, (e) => {
      const vc = e?.total != null
        ? Number(e.total)
        : (e?.viewerCount != null ? Number(e.viewerCount) : null);
      if (Number.isFinite(vc)) this.viewerCount = vc;
      this.push('roomUser', { viewerCount: vc });
    });

    // ── New Schema v3 Events (tiktok-live-connector 2.5.0) ──
    conn.on(WebcastEvent.SUPER_FAN, (e) => this.push('superFan', {
      user: extractUser(e?.user || e),
      joined: false,
    }));

    conn.on(WebcastEvent.SUPER_FAN_JOIN, (e) => this.push('superFan', {
      user: extractUser(e?.user || e),
      joined: true,
    }));

    conn.on(WebcastEvent.SUPER_FAN_BOX, (e) => this.push('superFanBox', {
      user: extractUser(e?.user || e),
      envelopeInfo: e?.envelopeInfo || null,
    }));

    conn.on(WebcastEvent.POLL_MESSAGE, (e) => {
      const info = e?.startContent || e?.endContent || e?.updateVotesContent || e?.pollBasicInfo || {};
      const options = Array.isArray(info?.optionList)
        ? info.optionList.map((o) => ({
            text: o?.optionText || o?.text || '',
            votes: Number(o?.currentTotal || o?.votes || 0) || 0,
          }))
        : [];
      this.push('poll', {
        pollId: e?.pollId ? String(e.pollId) : null,
        title: info?.title || info?.pollTitle || 'Live Poll',
        ended: !!e?.endContent,
        options,
      });
    });

    conn.on(WebcastEvent.OEC_LIVE_SHOPPING, (e) => {
      const prod = e?.popProduct || e?.productSnapShot || {};
      const title = prod?.title || prod?.productTitle || '';
      const price = prod?.price || prod?.formatPrice || '';
      if (!title && !e?.liveProductNumber) return;
      this.push('shopping', {
        actionType: e?.actionType ?? null,
        productNumber: e?.liveProductNumber ?? null,
        title: String(title || '').slice(0, 120),
        price: String(price || '').slice(0, 40),
      });
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      if (this.conn !== conn) return;
      this.push('streamEnd', {});
      this.disconnect(); // streamEnd is final — no auto-reconnect
      const k = sessionKey(this.platform || 'tiktok', this.username);
      if (sessions.get(k) === this) sessions.delete(k);
    });

    conn.on(ControlEvent.DISCONNECTED, () => {
      // Ignore stale disconnect events from replaced fallback attempts or while connect() is still falling back
      if (this.conn !== conn) return;
      if (this.state === 'connecting') return;
      this._cleanupConn();
      if (this.manualClose || !this.hasConsumers()) {
        this.state = 'closed';
        chatEvents.emit('state', { username: this.username, session: this.info() });
        return;
      }
      console.warn(`[chat] @${this.username} disconnected unexpectedly`);
      this.state = 'reconnecting';
      this.health.lastDisconnectedAt = Date.now();
      this.health.reconnectCount++;
      chatEvents.emit('state', { username: this.username, session: this.info() });
      this._scheduleReconnect();
    });

    conn.on(ControlEvent.ERROR, (err) => {
      if (this.conn && this.conn !== conn) return;
      const msg = safeError(err?.exception?.message || err?.message || err?.info || String(err));
      this.error = msg;
      this.health.errorsCount++;
      this.health.lastError = { message: msg, at: Date.now() };
    });
  }

  _buildConnectOpts({ forceAnon = false, clientPresets = null } = {}) {
    const anon = shouldUseAnonymous('tiktok', { accountId: this.accountId, forceAnon });
    const opts = {
      processInitialData: false,
      enableExtendedGiftInfo: false,
      fetchRoomInfoOnConnect: false, // we already fetched it via API
      authenticateWs: false,
      ...getTikTokClientProxyOptions(),
    };
    if (clientPresets) {
      opts.clientPresets = clientPresets;
    } else if (anon) {
      const fresh = pickFreshClientPresets();
      if (fresh) opts.clientPresets = fresh;
    }
    if (!anon) {
      // Snapshot credentials so a switchTo() during connect() doesn't leak.
      const { getActiveCredentials, getCredentialsById } = require('./accounts');
      const creds = this.accountId ? getCredentialsById(this.accountId) : getActiveCredentials();
      if (creds.sessionId) {
        opts.session = {
          cookie: {
            type: 'cookie',
            value: {
              sessionId: creds.sessionId,
              ttTargetIdc: creds.ttTargetIdc || '',
            },
          },
        };
        opts.authenticateWs = true;
      }
    }
    if (process.env.EULER_API_KEY) opts.signApiKey = process.env.EULER_API_KEY;
    return opts;
  }

  _createConnection(opts) {
    return new TikTokLiveConnection(this.username, opts);
  }

  async _attemptConnect({ forceAnon = false, clientPresets = null } = {}) {
    this._cleanupConn();
    const opts = this._buildConnectOpts({ forceAnon, clientPresets });
    this.usedAuth = !!opts.authenticateWs;
    const conn = this._createConnection(opts);
    this.conn = conn;
    this._bindEvents(conn);
    const state = await conn.connect(this.roomId || undefined);
    if (this.manualClose || this.conn !== conn) {
      try { conn.removeAllListeners?.(); } catch {}
      try { Promise.resolve(conn.disconnect()).catch(() => {}); } catch {}
      throw new Error('connection closed');
    }
    return { state, usedAuth: !!opts.authenticateWs };
  }

  async connect() {
    if (this.state === 'connecting' && this._connectPromise) return this._connectPromise;
    if (this.state === 'connected') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._cleanupConn();
    const seq = (this._connectSeq = (this._connectSeq || 0) + 1);
    this.manualClose = false;
    this.state = 'connecting';
    this.error = null;

    const p = (async () => {
      const initialOpts = this._buildConnectOpts({ forceAnon: false });
      const usedAuthInitially = !!initialOpts.authenticateWs;
      let result;
      try {
        result = await this._attemptConnect({ forceAnon: false });
        if (this.manualClose || this._connectSeq !== seq) {
          throw new Error('connection closed');
        }
      } catch (firstErr) {
        if (this.manualClose || this._connectSeq !== seq) throw firstErr;
        const blocked = isDeviceBlockedError(firstErr);
        const authErr = isAuthWsError(firstErr);

        let fallbackErr = firstErr;
        if ((usedAuthInitially && (blocked || authErr)) || (!usedAuthInitially && blocked)) {
          const hasFailoverProxy = getProxyList().length > 1;
          const usedProxy = getActiveProxyUrl();
          if (!usedAuthInitially && hasFailoverProxy) rotateProxy(usedProxy);
          console.warn(
            `[chat] @${this.username} WebSocket ${blocked ? 'DEVICE_BLOCKED' : 'auth error'}, ` +
            `retrying ${usedAuthInitially ? 'anonymous + ' : ''}fresh device preset` +
            `${!usedAuthInitially && hasFailoverProxy ? ' + failover proxy' : ''}`
          );
          try {
            result = await this._attemptConnect({
              forceAnon: true,
              clientPresets: pickFreshClientPresets(),
            });
          } catch (secondErr) {
            fallbackErr = secondErr;
            if (!this.manualClose && this._connectSeq === seq && usedAuthInitially && isDeviceBlockedError(secondErr) && hasFailoverProxy) {
              rotateProxy(usedProxy);
              console.warn(`[chat] @${this.username} anonymous retry DEVICE_BLOCKED, rotating proxy`);
              try {
                result = await this._attemptConnect({
                  forceAnon: true,
                  clientPresets: pickFreshClientPresets(),
                });
              } catch (thirdErr) {
                fallbackErr = thirdErr;
              }
            }
          }
        }

        if (this.manualClose || this._connectSeq !== seq) {
          throw fallbackErr;
        }

        if (!result) {
          this._cleanupConn();
          this.state = 'error';
          let msg = safeError(fallbackErr) || 'TikTok WebSocket connection failed';
          // Provide a friendly hint for common signing rate-limit or block errors.
          if (/Unexpected server response: 200/i.test(msg) || /SignatureRateLimitError/i.test(msg)) {
            msg += ' — Euler Stream signing rate-limited. Sign up free at https://www.eulerstream.com and set EULER_API_KEY in .env';
          } else if (isDeviceBlockedError(fallbackErr)) {
            msg += ' — TikTok WebSocket rejected device/IP (try Stealth Mode, another proxy, or EULER_API_KEY)';
          }
          this.error = msg;
          this.push('error', { error: msg });
          throw fallbackErr;
        }
      }

      if (this.manualClose || this._connectSeq !== seq) {
        return;
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const { state, usedAuth } = result;
      this.usedAuth = !!usedAuth;
      this.state = 'connected';
      this.startedAt = this.startedAt || Date.now();
      this.health.lastConnectedAt = Date.now();
      if (this._stabilityTimer) clearTimeout(this._stabilityTimer);
      this._stabilityTimer = setTimeout(() => {
        this._stabilityTimer = null;
        if (!this.manualClose && this.state === 'connected' && this._connectSeq === seq) {
          this.reconnectAttempts = 0;
        }
      }, 30_000);
      this._stabilityTimer.unref?.();
      this.push('connected', { roomId: state?.roomId ?? this.roomId ?? null });
    })().finally(() => {
      if (this._connectPromise === p) {
        this._connectPromise = null;
      }
    });
    this._connectPromise = p;
    return p;
  }

  hasConsumers() {
    return this.uiActive || this.recorderRefs > 0 || this.writers.size > 0 || this.listeners.size > 0;
  }

  disconnect() {
    this._connectSeq = (this._connectSeq || 0) + 1;
    this.manualClose = true;
    this.uiActive = false;
    this.recorderRefs = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._cleanupConn();
    for (const w of this.writers) { try { w.end(); } catch {} }
    this.writers.clear();
    this.listeners.clear();
    this.state = 'closed';
    chatEvents.emit('state', { username: this.username, session: this.info() });
  }

  snapshot(sinceId = 0) {
    return this.events.filter((e) => e.id > sinceId);
  }

  info() {
    return {
      platform: this.platform || 'tiktok',
      username: this.username,
      state: this.state,
      error: this.error,
      stealth: !this.usedAuth,
      startedAt: this.startedAt,
      viewerCount: this.viewerCount,
      eventCount: this.events.length,
      lastEventId: this.nextId - 1,
      hasFileWriter: this.writers.size > 0,
      health: this.health,
    };
  }
}

const sessions = new Map(); // sessionKey(platform, username) -> ChatSession | TwitchChatSession

function normalizeSessionTarget(username, platform = 'tiktok') {
  const normPlatform = normalizePlatform(platform);
  const normUser = getProvider(normPlatform).normalizeUsername(username) || String(username || '').trim();
  return { normPlatform, normUser, key: sessionKey(normPlatform, normUser) };
}

async function ensureSession(username, { platform = 'tiktok', source = 'ui', accountId = null, roomId = null, chatMeta = null, recorderRef = null } = {}) {
  const { normPlatform, normUser, key } = normalizeSessionTarget(username, platform);
  let s = sessions.get(key);
  if (!s) {
    if (normPlatform === 'twitch') {
      s = new TwitchChatSession(normUser, { chatEvents });
    } else if (normPlatform === 'youtube') {
      s = new YouTubeChatSession(normUser, { chatEvents });
    } else if (normPlatform === 'kick') {
      s = new KickChatSession(normUser, { chatEvents });
    } else if (normPlatform === 'soop') {
      s = new SoopChatSession(normUser, { chatEvents, chatMeta });
    } else {
      s = new ChatSession(normUser);
    }
    sessions.set(key, s);
  }
  if (accountId !== null && accountId !== undefined) {
    s.accountId = accountId || null;
  }
  if (roomId) {
    s.roomId = String(roomId);
  }
  if (chatMeta && !s.chatMeta) {
    s.chatMeta = chatMeta;
  }
  if (source === 'ui') s.uiActive = true;
  else if (source === 'recorder') {
    if (!recorderRef || !recorderRef.released) s.recorderRefs++;
  }

  // 'reconnecting' state means a reconnect is already scheduled — don't double-trigger.
  if (s.state !== 'connected' && s.state !== 'reconnecting') {
    try {
      if (s.state === 'connecting' && s._connectPromise) {
        await s._connectPromise;
      } else if (s.state !== 'connecting') {
        await s.connect();
      }
    } catch (e) {
      if (source === 'recorder') {
        if (!recorderRef || !recorderRef.released) {
          if (recorderRef) recorderRef.released = true;
          s.recorderRefs = Math.max(0, s.recorderRefs - 1);
        }
      } else if (source === 'ui') {
        s.uiActive = false;
      }
      if (!s.hasConsumers() && sessions.get(key) === s) {
        s.disconnect();
        sessions.delete(key);
      }
      throw e;
    }
  }
  return s;
}

function getSession(username, platform = 'tiktok') {
  const { key } = normalizeSessionTarget(username, platform);
  return sessions.get(key);
}

function closeSession(username, { force = true, platform = 'tiktok' } = {}) {
  const { key } = normalizeSessionTarget(username, platform);
  const s = sessions.get(key);
  if (!s) return false;
  if (!force) {
    s.uiActive = false;
    if (s.recorderRefs > 0 || s.writers.size > 0 || s.listeners.size > 0) {
      return false;
    }
  }
  s.disconnect();
  sessions.delete(key);
  return true;
}

function releaseRecorderSession(username, writer, listener, recorderRef = null, platform = 'tiktok') {
  const { key } = normalizeSessionTarget(username, platform);
  const s = sessions.get(key);
  if (writer) {
    if (s) s.detachFile(writer);
    else { try { writer.end(); } catch {} }
  }
  if (s) {
    if (listener) s.listeners.delete(listener);
    let shouldDec = true;
    if (recorderRef) {
      if (recorderRef.released) shouldDec = false;
      else recorderRef.released = true;
    }
    if (shouldDec) {
      s.recorderRefs = Math.max(0, s.recorderRefs - 1);
    }
    if (!s.hasConsumers()) {
      s.disconnect();
      sessions.delete(key);
    }
  } else if (recorderRef) {
    recorderRef.released = true;
  }
}

function listSessions() {
  return [...sessions.values()].map((s) => s.info());
}

function closeAll() {
  for (const s of sessions.values()) s.disconnect();
  sessions.clear();
}

function enforceStealth(targetPlatform = null) {
  const filterPlat = targetPlatform ? normalizePlatform(targetPlatform, null) : null;
  if (targetPlatform && !filterPlat) return;
  for (const [key, s] of [...sessions.entries()]) {
    const plat = normalizePlatform(s.platform || 'tiktok');
    if (filterPlat && plat !== filterPlat) continue;
    if (!isPlatformStealth(plat)) continue;

    if (plat === 'tiktok' && (s.usedAuth || s.state === 'connecting')) {
      s._connectSeq = (s._connectSeq || 0) + 1;
      s._connectPromise = null;
      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }
      s._cleanupConn();
      s.usedAuth = false;
      s.state = s.hasConsumers() ? 'reconnecting' : 'closed';
      chatEvents.emit('state', { username: s.username, session: s.info() });
      if (s.hasConsumers()) {
        s.connect().catch(() => {
          if (!s.manualClose && s.hasConsumers() && s.state !== 'connected') {
            s.state = 'reconnecting';
            chatEvents.emit('state', { username: s.username, session: s.info() });
            s._scheduleReconnect();
          }
        });
      } else {
        s.disconnect();
        sessions.delete(key);
      }
      continue;
    }

    if (s.accountId) {
      s.accountId = null;
    }
  }
}

module.exports = {
  ensureSession,
  getSession,
  closeSession,
  releaseRecorderSession,
  listSessions,
  closeAll,
  enforceStealth,
  ChatSession,
  chatEvents,
};
