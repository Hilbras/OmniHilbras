<!--
  PHASE NAMING — read this before reading any phase number below.

  `tasks/plan.md` and this file use "phase" for two different things, and I conflated them for a
  long time, reporting progress against the wrong one. The correction, stated so it is not repeated:

  - **`tasks/plan.md` is the plan.** Five phases: SDK foundation, provider adapters, local gateway,
    dashboard integration, cloud readiness. 49 of its 50 tasks are complete. Its phases are numbered
    1-5 and there is no Phase 6.
  - **This file is the refactoring log** for the work carried out against that plan. Its tasks are
    labelled "Phase 1/2/3" meaning *extraction round*, not plan phase. Nothing here is a plan phase.

  So "Phase 3" below does not mean plan Phase 3, and there are no "Phases 4-12" in either document.
  Progress is measured against `tasks/plan.md`.
-->


---

## Standing rule: every phase ships completely

**Push to GitHub, publish a GitHub release, and publish to npm after every phase**, every
checkpoint, and every task group that changes behaviour. A phase is not done when its code is
merged; it is done when the tag is on `main`, the release exists, and the version resolves from the
registry. Recorded in `AGENTS.md` so it is enforced rather than remembered.

**Compliance audited across every release made in this work** — `v1.16.0` through `v1.32.0`, all 17:

```
tag      git-pushed  github-release  npm-published
1.16.0   yes         yes              yes
…        …           …                …
1.32.0   yes         yes              yes
```

So the rule was being followed; it had simply never been written down, which is the same failure as
a guard that is not asserted — it survives on attention rather than on anything.

**The one step of it that is not reliable, recorded in `AGENTS.md` as well:** `npm publish` has twice
printed `+ @hilbras/omnihilbras@<version>` while the version was **absent** from the registry. The
tarball is staged and finalised a minute or two later, and a re-publish inside that window fails
with `409 Cannot publish over previously staged version`. A `409` means wait — not retry harder, and
not bump the version.

---

## Task 65: 141 provider logos were excluded from 18 consecutive releases

**Found by looking for a loose end, and the loose end was in the commit command itself.**

Every commit in this work was staged with:

```bash
git add -A -- . ':(exclude)public/providers'
```

The stated reason was that `public/providers/` is build output. **It is not.** The only thing that
reads the directory is the `logoPolarity()` plugin in `vite.config.ts`, and that plugin *writes*
`src/lib/logoPolarity.generated.ts` — the assets are pure input, and the only thing that ever wrote
into the directory was a human, once. The exclusion was silently dropping required assets from every
release, and nothing failed, because a missing logo is a 404 in a browser and a missing file is not
an error anywhere in a build.

Measured against the committed tree (`git cat-file -e HEAD:public/providers/…`):

```
deepseek.svg   MISSING in git — the app will 404 on this logo
qwen.svg       MISSING in git — the app will 404 on this logo
```

Both are referenced directly by `src/data/providers.ts`. A fresh clone of the released repository
renders a broken image for DeepSeek and Qwen, and the developer who pushed the tag had both files
sitting in their working tree the whole time.

**141 of 294 assets were uncommitted.** The second-order failure is worse: of the 214 assets named in
the committed `logoPolarity.generated.ts`, **96 were absent from a clone**. The tile-brightness rule
was applied to files that did not exist, while the files that did render received no rule. That is
the exact silent failure the generator was written to prevent — its own comment says so, naming
"an invisible logo, not an error" — caused by the generator's inputs not being committed.

**Fixed, and made unable to recur.** `tests/dashboard-assets.test.js` asserts every rendered mark is
*committed* rather than merely present, that the brightness map names only assets the repository has,
that no bundled SVG carries a script or a remote reference (141 files entered at once, and a
vendored logo is markup a browser executes), and that no mark is an empty file. Wired as
`pnpm test:repo`, run **first** in `pnpm test` so a missing binary fails fastest. Proven by
reproducing the defect — `git rm --cached` on three files, which fails three of the seven checks.

**Why it survived eighteen releases:** the exclusion existed only in shell history. Nothing in the
repository recorded it, so nothing could contradict it. That is the same shape as every other
finding this work has produced — a decision with no second copy to disagree with it is not a
decision anyone can check.

---

## Task 66: CI had never passed. Twenty-five runs, twenty-five failures

`AGENTS.md` step 1 said:

> CI runs the same command, so a change that passes locally passes in CI by construction.

**Measured, that sentence was false for the whole session.**

```
total runs: 25
 failure   25
oldest: 2026-09-29T13:35:59Z  failure
  "Phase 1: one version stated once, a CI that runs, an honest architect…"
```

Not one green run, ever — including the commit that introduced the workflow, whose title claims
"a CI that runs". Nineteen releases were published on top of it, each one verified locally and each
one shipping a red check that nobody had opened.

**The cause is the same class of defect as Task 65: two copies of one decision, free to disagree,
resolved by invisible state.** The dashboard imports `@hilbras/omnihilbras`, whose `types` is
`./dist/index.d.ts` — a **build output** — and the root `tsconfig.json` has no `paths` mapping, so a
build artifact *is* the type surface. But `pnpm typecheck` was:

```
tsc --noEmit && pnpm typecheck:sdk && pnpm typecheck:gateway
```

which typechecks the dashboard *first*, before anything builds the SDK. In a working tree `dist/`
happens to exist from an earlier build, so `tsc` resolved it and passed. In a checkout it does not
exist, so `tsc` reported 15 errors. Reproduced exactly by deleting `dist/` and re-running:

```
src/lib/gatewayClient.ts(1,35): error TS2307: Cannot find module '@hilbras/omnihilbras'
… 15 errors, identical to the CI log
```

The 12 `TS7006`/`TS7053` errors are all downstream of the three `TS2307`s: unresolved module, so
the SDK types become `any`, so `noImplicitAny` fires on every parameter that would have been typed.
One missing artifact, fifteen errors, and not one of them named the cause.

**Two fixes, because there were two ways for a local tree to differ from a clone.**

1. **Order.** `typecheck` is now `pnpm build:sdk && tsc --noEmit && pnpm typecheck:gateway`. The
   SDK's build *is* its typecheck — `tsc` emits only when the program has no type errors — so
   building and typechecking it separately would run the same compiler twice for one guarantee.
2. **Staleness.** `tsc` emits *over* `dist/` and never empties it, so an artifact outlives the
   source that produced it and a local tree can typecheck against an export that exists in no
   `.ts` file. `scripts/clean-sdk-dist.mjs` removes it first. Proven by planting
   `dist/ghost.{js,d.ts}` for a symbol no source produces: the old pipeline kept them forever, the
   new one cannot survive a build.

Cleaning rather than testing is the point. Once `dist/` is rebuilt from scratch there is no leftover
state for a working tree and a fresh checkout to disagree about, so the divergence is removed rather
than asserted against — which is also why there is **no test here**: a guard that string-matches a
shell command is the kind of guard that gets disabled instead of fixed.

**Deliberately narrow.** Only the SDK's output is cleaned. The gateway's `dist` is the deployable and
nothing in this repository imports it, so there is no demonstrated failure behind cleaning it and no
reason to touch it on a hunch.

`AGENTS.md` now says to run `gh run list` before shipping instead of trusting the sentence that was
wrong for twenty-five runs.

**Then CI advanced to `Test` and found a second defect, in the product, that local timing had been
hiding** — shipped as 1.33.3, see below.

---

## Task 67: a write with no way to ask whether it landed

With typecheck fixed, the CI log reached the tests and failed on something local had never shown:

```
✖ local API key store keeps only hashes and reveals the secret once
  [Error: ENOTEMPTY: directory not empty, rmdir '/tmp/omnihilbras-keys-VVUUui']
```

**The cause is one line.** `LocalApiKeyStore.authenticate` records `lastUsedAt` with a bare `void`:

```ts
if (matched) void this.touchLastUsed(matched.id);
```

That is *deliberate* — authentication runs on every request, and awaiting a disk write on that path
is a real cost. The `void` is the right call and this change does not reverse it. The defect is what
the decision left behind: the store could not be asked when it had caught up. The mutation queue was
private and nothing drained it, so `authenticate` resolving said "I asked for this write" rather than
"this write happened". Two consequences, both silent:

- **Shutdown lost data.** `main.ts` did `server.close(() => process.exit(0))` and exited with a
  `lastUsedAt` still queued. The gateway was told to record usage and then died without recording it.
- **Cleanup raced.** Removing the store's directory — a test's `t.after`, an operator clearing state
  — let the pending write recreate the file mid-removal. `ENOTEMPTY` is what that looks like, and it
  is why the gateway suite failed in CI and passed locally every time: a loaded machine gives the
  write long enough to land first, so the race is a machine-speed artefact, not a rare event.

Measured, not assumed — without a drain, the file immediately after `authenticate` returns:

```
without a drain, lastUsedAt present right after authenticate: NO — the write is still in flight
```

**Fixed by making the deferred work drainable, not by making it synchronous.**

- `LocalApiKeyStore.close()` awaits the mutation queue, looping until the queue stops advancing —
  awaiting one snapshot only covers work already queued at that moment. It never rejects, because
  `touchLastUsed` already swallows its errors by design: failing to record when a key was last used
  must not fail the request that used it, and by drain time there is no request left to fail.
- `ApiKeyStore.close?()` is on the interface, **optional**, so an in-memory store is not forced to
  implement a drain it does not need. It is declared rather than duck-typed because a store that
  defers a write and cannot be asked when it finished is the defect being fixed.
- `GatewayService.close()` stops the health monitor **then** drains the store, in that order: the
  monitor polls adapters, so leaving it running would let it enqueue work while the drain runs. The
  drain terminates on an idle queue and not a busy one, which is why `main.ts` closes the HTTP server
  first and drains second.

Three tests, not just the one that stopped failing: the drain makes the file factually current with
no sleep and no retry; closing twice is not an error, because shutdown and a test may both reach for
it; and the service's release order is asserted as `['monitor', 'store']`, so a future reordering
fails rather than being left to a comment.

`main.ts` and the tests now join the same operation at one place each — a `temporaryKeyStore` helper
that drains every store it opened before removing the directory. The three tests that each used to
carry their own `mkdtemp`/`rm` pair are one decision, not three, which is the shape this whole
refactoring has been trying to reach.

```
tests    785 → 788
```

---

## Task 68: a second credential-check route, registered ahead of the one that was better

`routes/connections.ts` contained two handlers for `POST /v1/connections/:providerId/check`. One was
generic; the other was pinned to `openrouter` and sat **first**, so it always won that path. And it
was the worse of the two:

```ts
assertOnlyFields(body, ['apiKey']);            // the copy — endpoint refused
...
assertOnlyFields(body, ['apiKey', 'endpoint']); // the generic handler — endpoint allowed
if (typeof body.endpoint === 'string' && body.endpoint.trim()) assertSafeEndpoint(…);
```

So the same request body got two answers, and the only difference between them was which branch the
URL happened to match first. Measured against a gateway with both providers registered:

```
openrouter check with an endpoint → 400  Request contains unsupported fields.
anthropic  check with an endpoint → 200  valid
```

`endpoint` is how a proxied or self-hosted provider is checked, so refusing it for one provider was
not a restriction anyone had asked for. It was one provider written into a route that already handled
every provider — the recurring shape, and the only one left in this file.

**The hypothesis I started with was wrong, and measuring is the only reason I know that.** I read
`service.validateConnectionCredential(providerId, …)`, saw the only caller pass a literal, and
concluded no non-OpenRouter credential could be checked at all. I had read 40 of the file's lines. The
generic handler at line 82 does exactly that job, and anthropic, gemini and zen all answer `200`.
My first probe compounded it: it registered no providers, so the `404` I got was the *service*
reporting an unknown provider, and I had already labelled it "no such route". Fix the probe before
blaming the code — twice in one turn.

**The fix is a deletion.** The copy was strictly redundant, so removing it is behaviour-preserving for
every body the dashboard sends and strictly widening for the rest. `POST /v1/connections/openrouter/check`
is now the generic route with a provider in the path, which is what it always was.

`docs/SPEC-SDK.md` listed **only** the copy. The generic route — the one that has been serving every
provider — was never documented at all, which is the same gap from the other side: the spec and the
code each described one of the two handlers and agreed on neither.

## Declined: collapsing the two body parsers

`parseOpenRouterConnectionRequest` and `parseGenericConnectionRequest` are line-for-line copies that
differ on exactly two things — `endpoint` is defaulted rather than required, and `id` is forced to
`openrouter` rather than optional — and only the generic one calls `assertSafeEndpoint`. Unifying
them is tempting and is **not** free: it would widen the fields OpenRouter accepts to include
`endpoint`, `id` and `resilience`, which is a behaviour change, and `id` is what lets a caller add a
second connection for a provider that already has one.

So it is recorded rather than done. The `assertSafeEndpoint` asymmetry is currently harmless — only
one of the two paths can take a caller-supplied endpoint, which is why the check is unnecessary in the
other — and no test shows a wrong result today. When it is worth doing, the decision to widen should
be made on purpose and the existing test at `server.test.js` that asserts `400` for an OpenRouter
endpoint override will have to change meaning, not just value.

```
tests    788 → 789
```

---

## Task 69: the "every route needs a spec line" rule had no mechanism, and one route had neither

`AGENTS.md` says:

> New gateway routes need tests in `apps/gateway/test/` and a line in `docs/SPEC-SDK.md`.

A rule nobody can run is a rule that survives on attention. Measured against the code:

```
routes served: 32   documented: 22
```

**Eight served paths had no spec line**, and one of them was a route that ingests a secret pasted by
the user:

```
/v1/oauth/kiro/import-token    ← undocumented, and untested
```

Every one of the eight is a Kiro or OpenCode Console sign-in route — added after the spec's route list
was written, which got the Cline family and nothing after. The rule was followed for exactly as long
as someone remembered it, which is the entire history of the rule.

`POST /v1/oauth/kiro/import-token` took a refresh token off a user's clipboard, spent it against AWS,
and stored the resulting access token instead. The implementation is careful — it trims, refuses an
empty paste **before** any network call, and never stores the pasted secret. None of which was
written down anywhere, and none of which was tested.

**`tests/gateway-routes.test.js` makes the rule run.** Five checks, and the two directions are both
there because each catches a different lie: every served path has a spec line, and every route the
spec advertises is a path the code matches. A spec line for a route that no longer exists is *worse*
than a missing one, because a reader cannot tell which kind of wrong they are looking at and the
omission at least shows up as a 404. The reverse check is clean today, which is the reason to keep it
rather than a reason to skip it.

Two more checks earn their place by accident. **A route path must be text a machine can read** — a
path assembled from a function call is invisible to every check here, and an invisible route is an
undocumented one, so `clineCallbackPath` is resolved through the module constant that holds it. And
**a route that accepts a pasted credential must be documented**, because for those routes the body
shape, the validation order, and what actually gets stored *are* the design; `import-token` spends
the paste and stores the access token, and `kiro/api-key` stores the paste itself because it cannot
be renewed. Those are decisions a reader needs, and one of them is the only route in the gateway
that keeps the secret you handed it.

Comments are stripped before matching on both sides. `routes/oauth.ts` documents its handlers in doc
comments that quote paths, and a naive matcher lets a comment vouch for a route the spec never
mentions.

**The first version of the guard had two bugs of its own, and both were in its matching, not its
intent.** It reported five real routes as phantoms because it compared `startsWith('/v1/keys/')`
against `PATCH /v1/keys/:id` as unrelated strings — a served *prefix* legitimately covers a documented
route below it, which is how the gateway actually dispatches. And it counted 21 paths where it should
have found 32, because its regex only matched string literals and missed paths held in constants.
A guard that under-counts its own subject reports a smaller gap than the real one, which is the worst
kind of wrong for a check whose entire job is to measure a gap.

## The test for the credential route, and two wrong assertions of mine

Only paths that reject **before** any network call are exercised. A non-blank token would register a
client with AWS and spend a real refresh token, so the exchange is stubbed — a test that quietly
makes a live provider call is exactly the thing that looks like coverage. Asserted: a blank or
missing paste is refused with `refreshToken is required` and **never reaches the exchange**; a real
paste does reach it; and the pasted value is never echoed back.

Two of my assertions were wrong before the test was right. I asserted the error "names the field"
with `/refresh token/i`, which does not match `refreshToken` — and the message that actually comes
back is the route's `refreshToken is required`, not the store's more specific one, because the route
validates first. Then I asserted the provider's message was surfaced verbatim, and the gateway
**redacted** it: `{"code":"AUTHENTICATION_FAILED","message":"Provider authentication failed."}`. The
redaction is correct, and the real `importKiroRefreshToken` supplies a `publicMessage` precisely so a
safe sentence can reach a browser. The test now varies *only* whether `publicMessage` is present and
asserts both halves: the provider's own sentence when it supplies one, redaction when it does not,
and the raw third-party string in neither case. Probing the running gateway first is what turned that
into a test of the annotation mechanism instead of a test of my assumption.

```
tests    789 → 795
```

---

## Task 70: "credentials never reach browser storage" was true, and unenforced

`AGENTS.md` and the gateway's design both say provider credentials and gateway keys never reach
browser storage. `localStorage` is readable by any script on the origin, is not cleared on logout, and
survives a restart — so a credential written there is a credential copied out by any future
dependency, any injected snippet, and any user who opens devtools.

The rule was true. It was also true by having only ever been *nearly* true:

```
localStorage.setItem(sidebarStorageKey, String(collapsed))   // sidebar collapsed
localStorage.getItem(sidebarStorageKey)
localStorage.setItem('omnihilbras-theme', theme)             // light or dark
```

Three accesses, two keys, both preferences, and **nothing anywhere in the repository that would notice
the fourth**. The fourth is the change a well-meaning contributor makes — cache the key so the user
does not retype it — and it is the one that cannot be undone for users who already pasted it.

**`tests/browser-storage.test.js` makes it provable.** Every storage key must be on a two-entry
allowlist, with a sentence per entry saying what it holds and why that is safe, so the list is a set of
claims a reviewer can disagree with rather than a rule about the future. The allowlist is checked in
**both directions**: an unused entry is worse than a missing one, because it widens what the list
permits without widening what the product does, and the next key can then match it by accident.

Stores the product does not use are asserted at **zero** rather than merely unreferenced. "We do not
use this" and "we do not use this *yet*" look identical in a grep of what exists, and only one of them
is a property.

## What a comment and a user-facing snippet are not

`src/lib/webSessionProviders.ts` tells the user, in a string, to run
`copy(JSON.parse(localStorage.userToken).value)` in **their own** browser console. That is DeepSeek's
storage, in their browser, and it is the instruction that makes the DeepSeek connect flow possible at
all. `WebCookieConnectDialog.tsx` explains in a comment why the dialog does *not* use `localStorage`.

Both mention credential-shaped storage; neither is this product storing a credential. So the guard
matches **calls**, not mentions. A guard that cannot tell a helper aimed at the user from the product
doing it would flag both, and a guard that cries wolf gets deleted — which is worse than no guard,
because it looks like coverage. Those two files are the reason the guard passes today, and they are
also its regression test.

## The bug in my own guard, found by planting the leak twice

The first version used `/\bkey\b/i`, which does **not** match `apiKey` — there is no word boundary
inside a camelCase compound, and `apiKey`, `refreshToken`, `userToken` and `accessToken` are precisely
how this codebase and every other JavaScript one names a credential.

I only found it because I planted the second case, which the guard was written for and did not catch:

```
PLANT 1: a new key holding the api key     → 3 checks fired
PLANT 2: an ALLOWED key handed a credential → 0 checks fired   ← the blind spot
PLANT 3: userToken and REFRESH_TOKEN       → 2 checks fired
```

Plant 2 is the interesting one: the allowlist protects *which keys exist*, and nothing was watching
what a permitted key was handed. Fixed by splitting camelCase and separators before matching, so
`apiKey`, `API_KEY` and `api-key` are the same three words and all three are caught. All three plants
now fire. A guard on a security rule that cannot see the most common spelling of the thing it guards
reports having looked without having looked, which is the failure mode this whole refactoring keeps
finding — and it took a deliberately planted leak to surface, not a careful reading.

```
tests    795 → 801
```

---

## Task 71: the secret scan was a ritual, and my first scanner had a hole in it

`AGENTS.md` said:

> Before any push, scan the tree for secret-shaped strings:
> `git grep -nEI "ohk_…|sk-or-v1-…|ghp_…|npm_…"`

That was carried out by hand before every push in this work — about twenty times — with **four**
patterns, and it is the only security control in the repository that depended on me remembering. A
manual pre-push ritual is a ritual: it is skipped under deadline, it does not run for whoever reviews
a pull request, and it does not run at all on the twenty commits between the one you remembered and
the tag you pushed. The 141 provider assets that 18 consecutive releases left out were missed for the
same reason — a thing done by hand, with nothing to notice when it stopped happening.

**`tests/no-secrets.test.js`.** Fifteen shapes instead of four, scanning the **tracked** tree. The
oracle is `git ls-files` deliberately: the defect its sibling suites exist to catch was a working tree
holding files the repository did not, so a scanner reading the working tree would have been blind to
exactly its own subject. Measured across the tree, all fifteen patterns match nothing, so the wider
net costs no false positives today — and a scanner that cries wolf on day one gets deleted rather than
fixed. The exemption list exists, is empty, and is **asserted empty**, because a list of exemptions
that accumulates quietly is how a scanner stops being one.

Also asserted, because they are the ways a scanner quietly becomes a no-op: every pattern is shown a
sample it must catch (a scanner that matches nothing is indistinguishable from a broken one), each
sample must match only its own pattern so a finding is not misattributed, and the scanner must not
match **itself or the rule documenting it** — it needs no self-exemption, because a regex source is
not a match, and that is worth asserting so nobody adds the exemption later on a false premise.

## The hole my own scanner had, found by its own test

The first version skipped files **by extension**. Its binary-skip test immediately caught that 154
skipped files were text:

```
.gitignore   LICENSE   public/_redirects   .env.example
public/providers/*.svg   (149 of them)
```

So a secret pasted into an SVG — which is markup the browser executes — would have sailed straight
through the scan. **A name is not a property of content**, and a maintained list of names is a list
that is wrong the moment somebody adds a file. Replaced with a content test: a file whose bytes
contain a NUL is binary, everything else is scanned. The whole asset directory is 2.8 MB, so reading
it is free, and the check still has real work to do — 145 of the 294 marks are genuinely binary and
all 149 SVGs are now inside the net.

Proven by planting, in a file the extension version skipped:

```
public/providers/scan-probe.svg:1  AWS access key id
src/zz-scan-probe.ts:1             OmniHilbras gateway key
```

Two smaller things the tests caught in me. **Four patterns had no sample**, so they were never proven
to match anything — the check failed on the pattern table rather than on the tree. And the JWT sample
was nine, nine and ten characters, which the pattern **correctly** refused, because its minimum segment
length is eight after the leading `eyJ`; a hand-written sample is exactly how a pattern's minimum gets
wrong. Replaced with the RFC 7515 example.

```
tests    801 → 807
```

---

## Task 72: one card in thirteen was showing invented traffic

`AGENTS.md` said a card with no connection stays `status: 'available'` with `—` metrics. Twelve of the
thirteen cards did exactly that. One did not:

```
id: 'ollama'   status: 'attention'   models: '6 models'
latency: '92 ms'   requests: '1,417'   lastUsed: '2 min ago'
health: 72   modelList: ['qwen3-coder', 'llama3.2', 'nomic-embed-text']
```

**Every one of those numbers was invented**, left over from when the dashboard was a static mockup.
`ProvidersPage` seeds its state from this catalog and `mergeGatewayConnections` overlays only the
providers that have a connection, so a card here is *exactly* what a user sees when the gateway has
never been asked about that provider. A user who had never run Ollama was shown an amber "attention"
badge, a 92 ms latency, 1,417 requests and three named models — indistinguishable from a local runtime
they had been using all week.

The rule was written after the mockup and the data was never changed, which is the same shape as every
other finding here: a decision stated once, nothing to compare it against, and no check. **One card out
of thirteen is exactly what a spot check misses and a reader trusts.**

## The invariant, restated so it can be asserted

**The catalog is the no-connection fallback, so no card in it may claim a measurement.** That is a
property of the data rather than an instruction about a UI state, which is the only reason it can be
checked: if a card's number could only have come from a measurement, and the catalog is shown precisely
when there is nothing to measure, then the number was invented. Live figures arrive from the gateway
and overwrite all of it.

`tests/provider-cards.test.js` also cross-checks **three files that have to agree** for a card's
credential to be collectable, and nothing compared them: the card's `auth`, the collector, and the
gateway route. A card claiming `auth: 'OAuth'` must have a `/v1/oauth/:id/start` route — three cards,
three routes. A card pasting a cookie must have a descriptor in `webSessionProviders.ts` whose `check`
and `paste` paths the gateway actually serves, matched against the route table so a renamed route stops
counting. And every card needs a bundled mark **or** an `initial`, because `ProviderMark` takes
`logo?` and falls back to a letter — which is how the user-defined `custom` card renders at all.

Proven by planting both halves:

```
a card claiming 6 models / 92 ms / 1,417 requests      → 1 check fired
a fourth OAuth card, 'newcomer', with no route         → 2 checks fired
```

## The clause I replaced described code that does not exist

The old rule also said an auth mode with no flow behind it — *"currently `OAuth`"* — must disable Save
in `AddProviderModal` and say so. Two separate problems:

- **There is no such mechanism.** `canSave` is `mode === 'single' ? hasSingleConnection : …`, and
  `hasSingleConnection` is `name && apiKey && endpoint`. It knows about form fields and nothing else. A
  reader of `AGENTS.md` would reasonably have assumed the code had this.
- **The parenthetical was false.** Three cards claim `auth: 'OAuth'` — `opencode-console`, `kiro`,
  `cline` — and the gateway serves a start route for all three. OAuth grew a flow after the rule was
  written and the rule was never updated.

So it is restated as the part that is both true and enforceable, and the unimplemented half is recorded
as what it is rather than left as a claim about code that is not there.

## Two places my guard was wrong, both about over-specifying

It required every card to have a logo; `custom` has none, **by design**, because `ProviderMark` falls
back to `initial`. And it required every web descriptor to declare both a `check` and a `paste` path;
the table legitimately varies per provider. Asserting a shape the data does not have is how a guard
gets deleted — the first version of the logo check would have failed CI on a correct card, and a
reviewer would have been right to switch it off rather than fix it.

```
tests    807 → 813
```

---

## Task 73: the Check button reported success for any key at all, for twelve of thirteen providers

`AddProviderModal` asks for a provider key and offers a **Check** button. The function behind it
branched on the provider:

```ts
if (selected.id === 'openrouter') {
  await checkOpenRouterConnection(apiKey, controller.signal);
  setTestState('success');
} else {
  await new Promise<void>((resolve) => {
    window.setTimeout(() => { setTestState('success'); resolve(); }, 850);   // ← nothing was asked
  });
}
```

**For every provider except OpenRouter, the button waited 850 ms and reported success without making a
request.** A key that was any string at all — `x`, a truncated paste, a key for the wrong service —
produced a green "Key looks valid". The only thing distinguishing the two branches was which card was
open, so the one provider whose key was really checked was the exception.

This is the rule at the top of `AGENTS.md` — *"a test, health check, or simulated result must not be
presented as a live one"* — broken in the single place the product tells a user their credential works.
It is the same class as the invented card metrics from 1.34.5: mockup behaviour that outlived the
mockup, surviving because nothing compared what the UI claimed against what it did.

**The cause was not the timer.** It was that the client could not name a provider.
`checkOpenRouterConnection` posted to a hardcoded `/v1/connections/openrouter/check` while the save beside
it was already generic (`putGatewayConnection(providerId, …)`) — two spellings of one decision. The
gateway has served `POST /v1/connections/:providerId/check` for every provider since the duplicated
OpenRouter-only route was deleted in 1.34.0, so the real answer was available the whole time and
unreachable. That is the fifth time the same shape has appeared: two copies of one decision, free to
disagree, with the worse copy winning because it was written first.

Fixed by making the check real for every provider: `checkConnectionCredential(providerId, { apiKey,
endpoint? })`, carrying the endpoint when the card has one so a self-hosted or proxied provider is
checked against the address it will be saved with. The hedged "Key looks valid" wording is gone, because
with a real check there is one honest sentence, and the vestigial `testTimerRef` went with it — a ref
that only ever held a fake delay is a ref that invites the fake delay back. The unreachable
`mode === 'bulk'` guards went too: the Check button only renders in single mode.

## `tests/dashboard-truthfulness.test.js`

**No success state may be set inside a timer callback.** Deliberately narrow — it looks at *who sets
success*, not at timers in general, because polling and debouncing are legitimate and a guard that flags
all of them gets switched off. Plus: every provider the client names in a path is a real card on a route
the gateway serves; the check goes through the gateway rather than waiting; and the one honest success
sentence is the one that is there.

## My guard could not see the timer it was written for

Planting the original code back made **one** of the two relevant checks fire. The timer check missed it,
because the scope was sliced from the innermost `=> {` **forward** — and that is the callback with the
word `setTimeout` cropped off:

```
=> { setTestState('success'); resolve(); }, 850);
```

So the guard for "a timer must not produce a success" had no way to see a timer. Fixed by finding the
innermost function start and then looking a short window *backwards* for the call that created it. Both
the multi-line original and a one-line variant are caught now, with the line number in the message.

**That is the third guard this session whose own detection was wrong in a way only a planted defect
revealed** — after the browser-storage `camelCase` blind spot and the route guard under-counting its own
subject. Each time the guard was green, correct-sounding, and blind in the specific place it existed to
look. Planting the defect is not a formality; it is the only thing that has found these.

