import { ProviderError } from '@omnihilbras/sdk-shared/errors';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-shared/openai-compatible';
import { normalizeCatalogModel } from '@omnihilbras/sdk-shared/model-normalize';
import { parseSseJson, parseSseStream } from '@omnihilbras/sdk-shared/streaming';
import { FetchHttpTransport, type HttpTransport } from '@omnihilbras/sdk-shared/transport';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CredentialValidation,
  FinishReason,
  Model,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
  TokenUsage,
  ToolCallDelta,
} from '@omnihilbras/sdk-shared/types';

export const nousProviderId = 'nous';
export const NOUS_BASE_URL = 'https://inference-api.nousresearch.com/v1';

/**
 * The portal that issues the device-code sign-in and the agent key.
 *
 * These are **two different credentials for one account**, and the portal is not the inference host:
 * OAuth lives at `portal.nousresearch.com` and inference at `inference-api.nousresearch.com`. The
 * reference project measured both, including the scope string, and the agent key exists because the
 * access token is short-lived while an agent key is a bearer the inference API accepts directly.
 */
export const NOUS_PORTAL_BASE_URL = 'https://portal.nousresearch.com';
export const NOUS_OAUTH_CLIENT_ID = 'hermes-cli';
export const NOUS_OAUTH_SCOPE = 'inference:invoke inference:mint_agent_key';
const NOUS_DEVICE_CODE_PATH = '/api/oauth/device/code';
const NOUS_TOKEN_PATH = '/api/oauth/token';
const NOUS_AGENT_KEY_PATH = '/api/oauth/agent-key';
const NOUS_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** A credential with less than this much life left is renewed rather than spent. */
const EXPIRY_SKEW_MS = 60_000;

type DeviceCodeAnswer = {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
};

type TokenAnswer = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

type AgentKeyAnswer = { api_key?: unknown; key_id?: unknown; expires_at?: unknown; expires_in?: unknown };

/**
 * The free model the credential probe asks for.
 *
 * A probe is a real inference request, so it must not spend an account's paid credits — which means a
 * free, text model. The **choice is read from the catalog at check time**, preferring a zero-price text
 * model, because a pinned id rots: the reference project pinned `poolside/laguna-xs-2.1:free`, and by
 * 2026-11 that model answers `404 Model not found` while the listing carries two other free models. A
 * stale pin turns every credential check into "the key could not be verified", which is a false report
 * about a key that is fine.
 *
 * This constant is the fallback for when the catalog cannot be read at all; it is the current free model
 * at the time of writing, and it is not trusted over a live answer.
 */
export const NOUS_FALLBACK_VALIDATION_MODEL = 'upstage/solar-mini4:free';
/** How long a chosen probe model is reused before the public catalog is read again. */
const PROBE_MODEL_TTL_MS = 5 * 60_000;

/**
 * The attribution tags Nous requires on inference requests.
 *
 * The reference project measured the refusal: without a `user=` tag the inference host answers 400 with
 * "missing user tag", which our generic OpenAI wire never sends. The keys matter, not the product name —
 * we send our own. Applied only to the resolved Nous chat URL, never to a custom endpoint a user saved.
 */
const NOUS_ATTRIBUTION_TAGS = ['product=omnihilbras', 'client=omnihilbras', 'user=omnihilbras'] as const;

/**
 * Nous's reasoning wire shape.
 *
 * The generic OpenAI-compatible base sends `reasoning_effort` at the top level. Nous's own first-party
 * client sends a nested `reasoning: { enabled, effort }` — the API does not advertise the top-level field
 * for every model. Both rewrites live here: the shared vendored adapter gained only `protected` request
 * helpers in every copy, so a provider's wire rules stay in its own adapter rather than in shared code.
 */
function nousWireBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const tags = Array.isArray(out.tags) ? [...out.tags] : [];
  for (const fallback of NOUS_ATTRIBUTION_TAGS) {
    const prefix = fallback.slice(0, fallback.indexOf('=') + 1);
    // Keep a caller's non-empty value for a key; fill only the missing or blank ones. A blank value
    // does not satisfy the upstream requirement, which is why a presence check alone is not enough.
    const kept = tags.filter((tag) => typeof tag !== 'string' || !tag.startsWith(prefix) || tag.slice(prefix.length).trim().length > 0);
    if (!kept.some((tag) => typeof tag === 'string' && tag.startsWith(prefix))) kept.push(fallback);
    tags.length = 0;
    tags.push(...kept);
  }
  out.tags = [...new Set(tags)];
  const effort = out.reasoning_effort;
  if (typeof effort === 'string' && effort) {
    out.reasoning = { enabled: true, effort };
    delete out.reasoning_effort;
  }
  return out;
}

type NousRawModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown } | null;
  architecture?: { output_modalities?: unknown } | null;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
};

type NousCatalog = { data?: unknown };


/** Keep embeddings and image-only entries out of a chat model list; silence about modalities is not a refusal. */
function isTextCapable(model: NousRawModel): boolean {
  const modalities = model.architecture?.output_modalities;
  return !Array.isArray(modalities) || modalities.length === 0 || modalities.includes('text');
}

/**
 * Nous Research.
 *
 * ## Why this is an adapter and not one more generic endpoint
 *
 * Two facts about Nous make the generic OpenAI-compatible path wrong, and both come from the reference
 * project's own measurements:
 *
 * 1. **`/models` is public.** The generic adapter's credential check reads the catalog, so against Nous
 *    it reports *any* key — including a wrong one — as valid. Only a 1-token inference proves a Portal
 *    key, which is what `validateCredential` and `healthCheck` send here.
 * 2. **The catalog carries non-chat entries.** Embeddings and image-only models are advertised on the
 *    same `/models` response, so a generic import lists models whose requests cannot work.
 *
 * Everything else is the OpenAI wire format, so chat and streaming come from the shared base.
 */
export type NousAdapterOptions = OpenAICompatibleAdapterOptions & {
  baseUrl?: string;
  /** Called when an expired credential was renewed, so the gateway can store the replacement. */
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
};

export class NousAdapter extends OpenAICompatibleAdapter {
  // The same transport the gateway supplied, used by the probe — a request the generic base never makes.
  private readonly probeTransport: HttpTransport;
  private readonly chatUrl: string;
  private readonly modelsUrl: string;
  private readonly portalUrl = NOUS_PORTAL_BASE_URL;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  /** The probe model last read from the public catalog, and when. */
  private chosenProbeModel?: { id: string; at: number };
  /** A renewed OAuth credential, keyed by the token it replaced, so one expiry costs one renewal. */
  private readonly renewed = new Map<string, ProviderCredential>();

  constructor(options: NousAdapterOptions = {}) {
    const baseUrl = (options.baseUrl ?? NOUS_BASE_URL).replace(/\/$/, '');
    super(
      {
        id: nousProviderId,
        name: 'Nous Research',
        baseUrl,
        auth: { header: 'Authorization', prefix: 'Bearer' },
      },
      options,
    );
    this.probeTransport = options.transport ?? new FetchHttpTransport();
    this.chatUrl = `${baseUrl}/chat/completions`;
    this.modelsUrl = `${baseUrl}/models`;
    this.onTokensRefreshed = options.onTokensRefreshed;
  }

