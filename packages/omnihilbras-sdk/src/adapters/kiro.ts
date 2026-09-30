import { ProviderError } from '../errors.js';
import { FetchHttpTransport } from '../transport.js';
import type { HttpTransport } from '../transport.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, MessageContent, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext } from '../types.js';

/**
 * Kiro.
 *
 * Kiro signs in through AWS SSO's OIDC device flow rather than a provider-specific one,
 * and once signed in it is not an OpenAI-compatible endpoint at all: it is CodeWhisperer's
 * streaming service, which takes a `conversationState` envelope and answers with an AWS
 * eventstream. So there is no generic adapter to point at this, and the translation below
 * is the whole integration.
 *
 * The auth half is a public OAuth client registered on demand, so nothing secret is
 * embedded here — the same shape as the OpenCode Console device flow.
 */
export const KIRO = {
  /** AWS SSO OIDC, where the device flow lives. */
  oidc: 'https://oidc.us-east-1.amazonaws.com',
  clientName: 'kiro-oauth-client',
  clientType: 'public',
  scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
  grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c',
  /** Where the user approves the device. */
  startUrl: 'https://view.awsapps.com/start',
  /** CodeWhisperer's streaming service, which is what actually answers. */
  inferenceUrl: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
  streamingTarget: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
  userAgent: 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
  amzUserAgent: 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
  eventStreamAccept: 'application/vnd.amazon.eventstream',
} as const;

export const kiroProviderId = 'kiro';

/**
 * Kiro's catalog. Ids must match its upstream exactly — an unknown id is refused with
 * `400 Invalid model. Please select a different model`, and there is no wildcard or
 * `auto` id to fall back on.
 */
/**
 * The catalog.
 *
 * Kiro publishes no model list over the API, so this is a published set rather than a
 * discovered one, and availability is per account: Kiro answers
 * `400 Invalid model. Please select a different model` for an id the signed-in plan does
 * not carry. That is the account's entitlement, not a broken connection, so it is surfaced
 * as itself and a model id is still the only thing that can be sent.
 */
export const KIRO_MODELS: ReadonlyArray<{ id: string; name: string; contextWindow?: number; maxOutputTokens?: number }> = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 64_000 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutputTokens: 64_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 272_000, maxOutputTokens: 128_000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272_000, maxOutputTokens: 128_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272_000, maxOutputTokens: 128_000 },
  { id: 'deepseek-3.2', name: 'DeepSeek V3.2' },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
  { id: 'minimax-m2.1', name: 'MiniMax M2.1' },
  { id: 'glm-5', name: 'GLM-5' },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' },
];

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export type KiroDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  /** Absolute, because AWS returns this relative on some regions. */
  verificationUrl: string;
  intervalSeconds: number;
  expiresIn?: number;
  clientId: string;
  clientSecret: string;
};

type Json = Record<string, unknown>;

/**
 * OAuth token endpoints are read directly rather than through the provider transport.
 *
 * The transport deliberately flattens an error body into a human sentence, and for a
 * device grant the machine token *is* the state: AWS answers a pending poll with
 * `400 {"error":"authorization_pending","error_description":"Authorization is still
 * pending"}`, and the flattened detail keeps only the description, so the grant reads as
 * a failure. Inference still goes through the transport, where that flattening is what we
 * want.
 */
async function postAuthJson<T>(url: string, body: Json): Promise<{ status: number; data: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: T;
  try {
    data = (text ? JSON.parse(text) : {}) as T;
  } catch {
    data = { error: 'invalid_response', error_description: text.slice(0, 200) } as unknown as T;
  }
  return { status: response.status, data };
}

/** Registers the public client the device flow needs. Nothing secret is embedded. */
export async function registerKiroClient(): Promise<{ clientId: string; clientSecret: string }> {
  const { data } = await postAuthJson<Json>(`${KIRO.oidc}/client/register`, {
    clientName: KIRO.clientName,
    clientType: KIRO.clientType,
    scopes: [...KIRO.scopes],
    grantTypes: [...KIRO.grantTypes],
    issuerUrl: KIRO.issuerUrl,
  });
  const clientId = typeof data.clientId === 'string' ? data.clientId : '';
  const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret : '';
  if (!clientId || !clientSecret) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'AWS did not return a client registration for Kiro.', {
      providerId: kiroProviderId,
      publicMessage: 'AWS did not return a client registration for Kiro. Try again in a moment.',
    });
  }
  return { clientId, clientSecret };
}

