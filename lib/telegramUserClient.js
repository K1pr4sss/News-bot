const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const config = require('./config');
const logger = require('./logger');

const GROUPS_FILE = path.join(__dirname, '..', 'telegramGroups.json');

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
let recentMessages = []; // { text, chatTitle, publishedAtMs }

function getSignal(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  const term = (nameOrSymbol || '').toLowerCase();
  if (!term || term.length < 2) return { mentionCount: 0 };
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const mentionCount = recentMessages.filter((m) => m.publishedAtMs > cutoff && m.text.includes(term)).length;
  return { mentionCount };
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
    logger.info('Telegram user-account client connected');

    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message?.message) return;
        const chat = await message.getChat();
        const chatTitle = chat?.title || chat?.username || String(message.chatId);

        // Only groups explicitly added via /addgroup - joining a group in the
        // real account is a manual step (see /addgroup's own description),
        // this just filters which of the account's joined chats actually feed
        // the scoring pipeline, so an account used for other things too
        // doesn't pull in unrelated noise.
        if (trackedGroups.length
            && !trackedGroups.some((g) => g.toLowerCase() === chatTitle.toLowerCase() || g === String(message.chatId))) {
          return;
        }

        recentMessages.push({ text: message.message.toLowerCase(), chatTitle, publishedAtMs: Date.now() });
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
  start, getSignal, getTrackedGroups, addGroup, removeGroup,
};
