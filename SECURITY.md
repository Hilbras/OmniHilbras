# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:

> **Security** → **Report a vulnerability** on <https://github.com/Hilbras/OmniHilbras>

That opens a private advisory visible only to the maintainers. If the option is unavailable on the repo,
open an issue that says only "security report available on request" with no detail — that is enough for me to
message you privately and nothing more.

Please include: what you did, what you expected, what happened, and the version — `npm ls @hilbras/omnihilbras`,
or the `version` field in `package.json` if you are running from a checkout.

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
  on disk afterwards. This was measured, not assumed — see `apps/gateway/test/api-key-manager.test.js`.
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
  `/v1/web-cookie`, `/v1/routing`, `/v1/usage`) still require the admin key when enforcement is on.
- **The token protects the dev dashboard only.** A production build has no proxy and calls the gateway directly,
  so it has no per-launch token; treat a production build served from another machine as unsupported until it is
  given its own delivery path.
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
- **Pinned provider response fixtures: 4 of 12 adapters.** Provider APIs change independently of this
  repository, so an adapter's wire format is only pinned where a real capture exists. The count is printed by
  `packages/omnihilbras-sdk/test/fixture-coverage.test.js` and fails if it drifts.

## Supported versions

The latest released version. This project ships every change as its own versioned, tagged release, so
"latest" and "supported" are the same thing; there is no long-term-support branch.

## What I will do

- Acknowledge a report within three days.
- Triage within seven, and tell you the severity I think it has and why.
- Credit you in the advisory unless you would rather I did not.