/**
 * A company IAM Identity Center start URL, as an enterprise sign-in supplies it.
 *
 * Only `*.awsapps.com` is accepted. That is not a general URL check for its own sake:
 * this value is sent to AWS as the `startUrl` of a device grant, so an unvalidated value
 * would turn the sign-in dialog into an open redirect carrying a user's approval.
 */
export function isKiroStartUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === 'awsapps.com' || host.endsWith('.awsapps.com');
}

/** Asks AWS for a device code the user approves in a browser. */
export async function beginKiroSignIn(startUrl: string = KIRO.startUrl): Promise<KiroDeviceAuthorization> {
  if (!isKiroStartUrl(startUrl)) {
    throw new ProviderError('INVALID_REQUEST', 'That start URL is not an AWS IAM Identity Center URL.', {
      providerId: kiroProviderId,
      publicMessage: 'That start URL is not an AWS IAM Identity Center URL. It should look like https://your-org.awsapps.com/start.',
    });
  }
  const { clientId, clientSecret } = await registerKiroClient();
  // AWS refuses the request without the start URL, answering
  // `400 Start URL is required`, so it is part of the grant rather than a preference.
  const { status, data } = await postAuthJson<Json>(`${KIRO.oidc}/device_authorization`, { clientId, clientSecret, startUrl });
  const deviceCode = typeof data.deviceCode === 'string' ? data.deviceCode : '';
  const userCode = typeof data.userCode === 'string' ? data.userCode : '';
  if (!deviceCode || !userCode) {
    /**
     * AWS's own reason is carried through, because "it did not work" is useless to
     * somebody who just typed their company's start URL. A start URL on a real
     * `awsapps.com` host that AWS rejects is almost always a typo in the organisation
     * name, and AWS says so: `Invalid start url provided`.
     */
    const detail = typeof data.error_description === 'string' ? data.error_description : '';
    const saysInvalidStartUrl = typeof data.error === 'string' && data.error === 'invalid_request';
    throw new ProviderError('AUTHENTICATION_FAILED', detail || `AWS did not return a Kiro device code (HTTP ${status}).`, {
      providerId: kiroProviderId,
      publicMessage: saysInvalidStartUrl
        ? 'AWS does not recognise that start URL. Check the organisation name in it, and that it ends in /start.'
        : detail || 'AWS did not return a Kiro device code. Try again in a moment.',
    });
  }
  const verificationUri = typeof data.verificationUri === 'string' ? data.verificationUri : startUrl;
  return {
    deviceCode,
    userCode,
    /**
     * The approval page a company start URL leads to is on that company's own domain, not
     * on `view.awsapps.com`. AWS returns an absolute URI in that case and it is used as
     * given; only a relative one is joined, and to the start URL that produced it.
     */
    verificationUrl: verificationUri.startsWith('http') ? verificationUri : joinVerificationUrl(startUrl, verificationUri),
    intervalSeconds: typeof data.interval === 'number' ? data.interval : 5,
    clientId,
    clientSecret,
    ...(typeof data.expiresIn === 'number' ? { expiresIn: data.expiresIn } : {}),
  };
}

function joinVerificationUrl(startUrl: string, path: string): string {
  try {
    return new URL(path, startUrl).toString();
  } catch {
    return startUrl;
  }
}

/* ------------------------------------------------------------------ *
 * Social sign-in
 * ------------------------------------------------------------------ */

/**
 * The social flow (Google, GitHub) is a different service from the AWS one: Kiro's own
 * auth host, not `oidc.*.amazonaws.com`.
 */
