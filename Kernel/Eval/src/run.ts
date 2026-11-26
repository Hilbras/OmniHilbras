import { readFile, writeFile } from 'node:fs/promises';
import { score, type Expectation } from './score.js';

/**
 * Runs a case file against a live gateway.
 *
 * Usage: `pnpm eval -- cases/smoke.json --model gpt-4o-mini --out report.json`
 * Environment: `OMNIHILBRAS_GATEWAY_URL` (default http://127.0.0.1:20138) and `OMNIHILBRAS_API_KEY`
 * when the gateway requires one. **This makes real provider requests and costs money**; that is the
 * point of an eval, and the runner prints the number of cases before sending any.
 */

type EvalCase = { id: string; prompt: string; system?: string; expectation: Expectation };
type CaseFile = { name?: string; cases: EvalCase[] };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const casePath = arg('--cases');
if (!casePath) fail('Usage: eval --cases <file> --model <id> [--out report.json]');
const model = arg('--model');
if (!model) fail('--model is required; an eval without a model scores nothing.');
const base = (process.env.OMNIHILBRAS_GATEWAY_URL ?? 'http://127.0.0.1:20138').replace(/\/$/, '');
const apiKey = process.env.OMNIHILBRAS_API_KEY;
const outPath = arg('--out');

const parsed = JSON.parse(await readFile(casePath, 'utf8')) as CaseFile;
if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) fail('The case file has no cases.');
console.log(`Running ${parsed.cases.length} case(s) against ${model}; real requests may cost money.`);

const results: Array<{ id: string; passed: boolean; detail: string; latencyMs: number }> = [];
for (const evalCase of parsed.cases) {
  const started = Date.now();
  const answer = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [...(evalCase.system ? [{ role: 'system', content: evalCase.system }] : []), { role: 'user', content: evalCase.prompt }], temperature: 0 }),
  });
  const latencyMs = Date.now() - started;
  if (!answer.ok) {
    results.push({ id: evalCase.id, passed: false, detail: `HTTP ${answer.status}`, latencyMs });
    continue;
  }
  const body = await answer.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content ?? '';
  const scored = score(text, evalCase.expectation);
  results.push({ id: evalCase.id, passed: scored.passed, detail: scored.detail, latencyMs });
  console.log(`${scored.passed ? 'PASS' : 'FAIL'} ${evalCase.id} — ${scored.detail}`);
}

const summary = { model, at: new Date().toISOString(), cases: results.length, passed: results.filter((result) => result.passed).length, results };
if (outPath) await writeFile(outPath, JSON.stringify(summary, null, 2));
console.log(`${summary.passed}/${summary.cases} passed`);
process.exit(summary.passed === summary.cases ? 0 : 1);
