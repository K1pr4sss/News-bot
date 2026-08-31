const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const executor = require('./executor');
const positions = require('./positions');
const logger = require('./logger');

let bot = null;

function start() {
  if (!config.telegramBotToken) {
    logger.warn('TELEGRAM_BOT_TOKEN not set - alerts/commands disabled');
    return;
  }
  bot = new TelegramBot(config.telegramBotToken, { polling: true });

  const isAuthorized = (msg) => !config.telegramChatId || String(msg.chat.id) === String(config.telegramChatId);

  bot.onText(/\/balance/, (msg) => {
    if (!isAuthorized(msg)) return;
    const balance = executor.getBalanceSol();
    bot.sendMessage(msg.chat.id, `Paper balance: ${balance.toFixed(4)} SOL (PAPER_TRADING=${config.paperTrading})`);
  });

  bot.onText(/\/positions/, (msg) => {
    if (!isAuthorized(msg)) return;
    const open = positions.getOpenPositions();
    if (!open.length) {
      bot.sendMessage(msg.chat.id, 'No open positions.');
      return;
    }
    const lines = open.map((p) => {
      const ageMin = ((Date.now() - p.opened_at) / 60000).toFixed(0);
      return `${p.symbol} (${p.mint.slice(0, 6)}...) - ${p.remaining_amount_sol.toFixed(4)}/${p.original_amount_sol.toFixed(4)} SOL - peak ${p.peak_change_pct.toFixed(0)}% - ${ageMin}min old`;
    });
    bot.sendMessage(msg.chat.id, lines.join('\n'));
  });

  bot.onText(/\/pnl/, (msg) => {
    if (!isAuthorized(msg)) return;
    const row = db.prepare(`
      SELECT COUNT(*) as trades, COALESCE(SUM(realized_pnl_sol), 0) as total_pnl
      FROM trades WHERE side = 'sell' AND realized_pnl_sol IS NOT NULL
    `).get();
    bot.sendMessage(msg.chat.id, `Sell events: ${row.trades}\nTotal realized P&L: ${row.total_pnl.toFixed(4)} SOL`);
  });

  logger.info('Telegram bot started');
}

function sendAlert(text) {
  if (!bot || !config.telegramChatId) return;
  bot.sendMessage(config.telegramChatId, text).catch((e) => logger.warn('Telegram sendMessage failed', { error: e.message }));
}

module.exports = { start, sendAlert };