export const KIRO_SOCIAL = {
  authHost: 'https://prod.us-east-1.auth.desktop.kiro.dev',
  /**
   * The callback is a custom scheme, not a web URL, and it cannot be changed: Kiro's
   * identity provider only has this one redirect registered. A browser will therefore not
   * return to OmniHilbras — it hands the code to the Kiro desktop app — so the code has to
   * be pasted back in. That is a property of the provider, not a gap in this flow, and the
   * dialog says so rather than opening a tab that silently fails.
   */
  redirectUri: 'kiro://kiro.kiroAgent/authenticate-success',
} as const;

export type KiroSocialProvider = 'google' | 'github';

function socialIdp(provider: KiroSocialProvider): 'Google' | 'Github' {
  return provider === 'google' ? 'Google' : 'Github';
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The PKCE pair for a social sign-in. The verifier never leaves the gateway.
 *
 * The challenge is the real S256 digest of the verifier, per RFC 7636 — an identity
 * provider that checks it would reject anything else, and one that does not check it still
 * costs nothing.
 */
export async function createKiroPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * The URL the user opens to sign in with Google or GitHub.
 *
 * `state` is checked on the way back, so a code cannot be pasted from somewhere else.
 */
export function buildKiroSocialUrl(provider: KiroSocialProvider, codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    idp: socialIdp(provider),
    redirect_uri: KIRO_SOCIAL.redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  return `${KIRO_SOCIAL.authHost}/login?${params.toString()}`;
}

export type KiroSocialSession = {
  provider: KiroSocialProvider;
  verifier: string;
  state: string;
  createdAt: number;
};

/** Exchanges a pasted authorization code for a Kiro session. */
export async function exchangeKiroSocialCode(session: KiroSocialSession, code: string): Promise<ProviderCredential> {
  const trimmed = code.trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the code Kiro showed you.', {
      providerId: kiroProviderId,
      publicMessage: 'Paste the code Kiro showed you.',
    });
  }
  // The same `redirect_uri` as the authorize request, or the exchange is refused.
  const { data } = await postAuthJson<Json>(`${KIRO_SOCIAL.authHost}/oauth/token`, {
    code: trimmed,
    code_verifier: session.verifier,
    redirect_uri: KIRO_SOCIAL.redirectUri,
  });
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!accessToken) {
    const detail = typeof data.error_description === 'string' ? data.error_description : '';
    throw new ProviderError('AUTHENTICATION_FAILED', detail || 'Kiro did not accept that code.', {
      providerId: kiroProviderId,
      publicMessage: detail || 'Kiro did not accept that code. Codes expire quickly — sign in again.',
    });
  }
  const expiresIn = typeof data.expiresIn === 'number' ? data.expiresIn : undefined;
  return {
    type: 'oauth',
    value: accessToken,
    ...(typeof data.refreshToken === 'string' ? { refreshToken: data.refreshToken } : {}),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
    ...(typeof data.profileArn === 'string' && data.profileArn ? { accountId: data.profileArn } : {}),
  };
}

/** A social session is short: the code it is waiting for expires within minutes. */
export const kiroSocialTtlMs = 10 * 60_000;

export function kiroSocialSessionExpired(session: KiroSocialSession, now = Date.now()): boolean {
  return now - session.createdAt > kiroSocialTtlMs;
}

/** A random, unguessable `state` for one social sign-in. */
export function newKiroSocialState(): string {
  return base64Url(globalThis.crypto.getRandomValues(new Uint8Array(24)));
}

export type KiroPoll =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | {
      status: 'connected';
      accessToken: string;
      refreshToken?: string;
      expiresIn?: number;
      profileArn?: string;
      /**
       * The registered client the grant was issued to. It is bound to the refresh token,
       * so a later renewal has to present the same pair or AWS answers `invalid_client`.
       */
      clientId: string;
      clientSecret: string;
    };

/**
 * Polls for the token. A pending answer is HTTP 400 with `authorization_pending` in the
 * body, so the status is read from the payload rather than treated as a failure.
 */
