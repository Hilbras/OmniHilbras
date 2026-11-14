# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:

> **Security** → **Report a vulnerability** on <https://github.com/Hilbras/OmniHilbras>

That opens a private advisory visible only to the maintainers. If the option is unavailable on the repo,
open an issue that says only "security report available on request" with no detail — that is enough for me to
message you privately and nothing more.

Please include: what you did, what you expected, what happened, and the version — the About page in the
desktop app, the package version in the dashboard, or the `version` field in `package.json` if you are
running from a checkout.

(There is deliberately no `OMNIHILBRAS_VERSION` env var and no version header on responses. I checked before
writing this and the version lives in exactly one place per package.json, which is what `pnpm version:check`
keeps in step.)

## What this project is, and what that means for risk

OmniHilbras is a **local-first** gateway. It binds `127.0.0.1` by default and refuses any other host:

```
OMNIHILBRAS_HOST must be a loopback address in local mode.
```

That refusal is enforced in two places — `loadGatewayConfig` and again in `startGatewayServer` — and is
mutation-tested. So the threat model is **other processes on your machine**, and a browser origin you have
allowlisted, not the public internet. If you deliberately put it behind a tunnel or a reverse proxy, you have
moved it into a different threat model and this policy's "low risk" statements no longer apply to it.

## Where credentials go

- Provider credentials are written through `secure-store.ts`'s `atomicWrite`: a `0700` directory, a `0600`
  file, `chmod` **after** the rename so the mode does not depend on umask, an `fsync`, and a refusal to write
  through a symlink. `tests/browser-storage.test.js` and `tests/no-secrets.test.js` enforce the rest.
- API key secrets are returned **exactly once**, at creation. They are absent from `list()` and from the file
  on disk afterwards. This was measured, not assumed — see `Kernel/API/test/api-key-manager.test.js`.
- No credential is ever handed to browser storage. `tests/browser-storage.test.js` allows exactly two
  `localStorage` keys (a sidebar preference and a theme) and requires `sessionStorage`, `document.cookie`
  writes, IndexedDB and the Cache API to be at **zero**.
- `tests/no-secrets.test.js` scans every tracked file for 15 credential shapes on every push and pull
  request.

**A key that has reached a commit must be rotated, not deleted.** Deleting the commit does not un-publish it,
and does not un-copy it.

## Known limits, stated rather than implied

- **The dashboard is recognised by a per-launch token, not by its Origin.** The gateway generates a random
  token at each start and writes it to `dashboard-token` in the state directory, at mode 0600. The dashboard's
  dev server reads that file and adds the token to the requests it forwards, so the browser never holds it. A
  management request is treated as the dashboard only when it presents the token. An allowlisted `Origin` alone
  is no longer enough. The gateway checks requests against the token it issued at start and keeps that in memory.
  The dev proxy reads the file on each request, so if the file is changed while the gateway runs, the proxy
  forwards the new value and the gateway refuses it with 401. A restart re-issues and rewrites the file, which
  brings them back into agreement. Management routes (`/v1/connections`, `/v1/keys`, `/v1/oauth`, `/v1/settings`,
  `/v1/web-cookie`, `/v1/routing`, `/v1/usage`, `/v1/providers`, `/v1/logs`, `/v1/health`) still require the admin
  key when enforcement is on.
- **The token protects the dev dashboard only.** A production build has no proxy and calls the gateway directly,
  so it has no per-launch token; treat a production build served from another machine as unsupported until it is
  given its own delivery path.
- **The dev proxy is a loopback development boundary, not a multi-user service.** `sec-fetch-site` is browser-set
  and blocks cross-origin page script, which is the CSRF case. A local process can send the same header to the
  Vite port and receive the token. The token file is 0600 and the dev server binds loopback; do not expose the
  dev port beyond loopback, and use the gateway's API keys for any shared machine.
- **The DuckDuckGo challenge runs upstream JavaScript in `node:vm`.** Code generation is disabled and no
  `process`/`require` is exposed, but `vm` is not a security boundary against a malicious challenge blob. It is
  treated as a supply-chain risk in that provider path; the proper fix is an out-of-process solver.
