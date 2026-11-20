import { isProviderError, ProviderError, providerPrefixes } from './index.js';;
import { quotaTierOrder } from './connections.js';
import type { ConnectionRecord, ModelCooldown, ResilienceSettings } from './connections.js';

/** Why a candidate was skipped, so the gateway can explain the decision. */
export type RouteSkipReason = 'disabled' | 'no-credential' | 'unhealthy' | 'rate-limited' | 'model-cooling-down' | 'no-models';

export type RouteCandidate = {
  providerId: string;
  connectionId: string;
  priority: number;
  resilience: ResilienceSettings;
  /** Upstream model to send instead of the public model id (a virtual model target). */
  model?: string;
};

export type RouteDecision = {
  candidates: RouteCandidate[];
  skipped: Array<{ providerId: string; reason: RouteSkipReason }>;
};

/**
 * A sliding-window limiter. One window is kept per connection so a burst that
 * straddles a minute boundary cannot double the effective rate.
 */
export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * The wait in ms before the next request is allowed, or 0 when one is allowed now.
   *
   * **A query. It records nothing.** It used to push the timestamp into the window when it allowed
   * a request, and the request path calls `record()` as well — so every request was counted twice
   * and a connection set to 60 requests per minute behaved like 30. The over-count only bites when
   * a limit is actually set, and the default is no limit, which is why it survived.
   *
   * It also over-counted in a second way: a request that was refused still consumed budget, and so
   * did a request whose provider call was never made. `record()` is the commit, and it is called
   * when the request is dispatched.
   */
  check(key: string, limitPerMinute: number): number {
    if (limitPerMinute <= 0) return 0;
    const now = this.now();
    const cutoff = now - 60_000;
    const recent = (this.window(key, cutoff));
    if (recent.length < limitPerMinute) return 0;
    return Math.max(0, recent[0]! + 60_000 - now);
  }

  /** The requests still inside the window, for the dashboard's view of a connection's load. */
  private window(key: string, cutoff: number): number[] {
    return (this.windows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
  }

  /** Records a request that was allowed without going through `check`. */
  /**
   * Counts one request against a connection's budget.
   *
   * Called when a request is **dispatched**, not when it succeeds: a request that was sent and then
   * failed still cost the provider a call, and a rate limit that forgives failures is not a rate
   * limit. A request that was *refused* is not counted, because nothing was sent.
   */
  record(key: string) {
    const now = this.now();
    const recent = this.window(key, now - 60_000);
    recent.push(now);
    this.windows.set(key, recent);
  }

  /**
   * Drops the windows of connections that no longer exist.
   *
   * Distinct from `prune()`, and both are needed. `prune()` answers *"is this timestamp still inside the
   * window?"* and is the right question for a live connection — which `prune()` could do but **nothing
   * called**, so every window ever recorded was retained for the life of the process. Measured: 3000
   * connections dispatched once each left 3000 windows behind, and `prune()` had to be called by hand to
   * clear them.
   *
   * Age alone cannot answer this either. A connection created ten minutes ago and dispatched to once has a
   * window that is stale by `prune()`'s standard and current by the connection store's, and pruning by age
   * would forgive the budget of a connection that still exists. So the live set decides existence and
   * `prune()` decides age, and neither is asked to do the other's job.
   */
  retain(liveKeys: ReadonlySet<string>): void {
    for (const key of this.windows.keys()) {
      if (!liveKeys.has(key)) this.windows.delete(key);
    }
  }

  /** Releases retained windows so an idle gateway does not grow without bound. */
  prune(maxAgeMs = 120_000) {
    const cutoff = this.now() - maxAgeMs;
    for (const [key, timestamps] of this.windows) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length === 0) this.windows.delete(key);
      else this.windows.set(key, recent);
    }
  }
}

export type ProviderOutcome = {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
};

/**
 * Tracks recent provider outcomes so routing can skip a connection that is
 * failing right now, without waiting for a health poll.
 */
/** How long an ejected provider waits before one probe request is allowed. */
const defaultRecoveryCooldownMs = 30_000;
const defaultMaxRecoveryCooldownMs = 10 * 60_000;
/**
 * The first wait for one account-and-model, and the ceiling the ladder climbs to.
 *
 * 60 s rather than the reference implementation's 2 s: our per-provider ejection already covers the
 * "something is briefly wrong" case at 30 s, and this cooldown exists for the *account's allowance*,
 * which a provider does not restore in two seconds. The ladder below is theirs (base × 2^(level-1)),
 * because the reason for it is theirs: an account that keeps refusing should be asked less often, not
 * every minute forever.
 */
