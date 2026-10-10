import { useEffect, useState } from 'react';
import { openGatewayLogStream, type GatewayLogEvent } from '../lib/gatewayClient';

/** The most recent events kept on the page. Older ones are dropped, so a long swarm run does not grow the page. */
const keptEvents = 200;

export function LogsContent() {
  const [events, setEvents] = useState<GatewayLogEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => openGatewayLogStream(
    (event) => setEvents((current) => [event, ...current].slice(0, keptEvents)),
    setConnected,
  ), []);

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold">Live requests</h1>
        <span className="muted font-mono text-[10px]">{connected ? 'streaming' : 'waiting for the gateway'}</span>
      </header>
      {events.length === 0 ? (
        <p className="muted text-[12px]">Each finished request appears here as it is recorded.</p>
      ) : (
        <ul className="divide-y divide-line font-mono text-[11px]">
          {events.map((event, index) => (
            <li key={`${event.requestId ?? event.at}-${index}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-2">
              <span className="muted">{new Date(event.at).toLocaleTimeString()}</span>
              <span className="truncate">
                {event.model} · {event.providerId ?? 'no provider'} · {event.attempts} {event.attempts === 1 ? 'attempt' : 'attempts'}
                {event.errorCode ? ` · ${event.errorCode}` : ''}
              </span>
              <span className={event.outcome === 'success' ? 'text-ok' : event.outcome === 'failure' ? 'text-danger' : 'muted'}>
                {event.outcome} · {event.latencyMs} ms
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
