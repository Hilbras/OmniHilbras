import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicAdapter } from '../Kernel/SDK/anthropic/dist/adapter/index.js';
import { GeminiAdapter } from '../Kernel/SDK/gemini/dist/adapter/index.js';
import { OpenAICompatibleAdapter } from '../Kernel/SDK/openai/dist/adapter/index.js';
import { CodexAdapter } from '../Kernel/SDK/codex/dist/adapter/index.js';
import { ApmixAdapter } from '../Kernel/SDK/apmix/dist/adapter/index.js';
import { BeatApiAdapter } from '../Kernel/SDK/beatapi/dist/adapter/index.js';
import { NousAdapter } from '../Kernel/SDK/nous/dist/adapter/index.js';
import { ClineAdapter } from '../Kernel/SDK/cline/dist/adapter/index.js';
import { createCodeBuddyAdapter } from '../Kernel/SDK/codebuddy/dist/adapter/index.js';
import { createKiloCodeAdapter } from '../Kernel/SDK/kilocode/dist/adapter/index.js';
import { createMinimaxCodeAdapter } from '../Kernel/SDK/minimax-code/dist/adapter/index.js';
import { ZcodeAdapter } from '../Kernel/SDK/zcode-start-plan/dist/adapter/index.js';
import { ZenAdapter } from '../Kernel/SDK/opencode-zen/dist/adapter/index.js';
import { OpenCodeGoAdapter } from '../Kernel/SDK/opencode-go/dist/adapter/index.js';
import { PROVIDER_TOOLS } from '../Kernel/Tools/dist/index.js';

/**
 * The capability table, against the bodies the adapters really build.
 *
 * A grep is not evidence: `anthropic` was listed as "declares `toolChoice` and never sends it" because the search
 * missed `toAnthropicToolChoice`, and it had been sending `{type:"any"}` all along. So every row that claims forcing
 * is driven here with a scripted transport, and the assertion is on the request the provider would have received.
 */

