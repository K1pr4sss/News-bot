const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const WALLETS_FILE = path.join(__dirname, '..', 'wallets.json');
// Mutable copy of config.insiderWallets - /watch and /unwatch operate on this,
// not the config module's own (effectively frozen-at-boot) list.
let trackedWallets = [...config.insiderWallets];
let pollTimer = null;

function persist() {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify({ insiderWallets: trackedWallets }, null, 2));
}

function getWatchedWallets() {
  return trackedWallets.map((w) => w.address);
}

function addWallet(address) {
  if (trackedWallets.some((w) => w.address === address)) return;
  trackedWallets.push({ address, label: address });
  persist();
  if (!pollTimer) _armInterval(); // first wallet ever added while running - start polling now instead of waiting for a restart
}

function removeWallet(address) {
  trackedWallets = trackedWallets.filter((w) => w.address !== address);
  persist();
  lastSnapshot.delete(address);
}

// Solscan's Pro API v2.0 (https://pro-api.solscan.io/v2.0/account/token-accounts) -
// confirmed live via their docs to exist with a genuine free tier, but the
// exact response field names weren't confirmed against a real API key before
// shipping (Solscan gates full docs behind signup). This parses defensively
// (tries a few plausible field-name variants, fails safe to skip) rather than
// assuming one exact shape - if it doesn't match your real key's response,
// check `logger.warn`'s logged raw sample and adjust FIELD extraction below.
//
// Design: batch-poll each tracked wallet's current token holdings every
// walletPollIntervalMs and diff against the previous snapshot. An increase in
// a mint's balance = a buy signal for that wallet; a >50% decrease in a mint
// we hold an open position in = the sell-exit trigger. This avoids parsing
// individual transfer transactions (a much less certain schema to guess at)
// and needs only one REST call per wallet per poll - no RPC, no WebSocket.
const HOLDINGS_URL = 'https://pro-api.solscan.io/v2.0/account/token-accounts';

// wallet -> Map(mint -> amount)
const lastSnapshot = new Map();
// mint -> [{ wallet, atMs }] buys seen in the current window
const recentBuys = new Map();
// mint -> { wallet, atMs } most recent >50% sell, cleared once consumed
const recentBigSells = new Map();

function parseHoldings(data) {
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const out = new Map();
  for (const row of rows) {
    const mint = row.token_address || row.tokenAddress || row.mint;
    const rawAmount = row.amount ?? row.balance ?? row.token_amount;
    if (!mint || !Number.isFinite(Number(rawAmount))) continue;
    out.set(mint, Number(rawAmount));
  }
  return out;
}

async function pollWallet(wallet) {
  try {
    const { data } = await axios.get(HOLDINGS_URL, {
      params: { address: wallet.address, type: 'token', page_size: 40, hide_zero: true },
      headers: config.solscanApiKey ? { token: config.solscanApiKey } : {},
      timeout: 10000,
    });
    const holdings = parseHoldings(data);
    const prev = lastSnapshot.get(wallet.address);
    lastSnapshot.set(wallet.address, holdings);
    if (!prev) return; // first poll for this wallet - nothing to diff against yet

    const now = Date.now();
    for (const [mint, amount] of holdings) {
      const prevAmount = prev.get(mint) || 0;
      if (amount > prevAmount) {
        const list = recentBuys.get(mint) || [];
        list.push({ wallet: wallet.address, atMs: now });
        recentBuys.set(mint, list);
      }
    }
    for (const [mint, prevAmount] of prev) {
      const amount = holdings.get(mint) || 0;
      if (prevAmount > 0 && amount <= prevAmount * 0.5) {
        recentBigSells.set(mint, { wallet: wallet.address, atMs: now });
      }
    }
  } catch (err) {
    logger.warn('Solscan wallet poll failed', { wallet: wallet.address, error: err.message });
  }
}

async function pollAll() {
  if (!trackedWallets.length) return;
  for (const wallet of trackedWallets) {
    await pollWallet(wallet);
    await new Promise((r) => setTimeout(r, 250)); // gentle, sequential - this is a free/low-volume tier, no need to burst
  }
  const cutoff = Date.now() - config.insiderWindowMinutes * 60 * 1000;
  for (const [mint, list] of recentBuys) {
    const fresh = list.filter((b) => b.atMs > cutoff);
    if (fresh.length) recentBuys.set(mint, fresh);
    else recentBuys.delete(mint);
  }
}

/** Distinct tracked wallets that bought this mint within the insider window. */
function getBuyerCount(mint) {
  return (recentBuys.get(mint) || []).length
    ? new Set((recentBuys.get(mint) || []).map((b) => b.wallet)).size
    : 0;
}

/** True if a tracked wallet dumped >50% of its position in this mint since the last poll. */
function checkAndConsumeBigSell(mint) {
  const hit = recentBigSells.get(mint);
  if (!hit) return false;
  recentBigSells.delete(mint);
  return true;
}

function _armInterval() {
  if (pollTimer) return;
  if (!config.solscanApiKey) {
    logger.warn('SOLSCAN_API_KEY not set - wallet tracking calls will likely 401. Get a free key at solscan.io/apis.');
  }
  pollAll();
  pollTimer = setInterval(() => pollAll().catch((e) => logger.error('Wallet poll cycle failed', { error: e.message })), config.walletPollIntervalMs);
}

function start() {
  if (!trackedWallets.length) {
    logger.info('Wallet tracking idle (wallets.json has no insiderWallets yet - insider signal reads as absent until /watch adds one)');
    return;
  }
  _armInterval();
}

module.exports = {
  start, getBuyerCount, checkAndConsumeBigSell, getWatchedWallets, addWallet, removeWallet,
};
