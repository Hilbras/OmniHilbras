# Cycle 5 review note — corrections to the whole-system comparison

This is a **new** note. `tasks/parity-loop/README.md:47` forbids deleting or overwriting an existing
report, so the corrections below are recorded here while `docs/reports/parity-cycle-5-system.md` and
the earlier reports stay exactly as they were written. The review behind it was local and read-only:
the report, the files it names, and both trees' release metadata were read; no live provider request,
Playwright run or `pnpm verify` was performed by the reviewer.

## Bookkeeping that was wrong

- `tasks/parity-loop/state.json` said `cycle: 4, step: 2` while its own history already recorded a
  cycle-4 step-3 event. It now says cycle 5, step 2, `running`, with `full_comparison` and
  `improvement_plan` pointing at `docs/reports/parity-cycle-5-system.md` and `provider_comparison` at
  `docs/reports/parity-cycle-4-providers.md`. A new history entry records why the stale plan items
  must not be re-planned.
- `docs/reports/9router-parity-scorecard.md` still carried cycle-4 evidence. The numeric scores remain
  the cycle-4 measurement — nothing here re-scores the whole loop without a fresh measurement — but
  row 6's video claim is corrected with the committed code, and row 12 stays red until the `3.98.0`
  ceremony actually ships. `tests/parity-state.test.js` is the new guard: the highest-numbered
  `parity-cycle-*-system.md` must match `state.cycle`, every `last_reports` path must exist, and the
  current cycle must have a history entry.

## Report items that are already done — do not re-plan them

1. **Item 2 (video) is implemented.** The cycle-5 report's §5 (`:133-137`) says `/v1/videos/*`
   refuses every request and no adapter exists. That is false in the working tree: the real xAI
   transport is `Kernel/SDK/xai/adapter/index.ts:87-135`, the route calls
   `supportsVideoGeneration`/`createVideoGeneration`/`pollVideoGeneration` with connection pinning at
   `Kernel/API/src/routes/video.ts:99-146`, and `Kernel/API/test/video-route.test.js:101-167` asserts a
   create that returns only `request_id`, pending versus completed polls, the connection-bound poll,
   the key gate and cancellation. It is committed at `a71f61d8`; `git diff HEAD` for the route is empty.
   Scorecard row 6 is now corrected on that evidence. `/systemone` is still absent, which is the
   remaining reason the row is below level 4.
2. **Item 4 (xai/kimi ids) is resolved.** `src/data/providers.ts:1006-1031` keeps `kimi` as the metered
   platform product and `:1033-1053` gives `kimi-code` its own coding-subscription card; `:1667-1694`
   states exactly which xAI lanes are served and which are not. `tests/provider-cards.test.js:376-414`
   is the endpoint/auth-agreement guard the report asks to add, and
   `Kernel/API/src/core/own-provider-adapters.ts:94,118` declare `validation: 'none'` beside both
   factories. No second flow or simulated lane is owed for either id.
3. **Item 7 (candidate-key honesty) already has its guards.**
   `tests/provider-validation.test.js:37-44` forbids an unevidenced `models` strategy, `:77-120`
   covers bogus keys and public-catalog keys, and `Kernel/API/test/model-capabilities.test.js:40-49`
   covers a `supports_tools: false` catalog entry. Importing 9router's regex family defaults
   (`9router/open-sse/providers/capabilities.js:573-584`) would assert context windows this repository
   has not measured, which contradicts the no-measured-claims rule.

## Report items deliberately excluded

- **Item 5 (CLI-tool configurator / translator inspector)** has no data source here. Grepping
  `Kernel/API/src` and `src` for the cli-tools/translator surfaces finds only format translation and
  inference code, while 9router ships roughly 28 `/api/cli-tools/*` and 5 `/api/translator/*` routes
  under its `src/app/api`. "Read existing gateway state only" is not implementable without inventing
  a large new config surface; the two pages would be a façade. Row 9 remains red.
- **Item 6 (login lockout / SSO)** is real but out of scope for this cycle's cost. `Kernel/API/src/routes/api-keys.ts:28,51`
   confirms model allow-lists, lockout and OIDC are absent, but row 10 already scores OH 4 against
  9router's 2, so it buys no parity. It spans a session store, a limiter, an OIDC PKCE flow, scoped
  keys and a Login component and should be its own cycle.
- **Provider ids not ported** (`cursor`, `gemini-cli`, `zed`, `commandcode`, `mimo-free`): the 9router
  registry files for these send forged CLI identity headers, use RSA callback auth or a non-standard
  auth header, embed a client secret, read tokens from the IDE's local DB, or are hidden because the
  free channel ended. `tasks/parity-loop/README.md:19-21` forbids that client/app impersonation and
  dead surfaces. The only cheap, honest id from report item 3 is `glm` as a plain keyed
  OpenAI-compatible router on `https://api.z.ai/api/coding/paas/v4/chat/completions`; its card says it
  is a **paid Z.ai coding-plan API key**, distinct from the `zcode` Start Plan subscription at
  `src/data/providers.ts:1334-1359` and from 9router's ZCode CLI OAuth. No Claude headers, client
  identity, OAuth flow or measured card field came with it.

## Release trail

`pnpm release:audit` was red on one tag, `v3.96.0`, which was tagged and released but has no npm
version; `npm view @hilbras/omnihilbras@3.96.0 version` returned E404 while `3.97.0` resolved
(report lines 31-34, 194, 203-208). Following the `3.70.0` precedent in
`scripts/audit-release-trail.mjs:84-86`, the gap is now recorded as unrecoverable — `3.97.0`
supersedes it and republishing stale code is worse than a bookkeeping gap — and the pin in
`tests/release-trail.test.js` counts it. `3.96.0` was **not** republished. The `3.98.0` bump is kept
in the three manifests and the derived copies; the commit, tag, push, GitHub release and npm publish
are a separate ceremony and are not claimed here.
