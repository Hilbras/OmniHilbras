import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, CircleAlert, LoaderCircle, MessageSquare, Square } from 'lucide-react';
import { ProviderMark } from './ProviderMark';
import { providerSlug } from '@hilbras/omnihilbras';
import { streamGatewayChat, type GatewayChatMessage, type GatewayConnection } from '../lib/gatewayClient';
import type { ProviderRecord } from './ProviderCard';

/**
 * A conversation with one of this provider's models.
 *
 * Every other control on the page reports *about* a provider — a badge, a latency, a model
 * count — and none of them prove the thing that matters, which is whether the model is any
 * good for what the user is about to do. "Test provider" sends `hi` and shows a green tick;
 * that proves the credential works, not that the model is usable.
 *
 * Three constraints, all learned from failures this page has already had:
 *
 * **Failures show the provider's own words.** A box that says "something went wrong" while the
 * model above it was refused for a specific, fixable reason is worse than no box.
 *
 * **The turn streams and can be stopped.** A chat that shows nothing for eight seconds and then
 * prints the whole answer is not a chat, and here the wait is the observation — it is the
 * clearest signal of which model is fast.
 *
 * **It is not offered when it cannot work.** A provider with no connection, or one the
 * gateway cannot serve at all, gets an explanation instead of a control that always fails.
 */

type Turn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  failed?: boolean;
  /** False when the provider cannot stream, so the wait is explained rather than mysterious. */
  streamed?: boolean;
};

const emptyTurns: Turn[] = [];

