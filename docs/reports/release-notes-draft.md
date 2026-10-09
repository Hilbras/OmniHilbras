# Draft release notes: 1.78.0

Not tagged, pushed or published. For review. Covers the 37 commits since `v1.77.2`.

Minor bump (`1.78.0`). The SDK's public runtime exports were compared against the published `1.77.2` package: 143 names
before, 148 after, none removed, five added (`KIRO_SOCIAL_DEVICE`, `gatedTools`, `pollKiroSocialDeviceSignIn`,
`retryAfterMs`, `startKiroSocialDeviceSignIn`). Existing imports keep working.

## Security

The dashboard is recognised by a per-launch token, not by its `Origin` header alone. The gateway writes a random token to
`dashboard-token` in the state directory (mode 0600) at each start. The Vite dev server reads it and adds it to the
`/v1` requests it forwards, so the browser never holds it. A forged `Origin` with no token is refused with 401.
Production builds have no such proxy and call the gateway directly, so they have no per-launch token. See SECURITY.md.

The gateway refuses requests whose `Host` is not a loopback name, with 421. This closes DNS rebinding into the local gateway.

The SDK's transport accepts an optional `checkDestination` hook. The gateway supplies one that refuses a remote provider
hostname resolving to a private or loopback address. This is partial. The name is resolved by the check, then again by the
connection, so a DNS server that answers differently each time can still get through. Closing that needs a connection-level
lookup and is tracked as open.

Storage, OAuth callbacks and API-key revocation were audited and tested. No defect was found in them.

## Changed behaviour

- **OpenCode Console:** an account with several workspaces is no longer saved silently with the first one. The sign-in
  lists the workspaces and saves the one you pick, through `POST /v1/oauth/opencode-console/session/:id/workspace`.
- **Provider-prefixed model ids:** the model list carries `qualifiedId`, such as `opencode-console/mimo-v2.6-flash`, and a
  request with that prefix is routed to that provider. The prefix is used only when it names a connected provider, so ids
  such as `qwen/qwen3.8-27b:free` keep working. Bare names are unchanged.
- **Zen free tier:** free-tier requests now declare the file-search tools `bash`, `glob`, `grep` and `read`, not a single
  placeholder. The single placeholder was refused by the gate; this request was measured to be accepted.
- **Usage records:** each record can carry `requestId` and `path`, the ordered connections tried with their outcomes. A
  failover shows which connection failed. Both fields are optional, and older `usage.json` files still load.
- **Usage page:** the recent-requests list is paged at 10 rows. Totals still cover every retained record.
- **429 responses:** the provider's `Retry-After` wait is attached to the error as `details.retryAfterMs`. The gateway does
  not yet use it to delay its own retry.

## Fixes

- The save path trims a pasted API key.
- The bulk API key box has autofill off.
- Connect dialogs return focus to the control that opened them when closed.
- Saved generic providers are treated as active, so their health check finds them.

## Migration

No migration is needed for consumers of the SDK. Dashboard users keep the same workflow, because the dev server adds the
token. Anyone who calls the gateway's management routes directly, outside the dashboard, now needs the token or an API
key, because an allowed `Origin` alone is no longer enough.

## Not in this release

- Honouring `Retry-After` in the executor.
- The DNS-rebinding race (see Security).
- Per-adapter fixtures for authenticated streams, errors and tool calls, which need provider credentials.
- A concurrency cap for inference requests. Measured to degrade under load, not to fail, at 400 concurrent requests.