const defaultModelCooldownMs = 60_000;
const maxModelCooldownMs = 30 * 60_000;

function modelKey(providerId: string, modelId: string) {
  return `${providerId}:${modelId}`;
}

export class HealthRegistry {
  private readonly state = new Map<string, { failures: number; successes: number; lastFailureAt?: number; lastCheckedAt?: string; lastLatencyMs?: number; lastError?: string }>();
  /** Cooldowns per `<connection or provider>:<model>`, each with the ladder level that produced its wait. */
  private modelCooldowns = new Map<string, ModelCooldown>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly recoveryCooldownMs: number = defaultRecoveryCooldownMs,
    private readonly maxRecoveryCooldownMs: number = defaultMaxRecoveryCooldownMs,
    /**
     * Called after a cooldown changes, so the vault can keep it.
     *
     * Optional because a registry is perfectly usable without a place to write — the embedded and test
     * callers pass nothing. Never awaited: a failure to record bookkeeping must not fail the request
     * that is asking for an answer.
     */
    private readonly persistCooldown?: (key: string, cooldown: ModelCooldown | undefined) => void,
  ) {}

  /** Seeds cooldowns read back from the vault, so a restart does not re-hammer an exhausted account. */
  seedModelCooldowns(cooldowns: Record<string, ModelCooldown>) {
    for (const [key, cooldown] of Object.entries(cooldowns)) {
      if (cooldown && cooldown.until > this.now()) this.modelCooldowns.set(key, { until: cooldown.until, level: cooldown.level });
    }
  }

  recordSuccess(providerId: string, latencyMs: number, checkedAt = new Date().toISOString()) {
    const current = this.state.get(providerId) ?? { failures: 0, successes: 0 };
    this.state.set(providerId, { failures: 0, successes: current.successes + 1, lastCheckedAt: checkedAt, lastLatencyMs: latencyMs });
  }

  /**
   * A refused login is a fact about one connection's credential, not about the provider's health: the provider's other
   * connections may be fine. The reason is kept for the dashboard, without counting toward ejecting the provider.
   *
   * `key` is the **connection id** when the caller knows it, and the provider id otherwise — the same rule
   * `recordFailure` follows one method up. It used to be the provider id unconditionally, so a refused refresh on
   * one account wrote its reason onto the provider and a two-account provider reported "sign in again" for a row
   * that was answering fine, which is what was reported as *"with two accounts, the healthy one is skipped"*.
   */
  noteLoginRefused(key: string, reason: string) {
    const current = this.state.get(key) ?? { failures: 0, successes: 0 };
    this.state.set(key, { ...current, lastError: `AUTHENTICATION_FAILED: ${reason}` });
  }

  recordFailure(providerId: string, errorCode: string, errorMessage: string) {
    const current = this.state.get(providerId) ?? { failures: 0, successes: 0 };
    this.state.set(providerId, { ...current, failures: current.failures + 1, lastFailureAt: this.now(), lastCheckedAt: new Date().toISOString(), lastError: `${errorCode}: ${errorMessage}` });
  }

  /**
   * A rate limit is a fact about one model's quota, so it cools that model alone.
   *
   * The wait grows with each consecutive refusal of the same pair and resets on a success, which is the
   * reference implementation's ladder (`getQuotaCooldown`): 1 min, 2, 4, 8 … capped. A provider that
   * keeps saying no should be asked less often, and an account that answered is not cooling at all —
   * `clearModelCooldown` is what makes the second half true.
   *
   * A provider that states its own reset time (`Retry-After`) is believed over the ladder and its level
   * is left alone, because a known expiry is better information than a guess about how often to retry.
   */
  recordModelRateLimit(providerId: string, modelId: string, input: { retryAfterMs?: number } = {}) {
    const key = modelKey(providerId, modelId);
    const previous = this.modelCooldowns.get(key);
    if (input.retryAfterMs !== undefined) {
      const cooldown = { until: this.now() + Math.min(input.retryAfterMs, maxModelCooldownMs), level: previous?.level ?? 0 };
      this.modelCooldowns.set(key, cooldown);
      this.persistCooldown?.(key, cooldown);
      return;
    }
    const level = Math.min((previous?.level ?? 0) + 1, 16);
    const waitMs = Math.min(defaultModelCooldownMs * Math.pow(2, level - 1), maxModelCooldownMs);
    const cooldown = { until: this.now() + waitMs, level };
    this.modelCooldowns.set(key, cooldown);
    this.persistCooldown?.(key, cooldown);
  }

  /**
   * The account answered for this model, so it is not cooling.
   *
   * Without this, the ladder only ever climbed: a pair that failed once stayed "level 1" forever, so the
   * next unrelated failure jumped to a four-minute wait, and a model that had been served successfully
   * still had to wait out a cooldown it no longer needed.
   */
  clearModelCooldown(providerId: string, modelId: string) {
    const key = modelKey(providerId, modelId);
    if (!this.modelCooldowns.has(key)) return;
    this.modelCooldowns.delete(key);
    this.persistCooldown?.(key, undefined);
  }

  isModelCoolingDown(providerId: string, modelId: string) {
    const cooldown = this.modelCooldowns.get(modelKey(providerId, modelId));
    return cooldown !== undefined && this.now() < cooldown.until;
  }

  /** Every live cooldown, for a caller that wants to keep them. */
  cooldowns(): Record<string, ModelCooldown> {
    const live: Record<string, ModelCooldown> = {};
    for (const [key, cooldown] of this.modelCooldowns) if (cooldown.until > this.now()) live[key] = cooldown;
    return live;
  }

  /**
   * A connection is treated as unhealthy only after consecutive failures, so a
   * single blip does not eject a working route. After the cooldown it is probed
   * again, so a recovered provider rejoins the chain without a restart.
   */
  isUnhealthy(providerId: string, threshold: number) {
    if (threshold <= 0) return false;
    const current = this.state.get(providerId);
    if (!current || current.failures < threshold) return false;
    const exponent = Math.max(0, current.failures - threshold);
    const cooldown = Math.min(this.recoveryCooldownMs * Math.pow(2, exponent), this.maxRecoveryCooldownMs);
    return this.now() - (current.lastFailureAt ?? 0) < cooldown;
  }

  snapshot(providerId: string, threshold: number) {
    const current = this.state.get(providerId);
    if (!current) return undefined;
    return {
      failures: current.failures,
      successes: current.successes,
      ...(current.lastCheckedAt === undefined ? {} : { lastCheckedAt: current.lastCheckedAt }),
      ...(current.lastLatencyMs === undefined ? {} : { lastLatencyMs: current.lastLatencyMs }),
      ...(current.lastError === undefined ? {} : { lastError: current.lastError }),
      ...(this.isUnhealthy(providerId, threshold) ? { ejected: true } : {}),
    };
  }

  forget(providerId: string) {
    this.state.delete(providerId);
  }

  /**
   * A cheap, stable string over the stored health state, for change detection (Phase 4).
   *
   * Read from the in-memory map only — it never probes a provider — so the real-time state channel can poll
   * it every second without spending a request. It changes when a failure, success, error or check time
   * changes, which is exactly what the dashboard needs to know to refresh. Sorted so map order cannot make
   * two identical states look different.
   */
  fingerprint(): string {
    return JSON.stringify(
      [...this.state.entries()]
        .map(([key, value]) => [key, value.failures, value.successes, value.lastError ?? '', value.lastCheckedAt ?? ''])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  }
}

