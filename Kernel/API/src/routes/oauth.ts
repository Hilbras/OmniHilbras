/**
 * Signing in: OAuth start/authorize/callback/exchange for the providers that use it, and the web-cookie hand-off for the ones that do not.
 *
 * This is the module that most needs the provider split, and where it would pay for itself
 * fastest: a fifth OAuth provider is five more `if` blocks here, in one file, next to the four
 * that already exist.
 */

import { randomBytes } from 'node:crypto';

import { claudeCodeCallbackPath, claudeCodeSessionIdFromCallbackPath, clineCallbackPath, codexCallbackPath, sessionIdFromCallbackPath } from '../core/oauth.js';
import type { RouteContext } from './route-context.js';

export const codexCallbackRoutePath = codexCallbackPath;
import {
  assertOnlyFields,
  escapeHtml,
  invalidRequest,
  isRecord,
  maxConnectionBodyBytes,
  maxKeyBodyBytes,
  parseBoundedString,
  parsePriority,
  readJsonBody,
  readOptionalString,
  readRequiredString,
  sendHtml,
  sendJson,
} from '../core/http.js';

/**
 * The sign-in target from a start body: whether this is an add-account sign-in, and which account is
 * being **edited**.
 *
 * `connectionId` is the row's Edit: the sign-in then replaces that connection's credential instead of
 * minting a new one. Shape-checked here because it becomes a stored connection id, and refused rather
 * than ignored when malformed — a typo that silently added a third account would be the worst outcome.
 */
function readSignInTarget(body: unknown): { addAccount: boolean; targetConnectionId?: string } {
  if (!isRecord(body)) return { addAccount: false };
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : undefined;
  if (connectionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId)) throw invalidRequest('connectionId is not a valid connection id.');
  return { addAccount: body.addAccount === true, ...(connectionId ? { targetConnectionId: connectionId } : {}) };
}

