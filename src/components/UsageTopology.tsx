import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { providerCatalog } from '../data/providers';
import type { GatewayUsageProviderGroup } from '../lib/gatewayClient';
import {
  buildTopologyLayout,
  MAX_PARTICLE_EDGES,
  NODE_SIZE,
  ROUTER_SIZE,
  type ProviderState,
  type TopologyEdge,
  type TopologyNode,
} from '../lib/providerTopology';
import { ProviderMark } from './ProviderMark';

/**
 * The provider canvas on the usage page: the gateway in the middle, every configured provider around it, with
 * the edges that served something in the current window drawn as an electric beam.
 *
 * The classification and the geometry live in `lib/providerTopology.ts` so they can be **called** by a test
 * rather than read as text; this file is the drawing. The two halves of the state — "active means served in
 * this window, not live" and the cost of the animations — are documented there and below.
 *
 * ## Cost
 *
 * The full effect is deliberate, and it is also the kind of thing that made this dashboard slow before, so
 * three things bound it:
 *
 *   1. **Nothing animates while it cannot be seen.** A background tab or a canvas scrolled past pauses by
 *      adding `topology-paused`, so those animations cost nothing.
 *   2. **The particle layers are capped** at `MAX_PARTICLE_EDGES`; past it the beam is drawn and the orbs are
 *      not. Thirty active providers would otherwise be three hundred and thirty continuously-moving nodes.
 *   3. **`prefers-reduced-motion: reduce`** turns the animation off in CSS and leaves the solid coloured edges.
 */

type RouterNodeData = { requests: number; providers: number };
type ProviderNodeData = { label: string; logo?: string; initial: string; color: string; requests: number; state: ProviderState };

const handleClass = '!h-0 !w-0 !min-h-0 !min-w-0 !border-0 !bg-transparent';

function ProviderNode({ data }: NodeProps<Node<ProviderNodeData>>) {
  const error = data.state === 'error';
  const idle = data.state === 'idle';
  return (
    <div
      className={`flex items-center gap-2.5 overflow-hidden rounded-xl border-2 bg-surface px-3 transition-colors duration-300 ${idle ? 'border-line opacity-60 hover:opacity-100' : ''}`}
      style={{ width: NODE_SIZE.width, height: NODE_SIZE.height, ...(idle ? {} : { borderColor: data.color, boxShadow: `0 0 16px ${data.color}40` }) }}
    >
      <Handle type="target" position={Position.Top} id="top" className={handleClass} />
      <Handle type="target" position={Position.Bottom} id="bottom" className={handleClass} />
      <Handle type="target" position={Position.Left} id="left" className={handleClass} />
      <Handle type="target" position={Position.Right} id="right" className={handleClass} />
      <ProviderMark logo={data.logo} initial={data.initial} color={data.color} className="h-6 w-6 shrink-0 rounded-md" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium" style={idle ? undefined : { color: data.color }}>
        {data.label}
      </span>
      {!idle && (
        <span className="relative flex h-2 w-2 shrink-0" title={error ? 'failed in this window' : 'served in this window'}>
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${error ? '' : 'animate-ping'}`} style={{ backgroundColor: data.color }} />
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: data.color }} />
        </span>
      )}
    </div>
  );
}

function RouterNode({ data }: NodeProps<Node<RouterNodeData>>) {
  // The card pulses only when something actually flowed, so an idle gateway is a still card rather than an
  // animation claiming activity.
  const powering = data.providers > 0;
  return (
    <div
      className={`relative z-[1] flex items-center gap-2 rounded-xl border-2 px-4 py-2.5 ${powering ? 'topology-router-core border-gold' : 'border-gold/40 bg-gold-soft'}`}
      style={{ width: ROUTER_SIZE.width, height: ROUTER_SIZE.height }}
    >
      <Handle type="source" position={Position.Top} id="top" className={handleClass} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={handleClass} />
      <Handle type="source" position={Position.Left} id="left" className={handleClass} />
      <Handle type="source" position={Position.Right} id="right" className={handleClass} />
      <img src="/favicon.svg" alt="" className={`h-5 w-5 ${powering ? 'topology-router-icon' : ''}`} />
      <div className="flex flex-col">
        <span className={`text-xs font-semibold tracking-tight text-gold-text ${powering ? 'topology-router-label' : ''}`}>OmniHilbras</span>
        <span className="font-mono text-[10px] text-muted">
          {data.requests} recent · {data.providers} providers
        </span>
      </div>
    </div>
  );
}

/**
 * An edge from the router to a provider.
 *
 * Idle is one dim line. Active and error edges are the beam: a soft halo, a plasma layer and a hot core, the
 * first two displaced by a turbulence filter so the line reads as a current rather than a stroke, with energy
 * orbs travelling along it. `particles` is false when the edge is past the cap, which still draws the beam.
 */
function TopologyEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style = {}, data }: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const state = (data?.state as ProviderState | undefined) ?? 'idle';
  const stroke = (style.stroke as string | undefined) ?? 'var(--color-line)';
  const particles = state !== 'idle' && data?.particles === true;
  const error = state === 'error';
  const filterId = `topo-${id}`;

  if (state === 'idle') return <BaseEdge id={id} path={edgePath} style={{ ...style, stroke, opacity: 0.3 }} />;

  return (
    <g className="topology-edge">
      <defs>
        <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="2" result="noise">
            <animate attributeName="baseFrequency" values="0.8;1.4;0.8" dur="0.25s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <path d={edgePath} fill="none" stroke={error ? 'var(--danger)' : 'var(--gold)'} strokeWidth={10} strokeOpacity={0.35} strokeLinecap="round" filter={`url(#${filterId})`} className="topology-edge-halo" />
      <path d={edgePath} fill="none" stroke={stroke} strokeWidth={5} strokeOpacity={0.85} strokeLinecap="round" filter={`url(#${filterId})`} className="topology-edge-plasma" />
      <BaseEdge id={id} path={edgePath} style={{ stroke: 'var(--text)', strokeWidth: 2.2, opacity: 1 }} className="topology-edge-kame" />
      {particles && (
        <>
          {Array.from({ length: 6 }, (_, index) => (
            <circle key={`${id}-orb-${index}`} r={index % 2 === 0 ? 4 : 2.5} fill={index % 3 === 0 ? 'var(--gold-bright)' : '#67e8f9'} opacity={0.95} style={{ filter: 'drop-shadow(0 0 4px #22d3ee)' }}>
              <animateMotion dur={`${0.4 + index * 0.08}s`} repeatCount="indefinite" path={edgePath} begin={`${index * 0.09}s`} />
            </circle>
          ))}
          {Array.from({ length: 5 }, (_, index) => (
            <circle key={`${id}-spark-${index}`} r={1.8} fill="#e0f2fe" opacity={0}>
              <animate attributeName="opacity" values="0;1;0;0;1;0" dur={`${0.35 + (index % 3) * 0.1}s`} begin={`${index * 0.07}s`} repeatCount="indefinite" />
              <animateMotion dur={`${0.28 + index * 0.05}s`} repeatCount="indefinite" path={edgePath} begin={`${index * 0.11}s`} />
            </circle>
          ))}
        </>
      )}
    </g>
  );
}

const nodeTypes = { provider: ProviderNode, router: RouterNode };
const edgeTypes = { topology: TopologyEdgeView };

/** Maps the pure layout onto React Flow's node and edge shapes, keeping the drawing types out of the module. */
export function toFlow(layout: { nodes: TopologyNode[]; edges: TopologyEdge[] }): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: layout.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      position: { x: node.x, y: node.y },
      data: node.data,
      draggable: false,
      selectable: false,
    })),
    edges: layout.edges.map((edge) => ({
      id: edge.id,
      type: 'topology',
      source: 'omnihilbras',
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      animated: false,
      data: { state: edge.state, particles: edge.particles },
      style: {
        stroke: edge.state === 'error' ? 'var(--danger)' : edge.state === 'active' ? 'var(--gold)' : 'var(--line)',
        strokeWidth: edge.state === 'idle' ? 1 : 3,
        opacity: edge.state === 'idle' ? 0.3 : 1,
      },
    })),
  };
}