/**
 * Wording that means *this account is out*, whatever status the provider wrapped it in.
 *
 * Matched against the provider's own message, case-insensitively, before the status code is looked at.
 * This is the rule the reference implementation taught (`ERROR_RULES` in its `errorConfig.js`), and the
 * reason it is here is concrete: an exhausted plan is not always a `429`. Aggregators answer `422` or
 * `400` with `insufficient_quota` in the body, or a `200` carrying a refusal — none of which the status
 * alone can tell apart from a malformed request. Those used to be treated as "the provider rejected
 * this request", which is terminal, so the *next account was never asked* and a healthy sibling sat
 * unused while the request failed.
 *
 * Deliberately narrow. Every phrase here describes the account or its allowance; none of them
 * describes the request. A `400` about the request itself must not rotate, because cooling an account
 * down over a bad body removes a working connection from rotation for everyone.
 */
const quotaOrCapacityWording = [
  'rate limit',
  'too many requests',
  'quota exceeded',
  'insufficient_quota',
  'insufficient quota',
  'exceeded your current quota',
  'exceeded your quota',
  'exceed quota',
  'quota limit',
  'quota exhausted',
  'quota reached',
  'no quota',
  'credit balance',
  'insufficient credit',
  'insufficient balance',
  'insufficient_balance',
  'billing',
  'capacity',
  'overloaded',
  'out of credit',
  'no remaining',
] as const;

