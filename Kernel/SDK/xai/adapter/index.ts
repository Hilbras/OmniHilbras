import {
  OpenAICompatibleAdapter,
  normalizeProviderBaseUrl,
  resolveProviderUrl,
  type OpenAICompatibleAdapterOptions,
} from '@omnihilbras/sdk-openai';
import { ProviderError } from '@omnihilbras/sdk-shared/errors';
import type { ProviderCapabilities, ProviderRequestContext } from '@omnihilbras/sdk-shared/types';

/**
 * xAI's own adapter: chat on the OpenAI-compatible wire, plus its asynchronous video-job surface.
 *
 * There is no simulated generation here. `video()` performs one real upstream request with the
 * connection's own credential and reports exactly what the upstream answered. Create answers with
 * the upstream `request_id` alone — xAI's create response has no video URL — and poll forwards the
 * upstream status, adding `videoUrl` only when the upstream itself says the job completed and gave a
 * URL. A status that is neither complete nor absent is never promoted to "done".
 *
 * The adapter is also the chat adapter for the `xai` connection: it subclasses OpenAI-compatible so
 * a saved xAI key keeps serving normal turns through the same gateway transport and vault context.
 */

export const xaiProviderId = 'xai';
const DEFAULT_BASE = 'https://api.x.ai/v1';

/** xAI's completion status values, as documented on the video poll response. */
const COMPLETE_STATUSES = new Set(['completed', 'done', 'succeeded', 'success']);

export type XaiVideoRequest =
  | { kind: 'create'; action: string; body: Record<string, unknown> }
  | { kind: 'poll'; id: string };

export type XaiVideoJob = {
  /** The upstream `request_id`, verbatim. Never generated locally. */
  id: string;
  /** The upstream status, verbatim, when the upstream stated one. */
  status?: string;
  /** The upstream `video.url`, present only for a completed job that actually published one. */
  videoUrl?: string;
};

type VideoPayload = Record<string, unknown>;

function record(value: unknown): VideoPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as VideoPayload : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function credentialHeader(context?: ProviderRequestContext): Record<string, string> {
  const credential = context?.credential;
  if (!credential || credential.type === 'none' || !credential.value) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'xAI video generation needs a saved credential for this connection.', {
      providerId: xaiProviderId,
      publicMessage: 'This xAI connection has no saved credential. Sign in again before creating a video job.',
    });
  }
  return { Authorization: `Bearer ${credential.value}` };
}

export class XaiAdapter extends OpenAICompatibleAdapter {
  private readonly videoBaseUrl: string;

  constructor(options: OpenAICompatibleAdapterOptions & { endpoint?: string } = {}) {
    const baseUrl = options.endpoint ?? DEFAULT_BASE;
    super({
      id: xaiProviderId,
      name: 'xAI',
      baseUrl,
      auth: { header: 'Authorization', prefix: 'Bearer' },
      modelFamily: 'gpt',
      // The shared capability union predates video; the gateway reads this flag structurally
      // (`supportsVideoGeneration`) so a new wire surface does not need 54 vendored type copies edited.
      capabilities: { video: true } as unknown as ProviderCapabilities,
    }, options);
    this.videoBaseUrl = normalizeProviderBaseUrl(baseUrl, xaiProviderId);
  }

  /**
   * One create or poll round-trip, on the same transport the gateway gives chat.
   *
   * `transport` is protected on the base class, which is deliberate: a provider-specific wire stays
   * inside its adapter. This method is that provider-specific wire.
   */
  async video(request: XaiVideoRequest, context?: ProviderRequestContext): Promise<XaiVideoJob> {
    const auth = credentialHeader(context);
    if (request.kind === 'create') {
      const action = request.action.trim();
      if (!/^[a-z-]{1,32}$/.test(action)) {
        throw new ProviderError('INVALID_REQUEST', `Unknown xAI video action: ${action || '(empty)'}`, { providerId: xaiProviderId });
      }
      // Strip only this adapter's own prefix. An unprefixed or foreign model is left alone so xAI's
      // own answer names the model it actually saw.
      const prefix = `${xaiProviderId}/`;
      const body = { ...request.body };
      if (typeof body.model === 'string' && body.model.startsWith(prefix)) body.model = body.model.slice(prefix.length);
      const response = await this.transport.request<VideoPayload>({
        method: 'POST',
        url: resolveProviderUrl(this.videoBaseUrl, `videos/${action}`, xaiProviderId),
        providerId: xaiProviderId,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      const data = record(response.data);
      const id = text(data.request_id);
      if (!id) throw new ProviderError('INVALID_RESPONSE', 'xAI accepted a video job but did not return a request_id.', { providerId: xaiProviderId });
      // No URL is constructed: create answers with the id alone, as upstream did.
      return { id };
    }

    const id = request.id.trim();
    if (!id || /[^A-Za-z0-9._:-]/.test(id)) {
      throw new ProviderError('INVALID_REQUEST', 'A video poll needs the request_id returned at creation.', { providerId: xaiProviderId });
    }
    const response = await this.transport.request<VideoPayload>({
      method: 'GET',
      url: resolveProviderUrl(this.videoBaseUrl, `videos/${encodeURIComponent(id)}`, xaiProviderId),
      providerId: xaiProviderId,
      headers: { Accept: 'application/json', ...auth },
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const data = record(response.data);
    const status = text(data.status);
    const video = record(data.video);
    const complete = status !== undefined && COMPLETE_STATUSES.has(status.toLowerCase());
    const videoUrl = complete ? text(video.url) : undefined;
    return {
      id,
      ...(status !== undefined ? { status } : {}),
      ...(videoUrl !== undefined ? { videoUrl } : {}),
    };
  }
}