function newId() {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ProviderPlayground({ provider, connection }: { provider: ProviderRecord; connection?: GatewayConnection }) {
  /**
   * What the gateway will actually route to.
   *
   * The connection's models win, because that is what the gateway resolved. The catalog list is
   * only a fallback for a connection whose discovery has not run yet — offering catalog models
   * the connection does not carry would produce requests the gateway has to reject.
   */
  const models = useMemo(() => {
    const fromConnection = connection?.modelIds ?? [];
    return fromConnection.length ? fromConnection : provider.modelList ?? [];
  }, [connection?.modelIds, provider.modelList]);

  const [model, setModel] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>(emptyTurns);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  /**
   * Keep the chosen model pointing at something real.
   *
   * A model refresh, or a policy change that narrows the set, must not leave the box pointed at
   * a model the gateway will no longer route to — it would then fail for a reason this page
   * caused.
   */
  useEffect(() => {
    if (models.length === 0) {
      setModel('');
      return;
    }
    setModel((current) => (models.includes(current) ? current : models[0]));
  }, [models]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const prompt = draft.trim();
    if (!model || !prompt || streaming) return;

    // The whole visible exchange, so the model has the thread. A failed turn is dropped rather
    // than sent as an assistant message — replaying a refusal as if the model had said it would
    // teach it to refuse.
    const history: GatewayChatMessage[] = [
      ...turns
        .filter((turn) => !turn.failed && turn.content.trim())
        .map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: prompt },
    ];

    const replyId = newId();
    setDraft('');
    setTurns((current) => [...current, { id: newId(), role: 'user', content: prompt }, { id: replyId, role: 'assistant', content: '' }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await streamGatewayChat({ providerId: provider.id, model, messages: history }, (_delta, accumulated) => {
        setTurns((current) => current.map((turn) => (turn.id === replyId ? { ...turn, content: accumulated } : turn)));
      }, controller.signal);
      setTurns((current) =>
        current.map((turn) =>
          turn.id === replyId
            ? {
                ...turn,
                // A stream that ends with nothing is not a success. Several reasoning models
                // spend the whole budget thinking and return an empty body, which a naive
                // check would record as a working model.
                content: result.content || 'The model returned an empty response.',
                provider: result.provider,
                model: result.model,
                latencyMs: result.latencyMs,
                usage: result.usage,
                streamed: result.streamed,
              }
            : turn,
        ),
      );
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      const message = aborted ? 'Stopped.' : error instanceof Error ? error.message : 'The request failed.';
      setTurns((current) => current.map((turn) => (turn.id === replyId ? { ...turn, content: message, failed: !aborted } : turn)));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [draft, model, provider.id, streaming, turns]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setTurns(emptyTurns);
  }, []);

  // A provider the gateway cannot serve, or one with no connection yet, gets a reason rather
  // than a control that can only fail.
  const blocked = provider.status === 'planned' || !connection?.hasCredential || models.length === 0;
  const reason = provider.status === 'planned'
    ? provider.unavailableReason
    : !connection?.hasCredential
      ? `Connect ${provider.name} above and this becomes a conversation with any of its models.`
      : 'No models are listed for this provider yet. Refresh its models, or add one below.';

  if (blocked) {
    return (
      <section className="card mt-5 p-4 sm:p-5" aria-labelledby="playground-title">
        <h2 id="playground-title" className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="h-4 w-4 text-gold-text" aria-hidden="true" />
          Try a model
        </h2>
        <p className="muted mt-2 max-w-2xl text-xs leading-relaxed">{reason}</p>
      </section>
    );
  }

  return (
    <section className="card mt-5 overflow-hidden" aria-labelledby="playground-title">
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="min-w-0">
          <h2 id="playground-title" className="flex items-center gap-2 text-sm font-semibold">
            <MessageSquare className="h-4 w-4 text-gold-text" aria-hidden="true" />
            Try a model
          </h2>
          <p className="muted mt-1 text-xs">A real request through the gateway, on this connection.</p>
        </div>
        {turns.length > 0 && (
          <button type="button" onClick={clear} disabled={streaming} className="btn-ghost self-start !px-3 !py-2 !text-xs disabled:opacity-40 sm:self-auto">
            New conversation
          </button>
        )}
      </div>

      <div className="border-b border-line bg-bg-soft/60 px-4 py-3 sm:px-5">
        <label className="block">
          <span className="sr-only">Choose a model</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} className="input !h-9 !w-full !py-2 !text-xs sm:!w-96">
            {models.map((option) => (
              <option key={option} value={option}>
                {providerSlug(provider.id)}/{option}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-2.5 flex items-center gap-2">
          <ProviderMark logo={provider.logo} initial={provider.initial} color={provider.color} className="h-5 w-5 rounded-md" />
          <span className="text-[11px] font-semibold">{provider.name}</span>
          <code className="muted truncate font-mono text-[10px]">{model}</code>
        </div>
      </div>

      <div ref={transcriptRef} className="max-h-[26rem] min-h-[9rem] space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
        {turns.length === 0 ? (
          <p className="muted py-6 text-center text-xs">Ask something. Whatever the model says is the real answer, not a sample.</p>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className={turn.role === 'user' ? 'flex justify-end' : ''}>
              <div
                className={
                  turn.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm border border-line bg-bg-soft px-3.5 py-2.5 text-xs leading-relaxed'
                    : `max-w-[92%] rounded-2xl rounded-bl-sm border px-3.5 py-2.5 text-xs leading-relaxed ${
                        turn.failed ? 'border-[#c23b31]/30 bg-[#c23b31]/10 text-danger' : 'border-line bg-surface'
                      }`
                }
              >
                {turn.failed && <CircleAlert className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />}
                <span className="whitespace-pre-wrap break-words">{turn.content || (streaming ? '…' : '')}</span>
                {turn.latencyMs !== undefined && (
                  <p className="muted mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[9px]">
                    <span>{turn.latencyMs} ms</span>
                    {turn.usage && <span>{turn.usage.totalTokens} tokens</span>}
                    {/* Said rather than left to look like a hang. A provider that cannot stream
                        answers in one piece, and silence is indistinguishable from being stuck
                        unless the panel explains it. */}
                    {turn.streamed === false && <span title="This provider cannot stream, so the whole answer arrives at once.">no streaming</span>}
                    {turn.model && turn.model !== model && <span>via {turn.model}</span>}
                  </p>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-line p-3 sm:p-4">
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="sr-only">Message</span>
            <textarea
              value={draft}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line. The convention people already have
                // from every other chat, and a send button alone is slower than typing.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Send a message…"
              className="input max-h-40 min-h-9 resize-none !py-2 text-xs"
            />
          </label>
          {streaming ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="btn-ghost !px-3 !py-2.5 !text-xs">
              <Square className="mr-1.5 h-3 w-3" aria-hidden="true" />Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!draft.trim() || !model}
              className="btn-gold !px-3.5 !py-2.5 !text-xs disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />Send
            </button>
          )}
        </div>
        <p className="muted mt-2 flex items-center gap-1.5 text-[10px]">
          {streaming && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />}
          A real request. Providers that meter credits will spend them.
        </p>
      </div>
    </section>
  );
}