/**
 * A scarcity word next to `quota` also means the allowance is gone, whatever the phrasing.
 *
 * Written as a pair of tests rather than a longer phrase list because the phrasings are unbounded and
 * the real ones arrived from the field: ZCode refuses a turn inside a `200` with `1005 exceed quota
 * limit`, which matched nothing in the list above — "quota exceeded" but never "exceed quota limit" —
 * so the account stayed in the terminal path and its siblings were never asked. A provider is free to
 * word this however it likes; what identifies it is that the sentence is about an allowance and says
 * that allowance is not available.
 *
 * Still narrow: a message that mentions quota without one of these words is about something else, and
 * does not rotate.
 */
const scarcityWording = ['exceed', 'limit', 'insufficient', 'exhaust', 'depleted', 'out of', 'no remaining', 'reached', 'zero', 'empty'] as const;

/** The provider's own words about this failure, if it gave any. */
function providerWording(error: unknown): string {
  if (!isProviderError(error)) return '';
  const details = error.details as { providerMessage?: unknown } | undefined;
  const said = typeof details?.providerMessage === 'string' ? details.providerMessage : '';
  return `${error.message} ${said}`.toLowerCase();
}

/** Whether the provider's sentence says the account has no allowance left. */
function saidQuotaIsGone(wording: string): boolean {
  if (quotaOrCapacityWording.some((phrase) => wording.includes(phrase))) return true;
  return wording.includes('quota') && scarcityWording.some((word) => wording.includes(word));
}

/**
 * The same test, for a caller that holds only the provider's message — the health sweep.
 *
 * A probe failure arrives as a string, because an adapter's `healthCheck` catches its own error to
 * report `unavailable` rather than throwing. That is where the second half of the ZCode failure lived:
 * the sweep spends a real turn, an account with no allowance refuses it, and the refusal was recorded
 * **against the provider**, ejecting every account of that provider for `30 s × 2^(failures-3)` — about
 * half an hour once nine had accumulated, including the account that was working.
 */
export function saysAllowanceExhausted(text: string): boolean {
  return saidQuotaIsGone(text.toLowerCase());
}

/**
 * Wording that means *the provider has restricted this account*, not that it has run out of anything.
 *
 * The distinction is the response, and it is the opposite of the allowance case. An exhausted allowance is
 * a fact a sibling can answer, so the walk continues. A restriction is the provider saying "something about
 * this session looks wrong" — and asking the *next* account through the same client fingerprint, from the
 * same address, is what turns one restricted account into several. So this stops the walk.
 *
 * Taken from a real refusal, CodeBuddy's `403` body:
 *
 * ```
 * {"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to
 *  unusual activity","zh":"账号存在异常行为,已被限制使用"}}
 * ```
 *
 * Both languages are matched, because the browser-facing message is localised and only the `msg` field is
 * reliably English.
 */
const accountRestrictedWording = [
  'request illegal',
  'unusual activity',
  'account has been restricted',
  'account restricted',
  'account is restricted',
  'account suspended',
  'account flagged',
  '账号存在异常行为',
  '已被限制',
  '账号异常',
] as const;

export function saysAccountRestricted(text: string): boolean {
  const wording = text.toLowerCase();
  return accountRestrictedWording.some((phrase) => wording.includes(phrase.toLowerCase()));
}

/** The provider's own words, for a caller holding the error rather than the message. */
export function providerWordingOf(error: unknown): string {
  return providerWording(error);
}

/**
 * A refusal that is about the account's **allowance**, not the provider's health.
 *
 * The distinction is the whole fix: "you have used your quota" is a fact about one credential that
 * another account answers, while a `5xx` or a timeout is the provider being unwell and is exactly what
 * the ejection counter exists for. Charging the first to health meant a spent account ejected itself —
 * and, via the provider-level verdict, its working siblings with it.
 */
export function isAllowanceRefusal(error: unknown): boolean {
  if (!isProviderError(error)) return false;
  if (saidQuotaIsGone(providerWording(error))) return true;
  if (error.code === 'RATE_LIMITED') return true;
  const status = error.statusCode;
  return status === 402 || status === 403 || status === 404 || status === 429;
}

/**
 * Whether this failure says something about **the account**, and so belongs on the next account.
 *
 * Distinct from `isRetryableFailure`, which asks whether the same route is worth retrying. The two
 * answer different questions and had been conflated: a `400` is not worth retrying on the same account,
 * but `insufficient_quota` on a `400` is a reason to try the *next* one.
 */
