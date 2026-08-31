const config = require('./config');
const db = require('./db');
const logger = require('./logger');

/**
 * The paper/live trading boundary. The rest of the pipeline (positions.js)
 * only ever calls getBalanceSol()/buy()/sell() on whichever executor this
 * exports - it has no idea whether money is real. Swapping in a LiveExecutor
 * (Jupiter swap API, when the user funds a real wallet) later means adding a
 * new file with the same three methods and changing the one require() below,
 * not touching positions.js.
 */
class PaperExecutor {
  getBalanceSol() {
    return db.prepare('SELECT balance_sol FROM paper_wallet WHERE id = 1').get().balance_sol;
  }

  _setBalanceSol(value) {
    db.prepare('UPDATE paper_wallet SET balance_sol = ? WHERE id = 1').run(value);
  }

  /** Simulated fill at the live price with a slippage haircut AND a flat
   * network/priority fee - real Solana transactions cost real SOL to land
   * regardless of trade size, and skipping that made every paper trade look
   * slightly better than a real one would. Deducted the same way on both
   * legs, matching how a real wallet actually pays it. */
  async buy({ amountSol, priceUsd }) {
    const balance = this.getBalanceSol();
    const totalCost = amountSol + config.paperFeeSol;
    if (totalCost > balance) return { success: false, error: 'insufficient paper balance (including fee)' };
    const filledPriceUsd = priceUsd * (1 + config.paperSlippagePct / 100);
    this._setBalanceSol(balance - totalCost);
    logger.info('Paper BUY filled', { amountSol, filledPriceUsd, feeSol: config.paperFeeSol });
    return { success: true, filledPriceUsd };
  }

  async sell({ amountSol, priceUsd, entryPriceUsd }) {
    const filledPriceUsd = priceUsd * (1 - config.paperSlippagePct / 100);
    const changeFraction = (filledPriceUsd - entryPriceUsd) / entryPriceUsd;
    const grossProceedsSol = amountSol * (1 + changeFraction);
    const proceedsSol = Math.max(0, grossProceedsSol - config.paperFeeSol);
    const balance = this.getBalanceSol();
    this._setBalanceSol(balance + proceedsSol);
    logger.info('Paper SELL filled', { amountSol, filledPriceUsd, proceedsSol, feeSol: config.paperFeeSol });
    return { success: true, filledPriceUsd, proceedsSol, realizedPnlSol: proceedsSol - amountSol };
  }
}

module.exports = config.paperTrading ? new PaperExecutor() : new PaperExecutor();
// ^ LiveExecutor isn't built yet (see plan doc) - PAPER_TRADING=false currently
//   still resolves here rather than silently trading for real. Swap this line
//   to `new (require('./liveExecutor'))()` when that module exists and the
//   user has explicitly funded + tested it.
