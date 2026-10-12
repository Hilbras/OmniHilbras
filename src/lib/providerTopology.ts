import type { GatewayUsageProviderGroup } from './gatewayClient';

/**
 * The layout and classification behind the usage page's provider canvas.
 *
 * ## Why this is a module and not part of the component
 *
 * Same reason as `providerCards.ts`: the logic was inside a `.tsx`, so the only way to check it was to read
 * its text. It is pure — groups and a catalog in, nodes and edges out, no DOM, no React — so it lives here and
 * `tests/usage-topology.test.js` **calls** it. Node cannot import a `.tsx` (JSX), so anything worth asserting
 * has to be outside one.
 *
 * ## What "active" means here, and what it does not
 *
 * The original this is ported from drives its edges from a live stream: active while a request is in flight.
 * This page has no stream, only a windowed aggregate, so the states are read from the window's numbers:
 *
 *   - **active** — the group served at least one request in the window;
 *   - **error** — it has failures and no successes: everything it did in the window failed;
 *   - **idle** — no requests in the window, which is a provider that is configured and unused.
 *
 * A provider serving a request *right now* is indistinguishable from one that served an hour ago. That is a
 * property of the data, not of this function, so the UI and the docs say "in this window" rather than implying
 * liveness.
 */

/** Geometry for one provider box. */
export const NODE_SIZE = { width: 168, height: 40 } as const;
export const ROUTER_SIZE = { width: 150, height: 46 } as const;
const NODE_GAP = 26;

/**
 * How many active edges keep their travelling orbs. Each is eleven continuously-moving SVG nodes, so thirty
 * active providers would be three hundred and thirty of them; past this the beam is still drawn and the orbs
 * are not. The first active providers in catalog order keep theirs, so the set is stable between renders.
 */
export const MAX_PARTICLE_EDGES = 12;

export type ProviderState = 'active' | 'error' | 'idle';

export type TopologyNodeData =
  | { kind: 'router'; requests: number; providers: number }
  | { kind: 'provider'; label: string; logo?: string; initial: string; color: string; requests: number; state: ProviderState };

export type TopologyNode = { id: string; kind: 'router' | 'provider'; x: number; y: number; data: TopologyNodeData };

export type TopologyEdge = {
  id: string;
  target: string;
  state: ProviderState;
  /** Whether this edge draws its particle layers. False for an idle edge or one past the cap. */
  particles: boolean;
  sourceHandle: 'top' | 'bottom' | 'left' | 'right';
  targetHandle: 'top' | 'bottom' | 'left' | 'right';
};

export type TopologyLayout = { nodes: TopologyNode[]; edges: TopologyEdge[] };

/** The minimum a catalog entry needs to be drawn: the fields `ProviderRecord` already carries. */
export type TopologyCatalogEntry = { id: string; name: string; logo?: string; initial: string; color: string };

/**
 * A group's window, as one of three states. A group with only cancellations is **not** an error: the client
 * stopped, which says nothing about the provider.
 */
export function providerState(group: GatewayUsageProviderGroup | undefined): ProviderState {
  if (!group || group.requests === 0) return 'idle';
  if (group.succeeded > 0) return 'active';
  if (group.failed > 0) return 'error';
  return 'idle';
}

/**
 * Places every catalog provider on an ellipse around the router, starting at the top and going clockwise.
 *
 * The horizontal radius grows with the provider count `(width + gap) * count / 2π`, so the arc between
 * neighbours never falls below one node's width however large the catalog gets; the vertical radius is 0.55 of
 * it, which is the ellipse ratio the original uses.
 *
 * Each edge leaves the router through the handle nearest its node's direction, so the lines fan outwards rather
 * than crossing the router card.
 */
export function buildTopologyLayout(
  groups: readonly GatewayUsageProviderGroup[],
  catalog: readonly TopologyCatalogEntry[],
): TopologyLayout {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const count = catalog.length;
  const rx = Math.max(320, ((NODE_SIZE.width + NODE_GAP) * count) / (2 * Math.PI));
  const ry = Math.max(190, rx * 0.55);

  const served = catalog.filter((card) => providerState(byId.get(card.id)) === 'active').length;
  const totalRequests = groups.reduce((sum, group) => sum + group.requests, 0);

  const nodes: TopologyNode[] = [
    { id: 'omnihilbras', kind: 'router', x: -ROUTER_SIZE.width / 2, y: -ROUTER_SIZE.height / 2, data: { kind: 'router', requests: totalRequests, providers: served } },
  ];
  const edges: TopologyEdge[] = [];
  const activeIds: string[] = [];

  catalog.forEach((card, index) => {
    const group = byId.get(card.id);
    const state = providerState(group);
    // From the top (−π/2) clockwise, so the first provider is at twelve o'clock and the order is stable.
    const angle = count === 0 ? 0 : -Math.PI / 2 + (2 * Math.PI * index) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    let sourceHandle: TopologyEdge['sourceHandle'];
    let targetHandle: TopologyEdge['targetHandle'];
    if (cy < -Math.abs(cx)) {
      sourceHandle = 'top';
      targetHandle = 'bottom';
    } else if (cy > Math.abs(cx)) {
      sourceHandle = 'bottom';
      targetHandle = 'top';
    } else if (cx > 0) {
      sourceHandle = 'right';
      targetHandle = 'left';
    } else {
      sourceHandle = 'left';
      targetHandle = 'right';
    }

    nodes.push({
      id: card.id,
      kind: 'provider',
      x: cx - NODE_SIZE.width / 2,
      y: cy - NODE_SIZE.height / 2,
      data: { kind: 'provider', label: card.name, logo: card.logo, initial: card.initial, color: card.color, requests: group?.requests ?? 0, state },
    });

    if (state !== 'idle') activeIds.push(card.id);
    edges.push({ id: `e-${card.id}`, target: card.id, state, particles: false, sourceHandle, targetHandle });
  });

  const withParticles = new Set(activeIds.slice(0, MAX_PARTICLE_EDGES));
  for (const edge of edges) edge.particles = withParticles.has(edge.target);

  return { nodes, edges };
}