export async function pollKiroSignIn(
  authorization: Pick<KiroDeviceAuthorization, 'deviceCode' | 'clientId' | 'clientSecret'>,
): Promise<KiroPoll> {
  const { data } = await postAuthJson<Json>(`${KIRO.oidc}/token`, {
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    deviceCode: authorization.deviceCode,
    clientId: authorization.clientId,
    clientSecret: authorization.clientSecret,
  });

  // A pending grant is HTTP 400 with the state in the body, so the body decides.
  const error = typeof data.error === 'string' ? data.error : '';
  if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
  if (error) {
    const description = typeof data.error_description === 'string' ? data.error_description : '';
    return { status: 'denied', error: description || `AWS reported ${error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}.` };
  }
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!accessToken) {
    return { status: 'denied', error: 'AWS returned a Kiro session with no access token. Start again.' };
  }
  return {
    status: 'connected',
    accessToken,
    ...(typeof data.refreshToken === 'string' ? { refreshToken: data.refreshToken } : {}),
    ...(typeof data.expiresIn === 'number' ? { expiresIn: data.expiresIn } : {}),
    ...(typeof data.profileArn === 'string' && data.profileArn ? { profileArn: data.profileArn } : {}),
    clientId: authorization.clientId,
    clientSecret: authorization.clientSecret,
  };
}

/**
 * Wraps a pasted API key as a credential.
 *
 * It is stored as a bearer credential with no refresh token, so the session cannot be
 * renewed and has to be replaced by hand. That is a property of the key rather than a
 * limitation of the import, so it is stated instead of being hidden behind a fake expiry.
 */
export function kiroCredentialFromApiKey(apiKey: string): ProviderCredential {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste a Kiro API key to connect.', {
      providerId: kiroProviderId,
      publicMessage: 'Paste a Kiro API key to connect.',
    });
  }
  return { type: 'api-key', value: trimmed };
}

/** Renews the session. Kiro's refresh grant uses the same token endpoint. */
export async function refreshKiroCredential(credential: ProviderCredential): Promise<ProviderCredential> {
  if (credential.type !== 'oauth' || !credential.refreshToken) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'This Kiro session cannot be renewed. Sign in again.', {
      providerId: kiroProviderId,
      publicMessage: 'This Kiro session cannot be renewed. Sign in again.',
    });
  }
  /**
   * The refresh grant is bound to the client that was registered when the sign-in started.
   * AWS answers `invalid_client` for any other pair, including the client *name*, so the
   * registered pair is carried on the credential and sent as issued.
   */
  const clientId = credential.oauthClientId;
  const clientSecret = credential.oauthClientSecret;
  if (!clientId || !clientSecret) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'This Kiro session cannot be renewed. Sign in again.', {
      providerId: kiroProviderId,
      publicMessage: 'This Kiro session cannot be renewed. Sign in again.',
    });
  }
  const { data } = await postAuthJson<Json>(`${KIRO.oidc}/token`, {
    grantType: 'refresh_token',
    refreshToken: credential.refreshToken,
    clientId,
    clientSecret,
  });
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!accessToken) {
    const detail = typeof data.error_description === 'string' ? data.error_description : '';
    throw new ProviderError('AUTHENTICATION_FAILED', detail || 'AWS did not renew the Kiro session. Sign in again.', {
      providerId: kiroProviderId,
      publicMessage: detail.includes('Invalid refresh token')
        ? 'This Kiro session has expired. Sign in again.'
        : detail || 'AWS did not renew the Kiro session. Sign in again.',
    });
  }
  const expiresIn = typeof data.expiresIn === 'number' ? data.expiresIn : undefined;
  return {
    type: 'oauth',
    value: accessToken,
    ...(typeof data.refreshToken === 'string' ? { refreshToken: data.refreshToken } : { refreshToken: credential.refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
    // Carried forward, or the next refresh has no client to send.
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
  };
}

/** True when the access token is within a minute of expiry. */
export function kiroCredentialExpired(credential: ProviderCredential | undefined, now = Date.now()): boolean {
  if (credential?.type !== 'oauth' || !credential.expiresAt) return false;
  const expiry = Date.parse(credential.expiresAt);
  return Number.isFinite(expiry) && expiry - 60_000 <= now;
}

/* ------------------------------------------------------------------ *
 * Inference
 * ------------------------------------------------------------------ */

/**
 * Message content is either a string or a list of parts, and Kiro's envelope takes plain
 * text, so both are flattened to text rather than one being dropped.
 */
function messageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

/**
 * Builds the `conversationState` envelope.
 *
 * Kiro takes the whole turn history rather than a message list, the model id is
 * addressed on the current message, and a system turn is folded into the user content
 * rather than sent as its own role, because the envelope has no system role.
 */
export function toKiroBody(request: ChatRequest, conversationId: string, credential?: ProviderCredential): Json {
  const system = request.messages.filter((message) => message.role === 'system').map((message) => messageText(message.content)).filter(Boolean);
  const turns = request.messages.filter((message) => message.role !== 'system');
  const current = turns[turns.length - 1];
  const history = turns.slice(0, -1).map((message) => ({
    [message.role === 'assistant' ? 'assistantResponseMessage' : 'userInputMessage']: {
      content: messageText(message.content),
      ...(message.role === 'assistant' ? { modelId: request.model } : { modelId: request.model, origin: 'AI_EDITOR' }),
    },
  }));
  const content = [system.length ? system.join('\n\n') : '', messageText(current?.content ?? '')].filter(Boolean).join('\n\n');
  // A profile scopes the session to an IAM Identity Center profile and is absent for a
  // plain Builder ID or social sign-in. It is sent **only when there is one**: an empty
  // `profileArn` is not the same as no profile, and Kiro answers
  // `400 Improperly formed request` for it.
  const profileArn = credential?.type === 'oauth' ? credential.accountId : undefined;
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: {
        userInputMessage: {
          content,
          modelId: request.model,
          origin: 'AI_EDITOR',
        },
      },
      history,
    },
    ...(profileArn ? { profileArn } : {}),
    ...(request.maxOutputTokens === undefined ? {} : { inferenceConfig: { maxTokens: request.maxOutputTokens } }),
  };
}