## And one place I was wrong in the other direction

The first version of the path check asserted "no provider may appear in a client path". The OAuth surface
is not uniform, and the difference matters: `startGatewayOauthSignIn(providerId)` is generic, but
`startGatewayDeviceSignIn` posts to `/v1/oauth/opencode-console/start` and gets back a `userCode` and a
`verificationUrl`, and `getClineSignInStatus` hits a `/session/` route Cline alone has. **Different
endpoints with different payloads are not two spellings of one decision** — that is what made the
credential check wrong, where the request and response were identical and only the path differed. Narrowed
to what is true regardless: the provider named is a card, and the path is served.

```
tests    813 → 818
```

---

## Task 74: two lists of providers, and seven providers with two descriptions

`src/data/providers.ts` holds `providerCatalog` — 13 cards. `src/components/AddProviderModal.tsx` held
`providerOptions` — 10 entries — and it re-declared `name`, `description`, `auth`, `color`, `initial`,
`logo` and the endpoint for each. Measured across the two:

```
FIELDS THAT DISAGREE: 7
  ollama      catalog: "Private local inference for coding models and offline development."
              modal:   "Local models on your machine"
  openrouter  catalog: "One connection for a broad catalog of hosted models and providers."
              modal:   "Many models through one API"
  …all seven shared providers disagreed on description
```

**Every provider the dialog can open had two descriptions**, and the dialog's is the one a user reads
while pasting a key into a form that will transmit it to that vendor. The two files also disagreed on
*membership*: 3 options (`openai`, `anthropic`, `google`) had no card at all, and 6 cards had no option.

## This duplication had already caused a real incident

`resolveProviderOption`'s own comment records it:

> This used to fall back to `providerOptions[0]`, which is OpenAI. A card the dialog did not know about
> therefore became OpenAI, with OpenAI's endpoint — so a key typed for one provider was validated
> against, and transmitted to, another.

The fix hardened the fallback. That was the right thing to do and **it left the cause in place**. A
second copy of a list is not a fallback hazard waiting to happen; it is one.

## Fixed by deriving the list, not by patching the symptom

`providerOptions` is now mapped from `providerCatalog`, filtered by `group` to the kinds of provider this
dialog can key. The only hand-written entries left are the three with no card, in a named
`withoutCard` list with the reason stated. The option set is **identical** to before — nothing lost,
nothing added — and the seven duplicate descriptions are gone, because there is no second place to keep
one.

## And I reintroduced the incident while fixing it

The filter's first version was `new Set(['api-key', 'local'])`. The `custom` card's group is `custom`,
so the neutral option fell out of the list — and `customOption()` was
`providerOptions[providerOptions.length - 1]`, so the last element became **Google**. An unknown
provider id would have resolved to Google, with Google's endpoint: *a key typed for one provider
transmitted to another*, which is the sentence the file's own comment uses to describe the original bug.

Both halves are now fixed and pinned. `customOption()` finds the entry **by id** and throws if it is
missing, because a positional lookup for "the neutral fallback" is a lookup that names a vendor the day
the ordering changes. And `custom` is in the eligible groups.

Three planted regressions, all caught:

```
PLANT A: drop 'custom' from the eligible groups      → the eligible groups must include 'custom'
PLANT B: make the fallback positional again          → the neutral fallback is positional again
PLANT C: hand-write an entry for a card that exists  → these have a hand-written dialog entry AND a catalog card: ollama
```

## A fourth guard bug, and the same shape as the first three

The eligible-groups assertion read `modal.slice(modal.indexOf('eligibleGroups'))` — and the **doc comment
above the declaration also names `eligibleGroups` and `custom`**, so the slice started in the comment and
picked its words up as a third entry. The check failed on its own explanation. Now it matches the
declaration, `/eligibleGroups\s*=\s*new Set\(\[([^\]]*)\]\)/`, and reads the initialiser rather than the
first mention.

That is the fourth time this session a guard's *own detection* has been wrong in a way only a planted
defect revealed. The pattern is consistent enough to be worth naming: every one of them was green,
plausible, and blind in the specific place it existed to look. The consistent remedy is also the same —
plant the defect, or do not claim the guard works.

```
tests    818 → 821
```

---

## Task 75: stop scraping the dashboard's source, and start calling it

`resolveProviderOption`, the provider list it reads, and the two guards around them were inside
`AddProviderModal.tsx` — a view that imports React and renders a portal, so **nothing could load it**.
That is why the checks written for them were text checks: *"the fallback must not be
`providerOptions[providerOptions.length - 1]`"*, which infers behaviour from the shape of the code, and
which failed on its own doc comment when the comment happened to name `eligibleGroups` and `custom`.

None of it needs a DOM. It moved to `src/lib/providerOptions.ts`, and `tests/provider-options.test.js`
now **calls** it. That required `"allowImportingTsExtensions": true` in the root `tsconfig.json` — which
`noEmit: true` already permitted, so it only allows the extension — and Node follows
`'../data/providers.ts'` to the real module.

The properties are stated over inputs, so they survive a rewrite of the implementation:

- **the guarantee**: twelve malformed ids — `''`, `'openai '`, `'OpenAI'`, `'constructor'`, `'__proto__'`
  and others — all resolve to `custom`, never to a named vendor. This is the incident from Task 74,
  which shipped once already: a key typed for one provider transmitted to another.
- every id the product knows resolves to itself, so the fix is not "send it somewhere else";
- the neutral option's endpoint is checked by **hostname** — `localhost` or `127.0.0.1` — because "where
  does a key go" is the property that matters;
- every option's fields are present, its colour is a hex triple, its initial is one character, its
  endpoint parses.

**58 lines of text checks were deleted rather than kept.** A source-shape check and a behavioural check
for the same guarantee is two places to keep in step, which is the defect class this refactoring has been
about for thirty releases.

## And reading the real data immediately found a second invented list

Replacing the hand-rolled parser in `tests/provider-cards.test.js` with a real import of
`providerCatalog` made a check fail that had been passing:

```
qwen-web.modelList has 3 invented model name(s)
```

`qwen-web` carries `qwen3.7-plus`, `qwen3.8-max` and `qwen3.8-omni-flash`. My regex parsed
`\[[^\]]*\]` on one line, the list spans four, and **the parser silently saw no list at all** — the
agreement-with-itself failure that is the whole theme of this work, in the guard written to end it.

**And it was not the same defect.** Those three names are measured: the comment beside them records
`GET /api/v2/models/`, which answers guests, returning three consistently and seven to someone else
minutes later — which is why the card calls it a dated snapshot rather than a promise, and why the dialog
shows the live list. Ollama's three were fabrications for a mockup beside a claim of `1,417` requests.
A mechanical rule cannot tell them apart; "a list of model names in a catalog file" is the same shape in
both. So the difference is recorded as a one-entry exemption with the provenance quoted, and the entry
count is asserted so a second list is a decision.

I was one command away from deleting a real, dated, documented measurement because my invariant did not
distinguish *invented* from *observed*. **A check that is right for the case you found and wrong for the
case next to it is not a check; it is a coincidence that compiles.**

```
tests    821 → 826
```

---

## Task 76: a health poll was being reported as usage

The 1.34.5 fix made the **catalog** honest — no card may claim a measurement. But the catalog is only
half of what a card shows; `mergeGatewayConnections` folds live gateway state over it, and that function
was inventing two fields:

```ts
lastUsed: liveHealthy ? 'just now' : 'saved locally',   // ← health, not usage
// `requests` was never set at all, so a connected card showed a permanent `0`
```

**`'just now'` claims a user did something.** `liveHealthy` is a health poll. A provider nobody had ever
sent a request to, which answers a model listing perfectly well, reported itself healthy and therefore
displayed **"just now"** under a heading about last use. So the mockup-era lie had a live twin: not
invented numbers this time, but a *real measurement of the wrong thing*, presented under a label that
promised a different one.

**A permanent `0` is not a measurement either.** There is no request counter in the gateway at all — the
only `count()` in it belongs to browser locators in the ChatGPT Web driver — so there is no number to
show and none to zero.

Both now stay exactly what the catalog said. The fields that *are* measured are untouched, including
`health`, which is the poll's verdict rendered as a bar.

## Extracted so the property can be stated generally

`mergeGatewayConnections` moved from `ProvidersPage.tsx` to `lib/providerCards.ts` — pure, records in and
records out — for the same reason `providerOptions` moved last release: the logic was in a `.tsx`, so the
only available check was to read its text, and reading text cannot tell a correct implementation from a
correct-looking one.

`tests/provider-card-merge.test.js` does not list the fields that must not be invented. It states two
properties that hold for every field, present and future:

- **with no connection and no health, the output is the input** — deep-equal, not equal on the keys
  someone remembered;
- **with a connection, every field that changes is traceable to the input.**

A field added next year that is invented from nothing fails the second check without this file knowing
anything about that field. It also covers the disconnect path: merging from the catalog rather than from
the previous state means a deleted connection's metrics cannot survive it.

Both plants fire — putting `lastUsed: 'just now'` back fails two checks, and `requests: '1,417'` fails
one.

## My own assertion was wrong, in the direction the general property exists to prevent

I first asserted that `health` could not change on a merge, carrying the degraded case's expectation
across by mistake. But `health` **is** measured — it is the poll's verdict — so it moves, and the
hand-written exception list was the thing at fault. That is exactly the failure mode a per-field list
invites: it encodes today's fields, and the moment a field is misfiled the list defends the wrong side.
The general property decided it correctly without knowing anything about `health`.

```
tests    826 → 834
```

---

## Task 77: the copy button handed out a model id the provider would reject

`ProviderDetailPage` had a function for how to show a model id:

```ts
function modelReference(providerId: string, model: string) {
  return providerId === 'openrouter' ? model : `${providerId}/${model}`;
}
```

and the row rendered the model name as `mistral-large` while the reference line directly beneath it
read `mistral/mistral-large`. Then, at line 730:

```ts
await navigator.clipboard.writeText(modelReference(provider.id, model));
```

**The copy button put the qualified string on the clipboard.** A user on the Mistral page clicked copy
beside `mistral-large` and pasted `mistral/mistral-large` into a `model:` field — an id Mistral does not
know, which the provider rejects. The confirmation toast then said "Copied mistral/mistral-large", so the
one place that could have corrected the impression repeated it.

Checked the gateway before assuming: routing is by the `x-omnihilbras-provider` **header**, and
`model` reaches the adapter verbatim (`model: request.model` in the OpenAI-compatible adapter). So a
qualified string was never a friendlier spelling of the id — it was a different, invalid one.

**The function was right for exactly one provider.** OpenRouter's ids genuinely carry their own
`vendor/` namespace, which is why it declined to add a second one; for the other twelve the prefix was
invented. And the provider is already the page this renders on, so the prefix carried no information
even where it was harmless.

This is the recurring shape at its smallest: one value, two renderings, and the one a user acts on
disagreeing with the one they read. Three renderings, in fact — the bold name, the reference line, and
the toast — and the two that agreed were the two nobody pastes.

## The guard is about the clipboard, not about this function

`tests/dashboard-truthfulness.test.js` asserts that **the clipboard receives a value, not a rendering of
one**: the argument to `clipboard.writeText` must be a plain identifier or member expression — no
template literal, no concatenation, no call. The clipboard is an API surface; whatever lands there is
what the user pastes somewhere the product cannot see, and a rendering is not the value.

Narrow on purpose, and it holds across all three call sites rather than one. If a composed string is
genuinely what should be copied, compose it into a named value first, so the clipboard and the toast are
visibly the same variable. Proven by putting the qualifier back:

```
clipboard.writeText(`${provider.id}/${model}`) — the clipboard gets a value, not a rendering of one
```

## And a prop that existed only to feed it

`ModelRow` took a `providerId` that nothing else used. With the function gone the prop went too — the
compiler found it (`'providerId' is declared but its value is never read`), which is the one check in this
work that is not something I wrote.

```
tests    834 → 835
```

---

## Task 78: the marketing page advertised a capability the product does not have

`src/App.tsx` is the **marketing entry** — `main.tsx` renders `<App />`, and the dashboard has its own
entries. Under the heading *"No black box — See the decision, not just the answer"* it said:

> Every request should tell you where it went, why it went there, **and what it cost**. OmniHilbras makes
> routing observable by default.
>
> - **Live request traces** — Follow a request from policy to provider and back.
> - **Useful metrics** — Track latency, retries, **spend**, and provider health.

And it illustrated all of it with a panel: `18.4k` requests, a `412 ms` p95, `99.98%` success, four
hardcoded request rows, an **animated green dot labelled live**, the caption "last 15 minutes · all
routes", and the footer **"Updated just now"**. Every number was a literal in that file.

Measured against the product:

| Claim | True? | Why |
| --- | --- | --- |
| Live request traces | **no** | the gateway keeps no request log and no trace. `request-context.ts` says so: *"Not telemetry, and not a trace."* |
| …and what it cost / spend | **no** | no cost accounting anywhere; the only `cost` in the gateway is the word in prose comments |
| Useful metrics | partly | provider health and per-provider latency are real and polled; aggregate counts and spend are not |
| Human-readable reasons | **yes** | `RouteSkipReason` is `disabled`, `no-credential`, `unhealthy`, `rate-limited`, `no-models`, and routing records which applied |

**And the two true claims were the better claims.** This product refuses to swallow a cause: every failure
has a named code, every skip has a named reason, and consecutive health failures stop a provider being
chosen. That is a stronger thing to sell than a request trace, and it is the thing that is actually built.
The section now claims exactly that: a request id on every response (`gateway.requestId` plus the attempt
ledger), named reasons rather than silent fallbacks, and health that changes routing.

The panel is gone, replaced by a comment recording what it was — an operator running this locally knows
exactly how many requests they have made, and a panel telling them 18.4k in the last fifteen minutes is a
false claim about **their own installation**, not a decoration. One of the four fake rows was
`Ollama · qwen3-coder · 92 ms` — **the same invented number** removed from the Ollama card in 1.34.5,
still here in a second component.

## The guard, and being honest that it is a list

`tests/marketing-claims.test.js` records seven claims that were false, each with the reason, and asserts
they are absent from the page. **That is a list, not a proof**: a new false claim phrased differently would
not be caught, and catching that needs a human reading the page against the code. The file says so in its
own header, and asserts the replacement claims are backed by gateway code (`gateway: { requestId:`, `type
RouteSkipReason =`, `reason: 'unhealthy'`) so the fix is not subtraction alone.

The mechanical rule is elsewhere and is stronger than word-matching: **no `animate-pulse` in the marketing
entry.** A pulse is a liveness signal, and nothing on that page is fed. My first attempt matched the word
`live` between two tags, which catches a standalone badge and misses the same lie inside a sentence — so
planting "Requests are live · spend tracked" with a pulse beside it was caught only by the second rule. A
fake feed needs a fake heartbeat whatever it calls itself.

## A check that could not see the code it was checking

The evidence test looked for `gateway: { requestId:` in `apps/gateway/src/*.ts` and did not find it,
because the line is in **`src/routes/inference.ts`** and the scan read only the top level. It reported the
marketing page as wrong when the gateway was right. Now recursive — a check that cannot see the code it is
checking is worse than no check, because it produces a confident wrong answer.

```
tests    835 → 840
```

---

## Task 79: two of five dashboard pages were fabrications, and one covered a capability that already worked

I fixed the invented card metrics in 1.34.5 and then measured which pages actually fetch anything:

| Page | imports the client | `useEffect` | hardcoded metric rows |
| --- | --- | --- | --- |
| ApiKeysPage | yes | 4 | 0 |
| **DashboardOverview** | **no** | **0** | **7** |
| ProviderDetailPage | yes | 6 | 2 (placeholders) |
| ProvidersPage | yes | 2 | 2 (placeholders) |
| **RoutingPage** | **no** | **0** | **8** |

**Two of five pages had no data source at all**, so every number on them was a literal. And `/`
redirected to `/overview` — so `DashboardOverview` was the **first page every operator saw**.

### What the landing page claimed

A range selector (`24h` / `7d` / `30d`) that swapped between three invented counts — `18,492` /
`124.8k` / `486.2k` — over four hardcoded provider rows carrying `8,921`, `5,284`, `2,870`, `1,417`
requests and `286 ms`, `438 ms`, `512 ms`, `92 ms` latencies, plus a hardcoded traffic table. The
`aria-label` said "over the last 24h", so a screen reader was told about a window too.

**`92 ms` and `1,417` for Ollama were the exact numbers I removed from the card in 1.34.5.** They were
in a second component, and a third. Fixing one instance and not asking where else the number lived is
how the same figure shipped three times — the recurring defect, one level up: the *value* had copies
even after the *card* was fixed.

### What the routing page claimed

Three clickable policies (`balanced`, `fast-local`, `private`) with `18.4k` / `6.8k` / `2.1k` requests;
four togglable rules with invented matches and fallbacks; a **Create policy** dialog for a feature that
does not exist anywhere in the gateway — no policy, no strategy setting, no rules store; and a simulator
whose `simulate()` was a `setTimeout` reporting success without simulating anything.

The summary cards read **"Fallback events 18 · last 24 hours"** and **"Decision time 4 ms p95"**. And the
"Test policies" button flashed **"All active policies passed the preview health check"** — a health-check
*result*, reported without a health check. That is the same defect as the Check button in
`AddProviderModal` (1.35.0), in a second component, found because the first one made me look.

**And the real capability was there the whole time.** `GET /v1/routing` exists, `service.describeRouting()`
answers it, the client wraps it as `getGatewayRoutingState`, and `ProviderDetailPage` already calls it.
The routing page was showing fiction *beside* a working endpoint.

## What I did

**RoutingPage now shows what routing can actually use** — per connection: enabled or paused, credential
present or absent, the health verdict, the latency the last poll measured, success and failure counts,
whether it has been ejected, the last error it produced, and its resilience budget, plus the failure
threshold that decides ejection. The reasons are the gateway's own `RouteSkipReason` values, so the page
renders a decision the gateway already makes rather than forming a second opinion. Loading, error and
empty states are real, and the error state says nothing is shown from memory.

**DashboardOverview is deleted** and `/` plus the catch-all now land on `/providers`. Its concept — a
traffic history — cannot be made real, because the gateway keeps no request log. `/providers` already
shows what the operator has and whether it is healthy, so the landing page is now the real version of
what the mockup was gesturing at. The `Overview` nav entry went with it, the sidebar's "Connect a
provider" CTA now points somewhere that can, and `dashboardRoutes` no longer names a route that does
not exist.

**The shell was already honest and I had not noticed.** `DashboardShell` has a `pending` flag that
renders a disabled "soon" entry, and three items carry it: **Usage**, **Request log**, **Settings** —
which is exactly what the fabricated pages were pretending to provide. The nav said those features did
not exist; the pages invented them anyway. The nav is now the only place that has to be right.

## Two guards, both mechanical

- **Every dashboard page imports the data client.** A page that asks the gateway nothing cannot be
  showing the gateway's state. That is the general form of this defect and it is what let two pages
  through.
- **A request count is only ever the placeholder `'0'`.** The gateway keeps no counter, so any other
  value is a fabrication. Proven by planting both:

```
requests: '18,492' — nothing counts requests, so only the placeholder is available
these pages import no data source, so anything numeric on them is a literal: OrphanPage.tsx
```

```
tests    840 → 842
```

## Task 80: a rate limit was a one-way switch, and the page could not see it

Task 79 made the Routing page show `GET /v1/routing` instead of fiction. It took four real requests to
notice that the endpoint it now renders **omitted the one field that decides eligibility**.

### What the report was missing, and why

`RateLimitPolicy` records every wait, and its own comment states the reason:

> Held here rather than in the engine so the whole limit policy is one object, and so the dashboard's
> view of a cooling-down connection cannot disagree with the limiter that made it cool.

`RoutingEngine.waits()` existed to expose exactly that. Measured:

```
grep -rn "\.waits()" apps/gateway/src src   # excluding the tests
(no matches)
```

**Nothing outside `routing-engine.test.js` ever called it.** The promise was in a comment and the value
never left the object — so a connection over its limit was reported as an ordinary connection, and the
Routing page (new in 1.38.0) rendered **"eligible — routing can choose this"** about a connection
routing was actively refusing. The page was reading a real endpoint and still lying, which is a harder
failure than the mockup it replaced: a fabricated page is at least consistently fabricated.

### The second copy of the decision

`RoutingPage.whyNotUsable()` also derived eligibility by hand, from four fields, in a `.tsx`. It
disagreed with `resolveRoute` in both directions:

| Connection | `resolveRoute` | the page said |
| --- | --- | --- |
| 1 failure, `lastError` set, threshold 3 | **candidate** | "last attempt failed" |
| over its rate limit | skipped, `rate-limited` | **"eligible — routing can choose this"** |

The first row is the session's recurring shape one level down: `lastError` survives long after the
ejection it caused has decayed, and nothing told the two copies which of them was authoritative. The
summary card counted eligible connections with a third, inline copy of the same rules.

### What reading the report exposed: a permanent outage

Wiring `rateLimitWaitMs` into the report meant writing a test for it, and the test refused to go green.
It had been asserting the wrong thing:

```
2nd request           -> REFUSED: RATE_LIMITED | limit of 1 requests per minute
after 1 more minute   -> REFUSED: Skipped: p (rate-limited)
after 60 more minutes -> REFUSED: Skipped: p (rate-limited)
```

**A connection that hit its rate limit could never serve another request for the life of the
process.** `plan()` built its skip list from `this.limits.observed()` — the waits *recorded* by the last
dispatch — while `enforce()` was the only writer, and `enforce()` runs on the candidates `plan()` had
already returned. So the refusal wrote a positive wait; the next plan skipped the connection *for
refusing*; nothing ran that could ever write `0` again. A per-minute budget that can spend itself once
is not a rate limit, it is a switch, and sixty minutes is longer than any limit anyone sets.

This has shipped in every release since the limit existed, and 20 gateway tests missed it, because
every test set a limit of 0 or sent fewer requests than the limit allowed.

## What I did

**The skip decision now asks the limiter.** `RateLimitPolicy.currentWait()` is a pure query over the
window, and `plan()` calls it per connection per request. The recorded wait became what it always
claimed to be — a *report*, never an input to a decision. A query records nothing, so the same rule that
fixed the double-count in 1.25.0 holds here.

**`GET /v1/routing` carries `rateLimitWaitMs`**, absent when no request has asked about the connection's
limit and `0` when it was asked and is free. The distinction is the gateway's own, recorded deliberately
in 1.25.0, and collapsing it would have made "never checked" look like "free".

**`src/lib/routingVerdict.ts`** now owns the eligibility rule — extracted out of the `.tsx` so it can be
called rather than read — and `RoutingPage` calls it for both the cards and the summary count. The rule
follows `resolveRoute`'s order: enabled, credential, not ejected, not waiting. `lastError` is no longer a
reason at all; on an eligible connection it is shown as *context*, because it is a record of one past
failure and not a verdict on the route.

**Two behaviour changes, both recorded rather than hidden:**

- A connection over its limit is now refused with `PROVIDER_UNAVAILABLE` — "No enabled provider
  connection can serve this model. Skipped: p (rate-limited)." — instead of `RATE_LIMITED`, because
  `plan()` now skips it before `enforce()` can refuse it. That is the more honest code: at that point
  nothing *can* serve the model. The cause is still named in the message, which is the part that matters,
  and it stays `retryable` so failover still happens.
- The recorded wait persists until a request re-checks it. `RateLimitPolicy` records a verdict per
  request and holds no timer. I expected the report to expire the wait on its own; it does not, and
  inventing a timer would let the dashboard describe a wait for a request that never happened.

## Guards

- `tests/routing-verdict.test.js` — 9 tests. The verdict must agree with `resolveRoute` on every input,
  which is the property; the four rules are an implementation detail free to move. Plus: the rule lives
  in `lib`, the page calls it, no hand-written eligibility chain survives in the `.tsx`, and the payload
  type declares the wait.
- `apps/gateway/test/routing-engine.test.js` — the latch itself: refused, then a candidate again after
  the window slides, and `plan()` does not corrupt the reported waits.
- `apps/gateway/test/routing.test.js` — end to end through the service and `describeRouting()`:
  absent → `0` → refusal naming its cause → recovery.

```
tests    842 → 854
```

## Task 81: a health check that proved nothing, and called itself route health

Two OpenCode connections, two credential models, and every model on both refused. The dashboard showed
both as **green**. Here is the whole finding, measured.

### What the dashboard said

```
GET /health  ->  {"status":"degraded", "providers":[
                   {"providerId":"opencode",         "status":"healthy", "latencyMs":1225},
                   {"providerId":"opencode-console", "status":"healthy", "latencyMs": 841}, …]}
```

The provider cards rendered that as **"Route health 100%"** on both.

### What the models actually did

Through the gateway's own adapters and the gateway's own stored credentials:

```
opencode (Zen API key, 67 chars)    free models  403  FreeTierError: free tier can only be used from within OpenCode
                                   qwen3.8-max  402  Insufficient account funds
opencode-console (OAuth, 39 chars)  free models  403  FreeTierError (identical)
                                   gpt-5-mini   400  Model is unavailable
```

Two different root causes, one invisible symptom. `opencode` needs account funds; `opencode-console` is
refused for a reason of its own that still needs investigating.

### Why they said `healthy`, honestly

Both adapters asked the cheap question and answered it correctly:

- `zen` calls `listModels` — the key is accepted, the catalog reads. **84 models listed happily.**
- `opencode-console` calls `validateCredential` — `/api/user` answers, so the session is live.

Neither was asked whether a model can answer. And **that is the right thing for a health check to do**,
which is the part worth being careful about. A poll runs every 60 seconds on every adapter, so a real
completion per poll is a real bill every minute. The SDK says so where it was decided:

> A signed-in probe would cost a billable request on every health poll, so the credential is checked for
> presence and shape only.

So "make health send a request" was the wrong fix, and for these two providers it could not even work:
every free model is refused outright, so a probe would report a working credential as a broken one.

**The defect is that the cheap check borrowed the expensive check's word.** `healthy` reads as *this
route can serve traffic*. It was returned for a fact about a credential. The session's recurring shape
one level up from 1.35.0's Check button and `health.ts`'s own "a check that proved nothing" — the
question was not asked, and nothing recorded which question had been asked instead.

## What I did

**`ProviderHealth.verified` is now required: `'credential' | 'inference'`.** Not optional with a
default, because a default is the old behaviour wearing a new name. A new adapter cannot compile without
choosing which question it answered.

**All nine adapters say `credential`,** because all nine read a catalog or a session and none completes
a request. That is the honest uniform answer; claiming `inference` would be the same overclaim pointed the
other way, and a test now forbids it.

**`/health` carries it through**, including the three verdicts `HealthManager` builds itself — an expired
session, an adapter with no health check, and a thrown probe.

**The card labels it.** `Route health 100%` is now `Credential check` plus one line: *"The gateway can
read this connection's catalog. Whether a model can answer is only known by sending one."* The
`inference` branch keeps the `Route health` label for a check that earned it.

## The guard was blind, and planting found it

`tests/health-verification.test.js`, 5 tests, asserts the property (**no consumer may present a
credential check as evidence about traffic**) rather than a list of nine adapters.

My first version counted `verified:` occurrences per file and required one. I planted the defect — deleted
the scope from Kiro's `healthy` return — and **it passed**, because Kiro has two verdicts and the second
one still carried its scope. A verdict belonging to a different branch satisfied a check about this one.
The fix counts `status:` literals inside the method body and requires one scope per verdict:

```
AssertionError: kiro.ts: 2 verdict(s) returned, 1 scope(s) declared
```

That is the sixth guard bug this session, and the same shape as the others: green, plausible, and blind in
the exact place it existed to look.

```
tests    854 → 859
```

## Task 82: the frontend, checked in a browser instead of by reading it

Every defect in this session so far was found by reading source and measuring the **gateway**. The
dashboard's `.tsx` files had never been opened in a browser. This one was, with `browser_exec` driving
the real page, and it found two things in the first ten minutes.

### 1. `92%` — a fabricated metric, still rendering

Verified live on `/dashboard/providers`:

```
CONNECTED | 7 | NEEDS ATTENTION | 2 | AVAILABLE | 4 | ROUTE HEALTH | 92% | last 24 hours
```

Three cards counted from `providers`. The fourth read **`92%`**, and its detail read **"last 24
hours"**. Both are literals. The gateway keeps no request log, no success counter and no timing
history, so there is no percentage to compute and no window to compute it over.

This is the **same value that shipped three times** in 1.34.5 and was deleted from two components in
1.37.0 and 1.38.0 — the `92 ms` / `1,417` Ollama figures from the fabricated Overview page. **The
number outlived the component it belonged to**, which is the recurring defect one level up from the one
I have been fixing: fixing the *card* is not fixing the *value*.

And the reason it survived is the one this release is mostly about:

```ts
async function testAll() {
  const health = await getGatewayHealth();
  setProviders((current) => mergeGatewayConnections(current, gatewayConnections, health));
  const healthyCount = health.providers.filter((p) => p.status === 'healthy').length;
  setNotice(`${healthyCount} of ${health.providers.length} provider connections are healthy.`);
}
```

**`GET /health` was called on every load and on every Test all. Its result was merged into the cards
and then discarded.** The summary card had no report to read, so it invented one. The load path did
the same, so it also needed `Test all` pressed before it showed anything.

The card now reads `CREDENTIAL CHECK · 5 of 11 · credential accepted`, counted from the report the
cards themselves were built from, and `—` until a report exists.

### 2. Two pages, one fact, two answers