export async function handleOauthRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, options, signal } = ctx;

    if (request.method === 'POST' && url.pathname === '/v1/oauth/cline/start') {
      // The 415 guard above already required a JSON content type.
      const body = await readJsonBody(request, maxKeyBodyBytes);
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['redirectUri', 'addAccount', 'connectionId']);
      const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : defaultClineRedirect(options.publicBaseUrl);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, service.startClineSignIn(redirectUri, addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/v1/oauth/cline/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? defaultClineRedirect(options.publicBaseUrl);
      sendJson(response, 200, service.beginClineAuthorization(redirectUri), origin);
      return true;
    }

    // Where Cline sends the browser after the user approves. Exempt from the cross-site guard and
    // from the API-key gate alongside Claude Code's callback, because a top-level navigation from
    // the provider carries `sec-fetch-site: cross-site`, no Origin, and no way to send a key.
    if (request.method === 'GET' && (url.pathname === clineCallbackPath || url.pathname.startsWith(`${clineCallbackPath}/`))) {
      const code = url.searchParams.get('code') ?? '';
      // The session id rides in the path. `state`, when it arrives, is
      // whatever the provider sent back — Cline replaces ours with a signed
      // blob naming the callback URL — so `clineStateMatchesCallback` is what
      // decides whether it may claim this session.
      const sessionId = sessionIdFromCallbackPath(url.pathname);
      const state = url.searchParams.get('state') ?? undefined;
      const providerError = url.searchParams.get('error');
      const outcome = code || providerError
        ? await service.completeClineSignIn({ code, ...(sessionId ? { sessionId } : {}), ...(state ? { state } : {}), ...(providerError ? { providerError } : {}) }, signal)
        : { ok: false, message: 'This callback carried neither an authorization code nor an error. Start the sign-in again.' };
      // The nonce is minted per render and handed to both the page and the header, so the
      // script the page carries is the script the CSP admits — and nothing else ever is.
      const nonce = scriptNonce();
      sendHtml(response, 200, clineCallbackPage(outcome.ok, outcome.message, nonce, sessionId), origin, nonce);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/cline/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/cline/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = service.clineSignInStatus(sessionId);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/oauth/cline/exchange') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['code', 'callback', 'redirectUri', 'name', 'priority']);
      const connection = await service.connectCline({
        code: parseBoundedString(body.code ?? body.callback ?? '', 'code', 8192),
        ...(typeof body.callback === 'string' ? { callback: body.callback } : {}),
        redirectUri: typeof body.redirectUri === 'string' ? body.redirectUri : defaultClineRedirect(options.publicBaseUrl),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(body.priority === undefined ? {} : { priority: parsePriority(body.priority) }),
      }, signal);
      sendJson(response, 201, { connection }, origin);
      return true;
    }

    // OpenCode Console uses a device flow, so there is no callback: the dashboard
    // starts the flow, shows the code, and polls until the Console reports it approved.
    if (request.method === 'POST' && url.pathname === '/v1/oauth/opencode-console/start') {
      sendJson(response, 201, await service.startOpencodeConsoleSignIn(), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/opencode-console/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/opencode-console/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.opencodeConsoleSignInStatus(sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    if (request.method === 'POST' && /^\/v1\/oauth\/opencode-console\/session\/[^/]+\/workspace$/.test(url.pathname)) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/opencode-console/session/'.length, -'/workspace'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const body = await readJsonBody(request, maxKeyBodyBytes);
      const workspaceId = readRequiredString(body, 'workspaceId');
      const status = await service.chooseOpencodeConsoleWorkspace(sessionId, workspaceId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    /**
     * Kimi Code, the `api.kimi.com/coding` subscription.
     *
     * A device flow, so there is no callback: the dashboard starts it, shows the code, and polls the
     * session route until Kimi reports the code approved.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kimi-code/start') {
      // `addAccount: true` keeps the existing connection and adds this one beside it — the same body
      // field Kiro's start takes, and the same absence-means-repair default, so an old client that
      // sends an empty body re-signs the one connection exactly as before.
      const body = await readJsonBody(request, maxKeyBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startKimiCodeSignIn(addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/kimi-code/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/kimi-code/session/'.length)).trim();
      // Shape-checked before it reaches the store, which is what stops a crafted path from being used
      // to probe for sessions. The store checks it too; this is the outer of the two.
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.kimiCodeSignInStatus(sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    /**
     * Kilo Code, a custom device flow. A single code serves as both device and user code; the user
     * approves at the verification URL and the dashboard polls until it is approved.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kilocode/start') {
      const body = await readJsonBody(request, maxKeyBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startKilocodeSignIn(addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/kilocode/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/kilocode/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.kilocodeSignInStatus(sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    /**
     * CodeBuddy, both regions. A browser approval, not a typed code: the start returns a URL, the user
     * approves there, and the dashboard polls the session route until the token lands. Two regional
     * cards on two domains, so two literal path sets.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/codebuddy-cn/start') {
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startCodeBuddySignIn('codebuddy-cn', addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/codebuddy-cn/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/codebuddy-cn/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.codebuddySignInStatus('codebuddy-cn', sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/oauth/codebuddy-intl/start') {
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startCodeBuddySignIn('codebuddy-intl', addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/codebuddy-intl/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/codebuddy-intl/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.codebuddySignInStatus('codebuddy-intl', sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    /**
     * MiniMax Code, an RFC 8628 device flow with PKCE. Two regional cards share the same flow but
     * have their own routes, so the spec and the machines that read it see two literal paths.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/minimax-code/start') {
      const body = await readJsonBody(request, maxKeyBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startMinimaxCodeSignIn('minimax-code', addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/minimax-code/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/minimax-code/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.minimaxCodeSignInStatus('minimax-code', sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/oauth/minimax-code-global/start') {
      const body = await readJsonBody(request, maxKeyBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startMinimaxCodeSignIn('minimax-code-global', addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/minimax-code-global/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/minimax-code-global/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.minimaxCodeSignInStatus('minimax-code-global', sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    /**
     * Qoder, a custom device flow with local PKCE. The dashboard opens the verification URL and polls
     * the session route until the token lands.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/qoder/start') {
      sendJson(response, 201, await service.startQoderSignIn(), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/qoder/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/qoder/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.qoderSignInStatus(sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    /**
     * Claude Code — the Anthropic subscription, reached by an authorization-code flow with PKCE.
     *
     * The browser is the only path here: probing `claude.ai/oauth/authorize` server-side returns a
     * Cloudflare interstitial rather than a code, so the user's own browser has to make the trip and
     * the callback comes back to us. The session id rides in the redirect path — see `claudeCode.ts`
     * for why — and `start` hands back both the URL to open and the id to poll.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/claude-code/start') {
      const body = await readJsonBody(request, maxKeyBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, service.startClaudeCodeSignIn(options.publicBaseUrl ?? 'http://127.0.0.1:8787', addAccount, targetConnectionId), origin);
      return true;
    }

    // Where Claude redirects the browser. Exempt from the cross-site guard and the API-key gate
    // alongside Cline's callback: a top-level navigation carries no `Origin` and no key.
    if (request.method === 'GET' && (url.pathname === claudeCodeCallbackPath || url.pathname.startsWith(`${claudeCodeCallbackPath}/`))) {
      const sessionId = claudeCodeSessionIdFromCallbackPath(url.pathname);
      /**
       * Claude repeats the code after a `#`, and reassembling it is what this line is for.
       *
       * The `#` half is a URL **fragment**, which a browser puts in `url.hash` rather than in the
       * query — and a client that pastes the whole callback may instead deliver it percent-encoded
       * **inside** `code`, which `searchParams` decodes back to `#`. Both forms are rebuilt here so
       * `splitCallbackFragment` receives a `code#state` pair either way. Passing `url.search` whole
       * was the first attempt and it handed the exchange `code=granted` — the parameter *name*
       * became part of the code, which Claude refuses with `invalid_grant` for a code that was right.
       */
      const raw = `${url.searchParams.get('code') ?? ''}${url.hash}`;
      const status = sessionId ? await service.completeClaudeCodeCallback({ sessionId, raw }, signal) : undefined;
      const ok = status?.status === 'connected';
      const message = ok
        ? `Connected to ${(status?.connection as { name?: string } | undefined)?.name ?? 'Claude Code'}.`
        : status?.error ?? 'This callback did not identify a Claude Code sign-in. Start the sign-in again from OmniHilbras.';
      const nonce = scriptNonce();
      sendHtml(response, 200, claudeCodeCallbackPage(ok, message, nonce, sessionId), origin, nonce);
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/v1/oauth/codex/callback') {
      const state = url.searchParams.get('state') ?? '';
      const session = state ? service.codexCallbackSession(url.pathname, state) : undefined;
      const code = url.searchParams.get('code') ?? '';
      const providerError = url.searchParams.has('error');
      const status = session && providerError
        ? service.failCodexCallback(url.pathname, state, 'Codex sign-in was not approved. Start again from OmniHilbras.')
        : session && code
          ? await service.completeCodexCallback({ sessionId: session.id, code, state }, signal)
          : undefined;
      const ok = status?.status === 'connected';
      const message = ok ? 'Connected to Codex.' : status?.error ?? 'This callback did not identify a Codex sign-in. Start again from OmniHilbras.';
      const nonce = scriptNonce();
      sendHtml(response, 200, oauthCallbackPage('Codex', ok, message, nonce, session?.id), origin, nonce);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/oauth/codex/start') {
      const body = await readJsonBody(request, maxKeyBodyBytes);
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startCodexSignIn(options.publicBaseUrl ?? 'http://127.0.0.1:8787', addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/codex/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/codex/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = service.codexSignInStatus(sessionId);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/claude-code/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/claude-code/session/'.length)).trim();
      // Shape-checked before it reaches the store, which is what stops a crafted path from being used
      // to probe for sessions. The store checks it too; this is the outer of the two.
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = service.claudeCodeSignInStatus(sessionId);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }

    // Kiro signs in through AWS's device flow: a code the user approves in their own
    // browser, and the gateway polls until AWS says it was approved.
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kiro/start') {
      // A company IAM Identity Center sign-in supplies its own start URL; a plain Builder
      // ID sign-in does not, and falls back to the public one.
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const startUrl = readOptionalString(body, 'startUrl');
      // `addAccount: true` keeps the existing connection and adds this one beside it. Absent means the
      // long-standing behaviour — repair the provider's connection — so an older client is unchanged.
      // `connectionId` names the account an Edit is updating; absent means the flow decides.
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startKiroSignInFlow(startUrl, addAccount, targetConnectionId), origin);
      return true;
    }

    // A refresh token exported from Kiro. Spent once here so the stored credential is an
    // access token, never the long-lived secret the user pasted.
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kiro/import-token') {
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const connection = await service.importKiroRefreshToken(readRequiredString(body, 'refreshToken'), signal);
      sendJson(response, 201, { connection }, origin);
      return true;
    }

    /**
     * An exported ChatGPT Web session.
     *
     * The blob is user-pasted and is parsed and filtered server-side before anything is
     * written, so the browser's decision about which cookies belong to this connection is
     * made here rather than trusted from the client.
     */
    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/gemini/check') {
      // Opens gemini.google.com and reports whether the session is signed in, then stores nothing. Cookie
      // presence and expiry are local checks and neither can tell a working session from a revoked one, so the
      // button costs a page load — which is the point of a check.
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      sendJson(response, 200, await service.checkGeminiWeb(readRequiredString(body, 'cookieHeader'), signal), origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/gemini/connect') {
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      // Checked before the save, so a cookie the page refuses never becomes a connection that reads as
      // connected and answers nothing.
      sendJson(response, 201, { connection: await service.connectGeminiWeb(readRequiredString(body, 'cookieHeader'), signal) }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/deepseek/connect') {
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      sendJson(response, 201, { connection: await service.connectDeepSeekWeb(readRequiredString(body, 'userToken'), signal) }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/tokenharbor/check') {
      // A credential check, not a completion: it reads `/api/me/profile` and stores nothing. The
      // card's notice says what the trade is — this proxies a service whose terms forbid it — and
      // the check is what makes the button worth pressing before saving a whole-account session.
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      sendJson(response, 200, await service.checkTokenHarborWeb(readRequiredString(body, 'cookieHeader'), signal), origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/tokenharbor/connect') {
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      // Anything other than a literal `true` is not the free-only import; a truthy string from a
      // hand-written request would otherwise narrow a connection nobody asked to narrow.
      const freeOnly = body.freeOnly === true;
      const connection = await service.connectTokenHarborWeb(readRequiredString(body, 'cookieHeader'), signal, freeOnly);
      sendJson(response, 201, { connection }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/qwen/check') {
      // A probe, not a connect, and it stores nothing. The open question is whether Alibaba's
      // bot-protection gate applies to an authenticated request, and that cannot be answered
      // without a signed-in account — so the route exists to make the question askable and to
      // report the provider's own answer rather than a verdict anyone guessed at.
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      sendJson(response, 200, { probe: await service.checkQwenWeb(readRequiredString(body, 'cookieHeader'), signal) }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/chatgpt/check') {
      // Deliberately before the connect route and deliberately storing nothing: this is the
      // "check the cookie" answer, which is which models the account will actually get.
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      // Async because it verifies: this opens the page and confirms the account is signed in,
      // which is what makes the button worth pressing before saving a whole-account session.
      sendJson(response, 200, await service.checkChatGptWeb(readRequiredString(body, 'storageState'), signal), origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/chatgpt/connect') {
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      // Anything other than a literal `true` is not the free-only import; a truthy string
      // from a hand-written request would otherwise narrow a connection nobody asked to narrow.
      const freeOnly = body.freeOnly === true;
      const connection = await service.connectChatGptWeb(readRequiredString(body, 'storageState'), signal, freeOnly);
      sendJson(response, 201, { connection }, origin);
      return true;
    }

    /**
     * Duck.ai — an anti-bot challenge, not a credential.
     *
     * The one web-cookie route whose credential is optional. Every sibling above refuses to
     * proceed without a paste because the service it talks to reads one; duck.ai does not, so
     * requiring a paste here would make a keyless connection impossible and would teach the
     * dashboard that this field is mandatory. What the button proves is stated in the service's
     * note: the endpoint answered and served a challenge this gateway solved.
     */
    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/duckduckgo/check') {
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      sendJson(response, 200, await service.checkDuckDuckGoWeb(readOptionalString(body, 'cookieHeader'), signal), origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/web-cookie/duckduckgo/connect') {
      const body = (await readJsonBody(request, maxConnectionBodyBytes)) as Record<string, unknown>;
      // Optional here, unlike every other web-cookie connect route: an empty paste is this
      // provider's normal case and stores the honest `{ type: 'none' }` rather than a fake secret.
      const cookieHeader = readOptionalString(body, 'cookieHeader');
      const connection = await service.connectDuckDuckGoWeb(cookieHeader, signal, body.addAccount === true);
      sendJson(response, 201, { connection }, origin);
      return true;
    }

    // Google or GitHub. The browser cannot return from a `kiro://` callback, so this
    // returns a URL to open and the code is pasted back on the exchange route below.
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kiro/social/start') {
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const provider = readRequiredString(body, 'provider');
      if (provider !== 'google' && provider !== 'github') throw invalidRequest('provider must be google or github.');
      const { addAccount, targetConnectionId } = readSignInTarget(body);
      sendJson(response, 201, await service.startKiroSocialSignInFlow(provider, addAccount, targetConnectionId), origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/oauth/kiro/social/exchange') {
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const connection = await service.completeKiroSocialSignIn(
        readRequiredString(body, 'sessionId'),
        readRequiredString(body, 'code'),
        signal,
      );
      sendJson(response, 201, { connection }, origin);
      return true;
    }

    // A long-lived Kiro/CodeWhisperer key. Stored as given: it has no refresh token, so it
    // cannot be renewed and has to be replaced by hand.
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kiro/api-key') {
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const connection = await service.connectKiroApiKey(readRequiredString(body, 'apiKey'), signal);
      sendJson(response, 201, { connection }, origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/oauth/kiro/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/v1/oauth/kiro/session/'.length)).trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw invalidRequest('Unknown sign-in session.');
      const status = await service.kiroSignInStatus(sessionId, signal);
      if (!status) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown sign-in session.' } }, origin);
        return true;
      }
      sendJson(response, 200, status, origin);
      return true;
    }


  return false;
}

export function defaultClineRedirect(publicBaseUrl: string | undefined) {
  return `${publicBaseUrl ?? 'http://127.0.0.1:8787'}/v1/oauth/cline/callback`;
}


/**
 * The tab Claude Code's callback lands on.
 *
 * Same shape as `clineCallbackPage` on purpose: the two are the only pages a provider's own redirect
 * renders, and a reader comparing them should find one design and two wordings rather than two designs.
 * The message is escaped, and a charset check is the second line of defence against a provider's own
 * words becoming markup.
 */
export function claudeCodeCallbackPage(ok: boolean, message: string, nonce: string, sessionId?: string) {
  return oauthCallbackPage('Claude Code', ok, message, nonce, sessionId);
}

export function oauthCallbackPage(provider: string, ok: boolean, message: string, nonce: string, sessionId?: string) {
  const safeMessage = /^[\S ]{1,300}$/.test(message) && !/[<>]/.test(message)
    ? message
    : 'The sign-in could not be completed.';
  const safeProvider = /^[A-Za-z0-9 ]{1,48}$/.test(provider) ? provider : 'Provider';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${ok ? `${safeProvider} connected` : `${safeProvider} sign-in failed`}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e6e8eb;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(520px, calc(100% - 2rem)); text-align: center; }
  .mark { width: 44px; height: 44px; margin: 0 auto 1rem; border-radius: 50%; display: grid; place-items: center;
          font-size: 22px; border: 1px solid #2a2f36; }
  .ok .mark { background: #10261b; border-color: #1f4d33; color: #7cc7a1; }
  .bad .mark { background: #2a1416; border-color: #4d2024; color: #f08a8a; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #aeb4bb; }
  .note { margin-top: 1.5rem; color: #8b9299; font-size: 12px; }
</style>
<main class="${ok ? 'ok' : 'bad'}">
  <div class="mark" aria-hidden="true">${ok ? '&#10003;' : '!'}</div>
  <h1>${ok ? `${safeProvider} connected` : `${safeProvider} sign-in failed`}</h1>
  <p>${escapeHtml(safeMessage)}</p>
  <p class="note">${ok ? 'You can close this tab and go back to OmniHilbras.' : 'Go back to OmniHilbras and start the sign-in again.'}</p>
</main>
${signInNotice(ok, safeMessage, safeProvider, sessionId, nonce)}
</html>`;
}


/**
 * A fresh CSP nonce for one page render. Never cached and never reused: the value is admitted by
 * exactly one response's `script-src`, so a page served a second time carries a different one and
 * a nonce learned from a previous response is worthless.
 */
function scriptNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * The callback page, which now **tells the tab that opened it** whether the sign-in worked.
 *
 * Cline is a redirect flow, so the outcome lands on this page and nowhere else. The dashboard tab
 * that opened the pop-up polls the sign-in session, but the session is resolved by *this* request —
 * so the dashboard would keep waiting and then time out, and the operator saw the failure only if
 * they happened to be looking at the pop-up. Kiro never had that bug because it is a device flow the
 * dashboard polls directly.
 *
 * The message is addressed to the dashboard's origin, carries no credential, and is the same text
 * already rendered on the page. `window.opener` is gone when the pop-up is opened with
 * `noopener`, so a `BroadcastChannel` is used as well and the dashboard listens on the same name.
 */
/**
 * The `<script>` the callback page runs, built as its own string.
 *
 * It is separate because a `</script>` written inside the page's template literal closes that literal
 * — TypeScript read the rest of the page as an arithmetic expression and the build failed. Keeping the
 * markup in one place and the script in another is also how the script's own escaping stays checkable.
 *
 * The tag carries the per-response nonce the caller handed to `sendHtml`, so the script is exactly the
 * one the page's CSP admits: without the attribute the browser refuses to run it, and with it, a
 * script injected beside it is still refused — the page keeps the no-attacker-execution rule it was
 * written under, now stated by the nonce rather than by the absence of a tag.
 */
function signInNotice(ok: boolean, message: string, provider: string, sessionId: string | undefined, nonce: string): string {
  return [
    `<script nonce="${nonce}">`,
    '  // Tell the dashboard tab. Posted with `*` because this page does not know the dashboard origin;',
    '  // the payload is a boolean, a sentence already rendered above, and the session id — no',
    '  // credential. The session id is what makes the post safe to act on: it is minted per sign-in,',
    '  // rides only on the gateway\u0027s own callback URL, and the dashboard listens only for the',
    '  // session it started, so a payload from anywhere else is shape-correct and still inert.',
    '  (function () {',
    `    var payload = { type: 'omnihilbras:sign-in', provider: ${JSON.stringify(provider)}, ok: ${ok ? 'true' : 'false'},`,
    `                    message: ${JSON.stringify(message)}, sessionId: ${JSON.stringify(sessionId ?? '')} };`,
    "    try { if (window.opener && !window.opener.closed) window.opener.postMessage(payload, '*'); } catch (e) {}",
    "    try {",
    "      if ('BroadcastChannel' in window) {",
    "        var channel = new BroadcastChannel('omnihilbras:sign-in');",
    '        channel.postMessage(payload);',
    '        channel.close();',
    '      }',
    '    } catch (e) {}',
    '  })();',
    '</script>',
  ].join('\n');
}

export function clineCallbackPage(ok: boolean, message: string, nonce: string, sessionId?: string) {
  // The message is plain text and is escaped below. This charset is a second
  // line of defence: it admits the punctuation a real outcome message needs and
  // nothing that could become markup.
  // A provider's own wording can carry characters the outcome message does not,
  // so it is rendered as text with quotes preserved rather than filtered away.
  const safeMessage = /^[\S ]{1,300}$/.test(message) && !/[<>]/.test(message)
    ? message
    : 'The sign-in could not be completed.';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${ok ? 'Cline connected' : 'Cline sign-in failed'}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e6e8eb;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(520px, calc(100% - 2rem)); text-align: center; }
  .mark { width: 44px; height: 44px; margin: 0 auto 1rem; border-radius: 50%; display: grid; place-items: center;
          font-size: 22px; border: 1px solid #2a2f36; }
  .ok .mark { background: #10261b; border-color: #1f4d33; color: #7cc7a1; }
  .bad .mark { background: #2a1416; border-color: #4d2024; color: #f08a8a; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #aeb4bb; }
  .note { margin-top: 1.5rem; color: #8b9299; font-size: 12px; }
</style>
<main class="${ok ? 'ok' : 'bad'}">
  <div class="mark" aria-hidden="true">${ok ? '&#10003;' : '!'}</div>
  <h1>${ok ? 'Cline connected' : 'Cline sign-in failed'}</h1>
  <p>${escapeHtml(safeMessage)}</p>
  <p class="note">${ok ? 'You can close this tab and go back to OmniHilbras.' : 'Go back to OmniHilbras and start the sign-in again.'}</p>
</main>
${signInNotice(ok, safeMessage, 'cline', sessionId, nonce)}
</html>`;
}