export function shouldRotateAccount(error: unknown): boolean {
  if (!isProviderError(error)) return false;
  // A caller who hung up is not a vote against the account.
  if (error.code === 'CANCELLED') return false;

  /**
   * A **restriction** outranks everything below, including the allowance rule.
   *
   * It is checked first because the two can appear in the same body, and the response differs: an exhausted
   * allowance belongs on the next account, while "this account has been restricted" is about the *client*
   * the provider is seeing — so walking on means presenting the same fingerprint again, from the same
   * address, to the next account. That is how one restricted account becomes several. The request stops,
   * the account is cooled, and the person is told what the provider said.
   */
  const wording = providerWording(error);
  if (saysAccountRestricted(wording)) return false;

  /**
   * The provider's own wording outranks its status code, and is checked first.
   *
   * An exhausted plan is not reliably a `429`: aggregators answer `422`, `400`, or even `403` with
   * `insufficient_quota` in the body. The status then reads as "the request was refused", which is
   * terminal, and the sibling account that could have served the request is never asked. Matching the
   * words first is the reference implementation's rule (`ERROR_RULES`), and it is what makes a plan
   * that ran out rotate while a genuinely malformed body still does not.
   */
  if (saidQuotaIsGone(wording)) return true;

  /**
   * A **local** concurrency saturation is not the account's allowance.
   *
   * `maxConcurrentRequests` is our own in-flight counter, and it is momentary: the request that
   * happened to arrive while the account was busy must be told so, not quietly re-billed to a sibling
   * and not treated as "this account is out". The limiter already marks it (`concurrencyLimited`,
   * `retryable: false`) because it is retryable *later*, not *elsewhere*.
   */
  const details = error.details as { concurrencyLimited?: unknown } | undefined;
  if (details?.concurrencyLimited === true) return false;

  /**
   * The allowance is gone: the account is spent, but the *request* is fine.
   *
   * These rotate. `402` is "payment required", `403` is how several providers signal a plan ceiling,
   * `404` is the model not being on this plan, and `429` is the limit itself. A sibling with quota
   * answers the same request — that is the whole point of holding several accounts.
   */
  const status = error.statusCode;
  if (status === 402 || status === 403 || status === 404 || status === 429) return true;
  // The provider is unwell; another account may be on a healthier host. Neither says anything about
  // the request. A 5xx *without* a retry budget still deserves the sibling.
  if (status !== undefined && status >= 500) return true;
  // A limit by name, with no status to read. Timeouts and unavailability are deliberately **not** here:
  // they are what a retry budget exists for, and moving on before spending it would skip an account
  // that is merely slow.
  return error.code === 'RATE_LIMITED';

  /**
   * Everything below is **not** the allowance, and moving on would spend a sibling for nothing:
   *
   * - `401` / `AUTHENTICATION_FAILED` — this account's credential is dead. A sibling has its own
   *   credential and would answer, so rotating would *work*; it is refused here for a different reason:
   *   a revoked key is an operator problem to fix, not something to paper over by quietly billing
   *   another account. The dashboard reports it against the account that owns it.
   * - `INVALID_REQUEST` / `NOT_SUPPORTED` — the request or the model is wrong; every account refuses
   *   it identically, so each one tried is a wasted upstream call.
   *
   * Both were measured before this rule existed: a request with a bad body was dispatched to eleven
   * providers over 9–90 s before the client was told nothing could serve it.
   */
  return false;
}

/** Failures worth another attempt. Bad requests and auth errors never are. */
export function isRetryableFailure(error: unknown) {
  if (!isProviderError(error)) return false;
  if (error.code === 'CANCELLED') return false;
  if (error.code === 'INVALID_REQUEST' || error.code === 'AUTHENTICATION_FAILED' || error.code === 'NOT_SUPPORTED' || error.code === 'NOT_FOUND') return false;
  /**
   * `INVALID_RESPONSE` is about the *answer*, not the request, and that distinction is the whole
   * reason it is here.
   *
   * Every code above describes this request or this credential: the model is wrong, the key is
   * refused, the lane does not exist. Another provider will refuse them the same way, so trying one
   * spends an upstream request to learn nothing. `INVALID_RESPONSE` is the opposite — the provider
   * accepted the request and returned a body nobody could read, which is 23 sites across the
   * adapters and says nothing at all about whether the *next* provider can answer.
   *
   * Before this, the system contradicted itself: the failover loop called `recordFailure` with this
   * code, marking the connection unhealthy, and then immediately stopped instead of trying a
   * connection the health system had just judged capable. One provider returning an empty stream
   * took down a request a healthy second provider would have served.
   */
  if (error.code === 'INVALID_RESPONSE') return true;
  return error.retryable || error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'RATE_LIMITED' || error.code === 'PROVIDER_REQUEST_FAILED';
}

