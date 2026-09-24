import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIAdapter } from '../dist/index.js';

test('OpenAIAdapter uses native defaults and organization headers', async () => {
  const calls = [];
  const transport = {
    async request(request) {
      calls.push(request);
      return {
        status: 200,
        headers: new Headers(),
        data: { id: 'chatcmpl-1', model: 'gpt-4.1-mini', choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }] },
      };
    },
    async *stream() {
      yield '';
    },
  };
  const adapter = new OpenAIAdapter({ transport, organization: 'org-test', project: 'project-test' });
  const response = await adapter.chat({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: 'Hello' }],
    maxOutputTokens: 128,
  }, { credential: { type: 'api-key', value: 'sk-test' } });

  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].headers['OpenAI-Organization'], 'org-test');
  assert.equal(calls[0].headers['OpenAI-Project'], 'project-test');
  assert.equal(JSON.parse(calls[0].body).max_completion_tokens, 128);
  assert.equal(response.providerId, 'openai');
});