- **The two OAuth callbacks are exempt from that gate, and here is what that means.** `GET
  /v1/oauth/cline/callback/:sessionId` and `GET /v1/oauth/claude-code/callback/:sessionId` answer the
  provider's redirect, which is a top-level navigation the browser is *sent* to — it carries no `Origin` and
  no way to send an `Authorization` header. So those two GET paths are reachable by an unauthenticated local
  process. They render an HTML page whose only content is a short outcome message: no token is in the
  response, and a callback can only act on a session this gateway minted, which requires the session id in
  the path — 256 random bits for Cline, 122 for Claude Code — *and* a code the provider issued. The routes
  carrying the result (`/v1/oauth/*/session/*`)
  and the routes that mint credentials (`/*/start`, `/v1/oauth/cline/exchange`) stay gated, and the
  exemption is GET-only and path-exact.
- **Provider tokens are stored, encrypted at rest** with a key derived from a local master key. They are not
  encrypted in a vault that can revoke them: `CredentialLifecycle` decides whether a stored credential is
  still usable, but "revoked at the provider" is discovered by spending one request.
- **Pinned provider response fixtures: 6 captures, across 24 provider packages considered.** Provider APIs
  change independently of this repository, so an adapter's wire format is only pinned where a real capture
  exists. The count is printed by `Kernel/SDK/tests/fixture-coverage.test.js` and fails if it drifts.

## Supported versions

The latest released version. This project ships every change as its own versioned, tagged release, so
"latest" and "supported" are the same thing; there is no long-term-support branch.

## What I will do

- Acknowledge a report within three days.
- Triage within seven, and tell you the severity I think it has and why.
- Credit you in the advisory unless you would rather I did not.

---

## What changed after the 2026-11-14 audit

A source-first audit (`~/security-audit-skill/omnihilbras/run-1`, run against `c642ba2f`) produced eight
findings. Six are fixed; each carries a regression test.

### Update trust

Every desktop build is **unsigned**, and the updater compared a download against a `sha512` taken from the
same release's `latest-*.yml` — which detects a truncated download and nothing more. Until a
release-signing key exists, the app **says it cannot verify an update and refuses to install one until a
person confirms**. `OMNIHILBRAS_UPDATE_PUBLIC_KEY` is where a verification key will be read from; the
verification itself is not implemented, and the app claims no more than that
(`tests/update-consent.test.js`).

The release workflow also gained a `preflight` job: a tag whose commit is not an ancestor of `main` is
refused, and publishing is a separate job — the only one holding `contents: write`, behind a `release`
environment. Every action is pinned to a commit SHA.

### Credentials in API responses

- **Tunnel tokens are never returned.** `publicTunnel()` omits the value and reports `hasToken`.
- **Proxy pool entries are validated on write and redacted on read.** Entries must parse as
  `http`, `https`, `socks4`, `socks5` or `socks5h` with a host; a refusal names the scheme and host and
  never the value, because a refused proxy URL is exactly the string carrying `user:pass@`. Responses
  show `***:***`; the stored entry keeps its credential, which is what the proxy needs.

### Inbound rate limiting

The gateway limited what it *sends* to providers and nothing about what arrives, so a retrying agent could
spend a quota at line speed. The LLM surface now allows **600 requests per minute per caller** —
`OMNIHILBRAS_REQUESTS_PER_MINUTE` changes it, `0` disables it, and a value that is not a non-negative
integer is ignored rather than refusing everything. `GET /v1/models` is deliberately exempt: it is
discovery, not spend. Refusals are `429` with `retry-after`.

### Runtime installer

`opencode-runtime` no longer takes the release version from npm's `latest` dist-tag — the only pointer to a
binary it then executes. The version is pinned in the repository (`pinnedOpencodeVersion` in
`Kernel/API/src/core/opencode-runtime.ts`), `latest` is available only when asked for by name, and
`OMNIHILBRAS_OPENCODE_SHA256` turns the recorded hash into a check.

### Browser-driver profiles

A driver profile is a signed-in third-party session on disk. It is created `0700`, keyed per connection so
two accounts never share one, and **removed when the connection is deleted**.

### Open, with the reason

- **Release signing** — no keys exist yet. The consent path is what is available; the verification is not
  written because there is nothing to verify against. This is the remaining half of the highest finding.
- **`minimatch` (moderate, DoS via glob expansion)** — reaches the toolchain through `electron-builder`
  only, not the shipped app. The fix belongs upstream; forcing it with an override risks the packager, and
  a forced remediation is not worth that. Review after `electron-builder` moves past `minimatch@3`.
