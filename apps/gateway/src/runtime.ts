import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderCredential } from '@hilbras/omnihilbras';
import type { ApiKeyRecord } from './api-keys.js';

/**
 * The outer runtime the gateway is deployed inside.
 *
 * Phase 5 of `tasks/plan.md`, and the last item in it: **auth context, tenant context, a remote
 * `SecretStore`, and deployment configuration represented by interfaces, with no cloud
 * infrastructure implemented.** Everything here already exists locally in some form; what did not
 * exist was a *name* for the boundary, which is what made the shape of a cloud deployment guesswork
 * rather than something the code states.
 *
 * ## The risk this closes
 *
 * The plan's own risk table carries, unmitigated: *"Local/cloud behavior diverges — Medium — share
 * the SDK and gateway service; keep auth/storage as outer runtime concerns."* That is a commitment
 * to a boundary, and a boundary nobody can name is not a boundary. These four types are it.
 *
 * ## What this deliberately does not do
 *
 * It does not implement anything remote, and it does not make the gateway multi-tenant. Both are
 * the cloud deployment's work, and doing either here would mean writing infrastructure to justify an
 * abstraction — which is how an abstraction ends up shaped by the first implementation that used it.
 *
 * In particular, **tenancy is named rather than threaded.** Every store call is still
 * `(connectionId, …)`, because a gateway serving one tenant is the shape that exists and the shape
 * that is tested. A multi-tenant deployment scopes a store by construction — one store instance per
 * tenant — rather than by adding a parameter to thirty methods. Naming the tenant here is what gives
 * that implementation somewhere to hang the scoping, and threading a value nothing reads would be
 * decoration that looks like architecture.
 */

/**
 * Which deployment this is, and where its state lives.
 *
 * A *shape*, not a default. `loadGatewayConfig` produces one; a cloud deployment produces another
 * with the same fields set from somewhere else. The gateway reads these and never assumes they came
 * from a file, which is the whole of "keep storage as an outer runtime concern".
 */
export type DeploymentConfig = {
  /**
   * Where this gateway can be reached, which is what an OAuth callback is built from.
   *
   * A cloud deployment's answer is its public URL, and the difference matters: a loopback URL
   * produces a callback only a browser on this machine can follow.
   */
  readonly publicBaseUrl: string;
  /** Where durable state lives, when this deployment has a directory at all. */
  readonly dataDir: string;
  /** Exact browser origins allowed to call this gateway. Empty means no browser may. */
  readonly corsOrigins: readonly string[];
  /** The tenant this deployment serves. A multi-tenant deployment constructs one gateway each. */
  readonly tenant: TenantContext;
};

/**
 * Who state belongs to.
 *
 * Carried in configuration rather than on every call, because a tenant is a property of a
 * *deployment* and not of a request. A request's identity is `AuthContext`; a deployment's owner is
 * this.
 */
export type TenantContext = {
  /** Opaque and stable. Never shown to a user; used to scope storage and to separate deployments. */
  readonly id: string;
  /** A person-readable name, for an operator looking at a log. Never used as a key. */
  readonly label?: string;
};

/**
 * Who is making a request, and — in a deployment that cares — on whose behalf.
 *
 * Replaces a boolean. The HTTP layer currently threads `trustedDashboardRequest`, which is a real
 * and correct security decision expressed as a value with no owner and no name, so nothing else in
 * the system can ask *who*. This says who, and the boolean becomes a property of it.
 */
export type AuthContext = {
  /**
   * The claim, not the mechanism.
   *
   * `dashboard` is a request from an allowlisted origin on this machine. `api-key` is a request
   * carrying a key this gateway issued. `system` is the gateway itself — a health sweep, a sign-in
   * callback. Anything finer (a user id, a session id, scopes) belongs here once something needs it,
   * and a cloud deployment that needs it from the start can add it without changing the meaning of
   * these three.
   */
  readonly kind: 'dashboard' | 'api-key' | 'system';
  /** The API key's record, for `api-key`. The only case that identifies a caller today. */
  readonly apiKey?: ApiKeyRecord;
  readonly tenant: TenantContext;
};