/**
 * Splits a `provider/model` request into its provider and model, but only when the prefix is a
 * provider this gateway actually has a connection for.
 *
 * Splitting at the first slash alone would misread real model ids: most ids in the catalog already
 * contain one (`qwen/qwen3.8-27b:free`), and `qwen` is not a provider prefix there. So the prefix must
 * name a connected provider, and anything else is returned unchanged as a bare model id.
 */
export function splitProviderPrefix(
  model: string,
  connections: readonly Pick<ConnectionRecord, 'providerId'>[],
): { model: string; providerId?: string } {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return { model: trimmed };
  const prefix = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  if (!rest) return { model: trimmed };
  // The id, the current slug, or a slug this table used to publish — so a client that saved an id before
  // a rename still resolves. See `provider-slugs.ts`.
  const owner = connections.find((connection) => connection.providerId === prefix || providerPrefixes(connection.providerId).includes(prefix));
  return owner ? { model: rest, providerId: owner.providerId } : { model: trimmed };
}

/**
 * The model name a provider must receive. A `provider/model` id is for the gateway, which uses the prefix to
 * choose a connection; a provider does not know its own prefix and refuses the name with it.
 *
 * Only the dispatched provider's own id or slug is removed, so a model whose real name contains a slash
 * (`qwen/qwen3.8-27b:free` on a provider that is not `qwen`) is sent unchanged.
 */
export function bareModelFor(model: string, providerId: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return trimmed;
  const prefix = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  if (!rest) return trimmed;
  return prefix === providerId || providerPrefixes(providerId).includes(prefix) ? rest : trimmed;
}

/**
 * The form a model name is compared in, for finding its connection only. It never changes what is sent upstream.
 *
 * A dot between digits and a dash are the same version (`claude-sonnet-4.5` and `claude-sonnet-4-5`), and a trailing
 * `(level)` is the thinking setting, not part of the model. Both are dropped for the comparison, so every spelling
 * reaches the connection that lists the model.
 */
export function lookupModelId(model: string): string {
  return model.trim().replace(/\(([^()]+)\)\s*$/, '').replace(/(\d)\.(\d)/g, '$1-$2').toLowerCase();
}

/**
 * The family a bare model name belongs to: its leading word, for the names that carry one. A prefixed name
 * (`provider/model`) names its provider itself and has no family to match.
 */