function bodyTransport() {
  const requests = [];
  const data = { id: 'r', content: [{ type: 'text', text: 'ok' }], candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', delta: { role: 'assistant', content: 'ok' } }] };
  return {
    requests,
    async request(request) {
      requests.push(request);
      return { status: 200, headers: new Headers(), data };
    },
    async *stream(request) {
      requests.push(request);
      yield `data: ${JSON.stringify({ ...data, choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`;
      yield 'data: [DONE]\n\n';
    },
    body: () => JSON.parse(requests.at(-1).body),
  };
}

const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const messages = [{ role: 'user', content: 'read a.ts' }];
const run = (adapter, model = 'm') => adapter.chat({ model, messages, tools, toolChoice: 'required' }, { credential: { type: 'api-key', value: 'k' } });
const oauthRun = (adapter, model = 'm') => adapter.chat({ model, messages, tools, toolChoice: 'required' }, { credential: { type: 'oauth', value: 'tok' } });

/** Body shapes are asserted per *wire family*, and each provider id is bound to the family its adapter uses. */
const WIRES = {
  openai: () => {
    const t = bodyTransport();
    return { t, adapter: new OpenAICompatibleAdapter({ id: 'openai', name: 'OpenAI', baseUrl: 'https://example.invalid/v1', auth: { header: 'Authorization', prefix: 'Bearer' } }, { transport: t }), run, expect: () => assert.equal(t.body().tool_choice, 'required') };
  },
  anthropic: () => {
    const t = bodyTransport();
    return { t, adapter: new AnthropicAdapter({ transport: t }), run, expect: () => assert.deepEqual(t.body().tool_choice, { type: 'any' }) };
  },
  gemini: () => {
    const t = bodyTransport();
    return { t, adapter: new GeminiAdapter({ transport: t }), run, expect: () => assert.equal(t.body().toolConfig?.functionCallingConfig?.mode, 'ANY') };
  },
  codebuddy: () => {
    const t = bodyTransport();
    return { t, adapter: createCodeBuddyAdapter('cn', { transport: t }), run: oauthRun, expect: () => assert.equal(t.body().tool_choice, 'required') };
  },
  kilocode: () => {
    const t = bodyTransport();
    return { t, adapter: createKiloCodeAdapter({ transport: t }), run: oauthRun, expect: () => assert.equal(t.body().tool_choice, 'required') };
  },
  minimax: () => {
    const t = bodyTransport();
    return { t, adapter: createMinimaxCodeAdapter('cn', { transport: t }), run: oauthRun, expect: () => assert.equal(t.body().tool_choice, 'required') };
  },
  zcode: () => {
    const t = bodyTransport();
    return { t, adapter: new ZcodeAdapter({ transport: t }), run, expect: () => assert.deepEqual(t.body().tool_choice, { type: 'any' }) };
  },
  opencode: () => {
    const t = bodyTransport();
    return { t, adapter: new ZenAdapter({ transport: t }), run: (a) => run(a, 'glm-5.3'), expect: () => assert.equal(t.body().tool_choice, 'required') };
  },
  'opencode-go': () => {
    const t = bodyTransport();
    return { t, adapter: new OpenCodeGoAdapter({ transport: t }), run: (a) => run(a, 'glm-5.3'), expect: () => assert.equal(t.body().tool_choice, 'required') };
  },
};

/** Each forced provider id names one of the wires above. A new row with no wire fails the guard. */
const FORCED_WIRE = {
  anthropic: 'anthropic', gemini: 'gemini', codebuddy: 'codebuddy', kilocode: 'kilocode', zcode: 'zcode',
  'codebuddy-cn': 'codebuddy', 'codebuddy-intl': 'codebuddy', 'minimax-code': 'minimax', 'minimax-code-global': 'minimax',
  opencode: 'opencode', 'opencode-go': 'opencode-go',
  openai: 'openai', openrouter: 'openai', 'openai-compatible': 'openai', apmix: 'openai', beatapi: 'openai',
  cline: 'openai', clinepass: 'openai', nous: 'openai',
  'agnes-ai': 'openai', agentrouter: 'openai', 'aion-labs': 'openai', '100milionseek': 'openai', anyrouter: 'openai', apinex: 'openai',
  coarena: 'openai', custom: 'openai', deepseek: 'openai', groq: 'openai', grok: 'openai', kimi: 'openai',
  kiraai: 'openai', mistral: 'openai', 'nara-router': 'openai', nvidia: 'openai', numes: 'openai',
  ollama: 'openai', qwen: 'openai', 'qwen-token-plan': 'openai', tiarina: 'openai', tokenharbor: 'openai',
  unorouter: 'openai', vengetic: 'openai', xkiro: 'openai', zro: 'openai',
};

test('every provider whose row claims forcing has a driven wire', async () => {
  const forced = Object.entries(PROVIDER_TOOLS).filter(([, caps]) => caps.toolChoice.includes('required')).map(([id]) => id);
  assert.ok(forced.length > 0);
  const undriven = forced.filter((id) => !FORCED_WIRE[id] || !WIRES[FORCED_WIRE[id]]);
  assert.deepEqual(undriven, [], `forced rows with no driven wire: ${undriven.join(', ')}`);

  for (const [wire, build] of Object.entries(WIRES)) {
    const { t, adapter, run: drive, expect } = build();
    await drive(adapter);
    assert.ok(t.requests.length > 0, `${wire} never reached its transport`);
    expect();
    if (wire !== 'openai') continue;
    // Codex is the one wire here that refuses forcing but does serve tools. A forced call is refused by
    // name before a request; a normal turn carries flat Responses function definitions.
    const codexTransport = {
      requests: [],
      async request() { return { status: 200, headers: new Headers(), data: {} }; },
      async *stream(request) {
        this.requests.push(request);
        yield `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`;
        yield `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`;
      },
    };
    const codex = new CodexAdapter({ transport: codexTransport });
    await codex.chat({ model: 'gpt-5', messages, tools }, { credential: { type: 'oauth', value: 'tok' } });
    assert.deepEqual(JSON.parse(codexTransport.requests.at(-1).body).tools, [
      { type: 'function', name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
    await assert.rejects(
      () => new CodexAdapter({ transport: bodyTransport() }).chat({ model: 'gpt-5', messages, tools, toolChoice: 'required' }, { credential: { type: 'oauth', value: 'tok' } }),
      /force a tool call/,
    );
  }
});

test('the generic routers are driven under their own provider ids', async () => {
  for (const [id, caps] of Object.entries(PROVIDER_TOOLS)) {
    if (!caps.toolChoice.includes('required') || FORCED_WIRE[id] !== 'openai') continue;
    const t = bodyTransport();
    const adapter = new OpenAICompatibleAdapter({ id, name: id, baseUrl: 'https://example.invalid/v1', auth: { header: 'Authorization', prefix: 'Bearer' } }, { transport: t });
    await run(adapter);
    assert.equal(t.body().tool_choice, 'required', `${id} did not send a forced choice`);
  }
});