```
/providers            opencode   Credential check   100%
/providers/opencode   opencode   ROUTE HEALTH       Pending
```

`ProviderDetailPage` **never called `getGatewayProviderHealth` on load**. It read health only when
someone pressed **Test provider**, into a `connectionHealthy` boolean with no notion of *which*
question had been asked. So a page opened cold said "Pending" — claiming a check was in progress when
nothing had been asked — while the providers page, reading the same poll, showed its result.

The detail page now reads health on load (same single-provider endpoint the Test button uses, because
waiting for every adapter to be probed made the button look broken), carries the `verified` scope from
1.40.0, and renders `Credential check · 100%` / `Not read yet` / `Failed` instead of a `100%`-or-
`Pending` pair that meant neither. Its connection badge no longer calls a credential poll "healthy".

### 3. The marketing page still illustrated the traces it no longer claims

Continued the audit past the dashboard. On `/`, the route panel showed:

```
local preview · request trace        # and an animated green dot reading "listening"
SELECTED ROUTE  200 OK  claude-sonnet-4
LATENCY 412 ms   POLICY balanced
1,284 req/min   p95 412ms   0 retries needed
```

**Every one of those is a literal, and the dot is a liveness claim.** There is no request counter, no
timing history, no retry counter, no request log, and nothing polling.

This is 1.37.0's fabrication, still on the page. That release deleted the "Live request traces" and
"spend" **copy** from `App.tsx` and its guard went green — because the guard reads `src/App.tsx`, and
this panel is **`src/components/RoutePreview.tsx`**, imported at `App.tsx:525` and rendered inside the
very section whose copy was rewritten to say the product had no traces.

> **The guard could not see a component the guard's own page rendered.** A check that reads the file
> which imports a component is not reading what the visitor sees, and it reported the page honest
> while the page was not.

The panel keeps what is genuinely worth demonstrating — the shape of a request, and the fact that
choosing a provider is a decision you can make — and loses everything that claimed a measurement:
throughput, p95, retry count, the literal request id `#8f2a`, the per-route latencies, the "balanced /
premium / efficient" cost labels, and the pulsing "listening" badge. What remains says **illustration**.

### 4. The guard was widened, and the ban list corrected

`marketing-claims.test.js` now scans every `.tsx` under `src/` instead of `App.tsx` alone, and records
`listening` and `req/min` with their reasons. The count assertion moved 8 → 9, with the reasoning
written down, because that test exists to stop the list being quietly emptied.

One entry had to be corrected rather than added: the ban was the bare word **`spend`**, and
`ProviderPlayground` legitimately says a provider "will spend" credits on a real request — which is
true and is the point of the warning beside it. A guard that forbids a common English verb gets
switched off rather than weakened, so the entry is now `spend tracking`, the phrase that would actually
be a claim.

## The guard was blind twice, and both times on the correct code

`tests/health-surfaces.test.js`, 6 tests, asserts the property: **any page showing a health verdict
must name what it established.** It scans every page in `src/pages`, so a fifth page is covered too.

Both failures were in the guard, not the code:

| Version | Blind because | Symptom |
| --- | --- | --- |
| window | looked for the scope in a **fixed 160 characters** before the label | flagged the one line doing it right — a ternary on one line fell outside the window |
| `/verified/` | the flag is `connectionVerified`, and the match was **case-sensitive** | `/verified/` never matches `Verified` |

Second one is the seventh guard bug of this shape, and the most embarrassing: the guard could not see
the identifier it was written to look for. It passed the planted `92%` regression immediately, and
failed the fixed code. A window is a guess about formatting; a case-sensitive pattern is a guess about
a spelling. Both are guesses where the declaration was available.

Both were found by **planting**, and both plants were caught by the corrected version: the original
`92% / last 24 hours` card fails the label check, and the restored `1,284 req/min` / `listening` panel
fails the claims check with `"listening"`.

## Also measured, and clean

Not everything in the audit was a defect, and it is worth saying so:

- No horizontal overflow at **1440, 1024 or 390 px** on any dashboard page; no element past the right edge.
- No text clipped by a fixed-height box. The `HEADE` I first read as truncation was `innerText` stopping
  at a line break — `scrollWidth` equals `renderedWidth`.
- **No button, link or `[role=button]` without an accessible name**, and no interactive target under 24px.
- Mobile at 390px: the sidebar collapses to a hamburger, cards and key rows fit, nothing overlaps.
- No console errors across the whole session.

```
tests    859 → 871
```

## Task 83: the free-tier gate is the request, not the credential — and I had it backwards

Every free model on the `opencode` connection was refused:

```
mimo-v2.6-flash-free   403  {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
big-pickle             403  (identical)
nemotron-3.5-…-free   403  (identical)
```

### What I concluded first, and why it was wrong

