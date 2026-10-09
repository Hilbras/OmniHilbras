import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Routing, retry, hedging, rate limiting and the request executor are generic. A provider's identity is
 * decided by its registration and capabilities, not by a name written into the shared algorithm. A
 * `providerId === 'kiro'` branch in shared code is how one provider's quirk becomes everyone's regression.
 *
 * This checks the live code, not comments, because the resolver's own documentation shows the bad pattern
 * on purpose. A protocol difference that genuinely needs a branch belongs in the adapter, not here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const SHARED = ['routing.ts', 'routing-engine.ts', 'request-executor.ts', 'retry-policy.ts', 'hedge-policy.ts', 'rate-limit-policy.ts'];
const PROVIDER_IDS = [
  'openai', 'anthropic', 'gemini', 'openrouter', 'cline', 'clinepass', 'kiro', 'kimi-code', 'claude-code',
  'zen', 'opencode', 'opencode-console', 'chatgpt-web', 'deepseek-web', 'tokenharbor-web', 'qwen-web',
  'mistral', 'ollama', 'nara-router', 'tokenharbor', 'apmix', 'tiarina', 'xkiro', 'apinex',
];

// Strips block and line comments, so only executable text is searched.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

for (const file of SHARED) {
  test(`${file} names no provider in executable code`, () => {
    const code = codeOnly(readFileSync(join(SRC, file), 'utf8'));
    const found = PROVIDER_IDS.filter((id) => ["'", '"', '`'].some((quote) => code.includes(`${quote}${id}${quote}`)));
    assert.deepEqual(found, [], `${file} branches on a provider name: ${found.join(', ')}. Put that difference in the adapter.`);
  });
}
