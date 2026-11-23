import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The parity loop's state is its only source of truth (`tasks/parity-loop/README.md:8-9`), so a stale
 * cycle number or a report path that does not exist sends the next run to the wrong evidence. This
 * guard reads the two artifacts that drifted after cycle 4 was implemented: state.json still said
 * cycle 4 while `parity-cycle-5-system.md` was already on disk, and the scorecard still cited the
 * older comparison. Neither drift is visible from inside the report itself.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reports = join(root, 'docs', 'reports');
const statePath = join(root, 'tasks', 'parity-loop', 'state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));

test('the newest whole-system report is the cycle the state claims', () => {
  const cycles = readdirSync(reports)
    .map((name) => /^parity-cycle-(\d+)-system\.md$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  assert.ok(cycles.length > 0, 'no parity-cycle-*-system.md reports were found; the guard would pass vacuously');
  const newest = Math.max(...cycles);
  assert.ok(
    Number.isInteger(state.cycle) && state.cycle > 0,
    `state.cycle is ${JSON.stringify(state.cycle)}, not a positive cycle number`,
  );
  assert.equal(
    state.cycle,
    newest,
    `state.json says cycle ${state.cycle}, but the newest whole-system report is cycle ${newest}`,
  );
});

test('every report named by the state exists on disk', () => {
  const paths = Object.entries(state.last_reports ?? {});
  assert.ok(paths.length > 0, 'state.last_reports is empty; the guard would pass vacuously');
  const missing = paths.filter(([, path]) => typeof path !== 'string' || !existsSync(join(root, path)))
    .map(([name, path]) => `${name}: ${JSON.stringify(path)}`);
  assert.deepEqual(missing, [], `state.last_reports names reports that are not there:\n  ${missing.join('\n  ')}`);
});

test('a history entry exists for the current cycle', () => {
  // The drift this caught was a state whose header said step 2 while its own history recorded a
  // cycle-4 step-3 event. The header and the log must describe the same cycle.
  assert.ok(Array.isArray(state.history) && state.history.length > 0, 'state.history is empty');
  assert.ok(
    state.history.some((entry) => entry.cycle === state.cycle),
    `no history entry for cycle ${state.cycle}; the current cycle has no record of what happened`,
  );
});
