import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectAssetCandidates,
  extractAssetReferences,
  extractAssistantText,
  parseFirstPartyContract,
  requireChatGptAssetUrl,
} from '../dist/chatgptFirstParty.js';

/**
 * The pure half of driving a ChatGPT turn through ChatGPT's own code.
 *
 * The turn itself needs a browser and a live session, so what is tested here is everything
 * that can be reasoned about without one: finding the request module, refusing to read
 * anything that is not ChatGPT's own asset, and reading an answer out of a delta stream.
 */

/** Shaped like a real minified chunk: the five markers, then a trailing export block. */
const chunkSource = [
  'function Kc(e=!1,t=`none`,n=Oz){return Oz(`finalized`,e,t,n)}',
  'Promise.all([ll.getEnforcementToken(t,{forceSync:!0}),al.getEnforcementToken(t)])',
  'U8.safePost(`/sentinel/chat-requirements/prepare`,e)',
  'function Xc(e,t,n,r,i,a){let o={};return e?.token?o[`OpenAI-Sentinel-Chat-Requirements-Token`]=e.token:o}',
  'const tail=1;',
  'export{A as B,Kc as $Kc,ll as $ll,al as $al,U8 as $U8,Xc as $Xc};',
].join('\n');

test('the request module is found by what it does, not by pinned names', () => {
  // The exports are minified and change on every build, so the markers are semantic and
  // the names are read out of the trailing export block.
  assert.deepEqual(parseFirstPartyContract(chunkSource), {
    finalizeRequirements: '$Kc',
    proofManager: '$ll',
    turnstileManager: '$al',
    requestClient: '$U8',
    buildSentinelHeaders: '$Xc',
  });
});

test('a chunk without the markers is refused, and says why', () => {
  // Silence here would read as a model that answered nothing.
  assert.throws(() => parseFirstPartyContract('const nothing = 1;'), /required markers/);
});

test('a chunk whose exports are missing is refused, and says which', () => {
  const noExports = chunkSource.slice(0, chunkSource.indexOf('export{'));
  assert.throws(() => parseFirstPartyContract(noExports), /their exports were not/);
});

test('only a first-party asset is ever read', () => {
  // The candidate list comes off a live page, so it is untrusted input: an origin or path
  // outside /cdn/assets/*.js is refused before anything is fetched from it.
  assert.equal(
    requireChatGptAssetUrl('https://chatgpt.com/cdn/assets/abc-123.js'),
    'https://chatgpt.com/cdn/assets/abc-123.js',
  );
  for (const bad of [
    'https://evil.example/cdn/assets/a.js',
    'https://chatgpt.com/evil.js',
    'https://chatgpt.com/',
    'https://chatgpt.com/cdn/assets/../secret.js',
  ]) {
    assert.throws(() => requireChatGptAssetUrl(bad), /Refusing to load/, `must refuse ${bad}`);
  }
});

test('candidates are filtered to first-party chunks and references are followed', () => {
  assert.deepEqual(
    collectAssetCandidates(
      ['https://chatgpt.com/cdn/assets/a.js', 'https://cdn.oaistatic.com/other.js', 'https://chatgpt.com/app.js'],
      ['https://chatgpt.com/cdn/assets/b.js'],
    ),
    ['https://chatgpt.com/cdn/assets/a.js', 'https://chatgpt.com/cdn/assets/b.js'],
  );
  // The contract is sometimes split across two chunks, so a chunk's own imports matter.
  assert.deepEqual(
    extractAssetReferences('import"./chunk-1.js";import"./chunk-2.js";', 'https://chatgpt.com/cdn/assets/parent.js'),
    ['https://chatgpt.com/cdn/assets/chunk-1.js', 'https://chatgpt.com/cdn/assets/chunk-2.js'],
  );
});

test('the answer is read out of a real-shaped delta stream', () => {
  // `append` is the load-bearing detail: for a string it concatenates, and reading it as
  // a replace keeps only the final fragment.
  const sse = [
    'event: delta_encoding',
    'data: "v1"',
    '',
    'data: {"type":"delta","v":{"message":{"author":{"role":"user"},"content":{"content_type":"text","parts":["hi"]}}}}',
    '',
    'data: {"type":"delta","v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]}}}}',
    '',
    'data: {"type":"delta","p":"/message/content/parts/0","o":"append","v":"work"}',
    '',
    'data: {"type":"delta","p":"/message/content/parts/0","o":"append","v":"ing"}',
    '',
    'data: {"type":"delta","p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.equal(extractAssistantText(sse), 'working');
});

test('a reasoning recap is not the answer, and a user turn is not either', () => {
  const sse = [
    'data: {"type":"delta","v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"reasoning_recap","content":"Worked for a second"}}}}',
    '',
    'data: {"type":"delta","v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["done"]}}}}',
    '',
  ].join('\n');
  assert.equal(extractAssistantText(sse), 'done');
});

test('a stream with no answer yields nothing rather than throwing', () => {
  // A stream that opens with a resume token and then ends is a real shape, and it is not
  // an error worth losing the turn over.
  assert.equal(extractAssistantText('data: {"type":"resume_conversation_token","token":"x"}'), '');
  assert.equal(extractAssistantText('data: "v1"'), '');
  assert.equal(extractAssistantText(''), '');
});
