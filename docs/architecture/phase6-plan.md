# Phase 6: borrowing from 9router — audit first, then the usage layer

**Created:** after the twelve-phase stabilization roadmap finished (v1.59.0).
**Origin:** an audit of `/home/gin/work/9router`, a Next.js local LLM proxy at v0.5.85 that ships
124 provider registry entries and ~1,052 declared models.

`tasks/plan.md` is the original five-phase plan and is 50/50 complete. **This is not a replacement for
it.** It is a new phase of work, and it uses its own numbering below so nothing collides with the
"Phase 1-5" in the plan or the "extraction round" labels in `tasks/todo.md`.

---

## The premise, and the part that is easy to get wrong

9router is **not** a better-engineered project than OmniHilbras. It is bigger, it has more features, and
its security posture on the hard problems (SQL injection, SSRF, RCE, spoofed headers) is genuinely solid.

What it is, measured:

| | 9router | OmniHilbras |
| --- | --- | --- |
| provider registry entries | 124 | 14 adapters / 22 cards |
| declared models | 1,052 | catalog-driven |
| request-log / usage store | yes (`usageRepo.js`, 8 exported functions) | **none at all** |
| format translators | 12 request translators | none |
| regression gate | present, **cannot run** | `pnpm verify`, runs |
| tests | 276 files, ~64 expected failures, no CI | 975, all green, CI green |

So the borrowing is asymmetric and runs **both ways**:

- **Take its feature ideas** — principally the usage/quota layer, which is the one real gap measured here.
- **Take its defect list** — its audit found four live bugs in a mature codebase, two of which are the
  exact classes OmniHilbras spent nine releases (v1.52-v1.56) eliminating.
- **Do not take its engineering as a standard** — a 276-file suite with no CI and a gate that reports every
  failure as a regression is not a model to copy.

## The one hard rule

**Phase 6.1 is read-only.** No feature is built until the audit has run, because building a usage store on
top of an unexamined request path would mean instrumenting whatever is already wrong.

---

## Phase 6.1 — Audit OmniHilbras against 9router's three defect classes (READ-ONLY)

Three classes, each of which 9router's audit found live in its own code:

1. **A truncated stream reported as a complete answer.** 9router: `open-sse/utils/stream.js:383-493` —
   `flush()` passes a `null` chunk to the translator, every translator except OpenAI-Responses returns
   nothing, no finish frame is emitted, and the stream still closes cleanly with
   `status: "success"`. OmniHilbras fixed the *health-recording* half of this in v1.52.0; the
   *client-facing* half (what the SSE body says) was never in scope.
2. **A dropped HTTP status making an error look like a success.** 9router:
   `src/app/api/v1/api/chat/route.js:35` rebuilds the Response without `status`, so a 401 becomes
   **200 with an empty completion**.
3. **Credential and data files written with inherited umask.** 9router: `data.sqlite` at mode `0644`
   holding live provider tokens, while the secret files beside it are correctly `0600`. The writer
   passes no `mode`, so it inherits umask.

Plus two of its Medium findings that are cheap to check here:

4. **An unbounded module-level cache.** 9router has four (`alpnCache`, `DNS_CACHE`, `oauthCooldown` keyed
   by a rotating token, `projectIdCache`). OmniHilbras bounds its caches deliberately — this checks whether
   that holds everywhere, including anything added recently.
5. **A regression gate that is quietly broken.** 9router's `verify-no-regression.mjs:17` derives keys via
   `split("/app/")`, so on any checkout not under `/app/` every failure matches nothing and every failure
   reports as a regression. Worth confirming OmniHilbras's own count guards (added v1.55.0) do not have an
   equivalent path assumption.

**Deliverable:** `docs/architecture/audit-9router-borrowing.md` — each class marked CLEAN / DEFECT /
NOT-APPLICABLE, with `file:line` on both sides for anything claimed. A class found clean is recorded as
clean, not skipped.

