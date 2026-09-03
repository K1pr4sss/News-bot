const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const config = require('./config');
const logger = require('./logger');

// Configurable so it can live on the same persistent volume as the SQLite DB
// in production (TELEGRAM_GROUPS_FILE_PATH=/data/telegramGroups.json on
// Railway) - without this, /addgroup's changes would be wiped on every
// redeploy just like the DB was before DB_PATH got pointed at the volume.
const GROUPS_FILE = process.env.TELEGRAM_GROUPS_FILE_PATH || path.join(__dirname, '..', 'telegramGroups.json');

function loadTrackedGroups() {
  if (fs.existsSync(GROUPS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    } catch {
      // fall through to config default below
    }
  }
  return [...config.telegramTrackedGroups];
}

let trackedGroups = loadTrackedGroups();

function persist() {
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(trackedGroups, null, 2));
}

function getTrackedGroups() {
  return [...trackedGroups];
}

function addGroup(nameOrId) {
  if (trackedGroups.some((g) => g.toLowerCase() === nameOrId.toLowerCase())) return;
  trackedGroups.push(nameOrId);
  persist();
}

function removeGroup(nameOrId) {
  trackedGroups = trackedGroups.filter((g) => g.toLowerCase() !== nameOrId.toLowerCase());
  persist();
}

// Logs in as the user's OWN Telegram account (MTProto, via GramJS) - the only
// way to read messages from groups without needing group-admin cooperation
// to add a bot. Requires a one-time interactive login (see
// scripts/telegramLogin.js) to produce TELEGRAM_USER_SESSION; this module
// just reconnects with that saved session, no interactivity needed at runtime.
let client = null;
let connectedAt = null;
let recentMessages = []; // { text, chatTitle, publishedAtMs }

// "Is the bot actually checking Telegram" was answerable before only by
// eyeballing raw debug logs (LOG_LEVEL flip + tail) - real friction every
// time this got asked this session. Exposed via /diagnostics instead: real
// connection state (not just "configured"), the actual tracked-group list
// (proves persistence survived every redeploy since), and real captured-
// message evidence (count + most recent chat/time), not just a boolean.
function getStatus() {
  return {
    configured: !!(config.telegramApiId && config.telegramApiHash && config.telegramUserSession),
    connected: !!connectedAt,
    connectedAt,
    trackedGroups: [...trackedGroups],
    recentMessageCount: recentMessages.length,
    mostRecentMessage: recentMessages[0]
      ? { chatTitle: recentMessages[0].chatTitle, at: recentMessages[0].publishedAtMs, preview: recentMessages[0].rawText.slice(0, 80) }
      : null,
  };
}

function getSignal(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  const term = (nameOrSymbol || '').toLowerCase();
  if (!term || term.length < 2) return { mentionCount: 0, sampleText: null };
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const matches = recentMessages.filter((m) => m.publishedAtMs > cutoff && m.text.includes(term));
  return { mentionCount: matches.length, sampleText: matches[0]?.rawText || null };
}

