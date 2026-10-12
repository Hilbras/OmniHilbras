import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTopologyLayout, MAX_PARTICLE_EDGES, NODE_SIZE, providerState } from '../src/lib/providerTopology.ts';

/**
 * The provider canvas on the usage page.
 *
 * Two kinds of claim are tested. The **classification** — what an edge colour means — because the page's whole
 * rule is that a figure not measured is not shown as zero, and an "active" edge is a claim about a measurement.
 * And the **cost bounds**, because the full 9router effect is deliberately kept on a dashboard that was slow
 * once, so the things that keep it bounded have to be asserted rather than remembered.
 */

const catalog = [
  { id: 'a', name: 'Alpha', initial: 'A', color: '#111111' },
  { id: 'b', name: 'Beta', initial: 'B', color: '#222222' },
  { id: 'c', name: 'Gamma', initial: 'C', color: '#333333' },
];
const group = (over) => ({ requests: 1, succeeded: 1, failed: 0, cancelled: 0, inputTokens: 1, outputTokens: 1, tokensMeasured: 1, costUsd: 0, pricedRequests: 0, unpricedRequests: 0, ...over });

test('a provider that served a request in the window is active', () => {
  assert.equal(providerState(group({ requests: 3, succeeded: 2, failed: 1 })), 'active');
});

test('a provider with only failures is an error, and one with only cancellations is not', () => {
  assert.equal(providerState(group({ succeeded: 0, failed: 4 })), 'error');
  // A cancellation is the client stopping, which says nothing about the provider — the same rule the rest of
  // the page applies. Calling it an error would blame the provider for the client's decision.
  assert.equal(providerState(group({ succeeded: 0, failed: 0, cancelled: 2 })), 'idle');
});

test('a provider with no requests in the window is idle, including one that is not in the breakdown at all', () => {
  assert.equal(providerState(group({ requests: 0, succeeded: 0 })), 'idle');
  assert.equal(providerState(undefined), 'idle', 'a configured provider with no usage must not read as active');
});

test('every catalog provider is placed, so a configured-but-unused provider is visible rather than missing', () => {
  const { nodes, edges } = buildTopologyLayout([group({})].map((g) => ({ ...g, id: 'a' })), catalog);
  const providerNodes = nodes.filter((node) => node.kind === 'provider');
  assert.deepEqual(providerNodes.map((node) => node.id), ['a', 'b', 'c']);
  assert.equal(edges.length, 3, 'one edge per catalog provider');
  assert.equal(providerNodes.find((node) => node.id === 'b').data.state, 'idle');
});

test('the router sits at the origin and the providers ring it, none on top of the router', () => {
  const { nodes } = buildTopologyLayout([], catalog);
  const router = nodes.find((node) => node.kind === 'router');
  assert.deepEqual({ x: router.x, y: router.y }, { x: -75, y: -23 }, 'the router is centred on the origin');
  for (const node of nodes.filter((entry) => entry.kind === 'provider')) {
    const distance = Math.hypot(node.x - router.x, node.y - router.y);
    assert.ok(distance > NODE_SIZE.width, `provider ${node.id} is drawn on top of the router`);
  }
  // The first provider is at twelve o'clock: directly above centre, and no other provider shares that spot.
  const first = nodes.find((node) => node.id === 'a');
  assert.ok(first.y < router.y, 'the first provider is above the router');
  assert.equal(new Set(nodes.filter((node) => node.kind === 'provider').map((node) => `${node.x},${node.y}`)).size, catalog.length, 'no two providers overlap');
});

test('a larger catalog is laid out on a larger ellipse, so nodes do not collide', () => {
  const small = buildTopologyLayout([], catalog.slice(0, 3));
  const large = buildTopologyLayout([], Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, initial: 'P', color: '#000' })));
  const radius = (layout) => Math.max(...layout.nodes.filter((node) => node.kind === 'provider').map((node) => Math.hypot(node.x, node.y)));
  assert.ok(radius(large) > radius(small), 'the ellipse must grow with the provider count');
});

