// lib/chat.js — Manage TikTok LIVE chat WebSocket connections per username.
// Used by server.js to capture chat/gift/like events alongside recordings.

const fs = require('fs');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { getStealthMode } = require('./room');

const RING_BUFFER_SIZE = 500;

// Reconnect backoff: 2s, 5s, 10s, 20s, 30s (capped)
const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];

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
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
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
    if (!this.conn) return;
    try { this.conn.removeAllListeners?.(); } catch {}
    try { this.conn.disconnect(); } catch {}
    this.conn = null;
  }

  _scheduleReconnect() {
    if (this.manualClose) return;
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[idx];
    this.reconnectAttempts++;
    console.log(`[chat] @${this.username} scheduling reconnect in ${delay}ms (attempt #${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      this.connect().catch((e) => {
        console.warn(`[chat] @${this.username} reconnect failed:`, e?.message || e);
      });
    }, delay);
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
    return ev;
  }

  attachFile(filePath) {
    try {
      const w = fs.createWriteStream(filePath, { flags: 'a' });
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

  async connect() {
    if (this.state === 'connecting' || this.state === 'connected') return;
    // Clean up any previous connection before creating a new one (prevents
    // listener accumulation on reconnect after error/disconnect).
    this._cleanupConn();
    this.manualClose = false;
    this.state = 'connecting';
    this.error = null;

    const opts = {
      processInitialData: false,
      enableExtendedGiftInfo: false,
      fetchRoomInfoOnConnect: false, // we already fetched it via API
      enableRequestPolling: true,    // fallback if WS upgrade fails
    };
    if (!getStealthMode()) {
      // Snapshot credentials so a switchTo() during connect() doesn't leak.
      const { getActiveCredentials } = require('./accounts');
      const creds = getActiveCredentials();
      if (creds.sessionId) opts.sessionId = creds.sessionId;
      if (creds.ttTargetIdc) opts.ttTargetIdc = creds.ttTargetIdc;
    }
    if (process.env.EULER_API_KEY) opts.signApiKey = process.env.EULER_API_KEY;

    this.conn = new WebcastPushConnection(this.username, opts);

    this.conn.on('chat', (e) => this.push('chat', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, userId: e.userId, profilePictureUrl: e.profilePictureUrl },
      comment: e.comment,
    }));
    this.conn.on('gift', (e) => this.push('gift', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
      giftName: e.giftName,
      diamondCount: e.diamondCount,
      repeatCount: e.repeatCount,
      giftType: e.giftType,
    }));
    this.conn.on('like', (e) => this.push('like', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
      likeCount: e.likeCount,
      totalLikeCount: e.totalLikeCount,
    }));
    this.conn.on('member', (e) => this.push('member', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
    }));
    this.conn.on('social', (e) => this.push('social', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
      label: e.label,
    }));
    this.conn.on('follow', (e) => this.push('follow', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
    }));
    this.conn.on('share', (e) => this.push('share', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
    }));

    // ── PK / link-mic battle ──
    // Fired once when two streamers start a PK match. The legacy data converter
    // populates `battleUsers` with simplified user info for both sides.
    this.conn.on('linkMicBattle', (e) => {
      const users = Array.isArray(e?.battleUsers)
        ? e.battleUsers.map((u) => ({
            uniqueId: u?.uniqueId,
            nickname: u?.nickname,
            profilePictureUrl: u?.profilePictureUrl,
            userId: u?.userId ? String(u.userId) : undefined,
          }))
        : [];
      this.push('pkStart', { battleUsers: users, battleId: e?.battleId ? String(e.battleId) : undefined });
    });
    // Fired periodically during a PK with running score updates and once again
    // at battle-end. We split into pkUpdate / pkEnd based on battleStatus
    // (TriggerReason enum: 2 = TRIGGER_REASON_BATTLE_END).
    this.conn.on('linkMicArmies', (e) => {
      const teams = Array.isArray(e?.teamArmies)
        ? e.teamArmies.map((t) => ({
            teamId: String(t?.teamId || ''),
            score: Number(t?.teamTotalScore) || 0,
            hostRank: Number(t?.hostRank) || 0,
          }))
        : [];
      const bs = e?.battleStatus;
      const ended =
        bs === 2 ||
        bs === 'TRIGGER_REASON_BATTLE_END' ||
        bs === 'BATTLE_END';
      this.push(ended ? 'pkEnd' : 'pkUpdate', {
        teams,
        totalDiamondCount: Number(e?.totalDiamondCount) || 0,
        battleId: e?.battleId ? String(e.battleId) : undefined,
      });
    });

    // ── Subscribe (paid monthly subscriber) ──
    this.conn.on('subscribe', (e) => this.push('subscribe', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
    }));

    // ── Envelope (treasure box / red envelope) ──
    this.conn.on('envelope', (e) => this.push('envelope', {
      treasureBoxData: e?.treasureBoxData || null,
      envelopeInfo: e?.envelopeInfo || null,
    }));

    // ── Question (Q&A mode) ──
    this.conn.on('questionNew', (e) => this.push('question', {
      user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
      comment: e?.questionText || e?.content || e?.comment || '',
    }));

    // ── Live Intro (host intro message at stream start) ──
    this.conn.on('liveIntro', (e) => this.push('liveIntro', {
      introText: e?.content || e?.introText || '',
      host: e?.host ? { uniqueId: e.host.uniqueId, nickname: e.host.nickname, profilePictureUrl: e.host.profilePictureUrl } : null,
    }));

    // ── Emote (sticker-only messages) ──
    this.conn.on('emote', (e) => {
      const emotes = Array.isArray(e?.emotes)
        ? e.emotes.map((em) => ({ emoteId: em.emoteId, imageUrl: em.emoteImageUrl || em.image?.url?.[0] || null }))
        : Array.isArray(e?.emoteList)
          ? e.emoteList.map((em) => ({ emoteId: em.emoteId, imageUrl: em.image?.url?.[0] || null }))
          : [];
      this.push('emote', {
        user: { uniqueId: e.uniqueId, nickname: e.nickname, profilePictureUrl: e.profilePictureUrl },
        emotes,
      });
    });

    // ── Caption / Subtitle (auto-generated by TikTok) ──
    this.conn.on('captionMessage', (e) => {
      // e.content is an array of { lang, content } — pick the first one
      const contents = Array.isArray(e?.content) ? e.content : [];
      const text = contents.map((c) => c?.content || '').filter(Boolean).join(' ');
      if (!text) return; // skip empty captions
      this.push('caption', {
        text,
        lang: contents[0]?.lang || null,
        timestampMs: e?.timestampMs ? Number(e.timestampMs) : null,
        durationMs: e?.durationMs ? Number(e.durationMs) : null,
        definite: !!e?.definite,
      });
    });

    // ── Room Pin (host pins a message) ──
    this.conn.on('roomPin', (e) => {
      // action: 1 = pin, 2 = unpin
      const action = e?.action === 2 ? 'unpin' : 'pin';
      let pinnedText = null;
      let pinnedUser = null;
      if (e?.chatMessage) {
        pinnedText = e.chatMessage.comment || e.chatMessage.content || null;
        const u = e.chatMessage.user || e.chatMessage;
        pinnedUser = { uniqueId: u.uniqueId, nickname: u.nickname, profilePictureUrl: u.profilePictureUrl };
      }
      this.push('roomPin', {
        action,
        pinnedText,
        pinnedUser,
        pinId: e?.pinId || null,
        displayDuration: e?.displayDuration ? Number(e.displayDuration) : null,
      });
    });

    // ── Rank Update (viewer rank / top gifter changes) ──
    this.conn.on('rankUpdate', (e) => {
      const updates = Array.isArray(e?.updatesList)
        ? e.updatesList.map((u) => ({
            rankType: u?.rankType || null,
            ownerRank: u?.ownerRank || null,
            showAnimation: !!u?.showEntranceAnimation,
          }))
        : [];
      if (updates.length === 0) return;
      this.push('rankUpdate', { updates });
    });

    this.conn.on('roomUser', (e) => {
      this.viewerCount = e.viewerCount ?? this.viewerCount;
      this.push('roomUser', { viewerCount: e.viewerCount });
    });
    this.conn.on('streamEnd', () => {
      this.push('streamEnd', {});
      this.disconnect();  // streamEnd is final — no auto-reconnect
    });
    this.conn.on('disconnected', () => {
      // TikTok dropped us. If not user-initiated, try to reconnect.
      if (this.manualClose) {
        this.state = 'closed';
        return;
      }
      console.warn(`[chat] @${this.username} disconnected unexpectedly`);
      this.state = 'reconnecting';
      this.health.lastDisconnectedAt = Date.now();
      this.health.reconnectCount++;
      this._scheduleReconnect();
    });
    this.conn.on('error', (err) => {
      this.error = err?.message || String(err);
      this.health.errorsCount++;
      this.health.lastError = { message: this.error, at: Date.now() };
    });

    try {
      const state = await this.conn.connect();
      this.state = 'connected';
      this.startedAt = this.startedAt || Date.now();
      this.reconnectAttempts = 0;  // reset backoff on success
      this.health.lastConnectedAt = Date.now();
      this.push('connected', { roomId: state?.roomId ?? null });
    } catch (e) {
      this.state = 'error';
      let msg = e?.message || String(e);
      // Provide a friendly hint for common signing rate-limit errors.
      if (/Unexpected server response: 200/i.test(msg) || /SignatureRateLimitError/i.test(msg)) {
        msg += ' — Euler Stream signing rate-limited. Sign up free at https://www.eulerstream.com and set EULER_API_KEY in .env';
      }
      this.error = msg;
      this.push('error', { error: msg });
      throw e;
    }
  }

  disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._cleanupConn();
    for (const w of this.writers) { try { w.end(); } catch {} }
    this.writers.clear();
    this.state = 'closed';
  }

  snapshot(sinceId = 0) {
    return this.events.filter((e) => e.id > sinceId);
  }

  info() {
    return {
      username: this.username,
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
      viewerCount: this.viewerCount,
      eventCount: this.events.length,
      lastEventId: this.nextId - 1,
      hasFileWriter: this.writers.size > 0,
      health: this.health,
    };
  }
}

const sessions = new Map(); // username -> ChatSession

async function ensureSession(username) {
  let s = sessions.get(username);
  if (!s) {
    s = new ChatSession(username);
    sessions.set(username, s);
  }
  // 'reconnecting' state means a reconnect is already scheduled — don't double-trigger.
  if (s.state !== 'connected' && s.state !== 'connecting' && s.state !== 'reconnecting') {
    await s.connect();
  }
  return s;
}

function getSession(username) {
  return sessions.get(username);
}

function closeSession(username) {
  const s = sessions.get(username);
  if (!s) return false;
  s.disconnect();
  sessions.delete(username);
  return true;
}

function listSessions() {
  return [...sessions.values()].map((s) => s.info());
}

function closeAll() {
  for (const s of sessions.values()) s.disconnect();
  sessions.clear();
}

module.exports = { ensureSession, getSession, closeSession, listSessions, closeAll };