The message names the OpenCode client, so I inferred the free tier wanted **the CLI's own credential** — a
356-char account session token rather than the Zen API key the adapter holds. I measured a fingerprint
comparison (67 chars in the vault, 356 in the CLI's `opencode.db`) and reported it as settled.

**It was inferred from one refusal rather than measured.** The user pointed at
`/home/gin/work/OmniRoute`, which serves the same models through the same base URL with
`authType: "apikey"`, and `open-sse/executors/opencodeFreeTierContract.ts` records the contract it
measured against the live endpoint on 2026-09-17:

```
1. stream: true in the body
2. a non-empty tools array — the official client's placeholder name is _noop
3. x-opencode-session shaped ses_ + 12 hex + 14 base62
4. User-Agent carrying opencode/<version> with version >= 1.17

"Removing any single one of the four turns a 200 into a 403."
```

A **Zen API key** reaches the free tier. The gate is the request. My conclusion was backwards, and a
working implementation was sitting on the same disk the whole time.

### What the adapter sends now

`ZenAdapter` applies the contract to any model whose id ends `-free`, streaming upstream and
re-aggregating the answer — because `stream: true` is one of the four conditions and there is no
non-streaming path to take. A caller's own tools are kept; the placeholder is only a fallback.

Two decisions worth recording:

- **The suffix decides, not a list.** The upstream rotates its free lineup — six models delisted and
  replaced inside a week, per the working implementation's own note. A hardcoded list would serve models
  that no longer exist and refuse ones that do.
- **The placeholder name is configuration.** One made-up name was accepted on `big-pickle` and refused on
  two other free models the next day. That is an observation about someone else's service, so
  `OMNIHILBRAS_ZEN_PLACEHOLDER_TOOL` and `OMNIHILBRAS_ZEN_USER_AGENT` override it without a release.

### Measured after the change: still refused, and now it says why

```
mimo-v2.6-flash-free   PROVIDER_UNAVAILABLE: OpenCode Zen refused mimo-v2.6-flash-free after this
                       gateway sent everything its free-tier request contract requires … The API key was
                       accepted, so this is not a credential problem: OpenCode limits its free tier to
                       non-datacenter networks, and this host's egress address is the likely cause.
```

All four conditions applied and the upstream still answers 403. The working implementation names the
likely reason twice: the CLI identity headers exist because *"Cloudflare requires [them] on VPS egress"*,
and the free tier *"rejects generic client UAs from datacenter IPs"*. This host's egress is `AS204044
Packet Star Networks Limited`, a hosting provider. **That is a hypothesis, recorded as one** — proving it
needs a request from a residential IP.

So the contract is necessary and, from here, apparently not sufficient. What is not left to hypothesis is
the message: a refused free model is not a key problem, and saying so is what stops the next person from
rotating a working credential. I made exactly that mistake earlier this session.

### The reasonless verdict was two layers deep

The bare *"The provider refused the request."* was not only the adapter's. `FetchHttpTransport.stream`
raises its own `ProviderError` for a non-2xx **before** yielding a single event, so the gate's refusal
arrived as a throw that never reached the adapter's handler. `captureGateRefusal` wraps the stream and
converts it — the only place that can still tell it was the gate, because by the time it throws the
contract state is gone. `providerErrorFromResponse` maps every 403 to `PROVIDER_REQUEST_FAILED` and
attaches no `statusCode`, so the gate is recognised by the provider's **own `FreeTierError` wording**
instead; that keeps a 429 as `RATE_LIMITED` rather than collapsing every gated refusal into one code.

### The guard was blind, and the same way

`tests/provider-refusals.test.js`, 7 tests. The seam check used a 400-character window after `catch`, and
deleting the `gatedRefusal(...)` call from the middle of that catch **still passed** — the window ran on
and found the word in the *next* method's name.

That is the same defect as `health-surfaces`' two blind spots in 1.41.0, and the third time a
fixed-width window has been the wrong place to look. It now reads the wrapper's **body**.

```
tests    871 → 889
```

## Task 84: ten providers as catalog cards, and the two-copies rule finally enforced

Asked for ten in the API-key group: Kimi, DeepSeek, Qwen, Mistral, Groq, Grok, NVIDIA, OpenAI, Gemini,
Anthropic. Chose **cards only, no new adapters**, because nine of the ten are already reachable through
the OpenAI-compatible path and writing an adapter for them would be building what exists.

Endpoints probed rather than assumed:

```
moonshot 401   deepseek 401   dashscope 401   mistral 401   groq 401
xai 401        nvidia 200      openai 401       gemini 403    anthropic 401
```

NVIDIA answers without a key — it publishes a public catalog at `integrate.api.nvidia.com/v1/models`. Every
one is a real endpoint; none needed an adapter.

### What the count guards caught, twice

`provider-cards`, `provider-options` and `provider-card-merge` each pin the catalog size at **13**. Adding
nine cards failed all three, which is the guard working: a catalog that changes silently is a catalog
whose numbers nobody has looked at.

The second failure was mine. Options went 10 → **16**, not 19. I added nine to ten without noticing that
`openai`, `anthropic` and `google` had moved out of `withoutCard` into the catalog — **+9 −3**. That
arithmetic error is itself an argument for the rule below: I could only get it wrong because the list was
described in two places.

### The rule that was documented, unenforced, and immediately broken

`providerOptions.ts` says:

> Adding a card for one of them means deleting its entry, and `tests/provider-cards.test.js` fails if both
> exist.

**It does not fail. No test checked.** So adding cards for `openai`, `anthropic` and `google` would have
left them in both places — the exact duplicate the comment forbids, and precisely how seven of seven
shared providers ended up with two different descriptions in 1.35.1. `withoutCard` is now empty and a test
enforces it.

My first version of that test compared against `providerOptions` and flagged **all sixteen cards**, because
options are *derived* from the catalog and a card legitimately appears in both. A check that cannot pass is
a check nobody keeps; it now measures the hand-written entries only.

### Mistral

You already had a Mistral card, so of the ten requested, **nine** are new. I added a second one before
noticing — the same two-copies defect — and deleted mine rather than yours.

### Verified in the browser, not just in tests

All ten render on `/dashboard/providers` and appear in the Add-provider dialog, with **zero broken images**
across 21 marks. Every logo path is a file already committed under `public/providers/` — no `initial` is
doing the work of a logo, which is the rule from 1.33.1 after 294 assets went missing from 18 releases.

```
tests    889 → 893
```

## Task 85: the nine cards were claimed to work, and nothing had ever checked

1.43.0 added nine providers with **no adapters**, on the stated grounds that the gateway serves them
through `ProviderResolver`'s saved-endpoint fallback. That claim was in a comment, in a release note, and
in `service.ts` — and it had never been tested for a **new** id, because every existing fallback test uses
ids that predate the fallback. `service.ts` registers exactly six: `cline`, `opencode`,
`opencode-console`, `kiro`, `chatgpt-web`, `deepseek-web`.

So: saved four of the new ids as connections and routed a real request through each, pointed at a loopback
port with nothing listening.

```
save kimi-probe    200   route 502 PROVIDER_UNAVAILABLE
save qwen-probe    200   route 502
save groq-probe    200   route 502
save nvidia-probe  200   route 502

refused as an UNKNOWN provider? no — the fallback engaged
```

A `502` from the dead port and a refusal for an unknown provider look identical from the client and mean
opposite things to whoever is debugging. The `502` is the only evidence the fallback built an adapter.

**The probe itself was wrong twice before it was right, and both failures were the kind that produce a
confident answer.** It used `POST` where the route is `PUT`, got a 404, and then read the *authentication*
failure of the follow-up request as "the fallback engaged" — a conclusion about a probe that had never saved
anything. It then sent `providerId` in the body, which `assertOnlyFields` rejects. Only after both did the
`502` mean anything. A probe that cannot fail loudly is not a probe, and I wrote one that reported success
twice on the way.

### The guard, and the three wrong shapes it took

`tests/new-provider-cards.test.js`, 6 tests, from the static half — what CI can run. Each of the first four
assertions was wrong before it was right:

| Attempt | Claim | Why it was wrong |
| --- | --- | --- |
| 1 | a card may not share an id with a registered adapter | `opencode` and `mistral` legitimately do |
| 2 | six registrations are readable from a literal match | four name constants — **two** were found |
| 3 | `const X = 'literal'` | `const deepseekWebProviderId: ProviderId = 'deepseek-web'` carries a type |
| 4 | the *derived* near-miss id must be unregistered | all three are, correctly |
| 5 | the *base* near-miss id must be unregistered | `opencode` is, correctly |

Four wrong guesses at the shape of the code, in a file whose whole job is to check the code. What it asserts
now is the hazard that can still happen: **an API-key card listed in `webSessionProviders.ts`** would show
"Sign in" on a card whose entire purpose is a key. Plus the near-misses must *be* web sessions, so the check
stays a measurement rather than a tautology.

Both properties were verified by planting: renaming the Groq card onto `deepseek-web`, and giving a new card
a `92 ms` latency.

```
tests    899 → 905
```

## Task 86: the browser-safety guard could not see 14 of the 24 SDK modules

1.42.0 shipped a blank dashboard (`node:crypto` in the barrel). 1.43.0 added
`tests/sdk-browser-safety.test.js` to stop it recurring. That guard is **green, plausible, and blind in the
exact place it exists to look** — the sixth such guard this session.

`barrelExports()` walks the SDK barrel so the `Buffer` rule applies to what the dashboard actually loads.
Its specifier pattern was `['"]\./([\w.-]+)\.js['"]`. The barrel's own lines are:

```
export * from './adapters/anthropic.js';    ← NO MATCH
export * from './errors.js';                ← MATCH
```

`[\w.-]+` cannot match a `/`. **Every subdirectory import was invisible**, so the walk stopped after ten
modules and fourteen adapters — including the three that use `Buffer` — were never examined:

```
barrelExports() reaches 10 files; src/ actually has 24
```

The exemption that justified narrowing the rule (*"no `.tsx` imports `cline`"*) was therefore reasoned from
a graph that silently excluded the modules it was reasoning about.

### The product is fine; the guard was not

Measured against the **built** bundle, not the source:

```
src.js         Buffer tokens: 0     Buffer. occurrences: 0
dashboard.js   Buffer tokens: 0     Buffer. occurrences: 0
process. hits: 4 — all React's own shim behind typeof process === 'object'
```

Zero `Buffer` in all three chunks. The `deepseek-web`/`chatgpt-web` strings that appear in the bundle are
the **catalog** in `src/data/providers.ts`, not the adapters. Tree-shaking drops the rest. So no blank page
today — by luck of bundling, not by design.

### Split by failure mode, because they are different

`Buffer` is an undefined identifier, not a build error: the bundle builds and throws **when the line runs**.
A `node:` import is externalized and fails while the graph loads. So module scope is what matters.

- **module-scope `Buffer`** → reaches the browser at page load → blank page. Now fatal.
- **in-function `Buffer`** in a function no `.tsx` calls → harmless, and three real modules do this.

### The first scope check was blind too, and planting is the only reason I know

```js
if (/^(export\s+)?(async\s+)?(function|class|const|let|var)\s/.test(line)) inDeclaration = true;
if (!inDeclaration && /\bBuffer\b/.test(line)) offenders.push(...)
```

`const CLINE_MARKER = Buffer.from(...)` sets the flag **on the line being checked**. Planted module-scope
`Buffer` → `ℹ fail 0`. Now module scope is brace depth 0, and all three plants go red:

| Plant | Result |
| --- | --- |
| module-scope `Buffer` in `cline.ts` | ✖ fatal test |
| nested adapter via subdirectory import | ✖ resolver now sees it |
| module-scope `Buffer` in that nested adapter | ✖ both |

## Task 87: an SSRF bypass in the provider-URL guard, which had no test at all

`isPrivateHostname` decides whether a user-supplied provider `endpoint` may be reached. Grepping the SDK
suite, the gateway suite and `tests/` for `isPrivateHostname` or `assertSafeProviderRequestUrl` returned
**nothing**. A security boundary with zero coverage, for its entire life.

`169.254.169.254` — the cloud metadata endpoint — was correctly refused. The same host as an IPv4-mapped
IPv6 address was not:

```
VERDICT  PRIVATE  URL
blocked  true     https://169.254.169.254/latest/meta-data/
ALLOWED  false    https://[::ffff:169.254.169.254]/
ALLOWED  false    https://[0:0:0:0:0:ffff:a9fe:a9fe]/
```

**A running gateway accepted and stored it:**

```
500   plain metadata (should be refused)   ← the guard's error
200   IPv4-mapped metadata                 ← saved as a connection
```

And it was not an inert string. Pointed at a loopback listener, the mapped form carried a real TCP connection
to it — `ERR_SSL_WRONG_VERSION_NUMBER`, i.e. TLS bytes arriving at a plain HTTP server. The address is
genuinely routable; the bypass is a real one.

`::` (the IPv6 `0.0.0.0`) was also allowed.

### Why the fix took three attempts, and what each one got wrong

1. **Match a trailing dotted quad — dead code.** `new URL('https://[::ffff:169.254.169.254]/').hostname` is
   `[::ffff:a9fe:a9fe]`. The WHATWG parser normalises to hex *before* the guard sees the string, so the only
   spelling that ever arrives is the hex one. Every case in the new test is written as the parser delivers it.
2. **Read the `ffff` marker from group 6 instead of group 5.** `numbers[6]` is `a9fe`, so the check returned
   undefined for the exact input it was written to catch, and the endpoint stayed reachable through a
   correctly-built, correctly-reasoned guard.
3. **`fe80::1` also ends in `0x0001`.** Reading groups 6–7 unconditionally reports it as `0.0.0.1` — the right
   verdict for the wrong reason, which is precisely how a future bug hides behind a passing test.

### The suite, and the proof it can fail

`packages/omnihilbras-sdk/test/url.test.js`, 9 tests on the compiled `dist`. It asserts the blocked set
*and* the public set, because a guard that refuses everything passes the first. `::ffff:0808:0808` (mapped
8.8.8.8) must stay **public** — the case that catches an over-broad fix. `isLoopbackHostname` must *not*
accept the mapped form, or cleartext HTTP opens to arbitrary private hosts.

Reverting the two new lines in `isPrivateHostname`:

```
✖ every private destination is refused, however it is spelled
    https://[::ffff:169.254.169.254]/  (IPv4-mapped metadata — the bypass)
✖ the mapped form is judged by its embedded IPv4, not by an IPv6 prefix
✖ http is refused for everything but loopback
ℹ pass 6  fail 3
```

### Still open, deliberately not fixed here

`localtest.me` resolves to `127.0.0.1` and is **allowed**. Blocking it needs resolution at request time, which
means deciding what to do when DNS fails and adds a lookup to every provider call. That is a design decision
with a latency cost, not a one-line fix, so it is recorded rather than guessed at.

## Task 88: adding a provider discarded the key and invented a healthy card

Found by an independent audit pass, then verified by reading the cited lines myself. Both halves are real,
and the second is the one that matters.

`ProvidersPage.tsx` had exactly one save path, for OpenRouter. Every other provider fell through to:

```ts
async function handleSave(newProvider: NewProvider, apiKey?: string) {
  if (newProvider.providerId === 'openrouter') { /* ... saveOpenRouterConnection ... */ return; }
  finishAdd([newProvider]);          // apiKey is never read again
}
```

So for **all nine providers added in 1.43.0**, and every other non-OpenRouter provider, the key the user
had just pasted was **discarded** — the gateway was never called — and the card was built from
`recordForNewProvider`:

```ts
status: 'connected',
health: 100,
lastUsed: 'just now',
```

A credential that had never left the browser, presented as a working, healthy, just-used connection. This is
the 1.34.5 Ollama defect and the 1.36.1 `lastUsed` defect, in a third location, and it survived both fixes
because **both of those were made inside `mergeGatewayConnections`** — the function that folds a connection
the gateway *reported*. Nothing looked at the path where there is no report.

`putGatewayConnection` was already implemented in `gatewayClient.ts` and had **no caller at all**. A
complete, working save path, unreachable.

### Fixed

- `handleSave` now calls `putGatewayConnection` for every non-OpenRouter provider and builds the card from
  the connection the gateway returns.
- `handleSaveMany` saves each entry and reports failures by name, instead of green-stamping all of them.
- `recordForNewProvider` → `recordForUnsavedProvider`, with `available` / `health: 0` / `lastUsed: 'never'` /
  `models: '—'`. It is still used for genuinely unsaved entries, so its fields must be honest rather than
  absent.
- `finishAdd` → `finishAddLocally`, and its notice ends **"Not saved to the gateway yet."**

### The guard, and the two plants that shaped it

`tests/provider-card-honesty.test.js`, 4 tests. `provider-card-merge.test.js` could not see this and still
cannot: it tests the merge, and the defect was in the non-merge path. "The merge is correct" is not the same
claim as "every card is honest".

Both of my first two versions were wrong, and planting is the only reason I know:

| Plant | Result |
| --- | --- |
| restore `connected` / `100` / `just now` | ✖ 2 tests |
| `void putGatewayConnection(...)` with a hand-built object | **passed** — the call was present, unreachably |
| awaited, but its result discarded | ✖ |
| `apiKey` removed from the request body | ✖ |

The middle one is the lesson: asking whether a function name appears anywhere in a file is not asking
whether it runs. The test now asserts the call is **awaited, its result bound, and that `apiKey` is in the
request body** — the field that was being dropped.

The first version also flagged five *correct* lines (a type union, a filter label, a function signature),
because the patterns matched bare tokens. Each now requires an object-literal `{` or `,` before the field.

Verified in the browser: 22 cards render, `#root` mounts, and **"just now" appears nowhere on the page**.

## Task 89: the management surface had no authentication at all

Found by an independent audit pass, then reproduced against a running gateway before being believed.
**This is the most serious defect of the session.**

`handleInferenceRoute` was the **only** consumer of `ctx.auth` in the entire route layer. It gated
`GET /v1/models` and `POST /v1/chat/completions`; nothing else checked anything. So the routes that *mint
credentials* and *switch the gate off* sat entirely outside it.

Measured with **no `Origin` and no `Authorization`** — a plain local process, nothing more:

```
200  GET  /v1/connections              → every configured connection and its endpoint
201  POST /v1/keys                     → {"key":"ohk_..."}    the full secret
200  PUT  /v1/settings/require-api-key {"requireApiKey":false}
```

The minted key is accepted by the one gate that does exist, so minting alone is a complete bypass of the
LLM surface. Disabling enforcement needs no credential at all, and **persists**.

`docs/SPEC-SDK.md` said "Keys authorize access to the LLM surface only; connection and key management stay
reachable from the local dashboard" — the spec described the defect.

### The gate sits at the single dispatch point, not in each handler

A gate per handler is a gate a route added later forgets. It is one `if` in `handleRequest`, before the
route loop, over `MANAGEMENT_PREFIXES`: `/v1/connections`, `/v1/keys`, `/v1/oauth`, `/v1/settings`,
`/v1/web-cookie`, `/v1/routing`. `authorize()` returns early when enforcement is off, so local mode and
every test that builds a gateway without a key store are unchanged.

### The list-agreement test found a hole I had just written

`/v1/web-cookie` — which stores a **whole-account session cookie** — was not in my first list of four. The
test that reads the router and checks it against `MANAGEMENT_PREFIXES` failed on it, and `/v1/routing` was
added alongside it (same disclosure as `/v1/connections`). The test earned its place within one run of
being written.

### What it cost an existing test, honestly

`routing.test.js` had one test that minted a key **over HTTP** and then presented it. That is now a
bootstrap deadlock — you cannot present a key to get a key. It mints through the store instead. Five
requests in that test then needed the key added, which is the gate working rather than a regression.

### Recorded limitation, not papered over

`kind: 'dashboard'` is derived from the `Origin` **header**, which any non-browser client sets freely, so a
local process can claim to be the dashboard and skip the gate. Closing that needs a per-launch secret the
browser presents — a design change, not a patch. Until then this raises the bar from *any local process* to
*a local process that also knows the key*: the difference between an accidental postinstall script and a
deliberate attacker. Written into `docs/SPEC-SDK.md` next to the contract.

## Task 90: three more false claims, a dead control, and a broken build script

All from the same audit round as Task 89. Each verified by reading the claim and the code that is
supposed to satisfy it.

### "All systems operational" in the header of every page

`DashboardShell.tsx` rendered a hardcoded green badge, unconditionally, 120 lines above a sidebar badge
that had been carefully built to *ask* the gateway — its own comment records that a literal "Gateway
online" reported the one thing that was false for exactly as long as the outage lasted. The header badge
was the fabricated twin.

It now calls the same `useGatewayStatus()` hook. **Proven in both directions**, which is the part that
matters: with the gateway up it reads "Gateway reachable"; with the gateway killed it reads "Gateway
unreachable" within one poll interval. The old string would have said "All systems operational" through
exactly that outage.

**I broke the dashboard doing it.** My first attempt appended the hook call *after* the component's
closing brace, because I searched for the last `return (` in the file rather than the one inside
`DashboardShell`. It **typechecked** — `gatewayUp` was in scope file-wide — and rendered a blank page,
because a hook called at module scope has no React dispatcher. `tsc` cannot see that; the browser can.
Found only because I checked the page rather than trusting the green typecheck.

### A "Strategy" select that changed nothing

`ProviderDetailPage.tsx` offered Balanced / Fastest response / Lowest cost / Prefer private, stored the
choice in local state, and flashed **"Policy changed to balanced."** `strategy` was never sent to the
gateway and nothing read it. The gateway has no policy, no strategy setting and no rules store — exactly
as `RoutingPage.tsx` states in its own header. Removed, and the local state with it.

The marketing page made the same claim in two more places, plus a decorative diagram labelled "policy
engine" (now "priority order", which is what the dots actually depict) and a `curl` sample pointing at
`gateway.omnihilbras.dev`, **a hostname with no DNS record** (now `http://127.0.0.1:8787`, which is where
the product actually runs).

`tests/marketing-claims.test.js` records all six with reasons; `FALSE_CLAIMS` goes 9 → 15. Both plants
verified: restoring the budget claim, and restoring the hardcoded badge, each turn the suite red.

The header comment on that count now says the uncomfortable part: five of the six were in files the guard
had been reading all along. **It catches these claims when someone records them, not when they are
written.** That dependency is stated rather than implied.

### `pnpm build` fails on a clean checkout

`build` ran `build:frontend` **before** `build:sdk`, and the dashboard imports the SDK barrel, which Vite
resolves through `node_modules` to `dist/`. Verified by removing the SDK `dist/` and running the frontend
build alone:

```
error during build:
Error: [vite]: Rolldown failed to resolve import "@hilbras/omnihilbras" from "src/pages/ProviderDetailPage.tsx".
```

`pnpm build` is a documented command in AGENTS.md and the only Build step in CI. It worked **only** because
`verify` runs `typecheck` first, and `typecheck` starts with `build:sdk`, priming the artifact. CI has been
green by ordering luck. Reordered to `build:sdk && build:frontend && build:gateway`.

### `playwright-core` was a devDependency that runtime code imports

`apps/gateway/src/chatgptWeb.ts:97` does `await import('playwright-core')` from **shipped runtime code**.
A `pnpm install --prod` gateway cannot load it, and the error message told users to run
`pnpm add -D playwright-core` — reproducing the wrong classification. Moved to `dependencies`; the two
install hints corrected.

### A subagent finding I did not act on

It reported `@types/pngjs` as an unused dependency. **`pngjs` ships no types** (`"types": None`) and
`vite.config.ts:3` imports it, so the stub is required. Left alone. A finding is a claim; this one was
wrong, and reading the cited evidence is what caught it.

## Task 91: the published package did not compile for a consumer without `@types/node`

`clineHeaders` built a header object with `'X-PLATFORM': process.platform`. TypeScript infers that as
`NodeJS.Platform` and writes the inference straight into the emitted declaration:

```ts
// packages/omnihilbras-sdk/dist/adapters/cline.d.ts
'X-PLATFORM': NodeJS.Platform;      // a type that does not exist without @types/node
```

Packed into a real consumer with no `@types/node` and compiled:

```
consumer has @types/node: no
cline.d.ts(61,19): error TS2503: Cannot find namespace 'NodeJS'.   REAL EXIT=2
```

### Four independent reasons it survived every gate here

1. the SDK typechecks against its own `@types/node`, so `NodeJS` resolves;
2. the root `tsconfig.json` sets `skipLibCheck: true`, skipping declaration files entirely;
3. the dashboard consumes the `workspace:*` link, never the tarball;
4. **nothing compiled the artifact from outside**, so no consumer's view was ever checked.

Point 4 is the class of defect. A guard reading this repository's own `dist/` would pass forever, because
`dist/` here is always built in a tree that has `@types/node`.

### Fixed, and asserted as the general property

`clineHeaders` now declares `Record<string, string>` — every value in it is a string, so the annotation is
also the honest description. `tests/published-types.test.js` asserts that **no emitted declaration may name
`NodeJS.*` or `Buffer`**, not that this one line is absent: the next instance would be a different file
with a different suffix. It also asserts the SDK has been built, so the file cannot pass by having no
subject.

Both plants verified:

| Plant | Result |
| --- | --- |
| revert the explicit return type (the original defect) | ✖ |
| a `Buffer` return in a *different* adapter | ✖ |

### A measurement trap worth recording

The first consumer script piped `tsc` into `head`, so `EXIT=0` came from **head**, not from `tsc` — and
the broken package read as a passing one. Capturing the exit code directly is the whole difference between
a reproduction and a no-op. The corrected script reports `REAL EXIT=2` reverted, `REAL EXIT=0` fixed.

# OmniHilbras SDK Tasks

- [x] Task 1: Create the SDK package and normalized contracts.
  - Acceptance: strict TypeScript types exist for chat, streaming, models, capabilities, errors, and secret lookup.
  - Verify: package typecheck passes and public exports are documented by types.
  - Files: `packages/omnihilbras-sdk/package.json`, `tsconfig.json`, `src/types.ts`, `src/errors.ts`, `src/secret-store.ts`, `src/index.ts`.
  - Scope: Small.

- [x] Task 2: Add transport, streaming, and provider registry.
  - Acceptance: fetch transport supports JSON, SSE streams, timeouts, cancellation, and normalized errors; registry resolves adapters by ID.
  - Verify: focused unit tests pass with fake fetch implementations.
  - Files: `src/transport.ts`, `src/registry.ts`, `src/streaming.ts`, tests.
  - Depends on: Task 1.
  - The real ids are `gpt-5.6-luna-free`/`-thinking` and the `gpt-5-6`/`gpt-5-5` families; dots and hyphens are one model.
  - Scope: Medium.

- [x] Task 3: Implement the generic OpenAI-compatible adapter.
  - Acceptance: configurable base URL, auth header, model path, chat path, JSON responses, and SSE streaming normalize correctly.
  - Verify: fixture-based contract tests cover success, HTTP errors, malformed responses, and stream termination.
  - Files: `src/adapters/openai-compatible.ts`, fixtures/tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [x] Task 4: Implement the native OpenAI adapter.
  - Acceptance: bearer auth, model listing, chat completions, and `[DONE]` stream handling are isolated in the OpenAI adapter.
  - Verify: adapter tests use representative OpenAI response and stream fixtures.
  - Files: `src/adapters/openai.ts`, tests.
  - Depends on: Task 3.
  - Scope: Small/medium.

- [x] Task 5: Implement the native Anthropic adapter.
  - Acceptance: Messages API conversion, system instructions, version headers, model listing, and native SSE event conversion are isolated in the adapter.
  - Verify: adapter tests cover text/tool responses, errors, and stream events.
  - Files: `src/adapters/anthropic.ts`, tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [x] Task 6: Implement the native Gemini adapter.
  - Acceptance: `generateContent`, model listing, authentication, request conversion, and streaming conversion are isolated in the adapter.
  - Verify: adapter tests cover candidate content, safety metadata, errors, and stream chunks.
  - Files: `src/adapters/gemini.ts`, tests.
  - Depends on: Task 2.
  - Scope: Medium.

- [x] Task 7: Add gateway service and configuration.
  - Acceptance: local configuration loads provider credentials/endpoints through `SecretStore` and builds a provider registry without provider conditionals in the service.
  - Verify: configuration and service unit tests pass with fake adapters.
  - Files: `apps/gateway/src/config.ts`, `src/service.ts`, tests.
  - Depends on: Tasks 3–6.
  - Scope: Medium.

- [x] Task 8: Add local HTTP routes and streaming responses.
  - Acceptance: `/health`, `/v1/models`, and `/v1/chat/completions` support JSON and SSE with consistent error envelopes.
  - Verify: integration tests use fake adapters and never contact real providers.
  - Files: `apps/gateway/src/server.ts`, routes, tests, package scripts.
  - Depends on: Task 7.
  - Scope: Medium.

- [x] Task 9: Connect provider health actions to the local gateway.
  - Acceptance: provider health testing calls the local gateway and surfaces structured success/error states; credential persistence remains preview-only for providers without a management endpoint.
  - Verify: browser smoke test and frontend build/typecheck pass.
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProvidersPage.tsx`, `src/pages/ProviderDetailPage.tsx`.
  - Depends on: Task 8.
  - Scope: Small/medium.

- [x] Task 9a: Add a secure local connection store.
  - Acceptance: connection metadata is stored separately from encrypted credentials; files use restrictive permissions and an injectable in-memory implementation supports tests.
  - Verify: focused storage tests cover encryption-at-rest, round trips, atomic writes, and no plaintext secret in the metadata file.
  - Files: `apps/gateway/src/connections.ts`, gateway tests.
  - Depends on: Task 7.
  - Scope: Medium.

- [x] Task 9b: Add OpenRouter validation and save routes.
  - Acceptance: the gateway validates credentials against OpenRouter on both Check and Save, stores only a valid key, and returns metadata without secrets.
  - Verify: gateway integration tests use a fake provider transport and assert validation-before-save, status codes, and redaction.
  - Files: `apps/gateway/src/config.ts`, `src/service.ts`, `src/server.ts`, gateway tests.
  - Depends on: Tasks 9a and 8.
  - Scope: Medium.

- [x] Task 9c: Connect the dashboard modal to the connection API.
  - Acceptance: OpenRouter Check and Save call the loopback gateway, errors remain in the dialog, and saved connection metadata is reflected without browser secret storage.
  - Verify: typecheck/build, gateway tests, and browser smoke test.
  - Files: `src/lib/gatewayClient.ts`, `src/components/AddProviderModal.tsx`, `src/pages/ProvidersPage.tsx`, `src/pages/ProviderDetailPage.tsx`.
  - Depends on: Task 9b.
  - Scope: Medium.

- [x] Task 9d: Add model discovery and import policy to OpenRouter connections.
  - Acceptance: Save accepts a free-only/all-models policy, fetches models server-side with the saved credential, filters free models by provider pricing, validates IDs, persists the selected model list, and preserves manually added IDs across re-imports.
  - Verify: adapter/service/gateway tests cover pricing parsing, both policies, malformed provider responses, metadata limits, concurrent mutations, and no-secret responses.
  - Files: `packages/omnihilbras-sdk/src/adapters/openrouter.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, tests.
  - Depends on: Tasks 9a–9c.
  - Scope: Medium.

- [x] Task 9e: Add model import controls and model catalog persistence to the dashboard.
  - Acceptance: OpenRouter connection dialog has an active/inactive free-model import toggle; Save triggers the correct import; detail pages show imported models and persist custom model IDs only after the gateway confirms them.
  - Verify: typecheck/build and browser smoke test for both toggle states, edit-policy preservation, and failed/successful model additions.
  - Files: `src/components/AddProviderModal.tsx`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, `src/pages/ProvidersPage.tsx`.
  - Depends on: Task 9d.
  - Scope: Medium.

- [x] Task 9f: Replace preview model tests with real gateway chat checks.
  - Acceptance: provider tests use live adapter health, model tests send a bounded real chat completion with the saved credential, and latency/success/error states come from the gateway response.
  - Verify: gateway contract test covers provider selection and max-token budget; typecheck/build and browser smoke test cover the real request path.
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, `apps/gateway/test/server.test.js`, docs.
  - Depends on: Task 9e.
  - Scope: Small/medium.

- [x] Task 9g: Add gateway API keys and the dashboard keys page.
  - Acceptance: the gateway mints, pauses, revokes, and authenticates client keys; only SHA-256 hashes are stored; enforcement guards `/v1/models` and `/v1/chat/completions` by default with an allowlisted-dashboard exemption; the dashboard page manages keys without browser secret storage.
  - Verify: gateway store/route tests cover hash-at-rest, one-time reveal, constant-time authentication, paused-key rejection, enforcement toggling, and origin exemption; typecheck/build and browser smoke test cover create, pause, resume, and delete.
  - Files: `apps/gateway/src/api-keys.ts`, `src/secure-store.ts`, `src/service.ts`, `src/server.ts`, `src/config.ts`, `test/api-keys.test.js`, `src/pages/ApiKeysPage.tsx`, `src/lib/gatewayClient.ts`, `src/components/DashboardShell.tsx`, `src/dashboardApp.tsx`, docs.
  - Depends on: Task 9f.
  - Scope: Medium.

- [x] Task 9h: Add per-connection retry, timeout, rate limits, and health-based failover.
  - Acceptance: each connection stores a validated resilience budget; retryable failures retry then fail over by priority; terminal failures never retry; deadlines and rate limits are enforced by the gateway; failing connections are ejected and recover automatically; the dashboard exposes the controls and live state.
  - Verify: routing tests cover retry-then-failover, terminal-error short-circuiting, timeout and rate-limit handoff, ejection with cooldown recovery, streaming failover before the first chunk, and background health polling; HTTP tests cover the attempt trace and resilience route; browser smoke test covers the Reliability panel.
  - Files: `apps/gateway/src/routing.ts`, `src/service.ts`, `src/connections.ts`, `src/server.ts`, `src/config.ts`, `test/routing.test.js`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9g.
  - Scope: Medium.

- [x] Task 9i: Add hedged requests and on-demand provider adapters.
  - Acceptance: a slow leading connection is raced against the next eligible one and the first reply wins with the loser cancelled; no hedge is sent when a fast leader answers or no second candidate exists; any provider can be added with a caller-supplied endpoint and served through an on-demand OpenAI-compatible adapter.
  - Verify: routing tests cover hedge-wins, fast-leader-not-hedged, single-candidate skip, leader-wins, failed-race fallback, and on-demand adapter resolution; live check against a deliberately slow endpoint measures the latency difference and the attempt trace.
  - Files: `apps/gateway/src/service.ts`, `src/connections.ts`, `src/server.ts`, `test/routing.test.js`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9h.
  - Scope: Medium.

- [x] Task 9j: Test every model concurrently from the provider page.
  - Acceptance: a Test all control sends one real bounded request per model through a bounded worker pool, with selectable concurrency, live progress, per-model results identical to a single test, a Stop control, and a summary with median latency and failure count.
  - Verify: browser smoke test covers the progress indicator, bounded in-flight count, per-model ping badges, and the completion summary.
  - Files: `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`.
  - Depends on: Task 9f.
  - Scope: Small/medium.

- [x] Task 9k: Collapse the dashboard into one React Router entry.
  - Acceptance: the dashboard is a single app mounted at `/dashboard` with real paths, the duplicate `provider.html`, `providers.html`, and `routing.html` entries are removed, navigation uses `Link`, and old `.html` URLs redirect to their replacement.
  - Verify: typecheck/build, dev-server rewrite, redirect table, and browser navigation between routes.
  - Files: `src/dashboardApp.tsx`, `src/components/DashboardShell.tsx`, `src/components/ProviderCard.tsx`, `src/pages/ProvidersPage.tsx`, `src/pages/DashboardOverview.tsx`, `src/pages/ProviderDetailPage.tsx`, `src/lib/routes.ts`, `vite.config.ts`, `public/_redirects`, docs.
  - Depends on: Task 9g.
  - Scope: Small/medium.

- [x] Task 9l: Implement the Cline OAuth sign-in flow.
  - Acceptance: the Cline card's Add connection opens the sign-in in the browser and finishes on its own — `POST /v1/oauth/cline/start` mints a single-use `state` and a session, Cline redirects the browser to `GET /v1/oauth/cline/callback`, the gateway claims the state, proves the token with a real account request, imports the model catalog, and saves an encrypted `oauth` credential. The dashboard learns the outcome by polling `GET /v1/oauth/cline/session/:id`. `POST /v1/oauth/cline/exchange` stays as the fallback for a provider that does not hand the code to a browser redirect. An expired token is renewed before use and written back to the vault.
  - Verify: 38 gateway tests cover the session lifecycle, single-use state, replay and forged-state refusal, the full browser round trip, a provider error with markup, a rejected code reaching the dashboard instead of a timeout, and the cross-site exemption staying narrow. 6 SDK tests cover `workos:` prefixing that leaves non-JWT keys verbatim, one-shot refresh with persistence, and missing-token handling. Browser check confirms the tab opens on Cline's real sign-in page, the dialog centres, and a real rejected code reports `Cline did not accept that sign-in. Try again.` with no connection stored.
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `src/types.ts`, `src/index.ts`, `test/cline.test.js`, `apps/gateway/src/oauth.ts`, `src/service.ts`, `src/server.ts`, `src/connections.ts`, `test/oauth.test.js`, `test/oauth-routes.test.js`, `test/cline-sessions.test.js`, `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, `src/data/providers.ts`, docs.
  - Depends on: Task 9g.
  - Scope: Medium.

- [x] Task 64: Phase 3 — `CredentialLifecycle`: the one question about a credential that needs no request.
  - Acceptance: a credential that says it has ended is reported as such without the provider being asked, and every uncertainty still asks.
  - Verify: 12 gateway tests, 1 SDK contract test; 762 tests. Measured end to end through `HealthManager`.
  - Findings: **every credential this project stores carries an expiry, and for two of the five kinds nothing ever read it.** A ChatGPT Web health check *launches a browser*, so a connection whose session ended an hour ago was launching one on every sweep to be told what the stored credential already said in writing. Cline was the same shape at lower cost.
  - **My first measurement was wrong and I corrected it before building.** I checked whether each adapter's *file* mentioned `expiresAt`, and reported three kinds unchecked. `deepSeekWebCredential` stores no expiry at all — a userToken — so the real gap is **two**, not three. Measuring the wrong thing and reporting it confidently is the failure this project keeps running into, and it is cheaper to catch here than after shipping.
  - The gap's real shape: `chatgpt-web` keeps its expiry *inside* the credential's JSON, and `toClineCredential` writes an `expiresAt` that `ProviderCredential` only declares on the OAuth branch — so a field was being stored that nothing could read back generically.
  - **A boolean could not express three states, and that was a real flaw in my first design.** `false` from an adapter that *cannot say* is indistinguishable from `false` from one that checked, so an uncertain adapter would have produced a confident "valid" and the gateway would have sent a request that cannot succeed. `isCredentialExpired` now returns `boolean | undefined`, where `undefined` is *cannot say* — and a test that asserts every uncertainty resolves to "go and ask" is what caught it.
  - **The SDK contract caught `isCredentialExpired` throwing on the very first adapter it was run against.** `chatGptWebSessionFromCredential` throws for a credential that is not a ChatGPT session, which is right on the request path and wrong in a *pre*-check: a pre-check that throws can take down whatever asked it. Now read defensively.
  - **The contract deliberately does not assert "a past expiry is expired"**, because a contract cannot know each provider's credential shape. A ChatGPT Web credential is a JSON storage state, not an OAuth record, and feeding one adapter the other's shape is exactly the plausible-looking fixture that proves a test rather than a fact — my first draft did precisely that and failed. The contract now pins what holds for *any* shape (does not throw; one of three answers; unreadable is `undefined`), and the shape-specific assertions live where the shape is owned.
  - **It is a pre-check and not a replacement.** A credential that is not expired may still have been revoked, so the network check still runs whenever the answer is not already known — asserted, because skipping it would report revoked sessions as healthy, which is the confidence-without-evidence this project refuses elsewhere.
  - Files: `apps/gateway/src/credential-lifecycle.ts` (new), `apps/gateway/src/health.ts`, `apps/gateway/src/service.ts`, `packages/omnihilbras-sdk/src/types.ts`, `packages/omnihilbras-sdk/src/adapters/{chatgpt-web,cline}.ts`, `apps/gateway/test/credential-lifecycle.test.js` (new), `packages/omnihilbras-sdk/test/provider-contract.test.js`.
  - Depends on: Task 63.
  - Scope: Medium.

- [x] Task 63: Phase 3 — a real `RequestContext`, because `ProviderRequestContext.requestId` was declared and never set.
  - Acceptance: one id per accepted request, and the *same* id in the reply, the refusal, and the context every adapter is called with.
  - Verify: 12 tests including an end-to-end one through a real server; 372 gateway tests. Measured end to end, not asserted.
  - Findings: **`ProviderRequestContext` has carried a `requestId` field since it was written, and nothing has ever set it.** Measured across the repository, the only `requestId` is a local inside the ChatGPT Web browser driver, which never reaches an adapter. So the one field that makes a request context worth having — the thing that lets a user quote *"it failed at 3pm, request 4f2a"* and an operator find that line — was declared and permanently `undefined`.
  - **Tying four fields into one tidier type would have changed nothing.** The finding is not that the type is scattered; it is that the one field that earns the type's existence is empty. So this is a feature, not an extraction, and it is sized like one.
  - Generated **once at the edge**, before routing. A context that acquired its id inside a provider adapter would be an id per *provider* rather than per *request*, which is the opposite of what it is for.
  - **Two of my own tests found holes in my own code, and the second is the same class as last release's.** I typed `RequestScope` `readonly` and returned a plain object — `readonly` is a *type* and nothing at runtime. Second time this session: a `ReadonlyMap` that was a real `Map`, now a `readonly` that was a mutable object. Frozen.
  - The other: `attachRequestId` **replaced** an id that was already attached by a different scope. Silently pointing an error at a request that was never in flight is worse than no id, so the first id wins and a second attachment is a no-op.
  - **My end-to-end probe printed `undefined` on both sides and I nearly read it as a wiring failure.** It was the probe: without an `Origin` header the request is not dashboard traffic, so the LLM surface's API-key gate refused it before it reached a provider. **The gate behaving correctly looked exactly like the feature being broken** — and had I trusted the probe I would have "fixed" working code. Now pinned as a test with that reasoning attached.
  - The id rides on the context field that already existed, so a published adapter type gains nothing and an adapter that ignores it is unaffected.
  - Files: `apps/gateway/src/request-context.ts` (new), `apps/gateway/src/credential-manager.ts`, `apps/gateway/src/request-executor.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/routes/inference.ts`, `apps/gateway/src/http.ts`, `apps/gateway/test/request-context.test.js` (new), `docs/SPEC-SDK.md`.
  - Depends on: Task 62.
  - Scope: Medium.

- [x] Task 62: Measure `FailoverPolicy` before creating it — and decline.
  - Acceptance: the roadmap's Phase 3 list is reconciled with what the code actually needs, with the reasoning on the record rather than the item quietly omitted.
  - Verify: read the executor's chain loop looking for a fourth decision. There is none — every statement is bookkeeping or a delegated call to a policy that already owns the choice.
  - Findings: **the failover decision is already covered by two files.** `routing-engine.plan` decides which routes may serve a model; `retry-policy.afterFailure` decides retry / next-route / stop; `request-executor` walks the chain and decides nothing.
  - A `FailoverPolicy` file would therefore be a **rename, not an extraction** — a file that decides nothing, added to the architecture because a list mentioned it. That is the cosmetic extraction every phase so far has been careful to avoid, and the roadmap's own constraint is *incremental refactoring rather than a rewrite*.
  - **Recorded rather than quietly dropped.** The plan file now says this item was measured and declined, with the measurement, so "Phase 3 complete" does not quietly mean "Phase 3 complete except for the parts I skipped".
  - No files changed. This is a decision, not a change.

- [x] Task 61: Phase 3 — `HedgePolicy`, the last of the four mechanisms separated from their rules.
  - Acceptance: whether a second request is worth sending, and which route, is one decision with a named reason for every refusal.
  - Verify: 14 tests; 360 gateway tests, all 346 previous ones unchanged. `request-executor.ts` 372 → 362, `service.ts` 994 → 985.
  - Findings: **`tryHedgedRace` was 107 lines, and every one was either bookkeeping or a decision about spending the operator's money.** A decision that decides how many paid requests a gateway makes should not be discoverable only by reading a timer callback, so the seven conditions moved out and the bookkeeping stayed.
  - **Three of the seven cannot change while a request is in flight** — no leader, no alternative, not configured — so they are decided once in `planFor` rather than re-decided per tick. Re-deciding what cannot change is how two things that must agree drift apart, and this is the fourth time that shape has been the bug.
  - **The clause that costs the most is `leader-settled`.** A hedge is only worth sending while the leader is *still in flight*: once it has answered, a second request buys an answer nobody will read, paid for in full. It is the one condition checked every tick, so it is the one most likely to drift if the tick and the settle bookkeeping live apart. A test asserts it, and another asserts the *property* — that no sequence of ticks can start a route twice or invent one.
  - **Every refusal names a reason, and that is the point of the extraction.** *"No hedge fired"* and *"a hedge fired and lost"* are completely different outcomes for a client reading the ledger. The old code had three bare `return`s in a timer callback, so the only way to learn why a configured `hedgeAfterMs` did nothing was to read the loop.
  - **I wrote a variable that was written and never read**, caught by the compiler, and removed it. I had been about to add a public field to surface the reason, which would have been a behaviour change to make a diagnostic available — the wrong trade for a release about extraction. The comment now says why the reason is *not* recorded, rather than claiming it was.
  - The hedge delay is taken from the **leader**, not from the candidate being hedged: the delay is a property of the request being slow, and taking it from a candidate would let a second request's settings silently retime the first.
  - Files: `apps/gateway/src/hedge-policy.ts` (new), `apps/gateway/src/request-executor.ts`, `apps/gateway/test/hedge-policy.test.js` (new).
  - Depends on: Task 60.
  - Scope: Medium.

- [x] Task 60: Phase 3 — `TimeoutPolicy` and `RateLimitPolicy`, so each policy is one object.
  - Acceptance: what a timeout value means is answered in one file; what a request limit means and when it is spent is answered in one file.
  - Verify: 22 tests; 346 gateway tests.
  - Findings: **`withDeadline` and `connections.ts` were two files answering one question** — "what does a timeout of 0 mean". The mechanism decided a non-positive timeout means no deadline, and the store decided the default, and the default had been `0`. That duplication is how the two of them disagreed for long enough for a hung provider to hold requests open. `DEFAULT_TIMEOUT_MS` now lives in `timeout-policy.ts` and `connections.ts` imports it, so the interpretation and the default cannot be changed apart.
  - `RateLimitPolicy` gathers three things that were in three files: the window's answer, the refusal built from it, and the commit. The disagreement between them was the defect fixed in 1.25.0. The engine's remaining job is only *which routes a request may take*.
  - **A test I wrote found a hole in my own code.** I typed `observed()` as `ReadonlyMap` and returned the real `Map` behind it — and `ReadonlyMap` is only a *type*, so the value was still mutable. A caller that could `set` a wait could make a throttled connection look ready, which is the exact confusion the waits exist to prevent. It is now a genuine read-only view rather than a copy, because `plan()` reads it on every request and copying a map per request to defend against a caller that does not exist is the wrong trade.
  - **A test of mine asserted a timeout's `publicMessage` equalled its `message`, and failed — and the code was right.** A client gets the provider-neutral wording and the dashboard gets the detail separately, so leaving `publicMessage` unset is deliberate: the generic sentence is accurate, and it is the one that should not name a provider's internals to a caller holding only a key. The test now asserts the real property — the code is classified, and the public message is safe to show.
  - Another test of mine called `enforce` twice expecting two records and got an exception for the second. Correct: the refusal *and* the wait are both expected, and the wait is recorded before the throw — which is the whole point of recording it.
  - Files: `apps/gateway/src/timeout-policy.ts` (new), `apps/gateway/src/rate-limit-policy.ts` (new), `apps/gateway/src/connections.ts`, `apps/gateway/src/routing-engine.ts`, `apps/gateway/src/service.ts`, `apps/gateway/test/timeout-policy.test.js` (new), `apps/gateway/test/rate-limit-policy.test.js` (new).
  - Depends on: Task 59.
  - Scope: Medium.

- [x] Task 59: Phase 3 — extract `RetryPolicy`, and fix a rule that asked again after being told no.
  - Acceptance: one decision — retry, next route, or stop — consulted by every path a request can fail on, and it does not depend on which path asked.
  - Verify: 12 policy tests plus the rewritten invariant guards; 324 gateway tests. Measured with the attempt ledger as the source of truth, before and after.
  - Findings: **the decision was inline at two places and had already diverged**, and the divergence was the bug. The chat path had `if (code === 'RATE_LIMITED' && attempts.length > 1) break;` and the streaming path had no rate-limit rule at all. Measured:
  - ```
    chat  / RATE_LIMITED   primary → primary → backup     3 attempts
    stream/ RATE_LIMITED   primary → backup                2 attempts
    ```
  - **Chat asked a connection that had just answered "you have reached your limit" a second time.** The condition was gated on the *global* attempt count, so a fresh request on a limited connection — global count of one — read as "not the first attempt" and was retried. The second request is not optimism; it is a request the provider has already refused, and it is paid for. The line's own comment said the opposite of what the code did.
  - The policy keys off `attemptsOnThisRoute`, the connection's own retry budget, and hands off for `RATE_LIMITED` **unconditionally**. A test asserts the answer is the same whether this was the first request or the fifth, because the original bug was exactly that the answer depended on the global count.
  - **A property worth pinning that I had not considered:** a provider marking a *terminal* code `retryable: true` is still stopped, because `isRetryableFailure` consults the code list before the flag. Trusting the flag would let a mistyped code fan out across every route.
  - **The totality test is the one that matters here** — every code the SDK can raise, in both retryable states, asserting the two paths differ in exactly one way (a stream never retries) and agree everywhere else. A policy that is merely correct on the cases you thought of is not a policy.
  - **My "no provider ids" guard was weak, and I only found out because it failed for the wrong reason.** It matched any hyphenated word, so it passed only because no such word happened to appear — and the moment `RetryPolicy` introduced `'next-route'` it failed on a name that is not a provider. It now reads the SDK's adapter directory, so it is self-maintaining: a new provider cannot be added without it noticing, and nothing else in the file can trip it. Rewritten in four files, and **verified by planting a real provider id**, which it caught: *"the model-catalog must name no provider, found: openrouter"*.
  - **I nearly concluded the rewritten guard was broken**, because my first planting attempt appeared to pass. The build had failed — I had piped `tsc` to `/dev/null`, so I could not see it — and I was reading a stale `dist`. Suppressing a command's output and then trusting its result is the same mistake as writing a test that asserts nothing.
  - Files: `apps/gateway/src/retry-policy.ts` (new), `apps/gateway/src/request-executor.ts`, `apps/gateway/test/retry-policy.test.js` (new), four invariant guards, `docs/SPEC-SDK.md`.
  - Depends on: Task 58.
  - Scope: Medium.

- [x] Task 58: Extract `ModelCatalog` — the last Phase 2 item in the plan.
  - Acceptance: the client list, the per-provider list, model-to-provider resolution and discovery all live together; the catalog names no provider.
  - Verify: 20 tests; 312 gateway tests. `service.ts` 1013 → 994 lines, which is **1,506 lines below where this phase started**.
  - Findings: **four provider-neutral jobs were scattered through the composition root** — the list a client sees, the list one provider offers, which provider a model id belongs to, and what a provider will actually serve when asked. None named a provider; together they are the whole of "what models can I use", which is a question about the catalog and not about the gateway.
  - `notSupported()` moved to `capability.ts` because a second consumer needed it, and importing a private function from the composition root would have been backwards. Its message names the adapter and the capability, because "this provider is unavailable" and "this provider never advertised the feature" look identical from outside and send the user to opposite places.
  - `resolveProviderId` is the interesting one, and each step is a **different kind of certainty**: the caller named one (not this method's job to overrule); exactly one saved connection owns it; several own it, so a chat-capable one wins — because owning a model in a catalog is not the same as being able to answer it; one connection exists at all, so use it, which is the manually-added-model case; and otherwise the default, which is a **refusal to guess** rather than a coin toss between unconnected providers.
  - A disabled connection does not claim a model, or switching one off would leave its models routed to it.
  - One of my own tests had a fixture that contradicted its own assertion — the first connection was enabled *and* credentialed while the test asserted an empty list. The code was right.
  - **Phase 2 as the roadmap specifies it is now complete:** `ProviderResolver`, `RequestExecutor`, `ConnectionManager`, `CredentialManager`, `SignInManager`'s sessions, `SignInCoordinator`, `RoutingEngine`, `ModelCatalog`, and the `routes/` split.
  - Files: `apps/gateway/src/model-catalog.ts` (new), `apps/gateway/src/capability.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/model-catalog.test.js` (new).
  - Depends on: Task 57.
  - Scope: Medium.

- [x] Task 57: Extract `RoutingEngine`, and find two defects in what it now owns.
  - Acceptance: the routing algorithm and its inputs live together; the engine names no provider; a default request has a deadline.
  - Verify: 13 engine tests plus 2 rewritten limiter tests; 292 gateway tests. `service.ts` 1043 → 1013 lines.
  - Findings: **`planRoute` was twenty lines in the composition root, and each reached for a different piece of state owned by someone else** — the health registry, the failure threshold, the rate limiter's waits, the default resilience. So the algorithm was in `routing.ts` and the inputs were scattered across a class, which is the shape that makes a routing change look like a service change.
  - **A connection saved without an explicit timeout had no deadline at all.** `withDeadline` treats a non-positive timeout as *run without a deadline*, and `defaultResilienceSettings.timeoutMs` was `0`, so a provider that stopped responding held the request open indefinitely — the client hung, nothing noticed. Both `withDeadline`'s own comment and the SPEC promised the opposite. **This is the third time this project has contradicted its own documented guarantee, and the first time it was the *default* that was wrong.** The default is now two minutes; `0` still means unlimited for anyone who asks, and existing connections keep their own settings, so the blast radius is new connections only.
  - **A rate limit of 60 per minute allowed 30.** `check()` pushed the timestamp into the window when it allowed a request, *and* the request path then called `record()`, which pushes again. Every request counted twice. It also over-counted in a second way: a request the limit *refused* consumed budget for a call that was never made. `check` is now a pure query; `record` is the commit and is called when a request is **dispatched**, not when it succeeds — because a request that was sent and failed still cost the provider a call. Measured, not assumed: 30 through before, 60 after.
  - **The sliding-window test was written against the buggy behaviour.** It drove `check` alone, because `check` used to record — which is precisely why the double count survived. Rewritten to drive both the way the request path does, with the window property now measured the way it is used, plus two new tests: *asking does not spend, and a request that is refused spends nothing* and *a request that was sent and failed still counts*.
  - Three of my own tests were wrong before the code was. I stubbed health as a set of healthy ids when `resolveRoute` asks `isUnhealthy(providerId, threshold)` — a double for the component the engine exists to consult is a double for the thing under test, and the mismatch surfaced as eight failures about a method I had invented. I asserted that an unowned model is skipped, when routing deliberately falls back to any usable connection so a manually added model works. And I asserted the default resilience had a timeout, which it did not.
  - Files: `apps/gateway/src/routing-engine.ts` (new), `apps/gateway/src/routing.ts`, `apps/gateway/src/request-executor.ts`, `apps/gateway/src/connections.ts`, `apps/gateway/src/service.ts`, `apps/gateway/test/routing-engine.test.js` (new), `apps/gateway/test/routing.test.js`, `docs/SPEC-SDK.md`.
  - Depends on: Task 56.
  - Scope: Medium.

- [x] Task 56: Extract `CredentialManager`, and collapse five copies of "which connection serves this provider".
  - Acceptance: one method answers it; no call site resolves a connection for itself.
  - Verify: 8 tests; 277 gateway tests. `service.ts` 1052 → 1043 lines. `connectionFor` and `context` are gone from the service, and `grep -c "connectionFor|this.context("` is 0.
  - Findings: **the answer was written in five places with the local variable named differently at each** — `owner` twice, `connection` twice — and one of the five was already a method whose entire purpose was to be the single answer. That method's own comment said the point was that *a credential cannot be assembled one way for a health check and another for a real request*, which is exactly what four inline copies undermine.
  - **This is the same seam that had already gone wrong one layer up.** In 1.23.0 the adapter factories were called with the provider id from one path and the connection id from another. Here the credential is looked up under an id the caller chose, and a credential under the wrong key is either missing — a confusing authentication error — or another connection's. So the fallback to the provider id is now confined to `CredentialManager.contextForProvider`, once.
  - **The failure is invisible when the two strings are equal, which they are for every connection the sign-in flows create.** A test that seeds the store under *both* `connection-1` and `p` with different secrets pins it: the provider id is never used as a storage key.
  - A connection with no model policy is asked for with **none rather than a default**. Inventing one here would silently widen or narrow somebody's catalog depending on which code path asked.
  - An unconnected provider is still polled, with the provider id standing in for the connection id. Failing instead would make *"not connected"* look like *"broken"*, which is the distinction the dashboard exists to draw.
  - Files: `apps/gateway/src/credential-manager.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/credential-manager.test.js` (new).
  - Depends on: Task 55.
  - Scope: Medium.

- [x] Task 55: One way to ask "which adapters are worth probing", and one answer to which connection.
  - Acceptance: `activeAdapters()` names no provider; the resolution path and the health path cannot disagree about which connection an adapter belongs to.
  - Verify: 5 new resolver tests, including *"the resolution path and the health path now agree on the connection"*. 269 gateway tests. `service.ts` 1081 → 1052 lines, provider-id literals 8 → 5 in code (`defaultProviderId`, the Cline registration, and three in the Cline connect path).
  - Findings: **`activeAdapters()` was six hand-written branches**, one per provider, each looking for a connection with a credential and building an adapter. Two of the six needed the connection id and four did not, so the six were not the same shape.
  - **The two that took an id were called with two different values.** `resolveAdapter` passed the *provider id*; `activeAdapters` passed the *connection id*. And that id is where the adapter writes refreshed credentials back to the store. So the key a Kiro adapter used for its token refresh depended on which caller built it first — the adapter is cached, so first wins, and whether a health probe or a request arrived first is invisible state. **This one is latent, not firing:** both sign-in flows set `id === providerId`, so the two values happen to be the same string today. A connection created through the generic `PUT /v1/connections/:id` route could differ, and then refreshed tokens would be written under the wrong key.
  - The factory now takes `{ providerId, connection }`, and **only the id crosses**. The rest of the record stays the connection layer's business rather than becoming a second opinion about the endpoint inside a provider adapter.
  - A provider with no static configuration is only probed once it has a credential, because probing without one spends a request that cannot succeed. That rule is now `ProviderResolver.active()` and is the whole of the method.
  - Two of my own resolver tests asserted the *old* factory contract and failed — correctly, since the contract had changed for a reason. Rewritten to assert the new one, including that an uncredentialed provider's factory is **never called** rather than called with a provider id it could mistake for a connection.
  - I also found `dynamicAdapters` left behind in the service by the `ProviderResolver` extraction in 1.16.0 — dead state from three releases ago, removed here rather than left to look load-bearing.
  - Files: `apps/gateway/src/provider-resolver.ts`, `apps/gateway/src/service.ts`, `apps/gateway/test/provider-resolver.test.js`.
  - Depends on: Task 54.
  - Scope: Medium.

- [x] Task 54: Extract `SignInCoordinator`, and fix a copy that had lost its error branch.
  - Acceptance: the claim → poll → save → publish loop exists once, and the failure describer exists once.
  - Verify: 14 tests; 266 gateway tests. `service.ts` 1098 → 1081 lines.
  - Findings: **the three copies of the failure describer had already drifted, and one had lost a branch.** Cline's fell straight to the generic fallback for anything that was not a `ProviderError`, so a socket that closed mid-exchange reported *"The sign-in could not be completed."* and nothing else. That is the one thing a failed sign-in must never do: the user is told the sign-in failed and not why. The three copies also carried three different generic fallbacks, so there was nothing holding them equal.
  - **The order of the loop is the substance, so each step is asserted separately.** Claim before polling (two tabs would otherwise both spend one OAuth grant, and the second fails at the provider with something that looks like a bug rather than a race); release on `pending` (not releasing would strand the sign-in — the claim is spent, so no later poll could ever finish it); save *before* publishing as connected (the reverse is the half-connect the file exists to prevent); a failed save resolves as `failed`, never `connected`.
  - A discovery note is **taken, not read**, so a second poll cannot re-show a stale message on a healthy connection.
  - The coordinator takes the session store **structurally** rather than as a concrete class, because the two flows hold differently shaped sessions — Kiro nests its device authorization and Console flattens it — and the coordinator has no business knowing which. That is also what makes `SignInSessionStore` usable here without a change.
  - I declared a `tolerateDiscoveryFailure` option and then found it was **never read** — the tolerance actually lives in the `save` callback, which is where it belongs. A dead option is worse than no option, so it is gone rather than left to look meaningful.
  - One of my own tests ran the coordinator against a session that did not exist yet, so it returned at the first line and asserted nothing: a test that passes for no reason. The helper now opens the session and hands its id over.
  - Files: `apps/gateway/src/sign-in-coordinator.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/sign-in-coordinator.test.js` (new).
  - Depends on: Task 53.
  - Scope: Medium.

- [x] Task 53: Take the provider contract from 9 adapters to all 11, and fix the three defects it found.
  - Acceptance: every adapter in the SDK is contracted; the gap list is empty; adding a twelfth fails the suite.
  - Verify: 112 contract assertions across 11 adapters. A deliberately added `zz-probe.ts` is still caught by name: *"adapters with neither a contract nor a stated reason: zz-probe"*. 377 SDK tests.
  - Findings: **the last two adapters were the two that needed the most, and the gap list is now empty.**
  - `deepseek-web` injects `{ fetch }`, and its flow is four endpoints: exchange the user token, solve a proof of work, open a chat session, then stream. **A fixture cannot invent a solvable proof-of-work challenge** — the solver tries `nonce` from 0 to `difficulty` and compares the *whole digest* for equality, so the challenge has to be the real hash of one of those nonces. My first fixture used `'a'.repeat(64)` and the adapter correctly reported *"no answer within the range it announced"*, which reads like a provider fault and is really a fixture that did not do the arithmetic. The harness now computes one from `deepSeekHashV1`.
  - **My `setStatus` did nothing.** The closures read the destructured `status` parameter while `setStatus` mutated `state.status`, so every refusal test ran at 200. A fixture that ignores its own control is the worst kind, because it presents as an adapter bug.
  - **A 401 was classified by which endpoint it landed on, and which endpoint that was depended on invisible state.** `users/current` and `completion` mapped 401 to `AUTHENTICATION_FAILED`; `create_pow_challenge` and `chat_session/create` mapped the *same* 401 to `PROVIDER_UNAVAILABLE`. Whether a user's dead session read as *"sign in again"* or *"the provider is down"* therefore depended on whether the access token happened to be cached. `PROVIDER_UNAVAILABLE` is retryable, so the router would fail over for a session that can never recover, and the dashboard would show an outage where the truth is an expired cookie. One `refusalFor` now handles all four endpoints, and evicts the cached token on any auth failure.
  - **The DeepSeek Web decoder trimmed every answer.** `content.trim()` on the return silently removed the leading and trailing whitespace of every answer. It was the only adapter in the SDK that did it, and the loss is not detectable by a client: an answer asked to be exactly `"  indented  "` arrives as `"indented"`, and a code answer loses its trailing newlines — visible as badly-indented code rather than as a truncated one. The contract found it because its hostile fixture ends in a single space, which looks like nothing and is the whole point.
  - `chatgpt-web` had **both defects again**: the same trim at `result.text.trim()`, and a signed-out page folded into `PROVIDER_REQUEST_FAILED`, which is retryable — so a dead session failed over to another provider and the user was never told to sign in again. `driverFailureCode` now separates *signed out* (auth), *blocked* (unavailable) and *anything else* (retryable).
  - So the last two adapters found **three** defects in code that had passing tests: two lossy trims and one refusal flattened into a retryable code. Neither file had a contract, and neither had a test that could have caught these.
  - Files: `test/harness/scripted-fetch.js` (new), `test/harness/scripted-driver.js` (new), `test/provider-contract.test.js`, `src/adapters/deepseek-web.ts`, `src/adapters/chatgpt-web.ts`, `test/deepseek-web.test.js`.
  - Depends on: Task 52.
  - Scope: Medium.

- [x] Task 52: One sign-in session lifecycle, and a units bug I inherited from both copies.
  - Acceptance: `KiroSessionStore` and `OpencodeConsoleSessionStore` share one lifecycle, and the "a grant is spent once" rule exists in exactly one function across all four stores.
  - Verify: 19 tests; 252 gateway tests. `kiro.ts` 268 → 258, `opencodeConsole.ts` 261 → 239, one new 200-line shared file.
  - Findings: **a diff of the two stores showed the lifecycle is byte-for-byte identical** — same `create`, `get`, `claim`, `release`, `resolve`, `publicStatus`, `sweep`, the same id pattern, the same "expired" message. Only the class name, two comment wordings, and a session shape that nested its payload in one and flattened it in the other. What mattered most was `claim`: the guard that stops two polls spending one OAuth grant, i.e. one code billed once, implemented twice in two files with nothing keeping the copies equal.
  - **The rule turned out to exist four times, not twice.** `KiroSocialStore` has a third copy — and for a *social* sign-in, which is a browser redirect and therefore the flow most likely to be retried by a user who double-clicks. `ClineSessionStore` has a fourth. So the shared piece is `claimOnce` and `releaseClaim`, two functions with no session shape assumed, which all four now call. Cline's extra behaviour stays in `ClineSessionStore` where it belongs: a wrong `state` spends **nothing**, so a user whose provider crossed the value can retry. That is expressed by returning `undefined` from the reader, which is what makes `claimOnce` leave the claim unspent.
  - **A units bug, inherited faithfully from both copies and then found by a test I wrote to check something else.** The fallback when a provider omits its expiry was `(ttlMs / 60000) * 1000` — which is `ttlMs / 60`. A 15-minute ceiling silently became a **15-second** session. It hid because every provider that works sends `expires_in`, and the broken conversion only runs on the path where one does not, so a browser sign-in would die in 15 seconds for any provider that went quiet. My sweep test failed for a reason I could not explain, which is what sent me to the arithmetic. Fixed by using the ceiling as the fallback, which deletes the conversion entirely, and by spelling out that `expiresInSeconds` is seconds and `ttlMs` is milliseconds so the same mistake cannot be made quietly again.
  - **Two of my own tests were wrong about behaviour that is correct.** I asserted a session is swept one ceiling after expiring; it is retained for one ceiling *past* expiry so a late poll reads *"expired"* rather than *"not found"* — two different problems a user would chase differently. And I counted implementations in a file that *quotes* the rule in its own header, so it reported two implementations when there is one. Comments in a test's subject have to be stripped before counting.
  - One test of mine had to be corrected for a units reason too: I read `defaultExpiryMinutes` as minutes when it was being used as seconds, which is the same confusion the production code had.
  - Files: `apps/gateway/src/sign-in-sessions.ts` (new), `apps/gateway/src/kiro.ts`, `apps/gateway/src/opencodeConsole.ts`, `apps/gateway/src/oauth.ts`, `apps/gateway/test/sign-in-sessions.test.js` (new).
  - Depends on: Task 51.
  - Scope: Medium.

- [x] Task 51: Phase 2 — extract `ConnectionManager`, and declare a capability instead of inferring it.
  - Acceptance: the store, the mutation lock, the catalog merge and the error mapping live in one file; the Core names no provider when saving a connection.
  - Verify: 20 `ConnectionManager` tests and 4 new `ProviderResolver` tests; `service.ts` 1174 → 1103 lines; 233 gateway tests (591 with the SDK).
  - Findings: **the duplication was the point worth fixing, not the moving.** Four near-identical error mappers differed only in their final sentence — *which* thing could not be saved. Four copies is four places for the next one to drift, and the copy that drifts is the one that starts blaming the operator for a disk error. There is now one mapper, and it takes the one sentence that varies.
  - **Lock scope is deliberately not uniform, and that surprised me.** `save` holds the lock across prove → read catalog → store, because two concurrent saves would otherwise interleave a catalog read between writes. `refreshModels` holds **no** lock: it is a slow read of a third party, and locking it would make every save in the gateway queue behind one provider. I had "helpfully" given it the lock while de-duplicating, which would have made a background rescan a stall on the dashboard's save button. Three tests now pin the asymmetry.
  - **A capability I inferred, and should have declared.** The Core used to ask "can this credential be proven before it is stored?" by naming Cline — Cline is absent from the registry, so `registry.get(id)?.validateCredential` was false for it and a literal was the only way through. I replaced it with "any on-demand provider can be validated". **Every on-demand provider has a `validateCredential`, so saving a ChatGPT Web credential started opening a real browser** — the two affected tests went from instant to 14 seconds each and failed. The fix is `onDemand(id, factory, { validateOnSave })`, **defaulting to false**: a factory cannot be inspected without building the adapter, and building it to answer a question is how a save button ends up launching a browser. Cline declares it; nothing else does.
  - **I rewrote `modelMetaFor` from memory instead of moving it**, and it was wrong on sight — the real one stores `n`/`c`/`i`/`o`/`p` single letters and reads pricing through `modelMetaPriceOrder`. Re-deriving a function from its *shape* rather than its text silently changes a stored format. This is the third time this session a plausible-looking fixture or a from-memory reimplementation has been the bug.
  - Three of my own tests were wrong before the code was: I made the store refuse when the claim was about the *validator*; I asserted "no calls recorded" when a `list` legitimately happens during a save; and I nested the store's recording state, so three tests passed the wrapper where the store was wanted. All three failed for reasons that had nothing to do with what they were testing.
  - Files: `apps/gateway/src/connection-manager.ts` (new), `apps/gateway/src/provider-resolver.ts`, `apps/gateway/src/service.ts`, `apps/gateway/test/connection-manager.test.js` (new), `apps/gateway/test/provider-resolver.test.js`.
  - Depends on: Task 50.
  - Scope: Medium.

- [x] Task 50: Phase 2 — split `server.ts` into `http.ts` and five route modules.
  - Acceptance: one 373-line `if` chain becomes five modules and a five-line dispatcher, and a test fails if any module claims a route that is not its own.
  - Verify: 4 structural tests; 37 route conditions before, 37 after (5 + 9 + 2 + 17 + 4), plus the auth gate. 210 gateway tests, all of the previous 206 unchanged.
  - Findings: **"the tests still pass" is weak evidence for a move like this, because a route that quietly stopped being reachable fails nothing.** Every existing test either still works or was never exercising that path. So the structure itself is now asserted: each module must decline every probe owned by another module, every module must decline an unroutable path so the 404 stays reachable, and the dispatcher's order is checked as a list.
  - **Why that failure mode is worse than it looks.** The dispatcher stops at the first handler that returns true. So one over-eager module — a dropped `&&`, a moved brace — silently shadows every module after it, and a 404 arrives in place of a real route. Proven rather than asserted: changing one condition to `startsWith('/v1')` in `connections.ts` made the guard fail with `connections claimed GET /v1/keys, which belongs to api-keys`, which is the whole bug in one line.
  - **Order is load-bearing and is now written down in one readable list.** The connection routes match on `startsWith('/v1/connections/')`, so `/check` and `/models/refresh` are only reached because they are tried first, and `inference` is last because it carries the authentication gate. That is no longer inferable from reading 373 lines.
  - `sendJson` was called from **43 places across all five modules** — the most-reached function in the file, and the clearest evidence the helpers were already a shared layer that had simply never been separated from the routes using them. They are `http.ts` now, and the rule they encode is that a route decides *which* resource and never how the bytes get there.
  - **The auth gate stayed with the routes it protects** rather than moving to the dispatcher. A gate in the dispatcher is one edit away from guarding the wrong thing, and it protects exactly two routes.
  - **A pre-existing test was network-dependent, and my own gate reporting hid it.** `pnpm verify` showed one failure — *"a check with no browser available is refused rather than passed"*, at 27.8 seconds — and then printed `verify exit: 0`. That zero was `echo`'s exit code, not `pnpm`'s: I had piped `pnpm verify` into `grep` and read `$?` afterwards. **A gate that reports green while a test fails is worse than no gate**, because it is believed. Fixed the capture and fixed the test.
  - The test called `checkChatGptWeb` with no driver injected, so the real driver launched a browser and reached for chatgpt.com — in a file whose own header says *"The DeepSeek connect flow, without a network"*. A test whose entire claim is *"with no browser, refuse rather than pass"* was depending on whether this machine happened to have one. The sibling file already injected a stub; this one now injects **the absence of one**, which is what it was always describing: `available()` answering `ok: false`. 28s → 1.2s, deterministic over three runs.
  - It now also asserts the driver's reason reaches the client (`/No browser is available/`). `PROVIDER_UNAVAILABLE` alone is the generic message this project does not ship, and a user cannot act on *"unavailable"* — they can act on *"install a browser"*.
  - Files: `apps/gateway/src/http.ts` (new), `apps/gateway/src/routes/{route-context,status,connections,oauth,api-keys,inference}.ts` (new), `apps/gateway/src/server.ts`, `apps/gateway/test/routes.test.js` (new).
  - Depends on: Task 49.
  - Scope: Medium.

- [x] Task 49: Phase 2 — extract `RequestExecutor`, and fix a routing defect it exposed.
  - Acceptance: the failover loop, the attempt ledger and the ordering live outside the composition root; a test says the executor names no provider.
  - Verify: 15 `RequestExecutor` tests and 2 new routing tests; `service.ts` 1409 → 1174 lines. The hedge test was run 5× consecutively to confirm it is not load-flaky.
  - Findings: **the loop and its effects were impossible to tell apart.** `chatWithFailover`, `tryHedgedRace` and `streamChatWithFailover` were 215 lines in the composition root, each interleaving the *order* (who is tried next, how many times, what is recorded) with the *effects* (send a request, apply a deadline, enforce a limit, record health). The split is that this file owns the order and the ledger and calls out for every effect — **eight named operations, not one service handle**, because a dozen-method object passed in is a service in disguise and would make the tests a re-implementation of the gateway rather than a description of the loop.
  - **Retry, hedge, timeout and rate-limit policies deliberately did not move.** Each reads a configured value off a candidate, and each has a policy file waiting in the next phase. Pulling them in would have dragged configuration reading along too, and this file would have stopped being about the loop.
  - **A defect the extraction exposed, and it was a real one.** `isRetryableFailure` treated `INVALID_RESPONSE` as non-retryable, so the loop stopped. But the loop *also* called `recordFailure` with that code, marking the connection unhealthy — so the system contradicted itself: it judged a provider broken, ejected nothing, and then declined to try a connection it had just judged capable. The four genuinely terminal codes are raised at 85 sites and every one describes **this request or this credential** (wrong model, refused key, no such lane), which is why another provider refuses them identically. `INVALID_RESPONSE` is raised at 23 sites and every one describes **an answer nobody could read** — a provider accepted the request and returned an unparseable body, which says nothing about whether the next provider can answer. One provider returning an empty stream was taking down requests a healthy second provider would have served. Fixed in the one place that decides, with the reasoning in the comment.
  - Three of my own tests were wrong before the code was, and each is worth naming: I asserted `PROVIDER_UNAVAILABLE` for a bare `Error` (a failure we cannot attribute to a provider must not blame one); I asserted both routes were tried when a non-retryable error correctly stops the chain; and I asserted one attempt per route when the default resilience legitimately retries once. The code was right in all three.
  - **The first hedge test was load-flaky and I nearly shipped it.** It passed at 43ms, then failed at 115ms on a machine at load 30 — a 1ms hedge timer racing an 80ms leader. Rewritten so the leader never settles on its own, which *guarantees* the timer fires while it is in flight, and the test waits for the hedge to actually be asked. Verified over 5 consecutive runs. A test that fails in CI for no reason is worse than no test, and "it passed when I ran it" is not evidence.
  - Files: `apps/gateway/src/request-executor.ts` (new), `apps/gateway/src/routing.ts`, `apps/gateway/src/service.ts`, `apps/gateway/test/request-executor.test.js` (new), `apps/gateway/test/routing.test.js`.
  - Depends on: Task 48.
  - Scope: Medium.

- [x] Task 48: Phase 2 — close the `resolveAdapter` seam with a `ProviderResolver`.
  - Acceptance: the resolution algorithm names no provider, and a test fails if one is added.
  - Verify: 12 `ProviderResolver` tests, including *"THE INVARIANT: the resolver names no provider"*, which strips comments and then greps for any provider-shaped string. `service.ts` 1410 → 1390 lines.
  - Findings: **the six `if` branches existed for one reason, and it was not that those providers were special.** They must be *built on demand*, because each needs a connection id, a lazily-created browser driver, or a shared access-token cache. That is a factory, and a factory is a registration — so the branches became `.onDemand(providerId, factory)` calls and the algorithm lost all knowledge of provider names.
  - **What this does and does not achieve, stated plainly.** The resolution algorithm now contains zero provider ids, and a test enforces that. But the service still names each on-demand provider *once*, in the constructor. The remaining step towards "a provider adds itself" is for adapter modules to carry their own registration — worth doing, but pretending this file has already solved it would be the kind of claim that reads as progress and is not.
  - Order is load-bearing and now tested twice: a deliberate `.onDemand()` registration beats a registry entry, and **a registered adapter is never shadowed by the synthesised OpenAI-compatible one**. The second matters more — a saved endpoint exists for plenty of providers that also have a registered adapter, and serving those generically would be *wrong* rather than merely imprecise.
  - I wrote the first version of the on-demand-ordering test asserting the opposite of what the code should do, and it failed. I had a passing-looking test written against my own wrong belief; the code was right and the test was the error, which is the only good outcome and still worth noticing.
  - Files: `apps/gateway/src/provider-resolver.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/provider-resolver.test.js` (new).
  - Depends on: Task 47.
  - Scope: Medium.

- [x] Task 47: Take the provider contract from 5 adapters to 9, and make the gap visible.
  - Acceptance: every adapter in the SDK is either contracted or listed with a reason, and adding an eleventh fails the suite until it is dealt with.
  - Verify: 94 contract assertions across nine adapters; a deliberately added `zz-probe.ts` is caught by name with *"adapters with neither a contract nor a stated reason: zz-probe"*.
  - Findings: **three adapters were structurally different from the rest, and the contract found it.** `cline`, `kiro` and `zen` needed nothing new. `opencode-console` publishes a **routing table**, not a model list — each model maps to the lane that serves it — and refuses a model by name when it cannot find a lane, so an OpenAI-shaped catalog answered a question nobody asked. `kiro` is **not JSON at all**: its answer is a length-prefixed binary eventstream read with a `DataView`, and a text decode corrupts it. Both needed harness support rather than a looser assertion, because a fixture that does not speak the provider's protocol cannot exercise it and a pass that way proves nothing.
  - The binary fixture is where the harness's own bug count is highest, and every one of them looked like an adapter bug. **A wrong header *type* byte** (`1` where the decoder requires `7`) made the frames still parse and still count, and every one arrived with no event type and no text — which reads as "the adapter dropped the answer" rather than "the fixture declared the wrong enum". A wrong header *name* did the same. The frames that fail to decode are the honest kind; the ones that decode to nothing are not.
  - A provider may now **nominate its model**, because asking and being told is right for OpenAI and wrong for Kiro — which publishes a fixed catalog and refuses anything else by name. One line, and a catalog change does not require editing the suite.
  - **The gap is named, not omitted.** `deepseek-web` (injects `{ fetch }`, needs its four-endpoint flow scripted) and `chatgpt-web` (injects `{ driver }` — a browser driver) are listed with reasons, and a test reads the adapter directory so a new one cannot be added and forgotten. An adapter silently missing from a contract is how a class of bug reaches production unnoticed, which is the failure this suite exists to prevent.
  - Files: `test/provider-contract.test.js`, `test/provider-contract.js`, `test/harness/scripted-transport.js`.
  - Depends on: Task 46.
  - Scope: Medium.

- [x] Task 46: Phase 2 — extract `ApiKeyManager`.
  - Acceptance: key policy is a separate concern with its own tests; the public surface and every user-facing string are unchanged.
  - Verify: 10 `ApiKeyManager` tests; the 13 pre-existing `api-keys` tests pass **unchanged**, including the enforcement path.
  - Findings: **I reworded two user-facing messages while moving the code, and a test caught it.** The original was `The API key is invalid or paused.` and I had written *"That API key was not recognised, or it has been disabled."* Both read better; both are also a behaviour change, and this phase exists explicitly not to make one. Restored verbatim, with a note saying why they were left alone. The lesson generalises: a refactor that quietly rewords what a user reads is the same failure as one that quietly changes what it returns, and only here did a test happen to notice.
  - The store keeps the security properties — random keys, SHA-256, one-time reveal, constant-time comparison. This adds only the two a store cannot decide: **whether enforcement is on at all** (no store means "not configured", not "accept everything", and the distinction is visible in `list()`), and **that a mutation is a unit** — a create racing a remove is a lost update on a file-backed store, and the store has no way to know two operations were meant to be sequential.
  - One test that encodes a fault that has not happened yet: **a lock whose promise chain dies on rejection turns one error into a permanently broken gateway**, because every later key operation then waits on a promise that will never settle. The chain catches.
  - Files: `apps/gateway/src/api-key-manager.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/api-key-manager.test.js` (new).
  - Depends on: Task 45.
  - Scope: Medium.

- [x] Task 45: Phase 2 — extract `HealthManager` out of `GatewayService`.
  - Acceptance: health is a separate concern with its own tests, `service.ts` no longer holds health state, and the public surface is unchanged.
  - Verify: 12 `HealthManager` tests run with no gateway, no stores and no network; all 155 pre-existing gateway tests pass unchanged. `service.ts` 1500 → 1432 lines.
  - Findings: **the extraction immediately caught a gap the contract could not close.** The manager passed an adapter's `unavailable` straight through, so a verdict with no `message` reached the dashboard unchanged — the same fault just fixed in four adapters. The contract catches that at build time, but a manager that merely forwards the omission will keep producing it for anything the contract does not cover, so **the boundary now fills the gap**. Two layers, deliberately: a test that fails, and a runtime that cannot be wrong.
  - The boundary is two questions and nothing else — *which adapters exist*, and *what context should this adapter be asked in* — supplied as closures. Passing the service itself would have made the extraction cosmetic; passing these two makes the manager testable in isolation and makes the coupling visible. If health ever needs a third thing from the gateway, that is the signal a boundary is wrong, not a reason to widen the interface.
  - `HealthRegistry` stays in `routing.ts` and is reached through one accessor. Routing *reads* failure counts to decide ejection and should not know where the counters live, and exposing the registry rather than new counting methods keeps `resolveRoute`'s provider-agnostic signature — which is well tested — untouched. Health keeps sole ownership of writing them, so a failure recorded by a request and one recorded by a sweep cannot disagree.
  - Tests that were impossible before, because health was only reachable through the service: three `report()` calls probe once; three concurrent `refresh()` calls are one sweep; asking about one provider probes one provider; an aborted or missing provider is *named* rather than reported unhealthy; a thrown check keeps the real cause instead of a generic failure. Each of those encodes a fault that shipped.
  - Files: `apps/gateway/src/health.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/test/health-manager.test.js` (new).
  - Depends on: Task 44.
  - Scope: Medium.

- [x] Task 44: A provider contract, and the four health checks it caught.
  - Acceptance: every adapter that can be driven offline passes a shared contract, and the contract has been seen to fail on the bug it exists to catch.
  - Verify: 56 contract assertions across `openai`, `openrouter`, `openai-compatible`, `anthropic` and `gemini`, all passing; the DeepSeek decoder passes a captured multi-frame stream; a decoder that keeps only the first fragment is **rejected** by the multi-part assertion. 475 tests pass.
  - Findings: **it found a real bug on the first run.** Four adapters — `anthropic`, `gemini`, `openai-compatible`, `openrouter` — reported `unavailable` from a bare `catch {}` with **no message**, so the dashboard could only say "unavailable" and not whether the key was rejected, the endpoint was wrong, or the provider was down. Those need three different things from the user. Six other adapters already did this correctly, so the shape existed to copy; it had just not been applied everywhere. All four fixed.
  - **The division of labour is the design.** The contract owns the invariants; a provider supplies only its `wireFormat` name, so the harness knows about HTTP and nothing about protocols. Asking a provider to describe its own expectations would make this a second copy of its tests; asking it only how to speak its own protocol makes this a contract, because the assertions live in one place and cannot drift per provider.
  - **The centrepiece is deliberately hostile to the DeepSeek failure.** Every completion fixture is multi-part, and the assertion is exact equality, because a test that builds its own input and then asserts against that input only proves the decoder agrees with the author of the test. The contract answer ends in a lone space and has parts sharing prefixes, so per-frame trimming and deduplication each fail. Proven rather than asserted: the shipped decoder returns `"1, 2, 3"` from a captured stream, and a decoder that keeps only the first fragment returns `"1"` and is **rejected**.
  - **Three harness bugs, each of which looked like provider bugs.** (1) The wrapper delegated `request` but stubbed `stream` as an empty generator, so all five providers "failed" streaming. (2) `refuseWith: 401` is the obvious thing to write, and reading only `.status` off a **number** yields `undefined` and then `200` — a refusal test that silently asserted a refusal works, and the provider passed. (3) `/models` also matches Gemini's `:generateContent` URLs, so a chat was answered with a model list and Gemini reported "missing a candidate". A test double that does not implement the interface it stands in for produces failures indistinguishable from real ones, which is worse than no double.
  - Also fixed in the harness, and both are fidelity bugs a harness cannot have: it now implements `HttpTransport` (`{status, headers, data}`, already parsed) rather than returning a `Response`, and it duplicates the transport's status-to-code mapping on purpose, because a double that shares the implementation it stands in for cannot catch a bug in it — and that mapping decides whether a connection gets ejected.
  - **Three injection styles exist**, which is the next architectural seam: most adapters take `{ transport }`, `deepseek-web` takes `{ fetch }`, and `chatgpt-web` takes `{ driver }`. That is why the contract needs a harness per style, and it is worth one seam later — see `docs/architecture/`.
  - Files: `packages/omnihilbras-sdk/test/provider-contract.js` (new), `test/provider-contract.test.js` (new), `test/harness/scripted-transport.js` (new), `packages/omnihilbras-sdk/src/adapters/{anthropic,gemini,openai-compatible,openrouter}.ts` (health reasons), `docs/architecture/README.md`.
  - Depends on: Task 43.
  - Scope: Medium.

- [x] Task 43: Phase 1 — one version stated once, a CI that runs, and an honest architecture map.
  - Acceptance: `pnpm verify` is the release gate, version drift fails CI, the committed probe is gone, and the architecture doc is measured rather than aspirational.
  - Verify: `pnpm version:check` fails on a real mismatch and passes when fixed; `pnpm version:fix` rewrites the derived copies; `.github/workflows/verify.yml` runs version → typecheck → test → build on Node 24 with pnpm 12.5.1 pinned. 419 tests pass.
  - Findings: **there was no CI at all.** `.github/workflows/` was empty, so 419 tests only ever ran when I happened to run them. That is not a safety net, it is a habit — and a habit does not run on someone else's machine, or on a machine too loaded to be paying attention. That is the largest single gap in the release process, and it is invisible until it is named.
  - **Version drift was one line, not a systemic problem.** I reported "six stale versions" and was wrong: five were `127.0.0.1` inside URLs and legitimate history. The real drift is `README.md` line 6, which advertised **0.2.0** while the project was at **1.12.2** — a hundred minor versions, unnoticed. `scripts/check-version.mjs` now checks the three manifests, the README line, the `X-CLIENT-VERSION` constant, and the latest tag, and it **fails** rather than generating: a generator is itself something that can go wrong silently, whereas a failing check cannot. The README match is anchored to the line's own shape, because a loose regex "fixes" the bump table's `0.2.0 → 1.0.0` examples and the URLs.
  - Removed the committed `apps/gateway/qwen_probe3.mjs` and added `tools/` for experiments. A throwaway probe in the gateway's source tree is how production and throwaway stop being distinguishable.
  - `docs/architecture/README.md` documents the architecture **as measured**, and two of its findings contradict what an outsider would assume. `routing.ts` is 186 lines with **zero** provider ids — routing is already provider-agnostic. `service.ts` is 1500 lines with **12**, and they are not scattered: six of them are one factory, `resolveAdapter`. So the Core is far cleaner than the "Core is full of provider conditionals" framing suggests, and the real gap is narrower and sharper: the Core has **no lifecycle concept at all** (`lifecycle`, `revoke`, `onboard`, `provision` — zero occurrences). Stateless providers already need no Core changes, because nine connections are live and the OpenAI-compatible ones take the generic branch untouched. What does not fit is a credential that must be created, refreshed and revoked — a Cline session, an OAuth grant — because there is nowhere for that to live. One `CredentialLifecycle` contract would absorb every hand-wired branch, which is a refactor's size rather than a rewrite's.
  - Files: `scripts/check-version.mjs` (new), `.github/workflows/verify.yml` (new), `docs/architecture/README.md` (new), `package.json`, `README.md`, removed `apps/gateway/qwen_probe3.mjs`.
  - Depends on: Task 42.
  - Scope: Medium.

- [x] Task 42: The cookie field was disabled with no way to enable it, and the catalog overclaim.
  - Acceptance: a provider with no risk notice gets a typeable field, Qwen carries the caution its own dialog promises, and the model list is labelled as the moving thing it is.
  - Verify: on `qwen-web` the caution and its checkbox render, the textarea is enabled once ticked, `Ask Qwen` enables on input, and the probe resolves in 1.4 s. 419 tests pass.
  - Findings: **a gate that could not be opened.** The textarea was `disabled={!acknowledged}`, while the checkbox that sets `acknowledged` renders **only when `riskNotice` is set**. Qwen had no notice, so it got a permanently disabled field and no visible way to unlock it — which reads as a broken dialog, not as a lock. The gate and the thing that can open it have to be the same condition: `disabled={mustAcknowledge && !acknowledged}`. This was latent for every provider without a notice, not something I introduced with Qwen.
  - Qwen also **needed** the notice. A Qwen session cookie is a whole-account session, and the dialog's own footer already says *"treat this like a password: it may access your signed-in web account"* — it was promising a warning it had no way to show.
  - **Then the probe reported seven models where it had reported three.** Repeated requests from here returned the same three every time; cookies were ruled out (none, `cna`, `isg`, and a pasted pair all agreed), and the gateway probe agreed with the direct one. So Qwen's guest catalog **varies**, and the "it answers three" I shipped in v1.12.0 was an overclaim. That is the second overclaim in a row on the same fact — first ten invented ids, then a hard "three" — and both came from treating an observed value as a constant. `QWEN_WEB_MODELS` is now a **dated snapshot** with `QWEN_WEB_MODELS_OBSERVED_AT`, and the dialog is the authority because it always shows the live list.
  - Files: `src/components/WebCookieConnectDialog.tsx`, `src/data/providers.ts`, `packages/omnihilbras-sdk/src/adapters/qwen-web.ts`, docs.
  - Depends on: Task 41.
  - Scope: Small.

- [x] Task 41: Make the Qwen dialog look like it works, because it did not.
  - Acceptance: the probe cannot wait forever, a slow answer reads as progress rather than a dead button, and the disabled button says what it wants.
  - Verify: the three questions are asked concurrently (`models` still precedes `turn`, since the turn names a model from it); a stalling transport returns an answer in ~120 ms with a reason rather than hanging; the disabled primary button carries "Paste the credential above first."; the in-flight state names the three questions and the 20 s ceiling. 419 tests pass.
  - Findings: **it worked, and looked broken.** The probe answers in about a second, and the dialog did eventually show the result — but "Ask Qwen" sat there with nothing to say, so a wait reads exactly like a dead button. Measured, not assumed: the gateway answers in 0.7–1.8 s by curl and the browser's own fetch took 1.2–1.5 s, so the network was never the problem. The delay was the **browser's main thread being starved** on a machine at load 17–42, which delays the promise callback rather than the request.
  - Three fixes, none of which depend on that diagnosis being right. **A 20-second budget**, so a stall becomes an answer instead of an indefinite spinner — and the answers gathered so far are returned rather than discarded, because a slow auth origin with a fast refusal on the turn is still a useful answer and throwing it away would be its own dishonesty. **The three questions now go out together** instead of in sequence, which was three round trips to another continent for no reason: the auth origin and the model catalog are independent, and only the turn waits for a model id. **The waiting state says what is being asked and how long it may take**, which is what turns a spinner into progress.
  - Also: the disabled primary button was silently greyed, which is read as a broken feature. It now carries "Paste the credential above first." And the field said `auth cookie` as both its label and its placeholder — words that do not say where the value comes from. It says `Cookie header from auth.qwen.ai` and shows what to copy.
  - Files: `packages/omnihilbras-sdk/src/adapters/qwen-web.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, tests, docs.
  - Depends on: Task 40.
  - Scope: Small.

- [x] Task 40: Give Qwen a real flow, and find out the one thing that was unknown.
  - Acceptance: the Qwen card is connectable, the dialog asks the three questions that matter, and it reports the provider's own answers. Nothing is saved unless a turn is actually served.
  - Verify: live through the dialog with a guest cookie — *"A turn was refused · Qwen refused the turn: FAIL_SYS_USER_VALIDATE, RGV587_ERROR::SM… · Credential at auth.qwen.ai: Unauthorized — 401 Unauthorized · 3 models served to guests"*; `POST /v1/web-cookie/qwen/check` returns the same; 417 tests pass.
  - Findings: **Qwen signals every refusal in the body and never in the status code — on both origins.** `auth.qwen.ai/api/v2/auths/` answers a guest with **HTTP 200** and `{"success":false,"data":{"code":"Unauthorized","details":"401 Unauthorized"}}`, and the turn answers 200 with `ret:["FAIL_SYS_USER_VALIDATE",…]`. A check that trusted the status reported a guest cookie as `authenticated: true`; the first version of this probe did exactly that and the live run caught it. Refusals are now read out of the body.
  - The card moved from `status: 'planned'` to **`available`**. `planned` meant "there is nothing behind this button" and the page disables it, which was right while the only thing Qwen could be asked was a guess. There is a flow behind it now. A card with a flow but no connection is `available` with `—` metrics, which is the project rule, and the dialog is where the blocker is explained and testable.
  - **I invented the model catalog and the probe caught it.** I wrote ten plausible ids — `qwen3.7-flash`, `qwen3.7-coder-plus`, `qwen3.7-vl-plus` and so on. The live endpoint answers **three**: `qwen3.7-plus`, `qwen3.8-max`, `qwen3.8-omni-flash`. Guessing a catalog is the same fault as guessing a capability: the card would have advertised models that do not exist and offered turns guaranteed to fail, with nothing on the page to say why. Qwen publishes no context length there, so none is claimed.
  - Also fixed: the DeepSeek dialog still said *"Or let OmniHilbras read it — a window opens"*, referring to the sign-in window removed in v1.10.0. It now explains what an empty `userToken` means instead.
  - **What is still unknown, and cannot be resolved here:** whether Alibaba's gate applies to an *authenticated* request. The card says so and the probe asks it. If the answer is no, this is a working provider; if yes, it stays a catalog entry — and either way nobody will have to take a guess on trust.
  - Files: `packages/omnihilbras-sdk/src/adapters/qwen-web.ts` (new), `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, `src/data/providers.ts`, tests, docs.
  - Depends on: Task 39.
  - Scope: Medium — a new surface and a new route.

- [x] Task 39: Retract the ChatGPT console one-liner, and re-test the Qwen gate.
  - Acceptance: the dialog never tells the user to use the Console for ChatGPT, and the error distinguishes "signed in, copied from the Console" from "not signed in".
  - Verify: the dialog offers only the Network and Application routes and no `copy(document.cookie)`; a header containing `__Secure-next-auth.callback-url` is told the cookie is HttpOnly and pointed at the Network tab, while a header with no NextAuth cookie is told the browser is not signed in. 411 tests pass.
  - Findings: **`copy(document.cookie)` cannot work, for anyone, ever.** NextAuth sets `__Secure-next-auth.session-token` `HttpOnly`, and `document.cookie` cannot read an HttpOnly cookie. I put it in v1.10.1 as the "fastest" path and it was the *only* path offered. What made it worse than simply not working is the shape of the failure: the header it returns is a plausible-looking set of chatgpt cookies with no session token, which reads exactly like being signed out — so it sent a signed-in user to sign in again. `__Secure-next-auth.callback-url` is *not* HttpOnly, so a signed-in browser still leaks part of the family, and that is now the discriminator: a sibling means signed in and copied from the wrong place, no sibling means signed out. The two need opposite instructions, and "sign in" is the wrong one half the time. Tracked from the raw cookie names, because the allowlist drops `callback-url` before the check runs.
  - **Qwen: the gate is real, unconditional for a guest, and not a clearance flow.** Re-tested against the live site (app v0.4.4, model list now `qwen3.7-plus`). The turn endpoint answers **HTTP 200** with `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],"data":{"url":"…/_____tmd_____/punish?x5secdata=…"}}`. Visiting that challenge URL returns 200, displays "Please connect them in order", **grants no cookie**, and the retry is refused with a freshly minted challenge. So it is a human puzzle, not something a client can satisfy. `/api/v1/chat/completions` is 404 — the v2 path is the only one. Also confirmed: asking the turn from inside the page **kills the renderer**, so a probe has to be made from Node with the harvested cookies and a byte cap.
  - The one untested hypothesis is the same one that unblocked DeepSeek: **a signed-in Qwen session may not be gated.** That needs a credential only the user has. The card stays `planned` with the reason updated to the measured verdict.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `src/lib/webSessionProviders.ts`, `src/data/providers.ts`, tests, docs.
  - Depends on: Task 38.
  - Scope: Small.

- [x] Task 38: Stop painting white tiles behind white logos.
  - Acceptance: no bundled logo is invisible on its card, in either theme, and the classification cannot go stale.
  - Verify: ChatGPT Web and Qwen Web render on a dark tile instead of white-on-white; `tokenharbor.svg` (`#16191e`) and `ollama.png` (pure black) get a light tile so they are visible in dark mode; 151 assets indexed as light, 63 as dark, no overlap; `pnpm build` regenerates the index. 409 tests pass.
  - Findings: **`ProviderMark` hard-coded `backgroundColor: logo ? '#ffffff' : …`**, so any light mark was a white glyph on a white tile. `chatgpt.svg` is `fill="#fff"`, and `qwen.svg` is `fill="#ffff"` — a four-digit hex meaning white at full alpha, which a naive `#rgb` check misses entirely. It was never only those two: **151 of the 157 bundled assets are light**, including `anthropic`, `openai`, `gemini`, `google`, `openrouter` and `kiro`, and **63 are dark**. One tile colour satisfies one group and hides the other, in whichever theme it did not match.
  - The classification is **generated from the asset files by a Vite plugin, not hand-written**. A hand-written list goes stale the moment a logo is added, and a stale entry fails *silently* — an invisible logo rather than an error — and there is no app test runner to catch it. `buildStart` reads every SVG and PNG and writes `src/lib/logoPolarity.generated.ts`, so `pnpm dev` and `pnpm build` both keep it true.
  - **SVGs and PNGs need different rules, and the difference is the interesting part.** An SVG's fills are sparse, so the test is on the extremes: any fill above 0.72 luminance needs a dark tile, and failing that any below 0.15 needs a light one. An average hides exactly the part that matters — `tokenharbor.svg` is a single `#16191e` path that averages to a harmless mid-tone while being invisible on a dark card. A PNG's pixels fill the whole box, so the average is right and the extremes are not: `openai.png` is a black knot on a white field whose brightest pixel is always 1, and only the average says it belongs on a dark tile.
  - Rasters needed a decoder — `pngjs` and `@types/pngjs`, dev-only. Before adding it I measured the eight PNGs the catalog actually uses: `openai`, `anthropic`, `gemini` and `mistral` are light, `ollama` is pure black, `opencode` is dark, `cline` and `openrouter` are mid. Four of the eight were broken in one theme or the other.
  - Files: `vite.config.ts` (`logoPolarity` plugin), `src/lib/logoPolarity.generated.ts` (generated), `src/components/ProviderMark.tsx`.
  - Depends on: Task 37.
  - Scope: Medium — a build step, a dependency, and a component.