export function UsageTopology({ groups }: { groups: readonly GatewayUsageProviderGroup[] }) {
  const container = useRef<HTMLDivElement | null>(null);
  const instance = useRef<{ fitView: (options?: { padding?: number; duration?: number }) => void } | null>(null);
  const [paused, setPaused] = useState(false);

  const { nodes, edges } = useMemo(() => toFlow(buildTopologyLayout(groups, providerCatalog)), [groups]);
  // Only remount React Flow when the node set changes; a data-only update must not rebuild the graph.
  const nodesKey = useMemo(() => nodes.map((node) => node.id).join(','), [nodes]);

  /**
   * Stops the animations when nobody can see them: a background tab, or the canvas scrolled out of view. The
   * CSS keeps the geometry and drops the motion, so an unseen canvas costs nothing per frame.
   */
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onVisibility = () => setPaused(document.hidden || !inView.current);
    const inView = { current: true };
    const observer = new IntersectionObserver(([entry]) => {
      inView.current = entry.isIntersecting;
      setPaused(document.hidden || !entry.isIntersecting);
    }, { threshold: 0 });
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    observer.observe(element);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
    };
  }, []);

  const fitOptions = { padding: 0.2, duration: 200 };
  const refit = useCallback(() => instance.current?.fitView(fitOptions), []);

  // Re-fit when the layout changes, and whenever the container is resized (a sidebar collapse, a window resize).
  useEffect(() => {
    const id = setTimeout(refit, 50);
    return () => clearTimeout(id);
  }, [nodes.length, refit]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => refit());
    observer.observe(element);
    return () => observer.disconnect();
  }, [refit]);

  return (
    <div
      ref={container}
      className={`h-[360px] w-full min-w-0 overflow-hidden rounded-2xl border border-line bg-gradient-to-b from-bg-soft to-bg sm:h-[520px] ${paused ? 'topology-paused' : ''}`}
    >
      <ReactFlow
        key={nodesKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={fitOptions}
        onInit={(reactFlowInstance) => {
          instance.current = reactFlowInstance as unknown as typeof instance.current;
          setTimeout(refit, 50);
        }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
        preventScrolling={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--line)" />
        <Controls showInteractive={false} className="topology-controls" />
      </ReactFlow>
    </div>
  );
}

export { MAX_PARTICLE_EDGES };