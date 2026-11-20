import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { executeLocalTool, localToolRootsFromEnv } from '../dist/src/core/local-tool-executor.js';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'oh-local-tools-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'const answer = 42;\n// TODO: later\n');
  writeFileSync(join(root, 'notes.txt'), 'hello\n');
  return root;
}

test('local tools are off unless both the flag and a root are present', () => {
  const root = sandbox();
  assert.deepEqual(localToolRootsFromEnv({}), []);
  assert.deepEqual(localToolRootsFromEnv({ OMNIHILBRAS_LOCAL_TOOL_ROOTS: root }), [], 'a root without the flag grants nothing');
  assert.deepEqual(localToolRootsFromEnv({ OMNIHILBRAS_LOCAL_TOOLS: '1', OMNIHILBRAS_LOCAL_TOOL_ROOTS: `${root},relative/path` }), [root]);
});

test('read, glob and grep work inside an approved root', async () => {
  const root = sandbox();
  const read = await executeLocalTool({ name: 'local_read', path: 'notes.txt' }, [root]);
  assert.equal(read.isError, false);
  assert.equal(read.content, 'hello\n');

  const glob = await executeLocalTool({ name: 'local_glob', path: '.', pattern: '*.ts' }, [root]);
  assert.equal(glob.isError, false);
  assert.equal(glob.content, 'src/a.ts');

  const grep = await executeLocalTool({ name: 'local_grep', path: 'src', pattern: 'TODO' }, [root]);
  assert.equal(grep.isError, false);
  assert.match(grep.content, /TODO: later/);
});

test('a path outside the root, or a symlink out of it, is refused', async () => {
  const root = sandbox();
  const outside = await executeLocalTool({ name: 'local_read', path: '../etc/passwd' }, [root]);
  assert.equal(outside.isError, true);
  assert.match(outside.content, /outside the approved/);

  const link = join(root, 'escape');
  symlinkSync('/etc', link);
  const escaped = await executeLocalTool({ name: 'local_read', path: 'escape/passwd' }, [root]);
  assert.equal(escaped.isError, true);
  assert.match(escaped.content, /outside the approved/);
});

test('local_grep does not follow a symlink out of the approved root', async () => {
  // Security audit 2026-11-20: walk() enumerates children; a symlink is not a directory, so it was passed
  // straight to readFileSync and its outside target was returned with an in-root label.
  const root = sandbox();
  const secret = join(tmpdir(), `oh-local-secret-${Date.now()}`);
  writeFileSync(secret, 'SUPERSECRET_MARKER\n');
  symlinkSync(secret, join(root, 'leak'));

  const grep = await executeLocalTool({ name: 'local_grep', path: '.', pattern: 'SUPERSECRET_MARKER' }, [root]);
  assert.equal(grep.isError, false);
  assert.doesNotMatch(grep.content, /SUPERSECRET_MARKER/, 'an enumerated symlink must not leak outside content');
});

test('a disabled gateway reports that local tools are off rather than reading a file', async () => {
  const result = await executeLocalTool({ name: 'local_read', path: 'notes.txt' }, []);
  assert.equal(result.isError, true);
  assert.match(result.content, /disabled/);
});