- [x] Task 37: Make the provider cards fit the space they are actually given.
  - Acceptance: no provider name, status, or metric is clipped at any content width, and the card count follows the container rather than the viewport.
  - Verify: 0 of 13 cards have a truncated name; "ChatGPT Web" needs 200 px and gets 200 px; Qwen Web's reason shows two full lines where it showed 176 px of 905; the simple and advanced grids are both 2 × 344 px with 0 overflowing elements at an 800 px viewport; column counts across content widths 360 → 1920 px: 1, 1, 2, 2, 2, 3, 3, 4, 5, 5, 6. 409 tests pass.
  - Findings: **breakpoints could not express the problem, and that is why the fix is not a breakpoint.** The sidebar is 252 px from `lg` up and off-canvas below it, so the same viewport width yields a content area 252 px narrower on one side of that breakpoint than the other — and collapsing the sidebar changes it again. Any fixed column count is therefore wrong somewhere. The grid is now `repeat(auto-fit, minmax(272px, 1fr))`, so a card is never rendered narrower than it can show its name and status, and it gains a column as soon as there is room for one. Measured: 360→1, 640→2, 900→3, 1200→4, 1440→5, 1920→6.
  - I first "fixed" it with `md:grid-cols-3` and **made it worse** — three cards in 225 px at an 800 px viewport truncated *every* name, "OpenCode Console" needing 129 px in 75. The measurement is what caught it; the reasoning had not.
  - Two clipping bugs that were never about the grid. **The name shared a row with the caution badge**, badge `shrink-0` and name `truncate`, so an "Account session" badge took the space and "ChatGPT Web" got 93 px of text in 82. The badge moved to the status line, where it reads better anyway. And **a planned provider's reason sat in a hard `max-w-[11rem]` box** — 905 px of sentence in 176 px. It now has its own full-width row, clamped to two lines, with the whole reason still on `title`.
  - Also: the advanced card's Models stat is a composite string — "77 models · all import" — needing 158 px in a 121 px cell, so it ellipsised to "77 models · all i…", which reads as a rendering fault rather than as a number. It wraps now. Two lines is honest; a clipped policy is not.
  - Files: `src/pages/ProvidersPage.tsx`, `src/components/ProviderCard.tsx`.
  - Depends on: Task 36.
  - Scope: Small — a layout fix, but three separate clipping faults.

