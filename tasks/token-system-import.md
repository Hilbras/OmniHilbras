# Import the full token-saving system from OmniHilbras.old

Goal: bring the old RTK/Headroom-era token systems into the current gateway/TokenSaver architecture
without regressing the current safety properties (valid JSON, reversible rewrites, no credential leaks,
provider-neutral adapters). Old code is reference, not a drop-in: paths and provider wiring differ.

## Phase 0 — Cache-aware token accounting (P0 correctness)

- [ ] Extend `TokenUsage` with `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, and an
      `estimated` marker.
- [ ] Extend `UsageRecord`, `UsageTotals`, `UsageBreakdownGroup`, `PriceableUsage`, and dashboard types.
- [ ] Add `canonicalizeUsage` for OpenAI, Claude, Gemini and Responses shapes: fold Claude cache into
      prompt, keep cache read/write, pass OpenAI/Gemini already-inclusive prompt through, recompute total,
      and stay idempotent.
- [ ] Propagate cache fields through the 25 vendored SDK `TokenUsage` types and their usage normalizers.
- [ ] Price cache read/write from the existing pricing fields; stop charging cached input at full rate.
- [ ] Tests: each wire shape, idempotence, missing usage (unmeasured, not zero), cache cost.

## Phase 1 — Savings telemetry and stats

- [ ] Add per-request compression telemetry: saver id, bytes before/after, estimated tokens saved,
      units, detail/reason, cache read/create.
- [ ] Persist it on the usage record (`meta`-equivalent, no prompts or credentials) and expose it in
      `GET /v1/usage`.
- [ ] Add `GET /v1/token-saver/stats?period=` with per-saver, per-provider, requests-with-telemetry,
      savings, cost avoided, and provider cache figures.
- [ ] Dashboard: Token Saver page with period selector, per-saver table, “ran but matched nothing” vs
      disabled, and cache read/write.
- [ ] Tests: aggregation across periods, pending/new rows, absent telemetry distinguished from zero.

## Phase 2 — RTK specialized filters

- [x] Port into `Kernel/TokenSaver`: git diff, git status, git log, build output, grep, find, tree,
      ls, search-list, read-numbered, dedup-log, smart-truncate.
- [x] Port autodetect with the old 1024-byte detection window, 500-byte minimum, 10 MiB raw cap and
      per-filter caps (10 matches/file, 10 files/dir, 20 dirs, 200 log/tree lines).
- [x] Route them ahead of the generic JSON/log/text compressors; keep JSON-aware behaviour for JSON.
- [x] Keep CCR retrieval for every lossy filter.
- [x] Tests: one fixture per filter, autodetect ordering, caps, retrieval, no-op on non-matching input.

## Phase 3 — Output and context limits

- [x] Add `maxOutputTokensCap` and `thinkingBudgetCap` to config/runtime, applied before adapters and
      re-clamped in adapters that compute their own ceiling.
- [x] Add `POST /v1/messages/count_tokens` (char/4 estimate including system/tools, marked estimated).
- [x] Expose both in `/v1/settings`; do not claim exact tokenizer accuracy.
- [x] Tests: cap clamp, thinking clamp, count endpoint shape and estimate.

## Phase 4 — History trimming and cache anchoring

- [x] Add threshold-based history trimming: estimate the final body, stub whole old tool/assistant
      blocks above a configurable threshold, keep the first user ask, recent turns, system and errors.
- [x] Emit telemetry for trimmed turns and estimated before/after.
- [x] Anchor Claude cache breakpoints after every saver, on the final body.
- [x] Tests: threshold boundary, first-user/recent/error preservation, no trim below threshold, anchors.

## Phase 5 — Optional output-shaping and external savers

- [ ] Port Caveman and Ponytail system-prompt injection with off/level settings and telemetry.
- [ ] Add a Headroom adapter (external/URL, fail-open, phantom-savings guard) behind config.
- [ ] Add PXPIPE image-context hook (Claude-format only) behind config.
- [ ] Each external saver: timeout, off switch, per-request opt-out, honest “ran/skipped” telemetry.
- [ ] Tests: disabled means untouched; failure falls through; no request depends on the external service.

## Phase 6 — Wiring and documentation

- [ ] Single saver order in the gateway: RTK/specialized → generic/local → Headroom → PXPIPE →
      history trim → cache anchor.
- [ ] Settings page exposes every saver, cap and threshold; `/v1/settings` reports what is loaded.
- [ ] README, `docs/SPEC-SDK.md`, architecture counts and AGENTS updated.
- [ ] `pnpm verify` green; token-saver and gateway suites cover every new saver.

## Non-goals / decisions

- No provider tokenizer dependency; counts stay estimates and are labelled as such.
- Do not copy old code wholesale: reimplement in TypeScript and keep the current reversible/JSON-safe
  behaviour.
- External Headroom/PXPIPE are optional; the gateway must work with them absent.
- Old `addBufferToUsage` is not imported verbatim: inflating reported usage by 2000 tokens is a false
  measurement. Any safety buffer is applied to context decisions, not to reported provider usage.