function kiroHeaders(credential: ProviderCredential): Record<string, string> {
  // `value` exists on every variant except `none`, which never reaches a request.
  const token = credential.type === 'none' ? '' : credential.value;
  return {
    'content-type': 'application/json',
    accept: KIRO.eventStreamAccept,
    'X-Amz-Target': KIRO.streamingTarget,
    'User-Agent': KIRO.userAgent,
    'X-Amz-User-Agent': KIRO.amzUserAgent,
    Authorization: `Bearer ${token}`,
  };
}

/**
 * One decoded event from Kiro's stream.
 *
 * The service answers with the **binary** AWS eventstream, not a text framing. Each frame
 * is `[total_length][headers_length][prelude_crc][headers][payload][message_crc]`, the
 * event name is an `:event-type` header — the names carry a leading colon — and the
 * payload is flat JSON rather than nested under the event name. All of that was read off
 * a live response: a parser written for the text framing matches no frame at all, which
 * is indistinguishable from a provider that answered nothing.
 */
export type KiroEvent = {
  type: string;
  /** Answer text, from `assistantResponseEvent` only. */
  text?: string;
  /** Share of the context window Kiro reports as used, 0–100. */
  contextUsagePercent?: number;
  /**
   * Credits this call cost. Kiro meters credits rather than publishing a token usage
   * event, so this is the only cost signal the service gives and it is not dropped.
   */
  creditsUsed?: number;
};

const kiroEventTypeHeader = ':event-type';
/** AWS eventstream header type 7: a string, preceded by its u16 length. */
const kiroStringHeader = 7;

function readText(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder().decode(bytes.subarray(start, start + length));
}

/** A single byte, treating an out-of-range read as 0 so a malformed frame cannot throw. */
function byteAt(bytes: Uint8Array, index: number): number {
  return index < 0 || index >= bytes.length ? 0 : (bytes[index] as number);
}

