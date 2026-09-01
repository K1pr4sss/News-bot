const test = require('node:test');
const assert = require('node:assert');
const { runSafetyFilters } = require('../lib/filters');

const cleanToken = { symbol: 'XYZ', liquidityUsd: 50000, socialsCount: 1 };
const cleanRugcheck = { rugged: false, mintAuthorityActive: false, freezeAuthorityActive: false };

test('passes with no Birdeye data at all (holder-count check is skipped, not enforced as a failure)', () => {
  const { pass } = runSafetyFilters(cleanToken, cleanRugcheck, null);
  assert.strictEqual(pass, true);
});

test('rejects when Birdeye reports a holder count below the floor', () => {
  const { pass, reasons } = runSafetyFilters(cleanToken, cleanRugcheck, { holderCount: 3 });
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('holder count')));
});

test('passes when Birdeye holder count clears the floor', () => {
  const { pass } = runSafetyFilters(cleanToken, cleanRugcheck, { holderCount: 500 });
  assert.strictEqual(pass, true);
});
