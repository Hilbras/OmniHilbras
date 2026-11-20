import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RateLimiter, MemoryRateLimitWindowStore, FileRateLimitWindowStore } from '../dist/src/core/rate-limit.js';

// Phase 9 scale foundation: two independent limiters over one shared store coordinate their counts. The
// default in-memory store stays process-local; the file store gives a bounded, atomic counter across instances.
// This is a count bound, not a lock-free guarantee — a concurrent read-modify-write can still race.

test('two limiters over one memory store share a caller budget', () => {
  const store = new MemoryRateLimitWindowStore();
  let now = 1_000_000;
  const a = new RateLimiter({ perMinute: 2, store, now: () => now });
  const b = new RateLimiter({ perMinute: 2, store, now: () => now });
  assert.equal(a.check('caller').allowed, true);
  assert.equal(b.check('caller').allowed, true, 'limiter B sees limiter A\'s first request');
  assert.equal(a.check('caller').allowed, false, 'the shared budget of 2 is spent');
  assert.equal(b.check('caller').allowed, false);
  now += 60_001;
  assert.equal(b.check('caller').allowed, true, 'a new window resets for both');
});

test('a file store persists the counter across instances and processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-rate-shared-'));
  try {
    const file = join(dir, 'rate.json');
    let now = 2_000_000;
    const first = new RateLimiter({ perMinute: 1, store: new FileRateLimitWindowStore(file), now: () => now });
    assert.equal(first.check('client').allowed, true);
    // A fresh limiter (as another process would construct) reads the same file.
    const second = new RateLimiter({ perMinute: 1, store: new FileRateLimitWindowStore(file), now: () => now });
    assert.equal(second.check('client').allowed, false, 'the second instance sees the spent budget');
    assert.equal(new FileRateLimitWindowStore(file).get('client')?.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default limiter stays process-local', () => {
  const a = new RateLimiter({ perMinute: 1 });
  const b = new RateLimiter({ perMinute: 1 });
  assert.equal(a.check('caller').allowed, true);
  assert.equal(b.check('caller').allowed, true, 'independent in-memory limiters do not share');
});
