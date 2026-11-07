import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoute } from '../dist/src/core/routing.js';

/**
 * The `fastest` strategy.
 *
 * Three properties, each one a way this could quietly do harm:
 *  - priority bands are never reordered, only the accounts sharing one;
 *  - an account with no reading sorts after every measured one (unknown is not fast);
 *  - a provider not set to `fastest` keeps the priority/name order untouched.
 */

function connection(id, priority = 1, providerId = 'agnes-ai') {
  return { id, providerId, name: id, endpoint: 'https://apify.example/v1', priority, proxyPool: 'none', enabled: true, hasCredential: true, modelPolicy: 'all', modelIds: ['m'], customModelIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

// The shape `resolveRoute` actually asks of health: two verdicts, not a snapshot.
const health = { isUnhealthy: () => false, isModelCoolingDown: () => false };

function plan(connections, { strategy = 'fastest', latency = {} } = {}) {
  return resolveRoute({
    connections,
    model: 'm',
    health,
    failureThreshold: 3,
    strategyFor: () => strategy,
    latencyFor: (id) => latency[id],
  });
}

test('fastest orders same-priority accounts by measured round trip', () => {
  const decision = plan([connection('slow'), connection('quick'), connection('medium')], {
    latency: { slow: { latencyMs: 900, samples: 4 }, quick: { latencyMs: 120, samples: 2 }, medium: { latencyMs: 400, samples: 1 } },
  });
  assert.deepEqual(decision.candidates.map((candidate) => candidate.connectionId), ['quick', 'medium', 'slow']);
});

test('an unmeasured account sorts after every measured one', () => {
  const decision = plan([connection('new'), connection('measured')], {
    latency: { measured: { latencyMs: 2000, samples: 1 } },
  });
  assert.deepEqual(decision.candidates.map((candidate) => candidate.connectionId), ['measured', 'new'], 'unknown is not fast');
});

test('priority bands are never reordered, only the accounts inside one', () => {
  const decision = plan([connection('backup', 2), connection('primary-slow', 1), connection('primary-fast', 1)], {
    latency: { 'primary-slow': { latencyMs: 900, samples: 2 }, 'primary-fast': { latencyMs: 100, samples: 2 }, backup: { latencyMs: 5, samples: 9 } },
  });
  assert.deepEqual(
    decision.candidates.map((candidate) => candidate.connectionId),
    ['primary-fast', 'primary-slow', 'backup'],
    'a fast account at priority 2 must not outrank a deliberate priority 1',
  );
});

test('a provider not set to fastest keeps the priority/name order', () => {
  const decision = plan([connection('b'), connection('a')], {
    strategy: 'priority',
    latency: { a: { latencyMs: 900, samples: 3 }, b: { latencyMs: 10, samples: 3 } },
  });
  assert.deepEqual(decision.candidates.map((candidate) => candidate.connectionId), ['a', 'b'], 'name order, as before');
});

test('two unmeasured accounts fall back to name order, so the chain is deterministic', () => {
  const decision = plan([connection('zeta'), connection('alpha')]);
  assert.deepEqual(decision.candidates.map((candidate) => candidate.connectionId), ['alpha', 'zeta']);
});