**Exit criteria:** every one of the five classes has a verdict backed by a code path. A finding without a
`file:line` is not a finding.

---

## Phase 6.2 — The usage store

The measured gap: **OmniHilbras keeps no per-request record at all.** Not a disabled page — the gateway
stores connections, API keys and OAuth sessions, and has no third store for requests. That is why `Usage`
and `Request log` sit disabled in the dashboard shell, and why `Overview` was deleted rather than built.

Mirror the existing pattern (`ConnectionStore` / `ApiKeyStore`, each with an in-memory and a local
implementation) rather than inventing a new one:

```ts
interface UsageStore {
  record(entry: UsageRecord): Promise<void>;
  list(query: UsageQuery): Promise<UsageRecord[]>;
  summary(query: UsageQuery): Promise<UsageSummary>;
}
```

One route, `GET /v1/usage`. Both dead nav items become real, and `Overview` becomes buildable on measured
data rather than on a fabrication.

**Constraints carried from the audit:**
- Redaction is required, not optional. 9router's request-details route drops message content entirely
  (`src/app/api/usage/request-details/route.js:56-63`) and its DB path strips auth/cookie headers
  (`src/lib/db/repos/requestDetailsRepo.js:61-69`). OmniHilbras must not record credential headers at all,
  and `tests/browser-storage.test.js`-style guards must cover it.
- Retention is bounded by construction. No unbounded table, no unbounded in-memory ring.
- **A client cancellation is not a request record of success or failure.** The v1.52.0 rule applies here too.

**Exit criteria:** `pnpm verify` green; the store has both implementations; a mutation test proving the
redaction guard bites.

---

## Phase 6.3 — Pricing wired to usage

`packages/omnihilbras-sdk/src/pricing.ts` exists (88 lines) and is currently unused for reporting. Joining
it to the Phase 6.2 records turns "tokens saved" into a number the dashboard can show and a claim the
release notes can make.

Small, and rides along with 6.2 — but **only** once 6.2 has landed, so there is data to price.

**Exit criteria:** every cost figure on screen is derived from a recorded measurement, never a constant.
`tests/marketing-claims.test.js` extends to cover it.

---

## Phase 6.4 — Format translation (deferred, may never run)

9router has 12 request translators; OmniHilbras has none, and every adapter speaks its own protocol to its
own provider — which is correct and stays.

The gap is on the *client* axis: the gateway serves OpenAI-shaped responses to every client, so a Claude
Code client and a Codex client both get OpenAI shape.

**This is a compatibility feature, not a provider one, and it is deferred for two reasons:** it is a bigger
surface than 6.2-6.3 combined, and it only matters if you care about non-OpenAI clients. It may never be
worth doing. Deciding that is a product call, not an engineering one.

---

## Explicitly NOT in this phase

Recorded so a later reader does not "helpfully" add them.

- **The MITM layer.** 17 modules plus root-CA generation, a browser-in-the-middle technique for scraping
  web UIs. Its own audit found unredacted credential logging in it. OmniHilbras has web-session adapters
  already; this is not an upgrade path.
- **Provider-count parity.** 22 cards with a proven "add a provider without touching core" property beats
  124 hand-written registry files with a stale count in their own docs.
- **Multi-account round-robin.** A real 9router feature and a genuine product decision, but it multiplies
  credential-handling risk and should not arrive as a side effect of an infrastructure phase.
- **A larger test suite.** Volume without a working gate is worse than a small green suite.

---

## Carried forward, unchanged

Blocked on credentials, not on engineering, and true before this phase:

- Pinned real provider captures: **4 of 14 adapters**. Eight of the ten remaining need a credential this
  machine does not have.
- Rotate: the Qwen `auth.qwen.ai` credential, `/home/gin/session.json`, and the live npm token. All three
  need rotating rather than deleting — a key that reached a commit is compromised.
