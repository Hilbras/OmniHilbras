# What the gateway market now treats as table stakes — and what OmniHilbras is missing

Read on 2026-11-26 from vendor documentation and two independent comparisons. The point is not to
copy a cloud gateway's feature list; it is to find the handful of capabilities that (a) the market
now assumes, (b) this project's existing data already makes cheap to add, and (c) matter more for a
local, single-operator gateway than for a hosted one.

## Sources

| Source | What was taken from it |
| --- | --- |
| [LLM gateway comparison: LiteLLM, OpenRouter and four alternatives](https://wz-it.com/en/knowledge/ki/llm-gateway-comparison/) (WZ-IT, Oct 2026) | Six gateways compared on operations, routing, budgets, keys, observability, guardrails |
| [LLM Routers Compared: LiteLLM vs Portkey vs OpenRouter](https://www.developersdigest.tech/blog/llm-router-comparison-2026) (Jun 2026) | The production checklist: multi-provider, fallbacks, cost tracking, load balancing, caching |
| [Cloudflare AI Gateway features](https://developers.cloudflare.com/ai-gateway/features/) (Nov 2026) | Caching, spend limits, rate limiting, auto router, dynamic routes, fallbacks |
| [Vercel AI Gateway docs](https://vercel.com/docs/ai-gateway) (Nov 2026) | Observability, budgets, trace drains, ZDR, provider/model allowlists, batch, service tiers, OIDC, BYOK |
| [TrueFoundry AI Gateway docs](https://www.truefoundry.com/docs/ai-gateway/caching) (Nov 2026) | Exact + semantic caching, cost tracking, access policies, MCP registry, prompt registry, guardrails, batch, rerank |
| [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/) | LLM01 prompt injection, LLM02 sensitive information, LLM06 excessive agency, LLM10 unbounded consumption |
| [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) (2026-07-28) | Confused deputy, token passthrough, SSRF, session hijacking, scope minimisation, local server compromise |
| [OpenTelemetry GenAI semantic conventions: November 2026 status](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/) | `gen_ai.*` spans/metrics, still Development, no release to pin yet |
| [promptfoo](https://www.promptfoo.dev/) | Evaluations, red teaming, guardrails and MCP proxy as one product surface |

## What the market now assumes

Every comparable gateway now offers, in some form: multi-provider routing with fallbacks, **cost
tracking and spend limits**, rate limits (requests and tokens), **caching**, **observability with
export**, **guardrails**, and — new in 2026 — **MCP as a first-class surface**. TrueFoundry and
Vercel add prompt registries, batch, rerank and provider/model allowlists; Cloudflare sells spend
limits scoped by model, provider or metadata dimension.

## What this project already has (verified in the tree)

- Fine-grained routing with candidates, hedges, circuit breaker, retries, idempotency and per
  connection rate limits (`routing-engine.ts`, `hedge-policy.ts`, `circuit-breaker.ts`,
  `idempotency.ts`, `rate-limit-policy.ts`).
- Per-request cost, token counts, cache-token counts and usage breakdown (`usage-pricing.ts`,
  `usage-canonical.ts`, `usage-breakdown.ts`), and a Prometheus endpoint (`core/metrics.ts`,
  `routes/metrics.ts`).
- API keys with `role`, `rpm`, `expiresAt`, `workspaceId`; audit trail; durable job history; SSE
  events with replay.
- An exact response cache — **30 s, in-memory, temperature 0 only** — and provider prompt-cache
  anchoring (`response-cache.ts`, `cacheAnchor`).
- An MCP introspection server and an operator-registered stdio→SSE plugin bridge (`routes/mcp.ts`,
  `routes/mcpPlugins.ts`), both with deliberate command/origin restrictions.

That is a stronger base than most of the market's self-hosted gateways. The gaps below are about
using data the project already collects, not about rebuilding the router.

## Gaps, ranked by value per unit of risk

### P0 — accountable spend (the largest gap, and mostly plumbing)

1. **Usage is not attributed to the key or workspace that spent it.**
   `UsageRecord` has no `apiKeyId`/`workspaceId`, and `UsageQuery` cannot filter by key. Every
   comparison gateway sells "spend by key/user/team"; this one cannot answer "who spent what". Add
   attribution first (old records stay explicitly unattributed), then filter/aggregate in `/v1/usage`
   and the usage page.
2. **No spend budget.** Cloudflare has cost budgets with windows; LiteLLM has per-key/user/team
   budgets. `rpm` and `expiresAt` are enforced, dollars are not. Add `budgetUsd` + `period`
   (`day|week|month|total`) and token quotas per key/workspace, enforce before dispatch using the
   usage aggregate, settle after, and expose remaining budget plus a documented refusal
   (`402`/`429`, `Retry-After`). Unpriced models must be honest: token quotas still apply, dollar
   budgets report "unpriced" rather than counting zero.
3. **Rate limits count requests, not tokens.** A TPM bucket next to `rpm` is what protects against
   one long-context request spending a minute's allowance. The token estimates already exist.
4. **A key cannot be confined to providers or models.** Vercel's provider/model allowlist is the
   pattern for a key that is handed to an agent: `allowedProviders`, `allowedModels` (glob),
   `allowedRoutes`. Enforced at dispatch, opt-in, so no existing key changes behaviour.

### P1 — safe to expose (the agent-era gate)

5. **No guardrails.** OWASP LLM01/02/06/10 are the relevant ones for a gateway: prompt injection
   arriving through provider responses, secrets leaving in logs, tool-call scope, unbounded
   consumption. A local policy engine — PII/secret redaction, blocked terms, max tokens, tool
   allowlist — with dry-run mode, per-connection/per-key rules and audit events. No cloud call.
6. **No trace export.** Metrics exist; spans do not. Emit an opt-in OTLP/HTTP exporter using a
   pinned subset of the `gen_ai.*` conventions (status is Development, so document the subset and
   the version), prompts excluded unless explicitly enabled, `recordAudit`-style sampling controls.
   This is what Vercel calls trace drains and TrueFoundry sells as log/metric export.
7. **MCP plugins have no per-tool approval.** The bridge already refuses `shell` and only spawns
   operator-registered ids, but any tool a plugin exposes runs on request. Add a per-plugin,
   per-tool allow/ask policy with audit, and an SSRF guard for URL-based plugins — the MCP security
   guide's confused-deputy and local-server-compromise sections.
8. **MCP introspection tools are read-only — keep it that way.** `list_connections`, `list_models`
   and `gateway_status` are the right surface for a gateway exposed to an agent. Any future
   write-capable MCP tool needs the same operator-registration rule the plugin bridge already
   applies, or the gateway becomes a credentialed shell for whoever holds the key.

### P2 — cheaper and faster (measurable savings)

9. **The cache is a placeholder.** 30 s, in-memory, temperature 0, not configurable, not shared.
   Make TTL/size configurable, persist it through the state seam, key it on the whole request
   (tools, response format, seed), honour `Cache-Control: no-store`, and expose `x-cache` plus hit
   metrics. Semantic caching should stay **opt-in and evaluated** — serve-similar-answer is how a
   gateway becomes confidently wrong.
10. **No batch surface.** `/v1/batches` over the durable job store: native where a provider has a
    batch API, bounded concurrency where it does not. The job history already records passes; this
    turns it into work.
11. **No rerank.** `/v1/rerank` (Cohere/Jina/Voyage-class providers). Cheap to add, expected by RAG
    users, and adjacent to the existing embeddings route.
12. **No webhooks.** Video generation and batch completion are polled. Signed HMAC delivery with
    retries and a dead-letter record turns the documented "request-driven polling" limit into a
    feature.

### P3 — product surface (the deferred E remainder)

13. **Eval harness and prompt registry.** The honest answer to "which provider is best for this
    task" is a test, not a table. Golden cases per provider/model, a CLI runner, and a CI gate that
    re-runs when a catalog or model changes — promptfoo's product surface, local-only.
14. **PWA, i18n and an axe gate.** A web manifest exists, but there is no service worker or offline
    shell, no message catalogue, and no automated accessibility check in the e2e suite. An
    installable dashboard shell and an axe run on every page are cheap wins; the wider
    design-system pass is already the documented E remainder.
15. **Desktop size.** Electron 45 packs a full Chromium; the unpacked build is large. Measure before
    choosing between trimming and Tauri; a rewrite is the riskiest item on this list and should not
    ride along with anything else.
16. **A2A.** An agent card is a small discovery surface; demand is still forming. Watch, do not lead.

## What not to copy

- **Cloud multi-tenancy, credits and hosted billing.** The vault, the key and the provider account
  are the user's; a budget is a local guardrail, not an invoice.
- **ZDR / prompt-training claims.** They are provider-policy statements, not gateway features; the
  gateway can record what a provider declares, not verify it.
- **Semantic cache on by default.** A wrong cached answer is worse than a slow right one.
- **Provider allowlists that silently break existing keys.** Every new restriction defaults off.
- **A feature that reports success without measuring.** The repo already fails tests for success
  states set in timers; the same rule applies to a budget, a cache hit or a guardrail.

## Proposed release slices

| Release | Contents | Why this order |
| --- | --- | --- |
| `4.1.0` | Usage attribution, budgets/quotas, TPM, key allowlists, dashboard spend view | Uses data already collected; answers the question every operator asks first |
| `4.2.0` | Guardrails, OTel export, MCP tool approvals, redaction/retention tests | Makes an exposed gateway defensible before adding more surface |
| `4.3.0` | Cache v2, batch, rerank, webhooks | Cost and latency wins, each on an existing seam |
| `5.0` or later | Eval harness, PWA/i18n/design system, desktop packaging decision, A2A | Product surface; the only slice that can justify a major |

Each new route needs its `Kernel/API/test/` coverage and a `docs/SPEC-SDK.md` line; each provider
capability needs its `Kernel/Tools/src/caps.ts` row; each new credential-shaped field needs the
vault round-trip test. Those rules already exist and are what keeps this list from becoming
folklore.

The executable version of this report — architecture decisions, acceptance tests, risks and
release slices — is [tasks/v5-plan.md](../../tasks/v5-plan.md).
