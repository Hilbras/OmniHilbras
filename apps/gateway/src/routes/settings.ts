import type { RouteContext } from './route-context.js';
import type { GatewayConfig } from '../config.js';
import { sendJson } from '../http.js';
import { CODEX } from '@hilbras/omnihilbras';

/**
 * `GET /v1/settings` — the configuration this gateway actually loaded.
 *
 * ## Why a route for a read-only view
 *
 * Because the alternative was the Settings nav item staying disabled forever, and the reason it was disabled
 * is worth stating precisely: **there was nothing to show.** Every setting lives in an environment variable,
 * and a page that restated a `.env.example` table would be documentation wearing a UI.
 *
 * This returns the *effective* values instead — what `loadGatewayConfig` resolved, after defaults, after
 * validation, after the loopback refusal — which is the thing an operator cannot otherwise see. Setting
 * `OMNIHILBRAS_PORT=0` fails validation and the gateway refuses to start, so "what is my port" has exactly one
 * answer at runtime, and this is where it comes from.
 *
 * ## What is deliberately absent
 *
 * **No secret, and no boolean that implies one.** `compatible.authRequired` is reported, because whether the
 * compatible endpoint demands a credential is a fact about the deployment. The credential itself is not, and
 * neither is anything derived from it. `dataDir` is a path the operator chose, and is shown because a Settings
 * page that hid it would leave no way to find where the vault is — but it is shown as a path, and the vault's
 * contents are behind `/v1/keys`, which requires the admin key.
 *
 * ## Read-only
 *
 * Exactly one setting is mutable at runtime — `requireApiKey`, through `PUT /v1/settings/require-api-key` —
 * and that is a different route because it is a different thing: a write, behind the same admin gate. This
 * route is a `GET` and says so, rather than accepting a `PATCH` that quietly does nothing.
 */
export const settingsPath = '/v1/settings';

/** Keys that must never appear in the response, whatever else changes. */
const FORBIDDEN_CONFIG_KEYS = [
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'authorization',
  'masterkey',
  'credential',
  'bearer',
] as const;

/**
 * Recursively assert that nothing credential-shaped survived into a response.
 *
 * Split on camelCase before matching, for the same reason `tests/browser-storage.test.js` does it: there is no
 * word boundary inside `apiKey`, and a guard that cannot see the commonest spelling of the thing it guards
 * reports having looked without having looked.
 */
function credentialShaped(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_-]+/).map((word) => word.toLowerCase());
  return words.some((word) => (FORBIDDEN_CONFIG_KEYS as readonly string[]).includes(word));
}

function assertNoSecrets(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (credentialShaped(key)) {
      throw new Error(`Refusing to serve a credential-shaped config key: ${path}${key}`);
    }
    assertNoSecrets(nested, `${path}${key}.`);
  }
}

/**
 * Whether Codex can be signed in against this gateway, and on what terms.
 *
 * `source` distinguishes an operator's own registered client from the public Codex CLI client, which
 * is what decides whether the callback needs a second listener and which loopback port is bound.
 * `publicClient` is stated because the user is about to authorise a subscription account through it,
 * which is not the same thing as authorising an API key.
 */
function codexReadiness(config: GatewayConfig) {
  const configured = Boolean(config.codex.clientId && config.codex.redirectUri);
  return {
    configured,
    source: configured ? ('operator' as const) : ('public-client' as const),
    redirectUri: configured ? config.codex.redirectUri : CODEX.publicRedirectUri,
    /**
     * The CLI version gating the catalog, stated because it decides how many entries come back.
     * Too low and models are hidden in a 200 with no error, which is invisible without this.
     */
    clientVersion: config.codex.clientVersion ?? CODEX.cliVersion,
    subscriptionOAuth: true,
  };
}

/** The subset worth showing, and nothing else. An allowlist rather than a redaction pass. */
function publicSettings(config: GatewayConfig) {

  return {
    host: config.host,
    port: config.port,
    /** Loopback is enforced twice, so this is always true; shown because a reader will want to know it is enforced. */
    localOnly: true,
    timeoutMs: config.timeoutMs,
    healthIntervalMs: config.healthIntervalMs,
    failureThreshold: config.failureThreshold,
    recoveryCooldownMs: config.recoveryCooldownMs,
    corsOrigins: config.corsOrigins,
    dataDir: config.dataDir,
    /**
     * Whether a Codex sign-in can start here, and where the browser will be sent back to.
     *
     * A readiness fact, not a credential: it says which client and registered redirect URI are in
     * effect so the dashboard can explain a failure before the user clicks rather than after.
     */
    codex: codexReadiness(config),
    endpoints: {
      openai: config.openai.baseUrl,
      anthropic: config.anthropic.baseUrl,
      gemini: config.gemini.baseUrl,
      openrouter: config.openrouter.baseUrl,
      compatible: {
        id: config.compatible.id,
        name: config.compatible.name,
        baseUrl: config.compatible.baseUrl,
        modelsPath: config.compatible.modelsPath,
        chatPath: config.compatible.chatPath,
        // The fact, not the value: whether a credential is required is deployment information.
        authRequired: config.compatible.authRequired,
      },
    },
    /**
     * How the values above got here.
     *
     * Not a claim that an env var was set — only that **changing it and restarting** is what would change the
     * value. Saying "restart required" on every row would be the truthful version and is what this is for.
     */
    mutableAtRuntime: ['requireApiKey'],
    mutableByRestart: [
      'host', 'port', 'timeoutMs', 'healthIntervalMs', 'failureThreshold',
      'recoveryCooldownMs', 'corsOrigins', 'dataDir', 'endpoints',
    ],
  };
}

export async function handleSettingsRoute(context: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = context;
  // A positive comparison on purpose: `!==` would be the same route and an *invisible* one to the guard in
  // `tests/gateway-routes.test.js`, which resolves `===` but not `!==`.
  if (url.pathname === settingsPath) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Settings are read-only here.' } }, origin);
      return true;
    }
    const config = service.config();
    if (!config) {
      // Only reachable for a service constructed directly rather than through `createGatewayService`, which
      // always loads one. Said plainly rather than answered with invented defaults.
      sendJson(response, 200, { settings: null, reason: 'This gateway has no loaded configuration to report.' }, origin);
      return true;
    }
    const settings = publicSettings(config);
    // Checked before it is sent, not trusted. If a future field is added above without thinking about this,
    // the gateway answers 500 rather than leaking — a failure that is loud beats one that is quiet.
    assertNoSecrets(settings);
    sendJson(response, 200, { settings }, origin);
    return true;
  } else {
    return false;
  }
}
