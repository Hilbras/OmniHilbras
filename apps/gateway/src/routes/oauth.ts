/**
 * Signing in: OAuth start/authorize/callback/exchange for the providers that use it, and the web-cookie hand-off for the ones that do not.
 *
 * This is the module that most needs the provider split, and where it would pay for itself
 * fastest: a fifth OAuth provider is five more `if` blocks here, in one file, next to the four
 * that already exist.
 */

import { claudeCodeCallbackPath, claudeCodeSessionIdFromCallbackPath, clineCallbackPath, sessionIdFromCallbackPath } from '../oauth.js';
import type { RouteContext } from './route-context.js';
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
} from '../http.js';

export async function handleOauthRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, options, signal } = ctx;

    if (request.method === 'POST' && url.pathname === '/v1/oauth/cline/start') {
      // The 415 guard above already required a JSON content type.
      const body = await readJsonBody(request, maxKeyBodyBytes);
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['redirectUri']);
      const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : defaultClineRedirect(options.publicBaseUrl);
      sendJson(response, 201, service.startClineSignIn(redirectUri), origin);
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/v1/oauth/cline/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? defaultClineRedirect(options.publicBaseUrl);
      sendJson(response, 200, service.beginClineAuthorization(redirectUri), origin);
      return true;
    }

    // Where Cline sends the browser after the user approves. This is the only
    // route exempt from the cross-site guard: a top-level navigation from the
    // provider carries `sec-fetch-site: cross-site` and no Origin.
    if (request.method === 'GET' && (url.pathname === clineCallbackPath || url.pathname.startsWith(`${clineCallbackPath}/`))) {
      const code = url.searchParams.get('code') ?? '';
      // The session id rides in the path. `state` is only present when the
      // provider echoes it, which Cline's AuthKit handoff does not.
      const sessionId = sessionIdFromCallbackPath(url.pathname);
      const state = url.searchParams.get('state') ?? undefined;
      const providerError = url.searchParams.get('error');
      const outcome = code || providerError
        ? await service.completeClineSignIn({ code, ...(sessionId ? { sessionId } : {}), ...(state ? { state } : {}), ...(providerError ? { providerError } : {}) }, signal)
        : { ok: false, message: 'This callback carried neither an authorization code nor an error. Start the sign-in again.' };
      sendHtml(response, 200, clineCallbackPage(outcome.ok, outcome.message), origin);
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

    /**
     * Kimi Code, the `api.kimi.com/coding` subscription.
     *
     * A device flow, so there is no callback: the dashboard starts it, shows the code, and polls the
     * session route until Kimi reports the code approved.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kimi-code/start') {
      sendJson(response, 201, await service.startKimiCodeSignIn(), origin);
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
     * Claude Code — the Anthropic subscription, reached by an authorization-code flow with PKCE.
     *
     * The browser is the only path here: probing `claude.ai/oauth/authorize` server-side returns a
     * Cloudflare interstitial rather than a code, so the user's own browser has to make the trip and
     * the callback comes back to us. The session id rides in the redirect path — see `claudeCode.ts`
     * for why — and `start` hands back both the URL to open and the id to poll.
     */
    if (request.method === 'POST' && url.pathname === '/v1/oauth/claude-code/start') {
      sendJson(response, 201, service.startClaudeCodeSignIn(options.publicBaseUrl ?? 'http://127.0.0.1:8787'), origin);
      return true;
    }

    // Where Claude redirects the browser. Exempt from the cross-site guard alongside Cline's callback:
    // a top-level navigation from the provider carries `sec-fetch-site: cross-site` and no Origin.
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
      sendHtml(response, 200, claudeCodeCallbackPage(ok, message), origin);
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
      const startUrl = readOptionalString(await readJsonBody(request, maxConnectionBodyBytes), 'startUrl');
      sendJson(response, 201, await service.startKiroSignInFlow(startUrl), origin);
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

    // Google or GitHub. The browser cannot return from a `kiro://` callback, so this
    // returns a URL to open and the code is pasted back on the exchange route below.
    if (request.method === 'POST' && url.pathname === '/v1/oauth/kiro/social/start') {
      const body = await readJsonBody(request, maxConnectionBodyBytes);
      const provider = readRequiredString(body, 'provider');
      if (provider !== 'google' && provider !== 'github') throw invalidRequest('provider must be google or github.');
      sendJson(response, 201, await service.startKiroSocialSignInFlow(provider), origin);
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
export function claudeCodeCallbackPage(ok: boolean, message: string) {
  const safeMessage = /^[\S ]{1,300}$/.test(message) && !/[<>]/.test(message)
    ? message
    : 'The sign-in could not be completed.';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${ok ? 'Claude Code connected' : 'Claude Code sign-in failed'}</title>
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
  <h1>${ok ? 'Claude Code connected' : 'Claude Code sign-in failed'}</h1>
  <p>${escapeHtml(safeMessage)}</p>
  <p class="note">${ok ? 'You can close this tab and go back to OmniHilbras.' : 'Go back to OmniHilbras and start the sign-in again.'}</p>
</main>
</html>`;
}


export function clineCallbackPage(ok: boolean, message: string) {
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
</html>`;
}