export function bareModelFamily(model: string): string | undefined {
  if (model.includes('/')) return undefined;
  const match = /^(claude|gpt|gemini)/i.exec(model.trim());
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * Turns the balanced connections of one priority so the first one changes with each request. A connection that does not
 * ask for balancing keeps its place, and so does every other priority, so a higher priority still wins.
 */
function rotateBalancedConnections(sorted: ConnectionRecord[], rotation: number) {
  if (rotation <= 0) return;
  let start = 0;
  while (start < sorted.length) {
    const priority = sorted[start]!.priority;
    let end = start;
    while (end < sorted.length && sorted[end]!.priority === priority) end += 1;
    const group = sorted.slice(start, end);
    const balanced = group.filter((connection) => connection.balance === true);
    if (balanced.length > 1) {
      const turn = rotation % balanced.length;
      const rotated = [...balanced.slice(turn), ...balanced.slice(0, turn)];
      let next = 0;
      for (let index = start; index < end; index += 1) {
        if (sorted[index]!.balance === true) sorted[index] = rotated[next++]!;
      }
    }
    start = end;
  }
}

/**
 * The `fastest` strategy: within each priority band, measured connections first, quickest first.
 *
 * Three decisions worth stating, because each is a way this could quietly do harm:
 *
 * - **Priority is never reordered.** Bands keep their order, so a `fastest` provider still respects the
 *   priorities an operator set; only the accounts sharing a priority are re-ordered. Otherwise one fast
 *   account would outrank every deliberate choice above it.
 * - **An unmeasured connection sorts after every measured one.** No samples means no reading, and
 *   "unknown" is not "fast" — a brand-new account should not outrank one with a measured 200 ms until
 *   it has proven itself. Once it has samples it competes normally.
 * - **A single sample is enough to compete.** The ledger reports `samples` so a stricter caller could
 *   demand more, but the alternative — refusing to order until N samples — leaves a provider with two
 *   accounts on name order for its first N requests. The EWMA settles quickly, and a bad first reading
 *   costs one request, not a permanent choice.
 *
 * A provider not set to `fastest` is untouched: the comparator returns without sorting anything.
 */
function orderFastestFirst(
  connections: ConnectionRecord[],
  strategyFor: ((providerId: string) => 'priority' | 'round-robin' | 'fastest') | undefined,
  latencyFor: ((connectionId: string) => { latencyMs: number; samples: number } | undefined) | undefined,
): void {
  if (!strategyFor || !latencyFor) return;
  const bands = new Map<string, ConnectionRecord[]>();
  for (const connection of connections) {
    if (strategyFor(connection.providerId) !== 'fastest') continue;
    const key = `${connection.providerId}:${connection.priority}`;
    const band = bands.get(key) ?? [];
    band.push(connection);
    bands.set(key, band);
  }
  for (const band of bands.values()) {
    if (band.length < 2) continue;
    const ordered = [...band].sort((left, right) => {
      const a = latencyFor(left.id);
      const b = latencyFor(right.id);
      // Unmeasured last; ties fall back to name so the order is deterministic between requests.
      if (!a && !b) return left.name.localeCompare(right.name);
      if (!a) return 1;
      if (!b) return -1;
      return a.latencyMs - b.latencyMs || left.name.localeCompare(right.name);
    });
    // Rewrite the band in place, keeping every other connection where it is.
    let cursor = 0;
    for (let index = 0; index < connections.length; index += 1) {
      const current = connections[index];
      if (!current || !band.includes(current)) continue;
      const next = ordered[cursor];
      if (!next) continue;
      connections[index] = next;
      cursor += 1;
    }
  }
}

/** Resolves a failover chain, ordered by priority then name for determinism. */
export function resolveRoute(input: {
  connections: ConnectionRecord[];
  model: string;
  explicitProviderId?: string;
  health: HealthRegistry;
  failureThreshold: number;
  rateLimitWaitMs?: Map<string, number>;
  /** Advances once per request, so balanced connections at one priority take turns. Zero keeps the name order. */
  rotation?: number;
  /** The model family a provider declares (`claude`, `gpt`), so a bare name is routed only within its family. */
  familyOf?: (providerId: string) => string | undefined;
  /** A provider's strategy; only `fastest` changes this function's order. */
  strategyFor?: (providerId: string) => 'priority' | 'round-robin' | 'fastest';
  /** Measured round trip per connection, for the `fastest` strategy. */
  latencyFor?: (connectionId: string) => { latencyMs: number; samples: number } | undefined;
  /** Sticky connection id preferred for this model, when still a candidate. */
  stickyFor?: (modelId: string) => string | undefined;
  /**
   * An account the caller named, which goes first **regardless of priority**.
   *
   * The caller asked for this account, so "first" is the promise; the siblings keep their priority
   * order behind it. Without this the sort below undid the pin whenever the chosen account was not
   * also the highest-priority one — which is every account a person clicks on but the first.
   */
  pinnedConnectionId?: string;
}): RouteDecision {
  const modelId = input.model.trim();
  const usable = input.connections
    .filter((connection) => connection.enabled && connection.hasCredential)
    .sort((left, right) =>
      // Paid accounts before cheap before free, then the existing priority and name. An absent tier
      // sorts with `paid` (0) so every record written before tiers existed keeps its old placement.
      (quotaTierOrder[left.quotaTier ?? 'paid'] - quotaTierOrder[right.quotaTier ?? 'paid'])
      || left.priority - right.priority
      || left.name.localeCompare(right.name));
  rotateBalancedConnections(usable, input.rotation ?? 0);
  orderFastestFirst(usable, input.strategyFor, input.latencyFor);
  // Last, so nothing above can reorder over it: the named account leads, priority or not.
  if (input.pinnedConnectionId !== undefined) {
    const index = usable.findIndex((connection) => connection.id === input.pinnedConnectionId);
    if (index > 0) {
      const [pinned] = usable.splice(index, 1);
      if (pinned) usable.unshift(pinned);
    }
  }

  const skipped: RouteDecision['skipped'] = [];
  const lookupId = lookupModelId(modelId);
  const ownsModel = (connection: ConnectionRecord) => lookupId.length > 0 && connection.modelIds.some((saved) => lookupModelId(saved) === lookupId);

  if (input.explicitProviderId) {
    // An explicit request is a deliberate pin: it is served even when the model
    // is not in that connection's catalog.
    const pinned = usable.filter((connection) => connection.providerId === input.explicitProviderId);
    if (pinned.length > 0) {
      return { candidates: pinned.map(toCandidate), skipped: [] };
    }
    // A pin with no usable connection is refused here, not routed to another provider. The caller chose that
    // provider, so serving the request elsewhere would bill a provider they did not pick.
    const configured = input.connections.filter((connection) => connection.providerId === input.explicitProviderId);
    const reason: RouteSkipReason = configured.some((connection) => !connection.enabled) ? 'disabled'
      : configured.length > 0 ? 'no-credential'
      : 'no-models';
    return { candidates: [], skipped: [{ providerId: input.explicitProviderId, reason }] };
  }

  const matching = usable.filter(ownsModel);
  const family = bareModelFamily(modelId);
  /**
   * The fallback pool when nothing lists the model.
   *
   * It is **every usable connection** when the name carries no family, and that is deliberate: a
   * provider can serve a model its catalog omits, and `routing.test.js` pins it ("a model no
   * connection lists still routes"). The cost is real, though — an unknown id was dispatched to 11
   * providers over 9–90 s before the client was told nothing could serve it. Narrowing it would break
   * the documented behaviour, so it stays as the test requires.
   */
  const sameFamily = family === undefined || !input.familyOf
    ? usable
    : usable.filter((connection) => input.familyOf!(connection.providerId) === family);
  if (matching.length === 0 && family !== undefined && input.familyOf && sameFamily.length === 0) {
    return { candidates: [], skipped: usable.map((connection) => ({ providerId: connection.providerId, reason: 'no-models' as const })) };
  }
  const fallbackPool = matching.length > 0 ? matching : sameFamily;
  /**
   * Whether the provider's own id is also the id of one of its connections.
   *
   * It very often is — the first account of a provider is saved under the provider id (`zcode`, and the
   * same shape for kiro, cline, every card whose first sign-in writes `providerId` as the connection
   * id). That aliasing made the provider-level check below read **that account's** counter, so one
   * account's failures ejected its siblings: with two ZCode accounts the working one was skipped as
   * `unhealthy` and the request failed with "Tried: zcode" while the second account was answering
   * normally. Counters keyed that way belong to the connection and are already read above.
   */
  const providerKeyIsAConnection = input.connections.some((connection) => connection.id === connection.providerId);
  const candidates: RouteCandidate[] = [];
  for (const connection of fallbackPool) {
    // Health is recorded per connection for request outcomes, and per provider for a background
    // sweep. Either answer ejects the connection: a provider-level check that failed says nothing
    // good about any account on it, while one account's failures must not eject its sibling — which
    // is what `providerKeyIsAConnection` guards against.
    const providerVerdict = providerKeyIsAConnection ? false : input.health.isUnhealthy(connection.providerId, input.failureThreshold);
    if (input.health.isUnhealthy(connection.id, input.failureThreshold) || providerVerdict) {
      skipped.push({ providerId: connection.providerId, reason: 'unhealthy' });
      continue;
    }
    // The same aliasing applies to the cooldown: with `zcode` as both the provider id and the first
    // account's id, a provider-keyed cooldown is that account's cooldown, and reading it here would
    // stand the *sibling* down for a model its own allowance covers.
    const providerCoolingDown = providerKeyIsAConnection ? false : input.health.isModelCoolingDown(connection.providerId, modelId);
    if (input.health.isModelCoolingDown(connection.id, modelId) || providerCoolingDown) {
      skipped.push({ providerId: connection.providerId, reason: 'model-cooling-down' });
      continue;
    }
    const waitMs = input.rateLimitWaitMs?.get(connection.id) ?? 0;
    if (waitMs > 0) {
      skipped.push({ providerId: connection.providerId, reason: 'rate-limited' });
      continue;
    }
    candidates.push(toCandidate(connection));
  }
  const stickyId = input.stickyFor?.(modelId);
  if (stickyId) {
    const idx = candidates.findIndex((c) => c.connectionId === stickyId);
    // Sticky never overrides a higher-priority (lower number) connection: priority still wins,
    // and health tracking on the preferred connection must keep happening.
    if (idx > 0 && (candidates[idx]?.priority ?? 0) <= (candidates[0]?.priority ?? 0)) {
      const sticky = candidates.splice(idx, 1)[0];
      if (sticky) candidates.unshift(sticky);
    }
  }
  return { candidates, skipped };
}

function toCandidate(connection: ConnectionRecord): RouteCandidate {
  return {
    providerId: connection.providerId,
    connectionId: connection.id,
    priority: connection.priority,
    resilience: { ...connection.resilience },
  };
}

export const noCandidateMessage = 'No enabled provider connection can serve this model.';
