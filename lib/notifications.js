// lib/notifications.js — Best-effort Discord & Telegram webhook notifications.

const { getSettings, isValidTelegramBotToken } = require('./settings');
const { safeError } = require('./utils');

const WEBHOOK_TIMEOUT_MS = 5000;

function formatMessage(type, payload = {}) {
  const user = payload.username ? `@${payload.username}` : 'Recorder';
  switch (type) {
    case 'went_live': {
      const viewers = payload.viewerCount != null ? ` (${Number(payload.viewerCount).toLocaleString()} viewers)` : '';
      const title = payload.title ? `\n${payload.title}` : '';
      return {
        title: `🔴 ${user} is LIVE${viewers}`,
        body: title.trim(),
        color: 0xe11d48,
      };
    }
    case 'record_started':
      return {
        title: `⏺️ Recording started: ${user}`,
        body: [
          payload.quality ? `Quality: ${payload.quality}` : null,
          payload.audioOnly ? 'Mode: Audio-Only' : null,
          payload.file ? `File: ${payload.file}` : null,
        ].filter(Boolean).join(' · '),
        color: 0x10b981,
      };
    case 'record_finished':
      return {
        title: `✅ Recording finished: ${user}`,
        body: [
          payload.file ? `File: ${payload.file}` : null,
          payload.sizeMb != null ? `Size: ${payload.sizeMb} MB` : null,
        ].filter(Boolean).join(' · '),
        color: 0x6366f1,
      };
    case 'record_stalled':
      return {
        title: `⚠️ Stream stalled: ${user}`,
        body: payload.error || 'No progress detected — reconnecting',
        color: 0xf59e0b,
      };
    case 'record_failed':
      return {
        title: `❌ Recording failed: ${user}`,
        body: payload.error || 'Unknown error',
        color: 0xef4444,
      };
    case 'disk_low':
      return {
        title: '💾 Critical: Low disk space',
        body: payload.error || 'Active recordings stopped to protect disk space',
        color: 0xef4444,
      };
    case 'cookie_expired':
      return {
        title: '🔑 Account cookie expired',
        body: `${payload.label || 'Account'}: ${payload.reason || 'Session expired — please update sessionid'}`,
        color: 0xf59e0b,
      };
    case 'parts_merged':
      return {
        title: `🧩 Parts merged: ${user}`,
        body: [
          payload.partsCount ? `${payload.partsCount} parts` : null,
          payload.file ? `File: ${payload.file}` : null,
          payload.sizeMb != null ? `Size: ${payload.sizeMb} MB` : null,
        ].filter(Boolean).join(' · '),
        color: 0x6366f1,
      };
    case 'test':
      return {
        title: '🔔 TikTok LIVE Recorder — Test Notification',
        body: 'Webhook notifications are configured and working.',
        color: 0x3b82f6,
      };
    default:
      return {
        title: `ℹ️ ${user}: ${type}`,
        body: payload.error || payload.file || '',
        color: 0x64748b,
      };
  }
}

async function postDiscord(webhookUrl, msg) {
  const title = String(msg.title || '').slice(0, 256);
  const body = msg.body ? String(msg.body).slice(0, 4096) : undefined;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title,
          description: body,
          color: msg.color,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  try { await res.body?.cancel?.(); } catch {}
  if (!res.ok) {
    throw new Error(`Discord HTTP ${res.status}`);
  }
}

async function postTelegram(botToken, chatId, msg, fetchImpl = fetch) {
  const token = String(botToken || '').trim();
  if (!token || !isValidTelegramBotToken(token)) {
    throw new Error('Invalid Telegram bot token');
  }
  const text = (msg.body ? `${msg.title}\n${msg.body}` : String(msg.title || '')).slice(0, 4096);
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  try { await res.body?.cancel?.(); } catch {}
  if (!res.ok) {
    throw new Error(`Telegram HTTP ${res.status}`);
  }
}

async function notifyEvent(type, payload = {}) {
  const { discordWebhookUrl, telegramBotToken, telegramChatId } = getSettings();
  if (!discordWebhookUrl && !(telegramBotToken && telegramChatId)) return;

  const msg = formatMessage(type, payload);
  const tasks = [];
  if (discordWebhookUrl) {
    tasks.push(
      postDiscord(discordWebhookUrl, msg).catch((e) => {
        console.warn('[notify] Discord error:', safeError(e));
      }),
    );
  }
  if (telegramBotToken && telegramChatId) {
    tasks.push(
      postTelegram(telegramBotToken, telegramChatId, msg).catch((e) => {
        console.warn('[notify] Telegram error:', safeError(e));
      }),
    );
  }
  await Promise.all(tasks);
}

async function testNotifications() {
  const { discordWebhookUrl, telegramBotToken, telegramChatId } = getSettings();
  if (!discordWebhookUrl && !(telegramBotToken && telegramChatId)) {
    const err = new Error('No Discord webhook or Telegram bot configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const msg = formatMessage('test');
  const results = {};
  if (discordWebhookUrl) {
    try {
      await postDiscord(discordWebhookUrl, msg);
      results.discord = { ok: true };
    } catch (e) {
      results.discord = { ok: false, error: safeError(e) };
    }
  }
  if (telegramBotToken && telegramChatId) {
    try {
      await postTelegram(telegramBotToken, telegramChatId, msg);
      results.telegram = { ok: true };
    } catch (e) {
      results.telegram = { ok: false, error: safeError(e) };
    }
  }
  return results;
}

module.exports = {
  formatMessage,
  postTelegram,
  notifyEvent,
  testNotifications,
};