- [x] Task 36: DeepSeek Web returned only the first character of every answer.
  - Acceptance: a real turn returns the whole answer, and a stream cut off mid-generation is an error rather than a clean `stop`.
  - Verify: "Count from 1 to 10" returns `'1, 2, 3, 4, 5, 6, 7, 8, 9, 10'` (29 chars) where it returned `'1'`; "In one short sentence, what is a hash table?" returns 144 chars; "What is 17 times 3?" returns `51`; a body with no `response/status: FINISHED` is refused. 407 tests pass.
  - Findings: **the decoder was reading a frame shape DeepSeek does not send.** The real reply to "Count from 1 to 5" is: one whole-response frame carrying the first fragment, then `{"p":"response/fragments/-1/content","o":"APPEND","v":","}`, then a run of frames whose value is a **bare string** and most of which carry **no path at all** — `{"v":" "}`, `{"v":"2"}`, `{"v":","}`. The decoder matched only `p === "response/fragments"` (the live path is the indexed form) and only fragment *objects* (every continuation is a string), so it kept the opening character and discarded the rest.
  - The failure was invisible because it looked like a working model. Every answer came back one character long with `finish_reason: stop`, so "working" for a prompt that asked for the word `working` passed, and a green tick appeared. It took a real conversation to surface it: **"Count from 1 to 10" answering `1` is not a terse model.** The lesson is the same one as everywhere else in this area — a check that only proves the thing it was written to prove will happily pass while the feature is broken.
  - Two more things the stream requires, both found by capturing a live body rather than reasoning about it: **`FINISHED` is a status word with a string value.** A decoder that appends every string value writes the literal word `FINISHED` onto the end of the answer, which is what the reference implementation does. It is consumed as status here. And a body that closes **without** `response/status: "FINISHED"` was cut off mid-generation — an expired session, a dropped connection — and is now refused with that named, instead of being returned as a fragment wearing `finish_reason: stop`.
  - Files: `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, tests (a captured stream is kept as a fixture, because the shape is the whole point).
  - Depends on: Task 35.
  - Scope: Small — a fix, but one that had been hiding a completely broken provider.

- [x] Task 35: A chat on each provider page, for actually talking to a model.
  - Acceptance: every provider page ends with a conversation against one of its own models, and a real turn streams back.
  - Verify: `deepseek-web` shows 14 models, answers "What is a hash table used for?" in 10.2 s, shows a second turn that carries the first in history, and labels the turn "no streaming". 401 tests pass.
  - Findings: **`/health` was re-probing all thirteen providers on every single request**, not just on the 60 s background sweep. Two things were wrong with that, and the second one is the interesting one. It was slow — 8.45 s per call. Worse, it was a *head-of-line blocker*: the browser allows six connections per origin, the page asked for health on load, and a sweep that outlived the poll interval queued the next behind it, so health requests monopolised the pool and ordinary requests to the same gateway queued behind them. A chat turn that answers in six seconds took over a minute, which looks exactly like a model that hangs. `health()` now serves the last sweep and stores it; concurrent callers share one sweep rather than each starting their own. Four consecutive calls: 2.9 s (cold), then 3 ms, 15 ms, 4 ms. `checkedAt` is reported so the caller can see the report's age instead of being handed something that implies it was just measured.
  - Also: **not every provider can stream.** DeepSeek Web declares `streaming: false` and the gateway answers a streamed request `501 NOT_SUPPORTED`. The panel retries it as one request and reports `streamed: false`, so the answer appears and the turn is labelled **"no streaming"** — a provider that cannot stream is not a provider that cannot answer, and showing a refusal would have been wrong. Tested against a provider that streams as well as one that cannot.
  - Deliberately **not** offered when it cannot work: a provider with no connection, or one the gateway cannot serve at all, gets a sentence explaining why instead of a control that can only fail. And a failed turn is dropped from the replayed history rather than sent back as an assistant message — teaching a model to refuse by showing it its own refusal is a subtle way to corrupt every later turn.
  - Files: `src/components/ProviderPlayground.tsx` (new), `src/lib/gatewayClient.ts` (`streamGatewayChat`), `src/pages/ProviderDetailPage.tsx`, `apps/gateway/src/service.ts` (health snapshot).
  - Depends on: Task 34.
  - Scope: Medium — a new surface and a new gateway behaviour.

- [x] Task 34: Test one provider, not thirteen — and stop a hung read from saying "not connected".
  - Acceptance: "Test provider" answers in about a second with the provider's own reason for any failure, and a slow or failed connection read says so instead of "No connection yet".
  - Verify: `GET /v1/health/deepseek-web` returns in 8 ms of gateway time (478–823 ms of real DeepSeek round trip) against 8.45 s for `GET /health`; the badge reads Checking… → Connected; "Test provider" reports `Ping 816 ms`; an unknown provider returns 404 naming it. 401 tests pass.
  - Findings: **three more layers of the same fault, all of them reporting rather than behaviour.** (1) "Test provider" called `getGatewayHealth()`, which probes every active adapter, to answer a question about one provider — thirteen probes to render one card, and on a loaded machine long enough that the button looked permanently stuck. There is now `GET /v1/health/:providerId`, and the test asserts the other adapter is *never probed* rather than merely that the response shape is right. (2) `loadConnection` had `.catch(() => undefined)` and no timeout, so a request that **hung for 60 seconds** left the page on its initial `false` and it said **"Not connected"** about a connection that existed, with an **Add connection** button inviting a second one. Three states now — loading, ready, failed — and a 10 s ceiling, because a read that stalls is not evidence of anything. (3) The health check then reported **"healthy in 0 ms"**, which was the *cached* access token: `accessToken()` caches for an hour, so the check proved nothing while looking like a check. `validateCredential` now passes `fresh: true`. This is the exact fault the area keeps making — a confident answer with nothing behind it.
  - Also: an unknown provider is `NOT_FOUND` naming itself, not `unavailable`. "This provider is down" and "you never connected it" are different problems, and the first sends the user to fix a credential that was never the issue.
  - Files: `apps/gateway/src/service.ts` (`probeAdapter`, `healthForProvider`), `apps/gateway/src/server.ts`, `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, tests, docs.
  - Depends on: Task 33.
  - Scope: Medium — a new route.

- [x] Task 33: Register DeepSeek Web for health, and give it a health check.
  - Acceptance: "Test provider" works on a DeepSeek connection, and health says healthy rather than "not connected".
  - Verify: `GET /health` reports `deepseek-web -> healthy`; a real turn through the gateway returns `'working'` in 7.9 s (proof of work solved); `GET /v1/connections` shows `deepseek-web | hasCredential: True | models: 14`. 397 tests pass.
  - Findings: **two** separate defects, both silent. `activeAdapters()` registers a real adapter for `chatgpt-web` but not for `deepseek-web`, so the DeepSeek connection fell through to a generic OpenAI-compatible adapter pointed at `chat.deepseek.com` — which is not an OpenAI endpoint — and health reported `unavailable` with an **empty message**. Routing was unaffected, because `resolveAdapter` was already correct, so the provider worked while reporting that it did not. Then, once registered, it reported `Health checks are not supported.`: `DeepSeekWebAdapter` had no `healthCheck` at all. Fixed at both levels, and the health check is a **credential check** (`users/current`) rather than a completion, so it costs one round trip and no proof of work — which is what makes it cheap enough for every poll.
  - Also: **`apps/gateway/test/deepseek-web-check.test.js` was never committed.** It ran locally, so the numbers in several releases counted tests that were not in the repository, and four of them had gone stale when `checkChatGptWeb` started verifying against a live page. Rewritten to assert what is true offline, and now tracked. The real lesson is not the missing `git add` — it is that "397 tests pass" was never a statement about the repository.
  - Files: `apps/gateway/src/service.ts`, `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `apps/gateway/test/deepseek-web-check.test.js` (now tracked), docs.
  - Depends on: Task 32.
  - Scope: Small.

- [x] Task 32: Refuse the signed-out `userToken`, and make copying it one line.
  - Acceptance: `{"value":null}` is refused by name, and the fastest extraction step is a copyable console line.
  - Verify: `parseDeepSeekUserToken('{"value":null}')` throws `AUTHENTICATION_FAILED`; `{"value":"real"}` and a bare token still work; an object with no `value` key is still used as-is. The DeepSeek dialog offers one link, one clickable snippet — `copy(JSON.parse(localStorage.userToken).value)` — and one `Connect` button. 390 tests pass.
  - Findings: probed the live site, and **`userToken` is `{"value":null,"__version":N}` when nobody is signed in** — that is the signed-out placeholder, and it is what the page actually stores. The parser fell through to "treat the raw string as the token", so that null wrapper became a **credential**: it looked valid, was accepted, and the failure surfaced much later as DeepSeek refusing a session nobody could explain. Deciding on **presence of the `value` key** rather than its emptiness matters: `{"other":"x"}` is some other object pasted by mistake and is used as-is, while `{"value":null}` is the signed-out state and is named as such. The old sign-in window had the identical hole — it read the null wrapper and declared itself signed in immediately, which is why the window "opened the home page and nothing happened". Also: extraction is now a **console one-liner** rather than a DevTools navigation, because the navigation is where people go wrong — a mis-click yields a cookie object or the signed-out placeholder, and neither is obvious at the point of failure. `copy(document.cookie)` for ChatGPT Web, `copy(JSON.parse(localStorage.userToken).value)` for DeepSeek.
  - Files: `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, tests, docs.
  - Depends on: Task 31.
  - Scope: Small.

