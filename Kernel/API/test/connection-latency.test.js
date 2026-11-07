import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionLatencyLedger } from '../dist/src/core/index.js';

/**
 * The per-connection latency ledger.
 *
 * The property that matters is that a reading describes **one account**, not a provider: two accounts
 * of one vendor are not equally fast, and averaging them into one number would describe neither.
 */

test('a reading is per connection, and an account with no samples has none', () => {
  const ledger = new ConnectionLatencyLedger();
  ledger.record('agnes-a', 100);

  assert.deepEqual(ledger.get('agnes-a')?.latencyMs, 100);
  assert.equal(ledger.get('agnes-b'), undefined, 'no samples means no reading, never 0');
});

test('the average is an EWMA, so a recovered account reads quick again', () => {
  const ledger = new ConnectionLatencyLedger({ alpha: 0.5 });
  ledger.record('a', 1000);
  ledger.record('a', 100);
  // 1000*0.5 + 100*0.5 = 550
  assert.equal(ledger.get('a')?.latencyMs, 550);
  ledger.record('a', 100);
  // 550*0.5 + 100*0.5 = 325
  assert.equal(ledger.get('a')?.latencyMs, 325);
  assert.equal(ledger.get('a')?.samples, 3);
});

test('a non-finite or negative sample is refused, because it is not a measurement', () => {
  const ledger = new ConnectionLatencyLedger();
  ledger.record('a', Number.NaN);
  ledger.record('a', -5);
  ledger.record('', 10);
  assert.equal(ledger.get('a'), undefined);
  assert.equal(ledger.get(''), undefined);
});

test('the ledger is bounded, and the least recently measured entry goes first', () => {
  const ledger = new ConnectionLatencyLedger({ maxEntries: 2 });
  ledger.record('a', 10);
  ledger.record('b', 20);
  ledger.record('a', 11); // refreshes a, so b is now the oldest
  ledger.record('c', 30);
  assert.equal(ledger.get('a') !== undefined, true);
  assert.equal(ledger.get('c') !== undefined, true);
  assert.equal(ledger.get('b'), undefined, 'the least recently measured entry was pruned');
});

test('forget drops a reading, so a reused id cannot inherit one', () => {
  const ledger = new ConnectionLatencyLedger();
  ledger.record('a', 10);
  ledger.forget('a');
  assert.equal(ledger.get('a'), undefined);
});

test('the snapshot reports every reading with its sample count', () => {
  const ledger = new ConnectionLatencyLedger();
  ledger.record('a', 10);
  ledger.record('b', 20);
  const snapshot = ledger.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['a', 'b']);
  assert.equal(snapshot.a?.samples, 1);
  assert.equal(snapshot.b?.latencyMs, 20);
});
