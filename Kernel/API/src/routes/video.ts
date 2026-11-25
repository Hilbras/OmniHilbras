/**
 * `/v1/videos/*` — an honest, billable video surface.
 *
 * One adapter (xAI, in its own SDK package) really creates and polls video jobs. Every other provider
 * ends in a named `NOT_SUPPORTED`: there is no global job table and no synthetic completion, so a
 * provider without a video wire cannot be given a job id or a URL. The wire shape, connection pinning,
 * abort handling, key gate, rate limiter and usage ledger are the same for both outcomes.
 *
 * Poll resolution has no global job table. A poll is bound to the connection that created the job (the
 * caller echoes `x-omnihilbras-connection`, as in the reference); `?provider=` is a fallback only. A bare
 * poll naming neither is an invalid request, never a guess at one account.
 */

import type { RouteContext } from './route-context.js';
import { type GatewayFailoverAttempt } from '../core/request-executor.js';
import { invalidRequest, isRecord, maxInferenceBodyBytes, readJsonBody, requestIdOf, sendJson } from '../core/http.js';
import { ProviderError, isProviderError } from '../core/provider-error.js';
import {
  VIDEO_POLL_PREFIX, extractApiKey, getExplicitConnectionId, getExplicitProviderId, isVideoRoute,
} from './inference.js';
import { isTrustedDashboard } from '../core/runtime.js';

const VIDEO_ACTIONS = new Set(['generations', 'edits', 'extensions']);

function cancelled(): ProviderError {
  return new ProviderError('CANCELLED', 'The video request was aborted before it was answered.', {
    retryable: false,
    publicMessage: 'The video request was cancelled.',
  });
}

export async function handleVideoRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, options, signal, origin } = ctx;
  if (!isVideoRoute(request.method, url.pathname)) return false;

  // The same gate `handleInferenceRoute` applies to the rest of the spend surface. This handler is
  // registered before it in `server.ts`, and the dispatcher's fast path excludes video paths, so this
  // is the only auth decision made for these requests.
  if (!isTrustedDashboard(ctx.auth)) await service.authorizePublicRequest(extractApiKey(request));

  const creating = request.method === 'POST';
  const scope = service.startScope('video-generation', undefined, undefined, requestIdOf(request));
  const startedAt = Date.now();
  let providerId: string | undefined;
  let connectionId: string | undefined;
  let attempts: GatewayFailoverAttempt[] = [];

  const recordUsage = (outcome: 'success' | 'failure' | 'cancelled', errorCode?: string): void => {
    void service.usage?.record({
      at: new Date().toISOString(),
      model: 'video-generation',
      ...(providerId ? { providerId } : {}),
      ...(connectionId ? { connectionId } : {}),
      outcome,
      attempts: attempts.length,
      latencyMs: Date.now() - startedAt,
      ...(errorCode ? { errorCode } : {}),
      requestId: scope.id,
    }).catch(() => undefined);
  };

  try {
    let action: string | undefined;
    let body: Record<string, unknown> | undefined;
    let id: string | undefined;

    if (creating) {
      const parsed = await readJsonBody(request, options.maxBodyBytes ?? maxInferenceBodyBytes);
      if (!isRecord(parsed)) throw invalidRequest('The request body must be a JSON object.');
      const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
      if (!model) throw invalidRequest('model must be a non-empty string.');
      action = url.pathname.slice(VIDEO_POLL_PREFIX.length).trim();
      if (!VIDEO_ACTIONS.has(action)) throw invalidRequest(`Unknown video action: ${action || '(empty)'}`);
      body = parsed;
      connectionId = getExplicitConnectionId(request, body);
      const explicit = getExplicitProviderId(request, body);
      const slash = model.indexOf('/');
      providerId = explicit ?? (slash > 0 ? model.slice(0, slash) : undefined);
    } else {
      id = url.pathname.slice(VIDEO_POLL_PREFIX.length).trim();
      if (!id) throw invalidRequest('Missing video request id.');
      const queriedConnection = url.searchParams.get('connection')?.trim();
      connectionId = getExplicitConnectionId(request, undefined) ?? (queriedConnection || undefined);
      const queriedProvider = url.searchParams.get('provider')?.trim();
      providerId = queriedProvider || undefined;
      if (!connectionId && !providerId) {
        throw invalidRequest('A video poll must name x-omnihilbras-connection (or ?connection=), or fall back to ?provider=; the gateway keeps no global video job table.');
      }
    }

    if (signal.aborted) throw cancelled();
    const connections = await service.listConnections();
    const connection = connectionId ? connections.find((entry) => entry.id === connectionId) : undefined;
    if (connectionId && !connection) throw invalidRequest(`Connection "${connectionId}" is not saved.`);
    if (signal.aborted) throw cancelled();

    // The account that would create the job decides which capability is in play; the query string is
    // only consulted when no connection was pinned. Never the other way round.
    const selected = connection?.providerId ?? providerId;
    const declared = selected ? await service.supportsVideoGeneration(selected) : false;
    if (signal.aborted) throw cancelled();

    // The one planned attempt exists for refusals too: a job that was never sent still has to appear
    // in the usage ledger as one attempted call, not as silence.
    attempts = selected
      ? [{
        providerId: selected,
        ...(connectionId ? { connectionId } : {}),
        attempt: 1,
        ok: false,
        latencyMs: Date.now() - startedAt,
        errorCode: 'NOT_SUPPORTED',
      }]
      : [];

    if (signal.aborted) throw cancelled();
    if (!selected || !declared) {
      // Keep the refusal by name. `runVideoGeneration` produces the identical message, but there is
      // no point resolving an adapter for a provider that has already answered false.
      const message = selected
        ? `Provider "${selected}" does not declare video generation; no video job was created and no job URL was invented.`
        : 'No provider was selected for video generation; no video job was created and no job URL was invented.';
      throw new ProviderError('NOT_SUPPORTED', message, {
        providerId: selected,
        retryable: false,
        publicMessage: message,
        details: { requestId: scope.id, attempts },
      });
    }

    const job = creating
      ? await service.createVideoGeneration(selected, connectionId, action!, body!, signal)
      : await service.pollVideoGeneration(selected, connectionId, id!, signal);

    if (signal.aborted) throw cancelled();
    // The job actually reached the adapter, so the planned attempt is now a real one.
    attempts = attempts.map((attempt) => ({ ...attempt, ok: true, errorCode: undefined }));
    if (connectionId) response.setHeader('x-omnihilbras-connection', connectionId);
    recordUsage('success');
    sendJson(response, 200, {
      id: job.id,
      ...(job.status !== undefined ? { status: job.status } : {}),
      // The URL is the upstream's own, forwarded only on its own completion signal. The gateway
      // never derives, guesses or repairs one.
      ...(job.videoUrl !== undefined ? { video: { url: job.videoUrl } } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
    }, origin);
    return true;
  } catch (error) {
    const wasCancelled = signal.aborted || (isProviderError(error) && error.code === 'CANCELLED');
    recordUsage(wasCancelled ? 'cancelled' : 'failure', isProviderError(error) ? error.code : 'INVALID_REQUEST');
    throw error;
  }
}