- [x] Task 31: Remove the separate-browser sign-in entirely. One button, and it opens in your browser.
  - Acceptance: the connect dialog has one sign-in control, it opens the provider in a new tab in the current browser, and nothing in the gateway launches a browser.
  - Verify: the DeepSeek dialog shows one link — `Open chat.deepseek.com`, `target="_blank"` — and the only button is `Connect`. `POST /v1/oauth/chatgpt/start` and `GET /v1/oauth/deepseek/status` are now `404`; `POST /v1/web-cookie/deepseek/connect` is `400` on an empty body and `POST /v1/connections` is `200`. 388 tests pass.
  - Findings: the user reported the window "opens the home page of DeepSeek and nothing happens" — **it was broken**, not merely surprising: the flow navigated but never detected the sign-in, so it sat there indefinitely. On top of that it was a second button next to the paste path, so the dialog offered two ways to connect and one of them silently failed. Two buttons, one broken and unexplained, is worse than one honest path, so the window flow is **removed rather than demoted**: both sign-in modules, both session stores, four service methods, four routes and thirteen tests are gone. The persistent profile is still used for *turns* when it happens to be signed in — it is just no longer how a connection is made. The trade-off, stated plainly: a pasted credential is replayed into the gateway's browser on each turn rather than the browser keeping it fresh, so the Cloudflare clearance can go stale and an edge challenge is somewhat more likely than with a signed-in profile. That is the cost of the user's choice, and it is the right trade for "do not open a window I did not ask for".
  - Files: `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, `apps/gateway/src/index.ts`, deleted `chatgptWebSignIn.ts` / `deepseekWebSignIn.ts` and their tests, docs.
  - Depends on: Task 30.
  - Scope: Medium.

- [x] Task 30: Say why a separate window opens, and offer signing in inside the browser instead.
  - Acceptance: the reason is stated *before* the click, and there is a link that opens the provider in the user's own tab.
  - Verify: the DeepSeek dialog now contains "A separate browser window will open on your desktop…" and a `Sign in inside this browser instead` link pointing at `https://chat.deepseek.com`, `target="_blank"`. 401 tests pass.
  - Findings: the complaint was "it does not open a new tab in the browser I am using, it opens another browser" — and the copy was silent about it, so a required behaviour read as a bug. **The window cannot be removed**: the session is read out of a browser profile OmniHilbras owns (`launchPersistentContext` against `~/.config/omnihilbras/<provider>/<hash>`), and a tab in the user's own browser is a different browser whose cookies and localStorage are not readable from here. So the fix is to say that first and give the other route a real link: sign in inside this browser, copy the `userToken` from localStorage, paste it. The extraction guides now also open with "With … open and signed in **in this browser**", because the copy path is now a first-class route rather than a fallback. What was genuinely wrong was not the window but the silence.
  - Files: `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, docs.
  - Depends on: Task 29.
  - Scope: Small.

- [x] Task 29: Stop calling a CORS refusal "offline".
  - Acceptance: a 403 from the gateway is reported as a refusal with its own wording, not as an outage.
  - Verify: on `http://localhost:5173` the badge reads `Gateway online` with 13 cards. The refusal case was reproduced by hand — `Origin: http://localhost:4173` is answered `403 CORS_ORIGIN_DENIED` while `:5173` gets `200` — and the two are now distinct states with distinct wording. 401 tests pass.
  - Findings: **the cause of four "restart the servers" requests was a stray `vite preview` I had left running on :4173** during browser verification, and a `pkill` that matched the wrong pattern missed it. The gateway was up the whole time and correctly refusing an origin that is not its dashboard; only the browser could not read the 403, so it looked like a dead server. Two lessons, both about my own process: leaving a server running after a verification attempt, and reporting a refusal as an outage. The second is the durable fix — `Gateway refused this page` / `this page's origin is not allowed` now says what is actually true, so the next person does not restart a correct server.
  - Files: `src/lib/useGatewayStatus.ts`, `src/components/DashboardShell.tsx`, docs.
  - Depends on: Task 28.
  - Scope: Small.

- [x] Task 28: Make the gateway badge tell the truth, and make an offline page recover by itself.
  - Acceptance: the badge reflects a real probe, and a page whose only request failed reloads itself when the gateway returns — with no manual refresh.
  - Verify: with the gateway stopped the sidebar read `Gateway offline` in red and `not answering · pnpm dev:gateway`; with it restarted, **without a reload**, it read `Gateway online`, `localhost:8787 · local mode`, 13 cards. The provider list also painted 13 cards immediately instead of after ~24 s. 401 tests pass.
  - Findings: **the badge was the literal string "Gateway online"** — it asserted rather than asked, so during an outage the dashboard reported the one thing that was false, and looked correct afterwards so nobody had cause to distrust it. And a page that failed its only request made **no further requests**, so nothing could ever notice the gateway coming back; the offline message was the last thing the tab ever said and the only exit was a manual reload. Both are fixed by a 4 s poll of `/v1/connections`, which answers in ~5 ms. A caveat worth writing down: the poll had to use the **absolute** gateway base — a relative `/v1/connections` reaches Vite, which answers 200 with the app's own HTML, so the badge would have reported the gateway as up for as long as it was down. Separately, `/health` (24 s, probes every provider) was awaited **before** the connections on the list, so the list sat empty for 24 seconds on every load; connections now set first and health refines them.
  - Files: `src/lib/useGatewayStatus.ts` (new), `src/lib/gatewayClient.ts`, `src/components/DashboardShell.tsx`, `src/pages/ProvidersPage.tsx`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 27.
  - Scope: Medium.

- [x] Task 27: Stop the provider list opening the API-key modal for a web-session provider.
  - Acceptance: Connect on a web-session card goes to the page that can actually sign you in, and no path opens the API-key modal for a provider with no API key.
  - Verify: 401 tests pass; typecheck and build clean. **The browser click-through could not be completed** — the dev server's module fetches keep failing with `ERR_NETWORK_CHANGED` on this network and the built bundle serves the marketing site at `/dashboard/providers`, so both routes to verifying it were blocked. The change is three lines and unambiguous, but it is unverified in the browser and should be checked by hand.
  - Findings: `AddProviderModal` collects an **API key**, and `resolveProviderOption` falls through to `providerCatalog` for anything it does not recognise — so clicking Connect on DeepSeek resolved to a catalog entry and opened an API-key dialog for a provider that has no API key. The user saw a dialog for a different provider entirely. The dialog that knows how to sign in (`WebCookieConnectDialog`) only ever rendered on the **detail** page; the list had no idea it existed. Fixed at two levels: the list's Connect now navigates to the provider's page for a web-session provider, and `openAdd` itself refuses one, so no future caller can repeat it. `isWebSessionProvider` is exported from the modal so the check is available rather than re-derived.
  - Files: `src/pages/ProvidersPage.tsx`, `src/components/AddProviderModal.tsx`.
  - Depends on: Task 26.
  - Scope: Small.

- [x] Task 26: Fix the last three hardcoded provider strings, and add the Qwen card honestly.
  - Acceptance: no provider-specific string lives in the dialog, and the Qwen card exists without offering an action that cannot work.
  - Verify: the DeepSeek dialog reads "Sign in with DeepSeek" and contains no occurrence of "ChatGPT"; its paste section reads "Or paste a userToken instead"; the Qwen card reads "Not built yet" with the reason and has no Connect button. 401 tests pass.
  - Findings: **five** provider-specific strings were hardcoded in the dialog, not one. I had claimed the class of bug was fixed after moving the sign-in blurb, and then left the button label, the waiting message, the no-display message, the paste section label and the field label — so DeepSeek's dialog said "Sign in with ChatGPT" and offered to paste a "session cookie". Fixing the one I noticed did not fix the class, which is the actual lesson. **The Qwen card exists and is honestly marked**: `status: 'planned'`, a required `unavailableReason` naming the TMD captcha, and **no Connect button in either card view** — the simple list card and the advanced card each had their own button, and the first one guarded was not the one the list renders. Also found, not fixed: **`GET /health` takes 24 seconds** because it probes all twelve providers on every call, and `ProvidersPage` awaits it *before* setting connections, so the whole list waits on it. Pre-existing and separate.
  - Files: `src/components/ProviderCard.tsx`, `src/components/WebCookieConnectDialog.tsx`, `src/lib/webSessionProviders.ts`, `src/pages/ProviderDetailPage.tsx`, `src/data/providers.ts`, docs.
  - Depends on: Task 25.
  - Scope: Medium.

- [x] Task 25: Add DeepSeek Web, and work out that Qwen Web is not worth a card.
  - Acceptance: a DeepSeek Web card that connects by signing in or by pasting a `userToken`, and a request path with no browser in it.
  - Verify: `POST /v1/oauth/deepseek/start` returns 201; an invalid `userToken` is refused with **DeepSeek's own answer** — `PROVIDER_REQUEST_FAILED`, "DeepSeek rejected the sign-in: Authorization Failed (invalid token)" — and no connection is created; 14 models; both cards render and the DeepSeek dialog names `chat.deepseek.com`; 401 tests pass.
  - Findings: the request path is plain HTTP with a bearer credential, so **no browser is in it at all** — a browser is involved only in obtaining the credential, once. `userToken` authorises `users/current` and **nothing else**; sending it at the completion endpoint gets a 401 that looks exactly like an expired session, so the two are exchanged and the access token cached. The credential is in **localStorage, not a cookie**, so `context.cookies()` returns nothing useful and the connection looks signed out forever; it is stored sometimes as `{"value":"…"}` and sometimes bare, so both are read. The endpoint takes one flat `prompt`, so history is flattened with turns labelled — a bare join of `["You are terse.", "2+2?"]` loses which was which. The SSE append frames often arrive with **no `type`**, so `thinking_enabled` from the last whole response decides the reasoning/content split; treating every append as the answer is how a model that thinks first answers with its reasoning. **Qwen Web: the catalog is open (three models, 1M ctx, visitor access, unminified `POST /api/v2/chat/completions`) and the turn is refused by Alibaba's TMD anti-bot**, which returns a captcha that must be rendered in a browser; a guest has no XSRF cookie either. A catalog and no card. Two findings kept: calling the endpoint from inside the page **kills the renderer**, because buffering an endless SSE stream with `response.text()` does — which is why a Qwen driver must read incrementally with a cap. The generalised dialog still shipped a **hardcoded ChatGPT sentence telling DeepSeek users a chatgpt.com window was about to open**, caught by looking at the rendered dialog rather than the code; that is why every provider now supplies its own note.
  - Files: `packages/omnihilbras-sdk/src/adapters/deepseek-web.ts`, `adapters/deepseek-pow.ts`, `apps/gateway/src/deepseekWebSignIn.ts`, `src/service.ts`, `src/server.ts`, `src/lib/webSessionProviders.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/data/providers.ts`, tests, docs.
  - Depends on: Task 24, and the proof-of-work work in commit 8f9db84.
  - Scope: Big.

- [x] Task 24: Sign in to ChatGPT Web in a browser window, and make the profile the fast path.
  - Acceptance: one button signs in and saves a working connection; the manual paste survives as a fallback; a turn afterwards still answers.
  - Verify: `POST /v1/oauth/chatgpt/start` returned `headed: true`; the first status poll returned `connected` with plan `Free` and a connection carrying 13 models; the next poll correctly reported the session already completed; two live turns then returned `'working'` (20s, 97s). 371 tests pass.
  - Findings: the profile **already held the session on disk** — a 72 KB cookie store in `~/.config/omnihilbras/chatgpt-web/` — so keeping it is not a new security model, discarding it is. The fragility is entirely in moving the credential *by hand*, and all of it goes away: which cookie, the `Cookie:` prefix, the numbered chunks, the truncated header, and an unknown plan. The session is now read out of the browser that created it, so the Cloudflare clearance the edge set is the one that gets kept. **The profile became the fast path and the vault the fallback** — injecting stored cookies on every turn would overwrite a fresher session (the clearance rotates) with a stale copy, which is how a working provider starts failing for no visible reason. A poll is **claimed before the page is read**, or two concurrent polls save two connections from one sign-in; sessions are swept because a leaked window is a signed-in session left open on a desktop. The **terms position is unchanged** and the warning stands. Also fixed: `btn-primary`/`btn-secondary` **were not real classes** — nothing in the stylesheet defines them, so the connect buttons here and every button in `KiroConnectDialog` had been rendering unstyled since they were written; and there was **no `:disabled` styling anywhere**, so an unclickable button looked identical to a clickable one.
  - Files: `apps/gateway/src/chatgptWebSignIn.ts` (new), `src/chatgptWeb.ts`, `src/service.ts`, `src/server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/components/KiroConnectDialog.tsx`, `src/index.css`, `apps/gateway/test/chatgpt-web-signin.test.js` (new), docs.
  - Depends on: Task 23.
  - Scope: Big.

- [x] Task 23: Build the ChatGPT section properly — the 13-card catalog, the credential guide, and a check that checks.
  - Acceptance: the catalog matches the reference's product surface, every card resolves, and a check catches a revoked session.
  - Verify: the connection reports 13 models; `POST /v1/web-cookie/chatgpt/check` returns `verified: true` for the real session and `AUTHENTICATION_FAILED` for a deliberately invalid one; both free models still answer `'working'`; 366 tests pass.
  - Findings: **the plan must not narrow the catalog.** `resolveChatGptWebSelection` never consults it — it maps an id onto a selection and lets the page refuse — so gating the catalog was a second, different rule, and a wrong gate is not symmetric: a model shown that cannot be used costs one visible failure, while a model hidden that can be used hides something that works. Also: **the reference's own page advertises ids its resolver refuses** (effort-suffixed ones), so the cards and the resolver are now one table with a test asserting every card resolves; **Pro must not ask for thinking** — `reason` is a hint the page does not honour there, and deriving it as `effortIndex > 0` sent it anyway, so the rule moved into the SDK; `gpt-5.5-pro-extended` is an **alias of pro**, not a distinct request, and ChatGPT exposes no wire model for it. The **parser refused the Cookie header** the guide told you to paste, while its own error said "paste the cookie header instead" — now accepted, allowlisted, with the token reassembled from its numbered chunks and a cut-short set refused by name. A **check that only parses accepts a dead session**, so it opens the page — and measured against a real and a fake session, **every DOM marker is identical**, so the only signal is the plan badge in the page text, polled for 15s. Every driver failure now carries a real cause (a challenge is `PROVIDER_UNAVAILABLE`, a sign-in wall is `AUTHENTICATION_FAILED`) because both arrived as `INTERNAL_ERROR`. And gating discovery on `policy === 'all'` made a free-only connection **unrefreshable**.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `apps/gateway/src/chatgptWeb.ts`, `apps/gateway/src/service.ts`, `apps/gateway/src/server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, tests, docs.
  - Depends on: Task 22.
  - Scope: Big.

- [x] Task 22: Make a ChatGPT turn through ChatGPT's own request path, which is what actually works.
  - Acceptance: a real turn returns a real answer through the gateway, on a real session.
  - Verify: `POST /v1/chat/completions` with `x-omnihilbras-provider: chatgpt-web` returns 200 and `content: "working"` for "Reply with the single word: working", and `"4"` for "What is 2+2?" — three consecutive successes in 20s, 24s and 37s. 8 gateway tests on the pure half, 341 total.
  - Findings: **typing into the composer does not work.** The request is accepted, a placeholder appears, and the page sits at "Think" indefinitely — signed in, plan known, composer accepting keystrokes, the send button enabled, the message posted. The composer path is simply not how a programmatic client makes a turn. What works is the page's own path: its Sentinel requirements, its proof-of-work and Turnstile tokens, its request client, and `POST /f/conversation`. The module is found by scanning the page's assets for **semantic markers** and reading the minified names out of the trailing `export{…}` block; all four markers are in one 2.6 MB chunk today, which imports directly and yields 4 074 exports. Three things had to be found rather than assumed: the asset is imported **directly**, because a generated blob module re-exporting from it fails with a bare "Failed to fetch dynamically imported module" that names no cause; only a first-party `/cdn/assets/*.js` URL is ever fetched, since the candidate list comes off a live page and is untrusted input; and the delta stream is JSON Patch **objects** whose `append` concatenates — reading it as a replace keeps only the last fragment, and reading the value out of JSON Patch's third slot writes `undefined` at every path, both of which read as a model that answered nothing. Also: the temporary-chat URL triggers the first-use onboarding modal and failed to navigate, so the plain landing page is used. **Not perfectly reliable** — a fetch inside ChatGPT's own code can fail on the network and gets exactly one retry; anything else is raised as a real failure so a broken session is not retried into looking intermittent. Attachments are not implemented.
  - Files: `apps/gateway/src/chatgptFirstParty.ts`, `src/chatgptWeb.ts`, `apps/gateway/test/chatgpt-first-party.test.js`, `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, docs.
  - Depends on: Task 21.
  - Scope: Big.

- [x] Task 21: Replace the invented ChatGPT model ids with the observed ones, and fix catalog refresh.
  - Acceptance: the catalog carries ids the web tier actually serves, and a refresh can remove a model.
  - Verify: `listModels()` for a free session returns `auto, auto-thinking` and the paid family is refused by name; a refresh on the live connection drops the stale `gpt-5.2` ids and the result survives a reload from disk. 42 ChatGPT Web tests, 329 total.
  - Findings: **every model id in the first catalog was invented** — `gpt-5.2`, `gpt-5.1`, `gpt-5-mini` — and none of them exist. The real ones are untidy, which is why tidy guesses were so easy: `gpt-5-6`, `gpt-5-6-thinking`, `gpt-5-6-pro`, `gpt-5-5`, `gpt-5-5-thinking`, `gpt-5-5-pro`, recorded upstream as "observed from first-party ChatGPT Pro and Free UIs". **And then it got it wrong a second way**: the first correction published `auto` as a model id, but `auto` is the string the *page* is given when an account is free and has no picker — not something a client can ask for. `resolveSelection` maps a client id onto a **UI selection** (a model label plus an effort index), and that is what the page is driven with; anything outside the set throws, so an unresolvable id is now refused before a browser launches while a known one is left to the page, since `resolveSelection` never consults a plan. Two more real bugs surfaced because the stale ids survived a refresh that returned 200: `updateModels` **unioned instead of replacing**, and its additive path files every addition as a *custom* model, so a withdrawn model is kept forever and becomes impossible to remove; and the persistent store's `updateModels` and the in-memory one had drifted, the latter quietly lacking `replace`. With the right model and the right access, **a turn still does not complete** — the page renders only `request-placeholder-request-WEB:…-0` and sits at "Think". Reading the answer is the remaining work, and the reference does it by driving ChatGPT's own JS module rather than selectors.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`, `apps/gateway/src/connections.ts`, `apps/gateway/src/service.ts`, docs.
  - Depends on: Task 20.
  - Scope: Medium.

- [x] Task 20: Unblock access to chatgpt.com, and correct the diagnosis.
  - Acceptance: the page loads and a turn is submitted, instead of a 403 at the edge.
  - Verify: measured on one machine, one session, one engine, varying one thing at a time — default UA gives 403 with `Just a moment...`, a real Chrome UA gives 200 with a composer present, and headed/full-Chromium make no difference. The composer accepts `pressSequentially` and the send button then reports `aria-disabled="false"`. 324 tests pass.
  - Findings: **the 403 was Playwright's default headless user agent, which substitutes `HeadlessChrome/151.0.7922.34` into the real Chrome string.** The address was never the problem, and the earlier "this is environmental, try a residential connection" note was wrong. Setting a real user agent, with a matching locale and timezone, fixes access outright. Three further things were needed to get a turn submitted, none obvious: a **persistent profile**, because the first-use "Temporary Chat" modal otherwise reappears every request holding focus and intercepting Send; **real keystrokes**, because the composer is ProseMirror and `fill()` sets the DOM without the input events React watches, leaving the send button permanently disabled; and clicking through `data-testid="modal-temporary-chat-onboarding"`, which ignores Escape. Also: `waitForFunction` must take a function, since a string is evaluated with `eval` and the page's CSP forbids `unsafe-eval`; and waiting for the stop button to disappear is the wrong completion signal, because the button stays in the DOM after a turn ends, so that wait never returns.
  - **Still not working:** no turn has produced an answer. The request posts, the page renders only `data-message-id="request-placeholder-request-WEB:…-0"` with no text, and sits at "Think" indefinitely, on a free-plan account. The reference project completes turns on this same machine by discovering ChatGPT's own JS module at runtime and performing an explicit model *selection*, never hardcoding a selector — which is the most likely place the remaining difference lies. Access is solved; completion is not. The card says so.
  - Files: `apps/gateway/src/chatgptWeb.ts`, `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, docs.
  - Depends on: Task 19.
  - Scope: Big.

- [x] Task 19: Make the ChatGPT Web refusal say what it is, instead of looking like a broken model.
  - Acceptance: a model test against a blocked address reports the block, with the reason intact.
  - Verify: `POST /v1/chat/completions` for `chatgpt-web` returns `PROVIDER_UNAVAILABLE` and the full sentence, in place of `Every provider route failed`. Three tests.
  - Findings: the block **was** being detected, but too early to fire. A Cloudflare challenge is not present the instant `goto` returns — the 403 comes back in 0.8s with an empty title and the interstitial only appears a few seconds later — so the pre-flight check saw nothing, the composer wait then ran to its timeout, and the result was reported as a 60-second timeout with no cause. The page is now re-read whenever a wait fails, and a page that loaded without a composer reports its own title and body text rather than nothing. Separately, the driver's failures were plain `Error`s, so crossing the routing layer they collapsed into "Every provider route failed" and the reason was discarded: a refused request was being reported as a broken model. They are now raised as provider errors, with a block classified as an outage and an ordinary page failure left as a request failure.
  - Files: `apps/gateway/src/chatgptWeb.ts`, `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`.
  - Depends on: Task 18.
  - Scope: Small.

- [x] Task 18: Accept the real ChatGPT export, chunk the oversized cookie, and gate the catalog on the plan.
  - Acceptance: a genuine CLI/Codex auth export connects, and a free-plan account is not offered paid models.
  - Verify: a real export is stored with its session cookie, `planType: free` and `expiresAt`, and round-trips all three; a real request reaches the browser and is refused by name as a block page. 34 SDK tests.
  - Findings: **the real export shares no keys with a Playwright storage state.** It is `{ accessToken, sessionToken, expires, account }` with no `cookies` key, so the storage-state parser rejected a genuine session with "That JSON has no `cookies` array" — the bug that was reported. `sessionToken` *is* the session cookie's value. Two fields are now carried through: `expires`, so a dead session is known before a browser launch, and `planType`, which is real entitlement and decides the catalog — a free plan gets 3 models, not the 6 that were invented, and an unrecognised plan gets the full set because a visible failure beats a hidden model. **The session token is ~5 KB and Chrome caps one cookie at 4096 bytes**, so `addCookies` failed the whole batch with `Invalid cookie fields`, which names no field and is not about the fields at all; found by varying one at a time against a real session. NextAuth already chunks oversized session cookies, and the driver now does the same, verified to reassemble byte for byte. `listModels()` also threw without a credential, which would have left a saved connection with no models. **And the answer to whether it works: no.** chatgpt.com serves `Just a moment...` — a Cloudflare interstitial with an empty body — *with a valid session loaded*, so the premise the design rests on is defeated at the edge and the selectors remain unconfirmed. The block is environmental.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`, `apps/gateway/src/chatgptWeb.ts`, docs.
  - Depends on: Task 17.
  - Scope: Medium.

- [x] Task 17: Give ChatGPT Web the ChatGPT logo, not OpenAI's.
  - Acceptance: the card shows ChatGPT's own mark.
  - Verify: the asset is ChatGPT's blossom path from OpenAI's own asset CDN, not a copy of `openai.svg`; the geometry differs from the OpenAI knot (4091 vs 1554 path characters); the SVG parses with no `<style>`, no script and no external reference; rasterised it renders the six-loop blossom.
  - The first version copied `openai.svg`, which is OpenAI's hexagonal knot — a different company's mark, and the wrong one to label a ChatGPT card with. Two errors, actually: `chatgpt.com` itself is 403 from here, so the mark comes from `cdn.oaistatic.com`. Upstream's file is a 16-unit favicon with a `prefers-color-scheme` block and a white background rect; the geometry is taken and the chrome dropped, so the glyph is white on transparent like every other card mark and there is no embedded stylesheet to collide with the dashboard's.
  - Files: `public/providers/chatgpt.svg`.
  - Depends on: Task 16.
  - Scope: Small.

- [x] Task 16: Add a Web Cookie Providers group with ChatGPT Web, behind a high-severity warning.
  - Acceptance: a new group holds a ChatGPT Web card that connects by pasting an exported session, and the credential warning is acknowledged before anything is stored.
  - Verify: the group renders between API Key and Local with one card; the card badge reads `ACCOUNT SESSION`, not `TERMS`; the dialog shows the warning, four export steps, and a paste field disabled until the box is ticked. `POST /v1/web-cookie/chatgpt/connect` accepts a real-shaped storage state (201, 6 models) and refuses non-JSON, an export with no OpenAI cookies, and a missing field. Only `chatgpt.com`/`openai.com` cookies survive — `notopenai.com` and `chatgpt.com.evil.example` are dropped. A bad paste shows the reason and clears the field. 23 SDK tests.
  - Findings: **the browser half has never seen the real application.** `chatgpt.com` returns its anti-bot block page from the development machine (`Unable to load site … Ray ID:…`), so `#prompt-textarea` and `[data-message-author-role="assistant"]` are ChatGPT's documented test hooks used on the assumption they are current. That is stated on the card, not buried. A stale session and a blocked request both render a real page with no composer, so they are told apart: a sign-in link means re-export, the block page's own wording means the network. The generic API-key modal was also opening underneath the right one, since `auth: 'Web cookie'` is not `isOauth` — suppressed. The reference project hardcodes no selector at all; it discovers ChatGPT's own JS module at runtime and drives their internal API. The version here is the maintainable one and the fragile one, traded knowingly.
  - Files: `packages/omnihilbras-sdk/src/adapters/chatgpt-web.ts`, `test/chatgpt-web.test.js`, `apps/gateway/src/chatgptWeb.ts`, `service.ts`, `server.ts`, `src/components/WebCookieConnectDialog.tsx`, `src/components/ProviderCard.tsx`, `src/data/providers.ts`, `src/pages/ProviderDetailPage.tsx`, `public/providers/chatgpt.svg`, docs.
  - Depends on: Task 15.
  - Scope: Big — a new group, a new auth shape, and a browser dependency in the gateway.