test('the router reports how many providers actually served something, not how many exist', () => {
  const { nodes } = buildTopologyLayout(
    [{ id: 'a', ...group({ requests: 5 }) }, { id: 'b', ...group({ requests: 0, succeeded: 0 }) }],
    catalog,
  );
  const router = nodes.find((node) => node.kind === 'router');
  assert.equal(router.data.providers, 1, 'only Alpha served something');
  assert.equal(router.data.requests, 5, 'and the count is the window total');
});

test('an active edge keeps its particles, an idle edge never does', () => {
  const { edges } = buildTopologyLayout([{ id: 'a', ...group({}) }], catalog);
  assert.equal(edges.find((edge) => edge.target === 'a').particles, true);
  assert.equal(edges.find((edge) => edge.target === 'b').particles, false);
  assert.equal(edges.find((edge) => edge.target === 'b').state, 'idle');
});

test('particles are capped, so thirty active providers do not become hundreds of moving nodes', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, initial: 'P', color: '#000' }));
  const { edges } = buildTopologyLayout(many.map((card) => ({ id: card.id, ...group({}) })), many);
  const withParticles = edges.filter((edge) => edge.particles);
  assert.equal(withParticles.length, MAX_PARTICLE_EDGES, 'the cap bounds the number of animated edges');
  assert.equal(edges.filter((edge) => edge.state === 'active').length, 30, 'every provider still draws its beam');
});

test('the canvas stops animating when it cannot be seen, and honours reduced motion', () => {
  // Both are the reason the full effect is affordable: motion with nobody looking is pure cost. Asserted in the
  // source because they are browser behaviour a node test cannot drive.
  const component = readFileSync(fileURLToPath(new URL('../src/components/UsageTopology.tsx', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8');
  assert.match(component, /document\.hidden/, 'the canvas no longer pauses when the tab is hidden');
  assert.match(component, /IntersectionObserver/, 'the canvas no longer pauses when scrolled out of view');
  // The **use** of the class, not the word: the explanatory comment above the code names `topology-paused`
  // too, so a bare word match passed on a component that never applied it — checked, and it did.
  assert.match(component, /paused\s*\?\s*'topology-paused'/, 'nothing applies the paused class, so the pause is decoration');
  assert.match(css, /\.topology-paused[\s\S]*?animation: none/, 'the paused class does not actually stop the animations');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?topology-edge-kame/, 'reduced motion does not stop the beam');
});

test('the canvas classifies from the windowed breakdown, and claims no liveness', () => {
  const component = readFileSync(fileURLToPath(new URL('../src/components/UsageTopology.tsx', import.meta.url)), 'utf8');
  // It must read the windowed groups, not a live stream: this page has no in-flight state to read.
  assert.match(component, /groups: readonly GatewayUsageProviderGroup\[\]/, 'the canvas takes the windowed groups');
  assert.doesNotMatch(component, /activeRequests|EventSource|lastProvider|errorProvider/, 'the canvas must not read live-request props it has no source for');
  const page = readFileSync(fileURLToPath(new URL('../src/pages/UsagePage.tsx', import.meta.url)), 'utf8');
  assert.match(page, /<UsageTopology groups=\{breakdown\?\.byProvider \?\? \[\]\}/, 'the page must feed the canvas the windowed breakdown');
});
test('a group that is not a catalog provider is ignored, so "unattributed" cannot be drawn as a provider', () => {
  // The gateway groups requests no provider served under `unattributed`. It is not a provider and is not in the
  // catalog, so it must never become a node — a canvas that drew it would invent a provider that does not exist.
  const { nodes, edges } = buildTopologyLayout([{ id: 'unattributed', ...group({ requests: 9, succeeded: 0, failed: 9 }) }], catalog);
  assert.deepEqual(nodes.filter((node) => node.id === 'unattributed'), [], 'unattributed must not become a node');
  assert.equal(edges.length, catalog.length, 'only catalog providers get edges');
  // It also must not colour anything: no catalog provider matches it, so every one is idle.
  assert.ok(edges.every((edge) => edge.state === 'idle'));
});
