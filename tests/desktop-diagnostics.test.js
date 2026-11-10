import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redact } from '../desktop/redact.mjs';

/**
 * A diagnostics file is meant to be sent to somebody else. These are the credential shapes the
 * gateway, the dashboard and provider errors can put into a log line.
 */

test('keys, bearer tokens and named secrets are removed', () => {
  const input = [
    'key sk-abcdefghijklmnopqrstuvwxyz',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    'api_key=super-secret-value',
    'refresh_token: another-secret',
    'password = hunter2',
  ].join('\n');
  const output = redact(input);
  for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz', 'eyJhbGciOiJIUzI1NiJ9', 'super-secret-value', 'another-secret', 'hunter2']) {
    assert.equal(output.includes(secret), false, `${secret} survived redaction`);
  }
  assert.match(output, /\[redacted-key\]/);
  assert.match(output, /Bearer \[redacted\]/);
});

test('ordinary diagnostics text is not mangled', () => {
  const input = 'gateway listening on 127.0.0.1:8787\nThe gateway exited (code 1).';
  assert.equal(redact(input), input);
});

test('the exporter writes the redacted log and never the vault directory contents', () => {
  const main = readFileSync(fileURLToPath(new URL('../desktop/main.mjs', import.meta.url)), 'utf8');
  assert.match(main, /logTail: redact\(logText\)/, 'the log tail is written unredacted');
  assert.doesNotMatch(main, /secrets\.enc|secrets\.key/, 'the exporter reads credential material');
  assert.match(main, /mode: 0o600/, 'the diagnostics file is not owner-only');
});
