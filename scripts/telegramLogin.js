/**
 * One-time interactive login to produce TELEGRAM_USER_SESSION - run this
 * locally once, not part of the deployed app. Logs in as YOUR Telegram
 * account (not a bot) via MTProto so the bot can read messages from groups
 * you're a member of.
 *
 * Usage: TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/telegramLogin.js +15551234567
 *
 * Since this needs to prompt for a login code Telegram sends to your phone
 * mid-execution, and Claude Code (or any external orchestrator) can't type
 * into a live stdin prompt, this polls two small answer files instead of
 * reading stdin directly - the orchestrator (or you, in a second terminal)
 * writes the code/password into those files once Telegram sends them.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const phone = process.argv[2];

if (!apiId || !apiHash || !phone) {
  console.error('Usage: TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/telegramLogin.js <phone-number-with-country-code>');
  process.exit(1);
}

const CODE_FILE = path.join(require('os').tmpdir(), 'tg_login_code.txt');
const PASSWORD_FILE = path.join(require('os').tmpdir(), 'tg_login_password.txt');

function waitForFile(filePath, label) {
  console.log(`WAITING_FOR_${label}:${filePath}`);
  return new Promise((resolve) => {
    const check = () => {
      if (fs.existsSync(filePath)) {
        const value = fs.readFileSync(filePath, 'utf8').trim();
        fs.unlinkSync(filePath);
        resolve(value);
      } else {
        setTimeout(check, 1000);
      }
    };
    check();
  });
}

(async () => {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => waitForFile(CODE_FILE, 'CODE'),
    password: async () => waitForFile(PASSWORD_FILE, 'PASSWORD'),
    onError: (err) => console.error('LOGIN_ERROR:', err.message),
  });
  console.log('SESSION_STRING:' + client.session.save());
  await client.disconnect();
  process.exit(0);
})();