function readNumber(source: Json, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readString(source: Json, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Decodes a whole Kiro response.
 *
 * Frames are walked by their declared length rather than scanned for a separator, and a
 * frame that claims an impossible length ends the walk instead of being read past — a
 * truncated body must not be mistaken for a complete one.
 */
export function decodeKiroStream(bytes: Uint8Array): KiroEvent[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events: KiroEvent[] = [];
  let offset = 0;
  while (offset + 16 <= bytes.length) {
    // `total_length` counts itself, so a frame occupies exactly that many bytes.
    const totalLength = view.getUint32(offset);
    const headersLength = view.getUint32(offset + 4);
    if (totalLength < 16 || offset + totalLength > bytes.length) break;
    const headersEnd = offset + 12 + headersLength;
    const frameEnd = offset + totalLength;
    // 12 prelude + headers + 4 trailing CRC must fit inside the frame.
    if (headersEnd + 4 > frameEnd) break;

    let cursor = offset + 12;
    let eventType = '';
    while (cursor < headersEnd) {
      const nameLength = byteAt(bytes, cursor);
      cursor += 1;
      const name = readText(bytes, cursor, nameLength);
      cursor += nameLength;
      if (cursor >= headersEnd) break;
      const headerType = byteAt(bytes, cursor);
      cursor += 1;
      if (headerType !== kiroStringHeader) break;
      if (cursor + 2 > headersEnd) break;
      const valueLength = view.getUint16(cursor);
      cursor += 2;
      const value = readText(bytes, cursor, valueLength);
      cursor += valueLength;
      if (name === kiroEventTypeHeader || name === 'event-type') eventType = value;
    }

    const payloadText = readText(bytes, headersEnd, frameEnd - 4 - headersEnd);
    let payload: Json = {};
    try {
      const parsed: unknown = JSON.parse(payloadText);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) payload = parsed as Json;
    } catch {
      // An unreadable payload still yields an event, so the frame count stays honest.
    }
    events.push(toKiroEvent(eventType, payload));
    offset = frameEnd;
  }
  return events;
}

/** Maps one decoded frame onto the fields this adapter can use. */
export function toKiroEvent(eventType: string, payload: Json): KiroEvent {
  if (eventType === 'assistantResponseEvent') {
    const text = readString(payload, ['content', 'text']);
    return text === undefined ? { type: eventType } : { type: eventType, text };
  }
  if (eventType === 'contextUsageEvent') {
    const percent = readNumber(payload, ['contextUsagePercentage', 'contextUsagePercent']);
    return percent === undefined ? { type: eventType } : { type: eventType, contextUsagePercent: percent };
  }
  if (eventType === 'meteringEvent') {
    const used = readNumber(payload, ['usage', 'creditsUsed']);
    return used === undefined ? { type: eventType } : { type: eventType, creditsUsed: used };
  }
  return { type: eventType };
}

/** Kiro's wording for an id the signed-in plan does not carry. */
function isKiroInvalidModel(error: unknown): boolean {
  const detail = (error as { details?: { providerMessage?: string } } | undefined)?.details?.providerMessage ?? '';
  return /invalid model|different model/i.test(detail);
}

/** The last frame carrying a value of this kind. The target is ES2022, so no `findLast`. */
function lastOf<T>(events: readonly KiroEvent[], pick: (event: KiroEvent) => T | undefined): T | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined) continue;
    const value = pick(event);
    if (value !== undefined) return value;
  }
  return undefined;
}

function conversationIdFor(request: ChatRequest): string {
  // Deterministic per request, so a retried request stays in one conversation.
  let hash = 0;
  for (const character of `${request.model}:${request.messages.map((m) => `${m.role}:${messageText(m.content)}`).join('|')}`) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return `omnihilbras-${(hash >>> 0).toString(16)}`;
}