async function start() {
  if (!config.telegramApiId || !config.telegramApiHash || !config.telegramUserSession) {
    logger.info('Telegram user-account scanning not configured (needs TELEGRAM_API_ID/API_HASH/USER_SESSION - see scripts/telegramLogin.js) - contributes 0 to social velocity until set');
    return;
  }
  try {
    client = new TelegramClient(new StringSession(config.telegramUserSession), config.telegramApiId, config.telegramApiHash, {
      connectionRetries: 5,
    });
    await client.connect();
    connectedAt = Date.now();
    logger.info('Telegram user-account client connected');

    // Real diagnostic gap: "connected" only ever proved the MTProto session
    // itself was alive, never that the account is still actually a MEMBER
    // of each tracked group (removed/kicked, or a renamed group no longer
    // matching the stored name, would look identical to "just quiet" from
    // message-capture logs alone - zero events either way). Checked once at
    // startup against the account's real current dialog list.
    try {
      const dialogs = await client.getDialogs({ limit: 200 });
      const dialogInfo = dialogs.map((d) => ({
        title: d.title,
        username: d.entity?.username || null,
        entityType: d.entity?.className || null, // Channel (broadcast or supergroup) vs Chat (basic group) vs User
        lastMessageAt: d.message?.date ? new Date(d.message.date * 1000).toISOString() : null,
        lastMessagePreview: d.message?.message ? String(d.message.message).slice(0, 80) : null,
      }));
      logger.info('Telegram account dialog list fetched', { count: dialogInfo.length });
      for (const g of trackedGroups) {
        const found = dialogInfo.find(
          (d) => d.title?.toLowerCase() === g.toLowerCase() || d.username?.toLowerCase() === g.toLowerCase(),
        );
        if (found) {
          // Real observability gap: "connected" and even "confirmed member"
          // both look identical whether messages are actually flowing or
          // not - this is the direct evidence either way, without needing
          // to passively wait for a live event that may never come if
          // something structural (channel vs group event handling, etc.)
          // is actually broken rather than the chat just being quiet.
          logger.info('Tracked group confirmed - account is still a member', {
            group: g, entityType: found.entityType, lastMessageAt: found.lastMessageAt, lastMessagePreview: found.lastMessagePreview,
          });
        } else {
          logger.warn('Tracked group NOT found in the account\'s current dialog list - likely removed/kicked/renamed, or the account never actually joined it', { group: g });
        }
      }
    } catch (err) {
      logger.warn('Telegram dialog list check failed', { error: err.message });
    }

    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message?.message) return;
        const chat = await message.getChat();
        // A group almost always has BOTH a display title and an @username
        // (the t.me/xxx slug) - these are usually different strings, so
        // matching only one (title alone was the original bug here) silently
        // drops every message from a group added by its username instead of
        // its exact display title, or vice versa. Check both, plus the raw
        // chat ID for groups without a public username at all.
        const candidates = [chat?.title, chat?.username, String(message.chatId)].filter(Boolean);
        const chatTitle = chat?.title || chat?.username || String(message.chatId);

        // Fail CLOSED, not open: an empty tracked list means "nothing added
        // yet," not "capture everything this account can see." The old
        // `trackedGroups.length && ...` check let an empty list bypass
        // filtering entirely - confirmed live capturing the bot's own DMs to
        // the user (chatTitle showed the bot's numeric user ID) once the
        // tracked-groups file got reset to empty by the path-mangling bug.
        // Same "optional signal reads as 0, never silently expands scope"
        // pattern every other source in this codebase already follows.
        if (!trackedGroups.some((g) => candidates.some((c) => c.toLowerCase() === g.toLowerCase()))) {
          logger.debug('Telegram message seen but chat not tracked - ignored', { chatTitle, candidates });
          return;
        }

        // Real observability gap this session kept running into: silent
        // modules made "is this actually working" impossible to answer from
        // logs alone. This line is the direct proof for Telegram specifically.
        logger.debug('Telegram message captured from tracked group', { chatTitle, textPreview: message.message.slice(0, 80) });
        // unshift, not push - newest-first, so matches[0] (getSignal's
        // sampleText) and recentMessages[0] (getStatus's mostRecentMessage)
        // are both actually the most recent match, not the oldest one still
        // inside the retention window.
        recentMessages.unshift({
          text: message.message.toLowerCase(), rawText: message.message, chatTitle, publishedAtMs: Date.now(),
        });
        const cutoff = Date.now() - 60 * 60 * 1000;
        recentMessages = recentMessages.filter((m) => m.publishedAtMs > cutoff);
      } catch (err) {
        logger.debug('Telegram message handler failed', { error: err.message });
      }
    }, new NewMessage({}));
  } catch (err) {
    logger.error('Telegram user-account client failed to start', { error: err.message });
  }
}

module.exports = {
  start, getSignal, getTrackedGroups, addGroup, removeGroup, getStatus,
};
