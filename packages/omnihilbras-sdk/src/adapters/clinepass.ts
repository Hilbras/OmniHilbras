import { ProviderError } from '../errors.js';
import { FetchHttpTransport } from '../transport.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { CLINE_OAUTH, clineHeaders, toClineAccessToken, unwrapClineEnvelope } from './cline.js';
import type { HttpTransport } from '../transport.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext } from '../types.js';

/**
 * ClinePass is Cline's paid model tier, reached with a plain API key.
 *
 * ## What the vendor source actually says, and what it does not
 *
 * Cline's own client registers two providers, `cline` and `cline-pass`, and the comment beside them
 * is explicit: *"Both Cline gateway providers share this AI SDK provider and the same Cline API."*
 * Same host (`https://api.cline.bot/api/v1`), same `Authorization: Bearer`, the same client headers.
 * The only thing that distinguishes a ClinePass request is the `cline-pass/` model prefix, and
 * whether the account is entitled to it.
 *
 * So this adapter is deliberately thin. It is **not** an OAuth adapter — there is no authorization-code
 * flow for a ClinePass key, and `cline-pass` is registered in Cline's auth registry as an alias of the
 * `cline` handler reusing the identical stored credential, so a sign-in button here would be a second
 * way to hold a token that ClinePass does not need. It is **not** a web-cookie adapter either: nothing
 * in Cline's SDK reads a cookie, and `app.cline.bot` is only ever opened in a real browser.
 *
 * The key comes from Settings → API Keys on app.cline.bot, which is what Cline's own documentation
 * tells a non-Cline client to do.
 */

/** The model prefix that is ClinePass. Everything else on this host is the free tier. */
export const CLINE_PASS_MODEL_PREFIX = 'cline-pass/';

export type ClinePassAdapterOptions = {
  transport?: HttpTransport;
  userAgent?: string;
};

export class ClinePassAdapter implements ProviderAdapter {
  readonly id = 'clinepass';
  readonly name = 'ClinePass';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  private readonly transport: HttpTransport;
  private readonly delegate: OpenAICompatibleAdapter;
  private readonly userAgent: string;

  constructor(options: ClinePassAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchHttpTransport();
    this.userAgent = options.userAgent ?? 'omnihilbras';
    this.delegate = new OpenAICompatibleAdapter(
      {
        id: this.id,
        name: this.name,
        baseUrl: CLINE_OAUTH.apiBasePath,
        auth: { header: 'Authorization', prefix: 'Bearer' },
        // No `Authorization` here: `clineHeaders('')` omits it, and the delegate fills the header in
        // from the credential. Sending both would mean the static copy is the one that wins.
        headers: clineHeaders('', {}, this.userAgent),
        unwrapResponse: (body) => unwrapClineEnvelope(body, { providerId: this.id, label: this.name }),
      },
      { transport: this.transport },
    );
  }

  /**
   * A ClinePass key does not expire, so this is `undefined` — "cannot say" — and never `false`.
   * The two look identical to the caller and only one of them is honest; `false` would let a revoked
   * key look healthy for as long as the gateway ran.
   */
  isCredentialExpired(): undefined {
    return undefined;
  }

  /**
   * Confirms the key against `/users/me`, which is the one Cline endpoint that checks a credential.
   *
   * **This proves the key is live and nothing more.** Whether it may use a given model is decided
   * server-side per request, from the subscription, and Cline states it in the response body
   * ("no access to clinepass subscription models yet"). There is no endpoint that answers "is this
   * subscription current", so a green result here must not be reported as an entitlement check.
   */
  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const key = this.requireKey(credential);
    const startedAt = Date.now();
    await this.transport.request<unknown>({
      method: 'GET',
      providerId: this.id,
      url: CLINE_OAUTH.accountUrl,
      headers: clineHeaders(key, { accept: 'application/json' }, this.userAgent),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  }

  /**
   * Lists only the ClinePass models.
   *
   * The endpoint returns the whole Cline catalog to a ClinePass key, so an unfiltered list would offer
   * a model this connection is not entitled to and fail on first use with a message about
   * subscriptions. Filtering makes the connection mean one thing before the request is ever sent.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const models = await this.delegate.listModels(this.context(this.requireKey(context.credential)));
    return models.filter((model) => model.id.startsWith(CLINE_PASS_MODEL_PREFIX));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    return this.delegate.chat(request, this.context(this.requireKey(context.credential)));
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    yield* this.delegate.streamChat(request, this.context(this.requireKey(context.credential)));
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const result = await this.validateCredential(context.credential ?? { type: 'api-key', value: '' }, context);
      return { status: 'healthy', verified: 'credential', checkedAt: result.checkedAt, latencyMs: result.latencyMs ?? Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: clinePassFailureReason(error),
      };
    }
  }

  private context(key: string): ProviderRequestContext {
    return { credential: { type: 'api-key', value: toClineAccessToken(key) } };
  }

  private requireKey(credential: ProviderCredential | undefined): string {
    if (!credential || credential.type === 'none' || !credential.value) {
      const message = 'A ClinePass API key is required.';
      throw new ProviderError('AUTHENTICATION_FAILED', message, { providerId: this.id, publicMessage: message });
    }
    return credential.value;
  }
}

/**
 * A short, safe explanation of why a ClinePass call failed.
 *
 * Separate from `clineFailureReason` rather than shared with it, because "Sign in again" is the wrong
 * instruction for a provider that has no sign-in here: the remedy is to check the key, or to check the
 * subscription, and those are different actions.
 */
export function clinePassFailureReason(error: unknown): string {
  if (error instanceof ProviderError) {
    const details = error.details as { providerMessage?: string } | undefined;
    const reason = typeof details?.providerMessage === 'string' ? details.providerMessage : undefined;
    if (error.code === 'AUTHENTICATION_FAILED') {
      return reason ? `ClinePass rejected the key: ${reason}` : 'ClinePass rejected the key.';
    }
    if (error.code === 'CANCELLED') return 'The health check was cancelled.';
    if (error.code === 'PROVIDER_TIMEOUT') return 'ClinePass did not answer in time.';
    if (error.code === 'PROVIDER_UNAVAILABLE') return 'ClinePass could not be reached.';
    return reason ? `${error.code}: ${reason}` : `${error.code}.`;
  }
  return 'The ClinePass health check failed.';
}