  /** Add the two Nous wire requirements to every inference body without changing the shared base. */
  protected toRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    return nousWireBody(super.toRequestBody(request, stream));
  }

  // ── sign-in ────────────────────────────────────────────────────────────────

  /**
   * Asks the portal for a device code.
   *
   * Form-encoded, not JSON: the reference project's client posts `client_id` and `scope` as a form and
   * the portal's own endpoints are read from that shape. Nothing here is a served substitute — if the
   * portal refuses, the refusal is the answer.
   */
  async beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn?: number }> {
    const { data } = await this.postForm<DeviceCodeAnswer>(NOUS_DEVICE_CODE_PATH, {
      client_id: NOUS_OAUTH_CLIENT_ID,
      scope: NOUS_OAUTH_SCOPE,
    });
    const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
    const userCode = typeof data.user_code === 'string' ? data.user_code : '';
    const given = typeof data.verification_uri_complete === 'string' && data.verification_uri_complete
      ? data.verification_uri_complete
      : typeof data.verification_uri === 'string' ? data.verification_uri : '';
    if (!deviceCode || !userCode) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'Nous did not return a device code. Try again in a moment.', {
        providerId: nousProviderId,
        publicMessage: 'Nous did not answer with a sign-in code. Try again.',
      });
    }
    return {
      deviceCode,
      userCode,
      verificationUrl: given || `${NOUS_PORTAL_BASE_URL}/device`,
      ...(typeof data.expires_in === 'number' ? { expiresIn: data.expires_in } : {}),
    };
  }

  /**
   * Polls the portal until the grant is approved, then mints the agent key.
   *
   * The poll reads the **body** whatever the status: a pending grant is `400
   * {"error":"authorization_pending"}` — data, not a failure — so the transport is asked for the refusal
   * body and the code decides the outcome. `slow_down` is a wait, not a denial.
   *
   * The agent key is best-effort, exactly as the reference project has it: the access token alone is a
   * valid bearer for inference, so a mint failure must not discard a sign-in that worked.
   */
  async pollSignIn(deviceCode: string, signal?: AbortSignal): Promise<
    | { status: 'pending' }
    | { status: 'denied'; error: string }
    | { status: 'connected'; credential: ProviderCredential; account: string }
  > {
    const { data } = await this.postFormAllowingRefusal<TokenAnswer>(NOUS_TOKEN_PATH, {
      grant_type: NOUS_DEVICE_GRANT,
      client_id: NOUS_OAUTH_CLIENT_ID,
      device_code: deviceCode,
    }, signal);

    const error = typeof data.error === 'string' ? data.error : '';
    if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
    if (error) {
      const description = typeof data.error_description === 'string' ? data.error_description : '';
      return { status: 'denied', error: description || `Nous reported ${error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}.` };
    }
    const access = typeof data.access_token === 'string' ? data.access_token : '';
    if (!access) return { status: 'denied', error: 'Nous did not return a session. Start the sign-in again.' };

    const minted = await this.mintAgentKey(access, signal);
    return {
      status: 'connected',
      account: 'Nous Research',
      credential: {
        type: 'oauth',
        // The agent key is what the inference host accepts as a bearer; the access token is the fallback.
        value: minted?.apiKey ?? access,
        ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
        expiresAt: minted?.expiresAt ?? (typeof data.expires_in === 'number'
          ? new Date(Date.now() + data.expires_in * 1000).toISOString()
          : new Date(Date.now() + 3600 * 1000).toISOString()),
        oauthClientId: NOUS_OAUTH_CLIENT_ID,
      },
    };
  }

  /** Whether a stored credential is already past its stated expiry — answered without a request. */
  isCredentialExpired(credential: ProviderCredential | undefined, now = Date.now()): boolean | undefined {
    if (credential?.type !== 'oauth') return undefined;
    if (!credential.expiresAt) return undefined;
    const expiry = Date.parse(credential.expiresAt);
    if (Number.isNaN(expiry)) return undefined;
    return expiry - EXPIRY_SKEW_MS <= now;
  }

  /**
   * The catalog, reduced to chat models and their stated facts.
   *
   * `context_length` is read from either the top level or `top_provider`, because the API has been seen
   * to use both. Prices are converted from per-token to per-1M, which is the unit the dashboard shows —
   * a zero stays zero, so a free model is recognisably free rather than an absent price.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const { data } = await this.probeTransport.request<NousCatalog>({
      method: 'GET',
      providerId: nousProviderId,
      url: this.modelsUrl,
      headers: {
        accept: 'application/json',
        ...(credential && 'value' in credential && credential.value ? { Authorization: `Bearer ${credential.value}` } : {}),
      },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const raw = (data as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(raw)) throw new ProviderError('INVALID_RESPONSE', 'Nous returned a model list without data.', { providerId: nousProviderId });

    const models = raw.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const model = entry as NousRawModel;
      if (!isTextCapable(model)) return [];
      const id = typeof model.id === 'string' ? model.id.trim() : '';
      if (!id) return [];
      // The generic mapper reads every field Nous publishes — price, context, max output, dates,
      // aliases, supported parameters — instead of the five this adapter used to keep. Text capability
      // is still checked here: a catalog entry that cannot answer a chat request is not a chat model.
      return [normalizeCatalogModel({ ...model, id }, nousProviderId) satisfies Model];
    });

    // First-party models first, preserving the catalog's order inside each group (sort is stable).
    return models.sort((a, b) => Number(!a.id.startsWith('nousresearch/')) - Number(!b.id.startsWith('nousresearch/')));
  }

  /**
   * Proves the key with one authenticated inference request, not by reading the public catalog.
   *
   * The rules are the reference project's, and each covers a different answer from Nous:
   * a 2xx is the only proof; 401/403 names the key as refused; anything else means the request could not
   * settle the question — which is stated as such rather than reported as a bad key.
   */
  async validateCredential(
    credential: ProviderCredential | undefined,
    context: ProviderRequestContext = {},
  ): Promise<CredentialValidation> {
    const resolved = await this.credential({ ...context, ...(credential ? { credential } : {}) }).catch(() => credential);
    const value = resolved && 'value' in resolved ? resolved.value : undefined;
    if (typeof value !== 'string' || !value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Enter a Nous Research API key.', {
        providerId: nousProviderId,
        publicMessage: 'Enter a Nous Research API key. Create one at portal.nousresearch.com/api-keys.',
      });
    }
    const startedAt = performance.now();
    const model = await this.probeModel(context.signal);
    try {
      await this.probeTransport.request({
        method: 'POST',
        providerId: nousProviderId,
        url: this.chatUrl,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: `Bearer ${value}`,
        },
        body: JSON.stringify(nousWireBody({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        })),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      // The status is read off the refusal the transport raised — it is the whole question this probe
      // asks. A 401/403 is the key being refused; any other status means Nous could not answer, which is
      // a different fact and says so.
      //
      // Read **structurally**, not with `instanceof ProviderError`. The transport is supplied by the
      // hosting gateway, which has its own copy of this SDK's `lib/`, and an error thrown by that copy is
      // not an instance of this file's class — `instanceof` returned false and the 401 was reported as
      // "could not verify (no status)", which is a false statement about a refused key. Measured by
      // saving a bogus key through the dashboard against a live gateway.
      const status = error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : undefined;
      if (status === 404) {
        // The probe named a model Nous no longer lists. That is a fact about the catalog, not about the
        // key, and saying "bad key" here would send the user to rotate a working credential.
        this.chosenProbeModel = undefined;
        throw new ProviderError('PROVIDER_UNAVAILABLE', `The Nous Research probe model ${model} is no longer listed.`, {
          providerId: nousProviderId,
          publicMessage: `The key could not be verified: the free probe model ${model} is no longer in Nous's catalog. Nothing is wrong with the key as far as this check can tell.`,
        });
      }
      if (status === 401 || status === 403) {
        throw new ProviderError('AUTHENTICATION_FAILED', 'Invalid or inactive Nous Research API key.', {
          providerId: nousProviderId,
          publicMessage: 'Nous Research refused this key. Create a new one at portal.nousresearch.com/api-keys.',
        });
      }
      throw new ProviderError('PROVIDER_UNAVAILABLE', `Unable to verify the Nous Research key (Nous returned ${status ?? 'no status'}).`, {
        providerId: nousProviderId,
        publicMessage: `The key could not be verified${status ? `: Nous answered ${status}` : ''}. The key was not saved.`,
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  /** Chat, after making sure the credential still is one. */
  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    return super.chat(request, { ...context, credential: this.asRequestCredential(await this.credential(context)) });
  }

  /**
   * Nous reasoning streams need their own reader.
   *
   * The generic base counts a delta as meaningful only when it carries role, content, tool calls,
   * finish reason or usage. Nous reasoning models often emit only `reasoning_content` for a long stretch,
   * and an agent tool round can end with reasoning and no answer text. The base threw `INVALID_RESPONSE`
   * ("stream ended before completion") for that, and dropped the reasoning even when it did arrive.
   * Here reasoning is meaningful, is forwarded in `delta.reasoning`, and a reasoning-only ending produces
   * one explicit empty text chunk with `finishReason: stop` — an honest empty answer, not a broken stream.
   * A stream with no payload at all, or no `[DONE]`, is still an invalid response.
   */
  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<NousChunk> {
    const events = this.transport.stream({
      method: 'POST',
      providerId: nousProviderId,
      url: this.chatUrl,
      headers: this.requestHeaders(this.asRequestCredential(await this.credential(context)), 'text/event-stream'),
      body: JSON.stringify(this.toRequestBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    let sawMeaningfulPayload = false;
    let sawReasoning = false;
    let sawText = false;
    let sawDone = false;

    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      const payload = parseSseJson<NousStreamChunk>(event, nousProviderId);
      if (!payload) continue;
      sawPayload = true;
      if (payload.error) throw nousStreamError(payload.error);

      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      const reasoning = nousReasoningText(delta);
      if (reasoning) sawReasoning = true;
      if (reasoning || delta?.role || delta?.content || delta?.tool_calls?.length || choice?.finish_reason || payload.usage) {
        sawMeaningfulPayload = true;
      }
      if (delta?.content) sawText = true;
      yield {
        id: payload.id ?? `stream-${request.model}`,
        providerId: nousProviderId,
        model: payload.model ?? request.model,
        delta: {
          ...(delta?.role ? { role: nousRole(delta.role) } : {}),
          ...(delta?.content ? { content: delta.content } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(delta?.tool_calls?.length ? { toolCalls: delta.tool_calls.map(nousToolCallDelta) } : {}),
        },
        ...(choice?.finish_reason ? { finishReason: nousFinishReason(choice.finish_reason) } : {}),
        ...(payload.usage ? { usage: nousUsage(payload.usage) } : {}),
      };
    }

    if (!sawPayload || !sawMeaningfulPayload || !sawDone) {
      throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before completion.', { providerId: nousProviderId });
    }
    if (sawReasoning && !sawText) {
      // The turn really answered — with thinking only. An empty text chunk says that plainly instead of
      // leaving the client waiting for a content block that will never arrive.
      yield {
        id: `stream-${request.model}`,
        providerId: nousProviderId,
        model: request.model,
        delta: { content: '' },
        finishReason: 'stop',
      };
    }
  }

  /**
   * The credential as the shared base needs to see it.
   *
   * The base sends its auth header **only** for an `api-key` credential, and that is right for it: an
   * OAuth token usually needs a different header or a different endpoint. Nous is the case where it does
   * not — the agent key minted from the sign-in is the same `Authorization: Bearer` an API key is — so the
   * shape is stated for the request and never stored. Without this, a signed-in connection failed with
   * "Missing API key for provider nous" while holding a perfectly good bearer.
   */
  private asRequestCredential(credential: ProviderCredential | undefined): ProviderCredential | undefined {
    if (credential && 'value' in credential && typeof credential.value === 'string' && credential.value) {
      return { type: 'api-key', value: credential.value };
    }
    return credential;
  }

  /**
   * The scheduler's entry point: the same renewal a request performs, reachable without one.
   *
   * The value returned is what the vault stores, so a rotated refresh token survives a restart. Nous renews in
   * two steps — a portal refresh and a fresh agent key minted from it — and `credential()` returns undefined only
   * for an absent argument, which this rules out, so the throw below is a type obligation rather than a branch a
   * caller should expect.
   */
  async renewCredential(credential: ProviderCredential): Promise<ProviderCredential> {
    if (credential.type !== 'oauth' || !credential.refreshToken) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The Nous Research session cannot be renewed. Sign in again.', {
        providerId: nousProviderId,
        publicMessage: 'The Nous Research session cannot be renewed. Sign in again.',
      });
    }
    const renewed = await this.credential({ credential });
    if (!renewed) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The Nous Research session has expired. Sign in again.', {
        providerId: nousProviderId,
        publicMessage: 'The Nous Research session has expired. Sign in again.',
      });
    }
    return renewed;
  }

  /**
   * The credential to use, renewed if it has expired.
   *
   * An OAuth session is two tokens: the portal's access/refresh pair, and the agent key minted from it.
   * The stored `value` is the agent key (what the inference host accepts) and `refreshToken` is the
   * portal's — so renewal is a refresh **and** a fresh mint, which is what the reference project does.
   * A renewal is memoised by the token it replaced, so one expiry costs one round trip rather than one
   * per request.
   */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential | undefined> {
    const current = context.credential;
    if (!this.isCredentialExpired(current)) return current;
    const refresh = current?.type === 'oauth' ? current.refreshToken : undefined;
    if (typeof refresh !== 'string' || !refresh) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The Nous Research session has expired. Sign in again.', {
        providerId: nousProviderId,
        publicMessage: 'The Nous Research session has expired. Sign in again.',
      });
    }
    const replaced = current?.type === 'oauth' ? current.value : '';
    const memo = this.renewed.get(replaced);
    if (memo) return memo;

    const { data } = await this.postFormAllowingRefusal<TokenAnswer>(NOUS_TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: NOUS_OAUTH_CLIENT_ID,
    }, context.signal);
    const access = typeof data.access_token === 'string' ? data.access_token : '';
    if (!access) {
      const description = typeof data.error_description === 'string' ? data.error_description : '';
      throw new ProviderError('AUTHENTICATION_FAILED', description || 'Nous refused to renew the session. Sign in again.', {
        providerId: nousProviderId,
        publicMessage: description || 'Nous refused to renew the session. Sign in again.',
      });
    }
    const minted = await this.mintAgentKey(access, context.signal);
    const renewed: ProviderCredential = {
      type: 'oauth',
      value: minted?.apiKey ?? access,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : refresh,
      expiresAt: minted?.expiresAt ?? (typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString()),
      oauthClientId: NOUS_OAUTH_CLIENT_ID,
    };
    this.renewed.set(replaced, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }

  /**
   * Exchanges an access token for an agent key — best-effort, exactly as the reference project has it.
   * A mint that fails leaves the access token as the bearer, because that is still a valid credential and
   * discarding a working sign-in over a short-lived convenience token would be the wrong trade.
   */
  private async mintAgentKey(accessToken: string, signal?: AbortSignal): Promise<{ apiKey?: string; expiresAt?: string } | undefined> {
    try {
      const { status, data } = await this.probeTransport.request<AgentKeyAnswer>({
        method: 'POST',
        providerId: nousProviderId,
        url: `${this.portalUrl}${NOUS_AGENT_KEY_PATH}`,
        headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ min_ttl_seconds: 7200 }),
        tolerateRefusalBody: true,
        ...(signal ? { signal } : {}),
      });
      if (status < 200 || status >= 300) return undefined;
      const apiKey = typeof data.api_key === 'string' && data.api_key ? data.api_key : undefined;
      const expiresAt = typeof data.expires_at === 'string' && data.expires_at
        ? (Number.isNaN(Date.parse(data.expires_at)) ? undefined : new Date(data.expires_at).toISOString())
        : typeof data.expires_in === 'number' ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined;
      return {
        ...(apiKey ? { apiKey } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async postForm<T>(path: string, fields: Record<string, string>): Promise<{ data: T }> {
    const { data } = await this.probeTransport.request<T>({
      method: 'POST',
      providerId: nousProviderId,
      url: `${this.portalUrl}${path}`,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    return { data };
  }

  private async postFormAllowingRefusal<T>(path: string, fields: Record<string, string>, signal?: AbortSignal): Promise<{ data: T; status: number }> {
    return this.probeTransport.request<T>({
      method: 'POST',
      providerId: nousProviderId,
      url: `${this.portalUrl}${path}`,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      tolerateRefusalBody: true,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * The model to probe with: a free text model from the **public** catalog, cached briefly.
   *
   * Only a zero-price model is eligible — the probe is a real request — and the catalog read is public,
   * so this adds no credential and no cost. If the catalog cannot be read, the fallback constant is used
   * and a 404 from it is reported as a catalog problem rather than an auth verdict.
   */
  private async probeModel(signal?: AbortSignal): Promise<string> {
    const cached = this.chosenProbeModel;
    if (cached && Date.now() - cached.at < PROBE_MODEL_TTL_MS) return cached.id;
    try {
      const models = await this.listModels(signal ? { signal } : {});
      // A `:free` id is Nous's own statement of a free-tier model; a zero price is the same fact stated
      // in the pricing block. Prefer the explicit suffix, then the price. Measured live on 2026-11-07:
      // 357 chat models, 5 at zero price, 2 of them carrying `:free` — the suffix is the narrower set.
      const free = models.find((entry) => entry.id.endsWith(':free') && entry.pricing?.inputPer1M === 0 && entry.pricing?.outputPer1M === 0)
        ?? models.find((entry) => entry.pricing?.inputPer1M === 0 && entry.pricing?.outputPer1M === 0)
        ?? models.find((entry) => entry.id.endsWith(':free'));
      if (free) {
        this.chosenProbeModel = { id: free.id, at: Date.now() };
        return free.id;
      }
    } catch {
      // A catalog that will not read does not answer the credential question; the fallback does.
    }
    return NOUS_FALLBACK_VALIDATION_MODEL;
  }

  /**
   * A health poll that states the stronger scope, because it really ran one inference request.
   *
   * The generic base reports `verified: 'credential'` from a catalog read, which against Nous is not even
   * a credential check — the catalog is public. This sends the same 1-token probe, so `inference` is the
   * fact it established. A refusal is still an inference attempt, so the scope does not shrink on failure.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    const credential = await this.credential(context).catch(() => context.credential);
    const value = credential && 'value' in credential ? credential.value : undefined;
    if (typeof value !== 'string' || !value) {
      return {
        status: 'unavailable',
        verified: 'inference',
        checkedAt: new Date().toISOString(),
        message: 'No Nous Research key is saved for this connection.',
      };
    }
    try {
      await this.validateCredential(credential, context);
      return {
        status: 'healthy',
        verified: 'inference',
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'inference',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The health check failed without a reason.',
      };
    }
  }
}

/** The streamed chunk this adapter emits: the gateway's shape plus the reasoning delta it forwards. */
type NousChunk = ChatChunk & { delta: ChatChunk['delta'] & { reasoning?: string } };

type NousStreamChunk = {
  id?: string;
  model?: string;
  error?: { message?: unknown; error?: { message?: unknown } };
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      /** Nous's first-party field, and the alternate spelling some gateways emit. */
      reasoning_content?: string;
      reasoning?: string | { content?: string; text?: string; summary?: string };
      tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

function nousReasoningText(delta: NonNullable<NonNullable<NousStreamChunk['choices']>[number]['delta']> | undefined): string | undefined {
  if (!delta) return undefined;
  const direct = typeof delta.reasoning_content === 'string' && delta.reasoning_content ? delta.reasoning_content : undefined;
  if (direct) return direct;
  const nested = delta.reasoning;
  if (typeof nested === 'string') return nested || undefined;
  if (nested && typeof nested === 'object') {
    const text = nested.content ?? nested.text ?? nested.summary;
    return typeof text === 'string' && text ? text : undefined;
  }
  return undefined;
}

function nousRole(role: string) {
  return role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user';
}

function nousFinishReason(reason: string): FinishReason {
  if (reason === 'stop' || reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') return reason;
  if (reason === 'function_call') return 'tool_calls';
  return 'other';
}

function nousToolCallDelta(call: NonNullable<NonNullable<NonNullable<NousStreamChunk['choices']>[number]['delta']>['tool_calls']>[number]): ToolCallDelta {
  return {
    index: call.index ?? 0,
    ...(call.id ? { id: call.id } : {}),
    ...(call.type ? { type: 'function' as const } : {}),
    ...(call.function?.name || call.function?.arguments ? { function: {
      ...(call.function.name ? { name: call.function.name } : {}),
      ...(call.function.arguments ? { arguments: call.function.arguments } : {}),
    } } : {}),
  };
}

function nousUsage(usage: NonNullable<NousStreamChunk['usage']>): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.prompt_tokens_details.cached_tokens }),
    ...(usage.completion_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }),
  };
}

function nousStreamError(error: unknown) {
  const payload = error as { message?: unknown; error?: { message?: unknown } } | undefined;
  const detail = typeof payload?.error?.message === 'string' ? payload.error.message : typeof payload?.message === 'string' ? payload.message : '';
  return new ProviderError('PROVIDER_REQUEST_FAILED', detail ? `The provider stream returned an error: ${detail}` : 'The provider stream returned an error.', { providerId: nousProviderId });
}

export * from '@omnihilbras/sdk-shared/openai-compatible';