export type KiroAdapterOptions = {
  transport?: HttpTransport;
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

export class KiroAdapter implements ProviderAdapter {
  readonly id = kiroProviderId;
  readonly name = 'Kiro';
  readonly capabilities = { chat: true, streaming: false, models: true } as const;

  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
  private renewed = new Map<string, ProviderCredential>();

  constructor(options: KiroAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchHttpTransport();
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Kiro publishes no model list over the API, so the catalog is the known set. That is
   * stated rather than implied: a model not in it is refused below instead of being sent
   * and coming back as `400 Invalid model`.
   */
  async listModels(): Promise<Model[]> {
    return KIRO_MODELS.map((model) => ({
      id: model.id,
      providerId: this.id,
      displayName: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    }));
  }

  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    if (credential?.type !== 'oauth' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Sign in to Kiro to use this provider.', {
        providerId: this.id,
        publicMessage: 'Sign in to Kiro to use this provider.',
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString() };
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const credential = await this.credential(context);
    const model = KIRO_MODELS.find((entry) => entry.id === request.model);
    if (!model) {
      throw new ProviderError('NOT_SUPPORTED', `Kiro does not offer a model called ${request.model}.`, {
        providerId: this.id,
        publicMessage: `Kiro does not offer a model called ${request.model}. Sign in to refresh the catalog.`,
      });
    }
    let response: { status: number; headers: Headers; data: Uint8Array };
    try {
      response = await this.transport.request<Uint8Array>({
        method: 'POST',
        providerId: this.id,
        url: KIRO.inferenceUrl,
        headers: kiroHeaders(credential),
        body: JSON.stringify(toKiroBody(request, conversationIdFor(request), credential)),
        // Read as bytes: the answer is a binary eventstream and a text decode corrupts it.
        responseAs: 'bytes',
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      /**
       * An id the plan does not carry comes back as a 400 that reads like a malformed
       * request. Naming the model is the difference between "Kiro is broken" and "this
       * account cannot use this model", and only the first of those is our fault.
       */
      if (isKiroInvalidModel(error)) {
        throw new ProviderError('NOT_SUPPORTED', `Your Kiro plan does not offer ${request.model}.`, {
          providerId: this.id,
          publicMessage: `Your Kiro plan does not offer ${request.model}. Kiro serves it to some accounts and not others.`,
          cause: error,
        });
      }
      throw error;
    }
    const events = decodeKiroStream(response.data ?? new Uint8Array());
    const text = events.map((event) => event.text ?? '').join('');
    // Kiro ends the stream by closing it; it publishes no stop event, so `stop` is the
    // only honest answer rather than a reason read from an event that never arrives.
    const creditsUsed = lastOf(events, (event) => event.creditsUsed);
    const contextUsagePercent = lastOf(events, (event) => event.contextUsagePercent);
    if (!text) {
      throw new ProviderError('INVALID_RESPONSE', 'Kiro returned no answer text.', {
        providerId: this.id,
        publicMessage: 'Kiro returned no answer text.',
      });
    }
    return {
      id: `kiro-${conversationIdFor(request)}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: text },
      finishReason: 'stop',
      /**
       * Kiro meters credits and publishes no token counts, so `usage` is left unset
       * rather than reported as zero. The credit cost is carried separately because it is
       * the real figure and dropping it would leave the call looking free.
       */
      ...(creditsUsed === undefined ? {} : { meters: { unit: 'credit', amount: creditsUsed } }),
      ...(contextUsagePercent === undefined ? {} : { contextUsagePercent }),
    };
  }

  /**
   * Kiro only speaks the eventstream, so a non-streaming answer is assembled from it and
   * yielded whole. Reporting that honestly beats implying a stream the provider does not
   * have.
   */
  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const response = await this.chat(request, context);
    yield {
      id: response.id,
      providerId: response.providerId,
      model: response.model,
      delta: { role: 'assistant', content: messageText(response.message.content) },
      finishReason: response.finishReason,
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable', verified: 'credential',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The Kiro session could not be checked.',
      };
    }
  }

  /** Renews at expiry, memoised so one request never spends two refresh grants. */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential as ProviderCredential | undefined;
    if (!kiroCredentialExpired(current, this.now())) return current as ProviderCredential;
    // Only an OAuth credential can be expired, so the variant is known here.
    const stale = (current as Extract<ProviderCredential, { type: 'oauth' }>).value;
    const memo = this.renewed.get(stale);
    if (memo) return memo;
    const renewed = await refreshKiroCredential(current as ProviderCredential);
    this.renewed.set(stale, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }
}