/**
 * Whether a request may reach the LLM surface without a key.
 *
 * Asked rather than answered at the call site, because this is the single security decision a cloud
 * deployment changes: a hosted gateway is public and *every* request needs a key, while a loopback
 * gateway exempts its own dashboard so the operator can test models without one.
 */
export function isTrustedDashboard(auth: AuthContext): boolean {
  return auth.kind === 'dashboard';
}

/**
 * Credentials, keyed by **connection**.
 *
 * Named for what it keys on, and that is not incidental: the SDK already exports a `SecretStore`
 * which is keyed by *provider* and read-only, so two exported types shared one name while meaning
 * different things and taking different arguments. Anyone reading `SecretStore` in either package
 * had to open the other one to find out which they had. The gateway's is connection-keyed and
 * writable, and says so.
 *
 * Named for what it does rather than where it comes from. The service's dependency on it was
 * `Pick<ConnectionStore, 'get' | 'set' | 'delete'>`, which described the *local file store's* origin
 * rather than the shape the gateway needs, so "could this be remote" had to be answered by reading
 * a constructor.
 *
 * **The signatures here are the ones the code already uses**, which is not quite the shape I would
 * have drawn. `get` takes a provider id; `set` does not. That is genuinely inconsistent — a store
 * that keys by connection only does not need the provider, and one that keys by both does — and it
 * is preserved rather than tidied because a store re-keyed under a new signature is a migration to
 * every adapter's refresh callback, which is not this task's business. `ConnectionCredentialStore`
 * was the same shape under a name that described where it lived; this is the name that describes it.
 */
export type ConnectionSecretStore = {
  /** The credential for a connection, or `undefined` when there is none. */
  get(connectionId: string, providerId?: string): Promise<ProviderCredential | undefined>;
  /** Stores or replaces a credential. Called when a provider refreshes tokens. */
  set(connectionId: string, credential: ProviderCredential): Promise<void>;
  /**
   * Forgets a credential, leaving the connection itself alone, and reports whether there was one.
   *
   * Separate from removing a connection because they are different operations: a connection with no
   * credential is a real state the dashboard already shows as *"not connected"*, and a store that
   * conflated the two would make a credential revocation look like an outage.
   */
  delete(connectionId: string): Promise<boolean>;
};

/**
 * The local deployment, for every caller that does not supply one.
 *
 * A single explicit tenant rather than none, because *"no tenant"* would be a second value to
 * handle and a second thing to get wrong — and because a deployment that genuinely serves many
 * constructs one gateway per tenant, which is the scope a `SecretStore` can close over.
 */
export function localDeployment(over: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return Object.freeze({
    publicBaseUrl: over.publicBaseUrl ?? 'http://127.0.0.1:8787',
    dataDir: over.dataDir ?? defaultLocalDataDir(),
    corsOrigins: Object.freeze([...(over.corsOrigins ?? ['http://localhost:5173', 'http://127.0.0.1:5173'])]),
    tenant: over.tenant ?? Object.freeze({ id: 'local', label: 'This machine' }),
  });
}

/** Where a local deployment keeps its state. Named here so the default is visible in one place. */
function defaultLocalDataDir(): string {
  return join(homedir(), '.omnihilbras');
}

/**
 * The bundle one gateway instance is built with.
 *
 * Optional throughout, with local defaults, because the overwhelming majority of callers are
 * embedded or single-user and must not be asked to think about any of it. That is what keeps a cloud
 * boundary from becoming a tax on the local case it is supposed to be optional for.
 */
export type GatewayRuntime = {
  readonly deployment: DeploymentConfig;
  /** How the gateway answers *"is this a local operator?"* when nothing has said. */
  readonly auth?: AuthContext;
  readonly secrets: ConnectionSecretStore;
};
