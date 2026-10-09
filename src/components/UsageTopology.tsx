import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { providerCatalog } from '../data/providers';
import type { GatewayUsageRecord } from '../lib/gatewayClient';
import { ProviderMark } from './ProviderMark';

type ProviderNodeData = {
  label: string;
  logo?: string;
  initial: string;
  color: string;
  requests: number;
  side: 'left' | 'right';
};

type CenterNodeData = { requests: number; providers: number };

const CENTER_ID = 'omnihilbras';
const CENTER_W = 180;
const CENTER_H = 72;
const NODE_W = 220;
const NODE_H = 46;
const ROW_PITCH = 58;
const COLUMN_X = 300;

const handleClass = '!h-0 !w-0 !min-h-0 !min-w-0 !border-0 !bg-transparent';

function ProviderNode({ data }: NodeProps<Node<ProviderNodeData>>) {
  const active = data.requests > 0;
  const sideHandle = data.side === 'left' ? Position.Right : Position.Left;
  return (
    <div
      className={`group flex h-[46px] w-[220px] items-center gap-3 overflow-hidden rounded-2xl border bg-surface/90 px-3 backdrop-blur transition-all duration-300 ${
        active ? 'border-transparent shadow-lg' : 'border-line opacity-60 hover:opacity-100'
      }`}
      style={active ? { boxShadow: `0 10px 30px -12px ${data.color}`, backgroundImage: `linear-gradient(90deg, ${data.color}1f, transparent 70%)` } : undefined}
    >
      <Handle type="target" position={sideHandle} id={data.side === 'left' ? 'out' : 'in'} className={handleClass} />
      <ProviderMark logo={data.logo} initial={data.initial} color={data.color} className="h-7 w-7 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-text">{data.label}</p>
        <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
          {active ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: data.color }} />
              {data.requests} recent
            </>
          ) : (
            'idle'
          )}
        </p>
      </div>
    </div>
  );
}

function CenterNode({ data }: NodeProps<Node<CenterNodeData>>) {
  return (
    <div className="relative flex h-[72px] w-[180px] flex-col items-center justify-center rounded-2xl border border-gold/40 bg-gradient-to-br from-gold-soft via-surface to-surface shadow-[0_0_40px_-10px_rgba(212,175,55,0.45)]">
      <Handle type="source" position={Position.Left} id="left" className={handleClass} />
      <Handle type="source" position={Position.Right} id="right" className={handleClass} />
      <span className="text-sm font-semibold tracking-tight text-gold-text">OmniHilbras</span>
      <span className="mt-0.5 font-mono text-[10px] text-muted">
        {data.requests} recent · {data.providers} providers
      </span>
    </div>
  );
}

const nodeTypes = { provider: ProviderNode, center: CenterNode };

export function UsageTopology({ records }: { records: GatewayUsageRecord[] }) {
  const { nodes, edges, height } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of records) {
      if (record.providerId) counts.set(record.providerId, (counts.get(record.providerId) ?? 0) + 1);
    }

    const providers = providerCatalog;
    const half = Math.ceil(providers.length / 2);
    const top = -((half - 1) * ROW_PITCH) / 2;
    const rows = Math.max(half, providers.length - half);

    const center: Node<CenterNodeData> = {
      id: CENTER_ID,
      type: 'center',
      position: { x: -CENTER_W / 2, y: -CENTER_H / 2 },
      data: { requests: records.length, providers: counts.size },
      draggable: false,
      selectable: false,
    };

    const providerNodes: Node<ProviderNodeData>[] = [];
    const providerEdges: Edge[] = [];

    providers.forEach((card, index) => {
      const side: 'left' | 'right' = index < half ? 'left' : 'right';
      const row = side === 'left' ? index : index - half;
      const requests = counts.get(card.id) ?? 0;
      const x = side === 'left' ? -COLUMN_X - NODE_W / 2 : COLUMN_X - NODE_W / 2;
      const y = top + row * ROW_PITCH - NODE_H / 2;

      providerNodes.push({
        id: card.id,
        type: 'provider',
        position: { x, y },
        data: {
          label: card.name,
          logo: card.logo,
          initial: card.initial,
          color: card.color,
          requests,
          side,
        },
        draggable: false,
        selectable: false,
      });

      const active = requests > 0;
      providerEdges.push({
        id: `e-${card.id}`,
        source: CENTER_ID,
        sourceHandle: side === 'left' ? 'left' : 'right',
        target: card.id,
        targetHandle: side === 'left' ? 'out' : 'in',
        type: 'default',
        animated: active,
        style: active
          ? { stroke: card.color, strokeWidth: 2, opacity: 0.95 }
          : { stroke: 'var(--color-border)', strokeWidth: 1, strokeDasharray: '3 5', opacity: 0.7 },
      });
    });

    return {
      nodes: [center, ...providerNodes],
      edges: providerEdges,
      height: rows * ROW_PITCH + 120,
    };
  }, [records]);

  return (
    <div
      className="relative w-full overflow-hidden rounded-2xl border border-line bg-gradient-to-b from-bg-soft to-bg"
      style={{ height }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.4}
        maxZoom={1.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--color-border)" />
      </ReactFlow>
    </div>
  );
}