- [x] Task 15: Give the Kiro card its logo, which it never had.
  - Acceptance: the Kiro card and page show Kiro's own mark rather than a letter.
  - Verify: `/providers/kiro.svg` is served as `image/svg+xml` and both the card and the provider page render it as an `<img>` at 1200×1200.
  - The mark is Kiro's own favicon, fetched from the CDN `app.kiro.dev` declares, rather than drawn or approximated: a `#9046FF` rounded square with the white ghost. A `kiro.png` was already tracked in the repo and matched the same artwork, but at 128px raster where the source is a 1200-unit vector, so the vector replaces it and the raster is removed. The card's `color` moved from `#ff6b35` (OmniRoute's Material-icon tint) to the logo's own `#9046ff`, so the fallback letter mark and the badge sit in the brand colour too.
  - Files: `public/providers/kiro.svg`, `src/data/providers.ts`.
  - Depends on: Task 14.
  - Scope: Small.

- [x] Task 14: Fix Kiro inference, and add its five other ways to connect.
  - Acceptance: a real Kiro request returns an answer, and the six sign-in methods are each wired to their own exchange rather than one generic paste box.
  - Verify: `POST /v1/chat/completions` with `x-omnihilbras-provider: kiro` returns real text, `finish_reason: stop`, and a `meters.credit` figure. The framing tests run against `test/fixtures/kiro-stream.bin`, a real captured 7-frame response. Device flow returns 201 with a real AWS code; an unapproved session polls as `pending`; a non-`awsapps.com` start URL is refused before any call; Google/GitHub return a real PKCE URL whose verifier never leaves the gateway; a pasted code is spent at most once. In the browser all six methods are listed and disabled until the risk is ticked, and a failed test row shows the provider's reason.
  - Findings: **v0.11.0's Kiro could not complete a single inference.** The answer is the binary AWS eventstream, not the text framing the first parser was written against — so every request returned 200 and every one failed with `INVALID_RESPONSE`, indistinguishable from a provider that answered nothing. The tests passed throughout because they were built from the same wrong assumption. Three further details, each a wrong guess first: header names carry a leading **colon** (`:event-type`), the payload is **flat** rather than nested under the event name, and there is **no `messageStopEvent` and no `usageEvent`** — a real response is `assistantResponseEvent`, `contextUsageEvent`, `meteringEvent`. `total_length` counts itself, so frames are walked by length. The transport decoded bodies as text, which mangles a binary stream into something that reads as empty, so `HttpRequest` now takes `responseAs: 'bytes'`, bounded like the text path. Kiro meters credits, so `usage` is left unset rather than reported as zero and the cost rides in its own `meters` field. Availability is per account: `400 Invalid model` becomes "Your Kiro plan does not offer X", since that is an entitlement and not a broken connection. Social sign-in cannot return to the gateway at all — the whitelisted redirect is `kiro://` — so the code is pasted back, with the PKCE verifier kept gateway-side. A company start URL is validated against `*.awsapps.com` because it becomes part of an OAuth grant. 25 Kiro tests, 283 total.
  - Files: `packages/omnihilbras-sdk/src/adapters/kiro.ts`, `src/transport.ts`, `src/types.ts`, `test/kiro.test.js`, `test/fixtures/kiro-stream.bin`, `apps/gateway/src/kiro.ts`, `service.ts`, `server.ts`, `src/lib/kiroAuth.ts`, `src/components/KiroConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 13.
  - Scope: Big — the published Kiro surface is replaced, and `HttpRequest` and `ChatResponse` change shape.

- [x] Task 13: Add Kiro to OAuth Providers, with a working sign-in and a non-dismissible terms warning.
  - Acceptance: the card carries a standing caution shown in both card views, on the page, and in the sign-in dialog, where nothing is sent to AWS until it is acknowledged. The sign-in is AWS's device flow and the catalog is served from CodeWhisperer's streaming service.
  - Verify: `POST /v1/oauth/kiro/start` returns 201 with a real AWS device code and `view.awsapps.com/start/#/device`; an unapproved session polls as `pending`; an unknown session is 404. In the browser the dialog shows the warning with an unticked box and no code, and only after ticking it does a real AWS code appear with a manual-link fallback. Kiro is not OpenAI-compatible — it is CodeWhisperer's streaming service, taking a `conversationState` envelope and answering with an AWS eventstream — so it needs its own adapter, with a system turn folded into the user content because the envelope has no system role, and unknown model ids refused before a request is spent. Two defects found by testing against live AWS: the device authorization needs a `startUrl` or AWS answers `400 Start URL is required`; and a pending grant arrives as HTTP 400 with the state in the body, which the provider transport had flattened to its human description, so the sign-in reported failure while the user was still approving it. OAuth token endpoints now read their bodies directly, as the Console poll already did. 15 SDK tests cover the envelope, the eventstream framing, the bare-body fallback, and the refusals.
  - Files: `packages/omnihilbras-sdk/src/adapters/kiro.ts`, `test/kiro.test.js`, `apps/gateway/src/kiro.ts`, `service.ts`, `server.ts`, `src/data/providers.ts`, `src/components/ProviderCard.tsx`, `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 12.
  - Scope: Medium.

- [x] Task 12: Add the TokenHarbor card, with the endpoint checked first.
  - Acceptance: the card resolves to TokenHarbor and to no other provider, appears in the add-provider dropdown, and borrows no other provider's logo.
  - Verify: `GET https://tokenharbor.ai/v1/models` answers `401 {"error":{"message":"Invalid or revoked API key. Rotate your key at https://tokenharbor.ai/dashboard.","type":"invalid_api_key"}}` and `POST /v1/chat/completions` answers the same, so the service is live, the route is `/v1`, and it wants a bearer key — which is what the generic adapter sends. `/api/v1` 404s and `/models` returns HTML, so only `/v1` is the API. Added to the catalog and, separately, to the add-provider dropdown: those are two lists, and although the v0.9.6 resolver makes the card authoritative for *resolution*, the dropdown still reads its own. Verified in the browser: the card renders, the dialog is titled "Add TokenHarbor API Key" and mentions no other vendor, and the dropdown lists TokenHarbor. The card colour `#3859ff` is taken from their stylesheet; they publish no theme-color and the terracotta on their page belongs to an Anthropic section they embed. The logo was supplied as a page snippet and is committed as `public/providers/tokenharbor.svg`. Two things were corrected in it: the `currentColor` fill, which resolves to black through an `<img src>` and would depend on how the file is embedded, is written out as the darkest ink from their own stylesheet; and the Tailwind size class and `img` role, which belong to the page rather than the artwork, are removed. There is a `tokenrouter` asset in the catalog for a different, unrelated service, which this deliberately does not reuse — that would be the same class of mistake as sending a key to the wrong vendor.
  - Files: `src/data/providers.ts`, `src/components/AddProviderModal.tsx`, docs.
  - Depends on: Task 11.
  - Scope: Small.

- [x] Task 11: Filter models by price, modality and context, from the catalog's own metadata.
  - Acceptance: models carry the prices, context windows and modalities their provider published, normalised to one unit; every filter is offered only where the provider published the field it filters on; and an absent field is never read as a zero.
  - Verify: `Model` gains `inputModalities`, `outputModalities` and `pricing`. OpenRouter supplies `context_length`, `architecture.input_modalities` and `pricing.prompt`/`completion` — which its adapter already read for its own free and text-output checks and then discarded — and OpenCode Console supplies `limit.context`, `modalities` and `cost`. The two quote in different units, per-token strings against per-1M numbers, so both are converted to per-1M at the edge with separate converters; guessing the unit would render a price a million times out. Measured live: OpenRouter 452 of 458 priced, 458 with context and modalities, 21 free, 288 accepting image; Console 77 of 77 on all three, 8 free, 64 accepting image. Metadata is captured during discovery, so a save or a models refresh costs no extra provider request, and it is stored compactly and validated on read. In the browser the filters narrow correctly — 8 free, 43 at 1M context, 64 accepting image, all matching the independent SDK measurement — and on Cline, which publishes nothing, the price, modality and context filters are absent, no badges appear, and search, result and sort remain. Two bugs the tests caught: `Number('')` is 0, so an empty price string read as free; and the slowest-first sort put untested models at the top, which the pre-existing rule had deliberately avoided.
  - Files: `packages/omnihilbras-sdk/src/pricing.ts`, `modelFilters.ts`, `types.ts`, `adapters/openrouter.ts`, `adapters/opencode-console.ts`, `test/pricing.test.js`, `test/model-filters.test.js`, `apps/gateway/src/connections.ts`, `service.ts`, `src/pages/ProviderDetailPage.tsx`, `src/lib/gatewayClient.ts`, `package.json`, docs.
  - Depends on: Task 10m.
  - Scope: Medium.

- [x] Task 10m: Never let a provider id resolve to a different vendor.
  - Acceptance: a card resolves to its own option and endpoint whether or not the dialog's list knows it, and an unknown id resolves to the neutral custom option rather than to a named vendor. A key must never be transmitted to a provider the operator did not name.
  - Verify: adding the NaraRouter card without adding it to the dialog's own option list made the dialog fall back to `providerOptions[0]`, which is OpenAI — so the dialog was titled "Add OpenAI API Key", carried `https://api.openai.com/v1`, and a NaraRouter key was validated against and transmitted to OpenAI, which replied with its own "Incorrect API key provided" shape. Verified fixed in the browser: the dialog is titled "Add NaraRouter API Key", references NaraRouter and not OpenAI, and the check request goes to `/v1/connections/nara-router` and returns NaraRouter's own `A valid API key is required.` The stale "Preview mode: this provider connection is not sent to the gateway yet" copy is corrected too, since the key demonstrably does reach the loopback gateway. `src/` has no test runner, so this is browser-verified rather than covered by an automated test.
  - Files: `src/components/AddProviderModal.tsx`, `src/data/providers.ts`, docs.
  - Depends on: Task 10l.
  - Scope: Small.

- [x] Task 10l: Stop discarding the provider's explanation, and stop treating a 403 as an auth failure.
  - Acceptance: a refusal names the provider's reason on every provider, and a refused request cannot eject a connection that is otherwise healthy.
  - Verify: two defects with one cause visible between them. First, the transport cancelled the error body unread and passed `undefined` to the classifier, so `providerErrorDetail` never had anything to work with and every refusal on every provider arrived with no reason — the body is now read on both the request and stream paths, bounded to 64 KB and JSON-parsed when it is JSON. Second, a 403 mapped to `AUTHENTICATION_FAILED`, which is a terminal route code, so one refused free model ejected the connection and took seventy working models with it; only a 401 is an auth failure on status alone, and Cline and OpenRouter already raise it deliberately. Measured live on `/inference/openai/v1` with a Console session: refused model now reports "OpenCode's free tier can only be used from within OpenCode", the following request on the same connection answers 200, and the pattern repeats. The dashboard tooltip carries the provider's words, taken from `providerMessage`, which is only sent to a trusted local dashboard origin. Seven tests cover the status mapping, and the body-extraction case fails against the old behaviour.
  - Files: `packages/omnihilbras-sdk/src/transport.ts`, `test/status-mapping.test.js`, `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 10k.
  - Scope: Medium.

- [x] Task 10k: Send `x-org-id` to the config endpoint, un-double the Anthropic lane, and add a model re-scan.
  - Acceptance: the Console config is read with the header it demands, a credential without an org recovers on its own, the Claude lane reaches the endpoint, and a connection saved with no models can be repaired without signing in again.
  - Verify: the connection saved with 0 models because `GET /api/config` answered `400 {"code":"org_required","message":"x-org-id is required"}` — the config call wants `x-org-id` while inference wants `x-opencode-org-id`. Measured: no header 400, `x-org-id` 200 with 77 models, `x-opencode-org-id` 400. The adapter now looks the org up from `/api/orgs` when the credential has none, so a credential saved before the org was captured recovers instead of failing forever; the stored connection went 0 to 77 models. The Anthropic lane was a second doubled path: `AnthropicAdapter` appends `v1/messages` to a base already ending in `/v1`, so Claude asked for `/v1/v1/messages` and got 404; corrected it now answers 402 Insufficient account funds, which is the endpoint working. `POST /v1/connections/:id/models/refresh` re-reads a saved catalog and keeps custom models. Also corrects a v0.9.2 claim: the config issues an `org_` id matching the orgs list, not a `wrk_` one, and the `403 Workspace access denied` measurement that suggested otherwise came from an id invented by swapping prefixes onto a real value.
  - Files: `packages/omnihilbras-sdk/src/adapters/opencode-console.ts`, `test/opencode-console.test.js`, `apps/gateway/src/opencodeConsole.ts`, `service.ts`, `server.ts`, docs.
  - Depends on: Task 10j.
  - Scope: Medium.

- [x] Task 10j: Claim the device exchange, and start the sign-in once per dialog.
  - Acceptance: two overlapping polls cannot spend the same single-use device code, and a re-render cannot mint a second one. Both are proven by tests that fail without the fix.
  - Verify: a device code dies the moment the token is issued, and the dashboard polls every second while saving a connection takes longer, so two polls overlap. The losing poll was told `The device code is invalid` and overwrote a success — matching the reported symptom exactly, where the Console showed "Device authorized" and the dashboard showed "The device code is invalid". The exchange is now claimed before the Console is called and a pending claim is released so the next poll may retry. Separately, `onConnected` and `onClose` are inline arrows, so their identity changes each render, which rebuilt the start callback and requested a fresh device code on every render while the browser was sent to whichever was minted last. A ref guard makes it start once. Four service-level tests drive the real method against a stubbed Console that treats the grant as dead after use; the overlapping-poll test was confirmed to fail with the claim removed and pass with it restored. In the browser, twelve forced re-renders produce exactly one start call.
  - Files: `apps/gateway/src/service.ts`, `apps/gateway/test/opencode-console-race.test.js`, `src/components/OauthConnectDialog.tsx`, docs.
  - Depends on: Task 10i.
  - Scope: Small.

- [x] Task 10i: Take the org id from the Console config, and stop a catalog read failing a sign-in.
  - Acceptance: the org id sent with inference requests is the one the Console's own config hands out, a sign-in the user approved is not thrown away because the catalog would not read, and a failure names the provider's reason instead of a generic refusal.
  - Verify: the config issues a `wrk_` workspace id and the orgs list carries `org_` ids, and the live lane answers `403 Workspace access denied` for the `org_` form while `wrk_` and an absent header both answer `200`. `/api/orgs` is also `401` for an API key, so it is read for the org name only. Separately, the transport's generic 4xx message was being shown instead of the provider's words, so a real reason never reached the user; the provider detail is now surfaced the way the Cline sign-in already does. Model discovery is tolerated for this provider only, so a session the user just approved is kept and the reason is carried on the sign-in status. 14 gateway tests, including one that pins the workspace-id-over-orgs-list ordering and one that an unreadable config degrades to the orgs list rather than losing the org.
  - Files: `apps/gateway/src/opencodeConsole.ts`, `apps/gateway/test/opencode-console.test.js`, `apps/gateway/src/service.ts`, `src/components/OauthConnectDialog.tsx`, docs.
  - Depends on: Task 10h.
  - Scope: Small.

- [x] Task 10h: Fix the Console verification URL, which pointed at the API host.
  - Acceptance: the device page opens on the Console web host, and the dashboard says what to expect when the browser has no Console session.
  - Verify: the Console serves its API from `console.opencode.ai` and its pages from `opencode.ai`. `verification_uri` is relative, so joining it to the API host produced `/console/console/device`, which renders a blank page and presents as a sign-in that did nothing. Reproduced live: the doubled path was reached, the corrected URL is not, and an unauthenticated visit correctly redirects to `/console/login?next=/console/device?user_code=…&reason=device` with the device query preserved. 12 gateway tests cover the host split, the leading-slash case, a missing device code, pending-as-400, `slow_down`, a refusal in the Console's words, the org the client would pick, a token with no account lookup, a token with no access token, single-claim sessions, expiry, and a malformed session id.
  - Files: `packages/omnihilbras-sdk/src/adapters/opencode-console.ts`, `apps/gateway/src/opencodeConsole.ts`, `apps/gateway/test/opencode-console.test.js`, `src/components/OauthConnectDialog.tsx`, docs.
  - Depends on: Task 10g.
  - Scope: Small.

- [x] Task 10g: Build the OpenCode Console device-code sign-in, and light up the card.
  - Acceptance: the card signs in through the vendor's own device flow, stores the session per connection, renews it, and serves the catalog from the lanes the server names. Gemini is refused by name.
  - Verify: `POST /v1/oauth/opencode-console/start` returns 201 with a session, a 9-character user code, and an absolute verification URL — the Console returns a relative path, so it is joined to the server. `GET .../session/:id` reports `pending` for an unapproved code, 404 for an unknown session, 400 for a malformed id. In the dashboard the dialog shows the code, links to the code page, and falls back to the manual link when the tab is blocked. 15 new SDK tests cover lane dispatch, the Gemini refusal, renewal with the org preserved, the config-sourced org id, per-session lane caching, and the prefix-stripping of a vendor-prefixed id. Two bugs were found by those tests: a request renewed the session twice because the credential is resolved twice, and a config-supplied org id never reached the header because the adapter read only the credential.
  - Files: `packages/omnihilbras-sdk/src/adapters/opencode-console.ts`, `types.ts`, `test/opencode-console.test.js`, `apps/gateway/src/opencodeConsole.ts`, `service.ts`, `server.ts`, `src/lib/gatewayClient.ts`, `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 10f.
  - Scope: Medium.

- [x] Task 10f: Add the OpenCode Console card, and correct the two wrong claims.
  - Acceptance: a Console card exists in the OAuth group without disturbing the existing Zen card, an auth mode with no flow behind it disables its connect action and says so, and the IP-scoped and no-third-party claims are withdrawn in favour of the measured credential-scoped result.
  - Verify: `opencode-console` renders under OAuth Providers and `opencode` still renders under API Key Providers. On the new card both Add connection buttons are disabled with the title "OpenCode Console sign-in is not available yet." and the empty state reads "Sign-in for this provider is not available yet."; Cline's buttons stay enabled, since it has a flow. Correction: `opencode run -m opencode/mimo-v2.6-flash-free` answers `OK` at cost 0 on the installed client, whose stored credential is a Console OAuth session — recognisable because the client renders `metadata.orgName` as the label, and an org name only exists on the device flow. A Console-authenticated `/api/config` names the real lanes (`/inference/openai/v1` with all 7 free models, `/inference/anthropic/v1`, `/inference/google/v1beta`) and a per-account `x-opencode-org-id`; the API key with that header is still refused, so neither the org id nor the address is the gate.
  - Files: `src/data/providers.ts`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 10e.
  - Scope: Medium.

- [x] Task 10e: Retest against 9router's own keyless request, and correct the scope of the finding.
  - Acceptance: the refusal is retested against the reference implementation's own request rather than a hand-written one, and the conclusion is narrowed to what was actually measured.
  - Verify: 9router's keyless executor (`open-sse/executors/opencode.js`) hardcodes `Authorization: Bearer public` and requires canonical 30-character session and request ids (`ses_`/`msg_` + 12 hex + 14 base62) with `x-opencode-client: desktop` and `x-opencode-project: global`. Reproducing that exactly still returns `403` on every restricted model, so the request shape is not the variable. The remaining variable is the egress address: 9router's own page offers a Proxy Pool to "bypass IP-based limits" and Zen keys the free tier on the client address via `createIpRateLimiter` (`handler.ts:104-127`). v0.7.3's "unreachable" is therefore narrowed to "unreachable from an address that is not on the inside". Also recorded: `x-real-ip` is a client-controllable rate-limit input, a weakness in OpenCode's deployment to report rather than exploit.
  - Files: docs only.
  - Depends on: Task 10d.
  - Scope: Small.

- [x] Task 10d: Establish where the Zen free-tier refusal is actually decided.
  - Acceptance: the deciding layer is identified from provider source rather than inferred from symptoms, and the behaviour of the two reference projects that advertise a keyless OpenCode lane is recorded as measured.
  - Verify: OpenCode's own Zen handler prefixes a relayed upstream error with `Error from provider (<displayName>)` (`handler.ts:339`), so the refusal is an upstream provider's, not Zen's. Zen's edge treats `public` as no key (`handler.ts:107`) and admits anonymous callers when the model's `allowAnonymous` flag is set, rate-limiting by IP (`handler.ts:126`, `:699-701`), so these models are open at the edge and refused downstream. The full client matrix is credential-, header-, transport- and lane-independent across 5 retries. OmniRoute never calls Zen for this: its `open-code` MITM target rewrites `body.model` and forwards to its own router (`handlers/openCode.ts:26,29`), while its `noauth.ts` blurb advertises the very request shape that receives a 403. 9router's lane is `noAuth` with a placeholder `baseUrl` and a stale hardcoded model list, and its own test already reports `OpenCode free tier unavailable`.
  - Files: docs only.
  - Depends on: Task 10c.
  - Scope: Small.

- [x] Task 10c: Record the near-identical model id that makes a working route look broken.
  - Acceptance: the confusion between Zen's free `mimo-*-free` and OpenRouter's paid `xiaomi/mimo-*` is documented with both measured, so a "works in my other gateway" report is checked against the model id and provider before it is read as a routing fault.
  - Verify: `xiaomi/mimo-v2.6-flash` and `xiaomi/mimo-v2.5` answer through the configured OpenRouter connection; `mimo-v2.6-flash-free` and `mimo-v2.5-free` refuse on Zen with `403`. The two are distinct vendors' models with near-identical ids.
  - Files: docs only.
  - Depends on: Task 10b.
  - Scope: Small.

- [x] Task 10b: Measure why the restricted Zen free models refuse, and say so plainly.
  - Acceptance: the refusal cause is established by live request, not inference, and recorded in the docs. Client-impersonation headers are not shipped if they unlock nothing.
  - Verify: the live catalog holds 82 models, 11 free. Exactly one free model answers (`space-bunny-free`). Eight refuse with `403`; `deepseek-v4-flash-free` refuses with `400` and an upstream "Model is unavailable"; `jev-1.13-free` is refused by name. The restriction survives `x-opencode-client: desktop`, an `opencode/…` User-Agent, the sentinel `Bearer public`, `stream: true`, and a valid key, so those headers were tried and removed. Zen returns an empty error body to an authenticated caller and a descriptive one to an unauthenticated caller, which is why a refusal surfaces as a bare status. 9router's hardcoded free list is stale: it advertises `union-alpha`, absent from the catalog and refused by every lane.
  - Files: docs only. The v0.7.0 adapter is unchanged.
  - Depends on: Task 10a.
  - Scope: Small.

- [x] Task 10a: Route OpenCode Zen per model to the lane Zen publishes for it.
  - Acceptance: `ZenAdapter` picks chat, responses, or messages per model from the published table, translating each wire format, and refuses the two unimplemented lanes by name. The messages lane authenticates with `x-api-key`, not a bearer token.
  - Verify: 11 new SDK tests cover lane selection including the `qwen3.8-max` exception, both wire formats in and out, error envelopes, the streaming refusal, and a validation that spends no request. Live: `claude-sonnet-5` went from 401 to 402 when the header was corrected, which is what proves the fix; `space-bunny-free` answers through the new adapter; paid models answer 402 (no credits) and restricted free models 403.
  - Files: `packages/omnihilbras-sdk/src/adapters/zen.ts`, `test/zen.test.js`, `src/index.ts`, `apps/gateway/src/service.ts`, docs.
  - Depends on: Task 9z.
  - Scope: Medium.

- [x] Task 9z: Match 9router's model probe, and soft-pass a reasoning-only reply.
  - Acceptance: the probe budget is 1024 tokens with a `hi` prompt, and a response whose content is empty but which carries reasoning under any of the four common field names is a pass labelled `reasoning only` rather than a failure. A genuinely empty response still fails, and a truncated one is retried once at 2x.
  - Verify: measured on the OpenRouter free tier. `inclusionai/ling-3.0-flash-fin`, `liquid/lfm-2.5-2.6b` and `nvidia/nemotron-3.5-lightning` all failed or returned nothing at a 96-token budget and answer cleanly at 1024. `nemotron-3-nano-omni-30b-a3b-reasoning` answers 4 of 5, and its one failure now reports "the provider returned no choices" instead of a bare "invalid response".
  - Files: `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, `packages/omnihilbras-sdk/src/adapters/openai-compatible.ts`, docs.
  - Depends on: Task 9y.
  - Scope: Small.

- [x] Task 9y: Stop recording an empty model response as a pass.
  - Acceptance: the model test budget is 96 tokens, and a response with no visible text is a failure carrying a reason rather than a `Ping` badge. A response with tool calls still counts as an answer.
  - Verify: live against OpenRouter free models. `liquid/lfm-2.5-2.6b:free` and `dots-studio/dots-3-note-preview:free` both returned `content: null, finish_reason: length` at 16 tokens and were recorded as passes; at 96 tokens both answer `OK` with `finish_reason: stop`.
  - Files: `src/lib/gatewayClient.ts`, docs.
  - Depends on: Task 9x.
  - Scope: Small.

- [x] Task 9x: Say why a Cline call failed.
  - Acceptance: a Cline health check returns a reason instead of a bare `unavailable`, and a failed token renewal is reported as an expired session rather than a raw 4xx.
  - Verify: 3 new SDK tests. Live: a Cline health check that previously reported only `unavailable` now reads "Cline rejected the token. Sign in again."
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `test/cline.test.js`, docs.
  - Depends on: Task 9w.
  - Scope: Small.

- [x] Task 9w: Address credentials by connection, so a provider can hold several.
  - Acceptance: `PUT /v1/connections/:providerId` updates that provider's existing connection, and passing an `id` adds another alongside it. Each connection's credential is stored and read under its own connection id, never a provider id.
  - Verify: 3 new store tests cover two connections of one provider holding distinct credentials, an id-less save reusing the existing connection, and deleting one connection leaving the other's credential intact. Live against OpenCode: two connections (`opencode`, `opencode-backup`) coexist with 82 models each and appear separately in `/v1/routing`; the pre-existing OpenRouter and Cline connections still resolve their credentials after the vault rekey.
  - Files: `apps/gateway/src/connections.ts`, `src/service.ts`, `src/server.ts`, `test/connections.test.js`, docs.
  - Depends on: Task 9v.
  - Scope: Medium.

- [x] Task 9v: Add OpenCode Zen, and fix the save path that made it unreachable.
  - Acceptance: OpenCode Zen appears in the catalog and the add-connection dialog, and saving it stores an encrypted credential and imports the live catalog through the generic route. The API key is handed to the page for any provider that asks for one, not OpenRouter alone.
  - Verify: live against OpenCode — `PUT /v1/connections/opencode` returns a saved connection with 82 real models imported from `https://opencode.ai/zen/v1/models`, and a chat request through the gateway routes to OpenCode and returns its own 401 for a bad key. The connection is deleted afterwards so no fake credential lingers.
  - Files: `src/data/providers.ts`, `src/components/AddProviderModal.tsx`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9u.
  - Scope: Medium.

- [x] Task 9u: Narrow and order the model list by test result.
  - Acceptance: a result filter (All / Untested / Passed / Failed) with a count per option, and a sort by name, fastest, or slowest. Untested models sort last in either latency order. The result filter is suspended during a bulk run so the list does not empty out from under the workers. Failures stay on their own row; there is no aggregate failure panel.
  - Verify: browser check on the OpenRouter page after a 22-model run — All=22, Untested=0, Passed=15, Failed=7, with 0 console errors; the filter narrows the list and sort control applies. On the Cline page, a search plus the Failed filter shows the 8 failing models out of 458.
  - Files: `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9t.
  - Scope: Small.

- [x] Task 9t: Match Cline's client identification and chat envelope.
  - Acceptance: Cline requests carry the same client-identification header set Cline's own clients send, including `HTTP-Referer: https://cline.bot`, and a non-streaming chat response wrapped in `{"success":true,"data":{…}}` is unwrapped while `{"success":false,…}` is raised with Cline's own reason.
  - Verify: 6 new SDK tests cover the envelope shapes, a chat completion read through the envelope, the full header set, and that a caller-supplied header cannot override the token. Confirmed live that the referer alone changes Cline's answer, so the header set is not cosmetic.
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `src/adapters/openai-compatible.ts`, `test/cline.test.js`, docs.
  - Depends on: Task 9s.
  - Scope: Small.

- [x] Task 9s: Filter models inside a provider page.
  - Acceptance: every provider page has a search box above its model list that matches the full model ID and the part after the vendor prefix, shows `Showing N of M`, distinguishes no-match from nothing-imported, and has a clear control. `Test all` operates on the listed models and says `Test N shown` when a filter is active.
  - Verify: browser check on the Cline page with 458 real models — `claude-sonnet` narrows to 8 rows, the bulk button reads `Test 8 shown`, a nonsense query shows "Nothing in 458 models matches", and the clear control resets. 0 console errors.
  - Files: `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9r.
  - Scope: Small.

- [x] Task 9r: Read connections back from the gateway after a sign-in, and guard required fields.
  - Acceptance: a completed sign-in re-reads the authoritative record from the connections route instead of adopting the sign-in payload, and the resilience panel falls back to defaults rather than reading a required field unguarded.
  - Verify: browser check with a connected Cline account renders the provider page with 0 console errors, and every former unguarded read of `connection.resilience` now goes through one guarded local.
  - Files: `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9q.
  - Scope: Small.

- [x] Task 9q: Search models on the providers page, and fix what the search exposed.
  - Acceptance: the providers page search matches provider names and imported model IDs, including the part after a vendor prefix, and reports results grouped by provider with an honest serving state. Health is recorded from the reported status rather than the absence of a throw, and a provider's own wording reaches the operator through the dashboard only.
  - Verify: 1 new gateway test asserts an adapter reporting `unavailable` is recorded as a failure. In the browser against the live Cline account, `claude` reports 3 models across 1 provider, `claude-sonnet` reports 9 across 2, a nonsense query shows the empty state, the clear control resets, and the Cline badge reads `serving`.
  - Files: `src/pages/ProvidersPage.tsx`, `apps/gateway/src/service.ts`, `src/server.ts`, `test/routing.test.js`, docs.
  - Depends on: Task 9p.
  - Scope: Medium.

- [x] Task 9p: Return a whole connection from sign-in, and load any provider's connection.
  - Acceptance: a connected sign-in status carries the complete connection record, and a provider page loads its saved connection for every provider rather than only the first one that shipped with a flow.
  - Verify: a test asserts every connection field and every `resilience` field survives the session status. In the browser with a real Cline account connected, the page reports 1 active connection and 458 models with 0 console errors, where before it blanked on connect and reported no connection on load.
  - Files: `apps/gateway/src/oauth.ts`, `src/service.ts`, `test/oauth-routes.test.js`, `src/components/OauthConnectDialog.tsx`, `src/lib/gatewayClient.ts`, `src/pages/ProviderDetailPage.tsx`, docs.
  - Depends on: Task 9o.
  - Scope: Small.

- [x] Task 9o: Fix the Cline API base URL, expiry units, and swallowed errors.
  - Acceptance: the adapter targets `https://api.cline.bot/api/v1`, an expiry reported in epoch seconds is not read as 1970, and a provider 4xx keeps a short token-free excerpt of what the provider said so the callback page can name the reason.
  - Verify: tests pin every Cline endpoint under `/api/v1`, the resolved `models` and `chat/completions` URLs, the seconds/milliseconds boundary, and that token-shaped strings are stripped from an error excerpt. Confirmed live: `/api/v1/models` answers 200 with the full catalog and no valid token, while `/models` answers 401 with Cline's "re-authenticate" message, which is the failure this fixes.
  - Files: `packages/omnihilbras-sdk/src/adapters/cline.ts`, `src/transport.ts`, `test/cline.test.js`, `apps/gateway/src/oauth.ts`, `src/service.ts`, docs.
  - Depends on: Task 9n.
  - Scope: Small.

- [x] Task 9n: Correlate the sign-in by redirect path instead of `state`.
  - Acceptance: a callback that carries no `state` at all still completes the sign-in, because the session id travels in the path of `redirect_uri`, which the provider must honour verbatim. `state` is still minted, sent, and checked when it comes back. A session is claimed exactly once, a wrong `state` spends nothing, and a callback identifying no session is refused with a message that points at the paste box.
  - Verify: 33 gateway tests including the regression that a state-less callback completes, a crossed state exchanges nothing and can be retried, a replayed path is refused even with the right state, and the `redirect_uri` sent to the token endpoint equals the one the authorize request carried. Confirmed live against the gateway with a state-less callback, which now reports Cline's own rejection instead of an unknown-session error.
  - Files: `apps/gateway/src/oauth.ts`, `src/service.ts`, `src/server.ts`, `test/cline-sessions.test.js`, `test/oauth-routes.test.js`, docs.
  - Depends on: Task 9m.
  - Scope: Small.

- [x] Task 9m: Centre the OAuth dialog and open the browser from the click.
  - Acceptance: the dialog renders through `createPortal` into `document.body` so it centres like the API-key dialog, and the sign-in tab is opened inside the click handler that starts the flow, because a browser only permits `window.open` during a user gesture.
  - Verify: the dialog's DOM depth drops from inside the transformed page container to a direct child of `body`; the browser opens a tab on `authkit.cline.bot` from a single click on Add connection.
  - Files: `src/components/OauthConnectDialog.tsx`, `src/pages/ProviderDetailPage.tsx`, `docs/SPEC-SDK.md`.
  - Depends on: Task 9l.
  - Scope: Small.

- [ ] Task 10: Define cloud integration boundaries.
  - Acceptance: auth context, tenant context, remote `SecretStore`, and deployment configuration are represented by interfaces without implementing cloud infrastructure.
  - Verify: typecheck and architecture review.
  - Files: SDK/gateway interfaces and documentation.
  - Depends on: Task 8.
  - Scope: Small.
