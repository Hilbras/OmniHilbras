# DeepSeek Web V2 — provider plan

Chosen auth shape (operator's decision): **A** — OmniHilbras opens `chat.deepseek.com` in its own
window, the operator signs in there normally (password, hCaptcha, emailed code — all theirs), and the
token that window holds is handed to the gateway and stored in the vault. Every inference request
afterwards is the gateway's.

That choice is forced by measurement, not preference — see `docs/reports/deepseek-web-capture.md`:
`POST /api/v0/users/login` carries a 224-byte opaque blob we cannot build, and requesting the emailed
code needs an hCaptcha token minted on DeepSeek's origin. A headless credential login is impossible;
a window that DeepSeek accepts is not.

## What is different from `deepseek-web` (which stays as it is)

| | `deepseek-web` (kept) | `deepseek-web-v2` |
| --- | --- | --- |
| Auth | paste a `userToken` copied from DevTools | sign-in window; the token is captured and vaulted |
| Fingerprint | `x-client-version: 2.0.0`, `x-client-locale: en-US` | `2.8.0`, `en_US`, `x-device-id`, `x-device-model`, `x-client-timezone-offset` |
| Body | `parent_message_id: null` always | chained to the previous assistant message id in the session |
| Model list | a fixed table in the adapter | `GET /api/v0/client/settings?scope=model` → `model_configs[].value[]` |
| Session death | generic auth failure | explicit "session expired — sign in again", because **there is no refresh token** (`auth_token/check_device` → `{"rotate": null}`) |

## Phases

1. **Desktop window.** `deepseek:sign-in` IPC in `desktop/main.mjs`: a `BrowserWindow` on a persistent
   partition, loads `https://chat.deepseek.com`, watches for `localStorage.userToken` to become
   non-empty, returns the value and closes. Preload exposes it as `omnihilbras.deepseek.signIn()`.
2. **Gateway.** Provider id `deepseek-web-v2`, slug `dsw2`; registration in `config.ts` + `service.ts`;
   `POST /v1/web-cookie/deepseek-web-v2/connect` (the token, for the window hand-off and for a paste
   fallback); spec lines in `docs/SPEC-SDK.md` (the route test enforces them).
3. **Adapter.** The `deepseek-web` adapter gains a `variant: 'v2'` option that switches the fingerprint
   headers, the body fields (`action: null`, chaining), and the model source. One implementation, two
   registered providers — a second copy of ~1000 lines would drift.
4. **Dashboard.** A card in the catalog for the new provider; the connection dialog offers **Sign in
   with DeepSeek** when the desktop bridge is present, and says plainly that a browser dashboard cannot
   read the window's storage (no button that cannot work).
5. **Docs, tests, version.** Capture doc updated with what shipped; adapter tests for the V2 contract;
   `provider-cards` / `provider-options` / route-doc tests kept green; version bump and release.

## Not in scope

- Headless credential login. Ruled out by the capture.
- Refresh. DeepSeek issues none; the provider must surface expiry instead of retrying.
- File upload (`/api/v0/file/upload_file`) — `ref_file_ids` was empty in every captured turn.

## What shipped in 3.38.0

- Desktop window (`provider:sign-in`), capturing `userToken` **and** the page's fingerprints.
- Gateway `deepseek-web-v2`: slug `dsw2`, registration, `variant: 'v2'` adapter, connect route,
  credential carrying `deviceId` / `shumeiDeviceId` / `did`.
- Vault: the api-key credential gained those three optional fields, with the restart round-trip test
  extended — the vault writes them, so the vault reads them back.
- Adapter: v2 fingerprint headers (`2.8.0`, `en_US`, `x-device-id`, `x-device-model`), `action: null`,
  `shumei_device_id` from the captured value, model list from `client/settings` with the built-in table
  as the fallback.
- Dashboard: the card, the descriptor with a `signIn` block, and the dialog's sign-in button with the
  honest browser message.

**Not verified yet:** the window end-to-end on a built desktop app. The pieces compile and the vault
round-trip is green, but nobody has clicked sign-in in the packaged app — that is the next step, not a
claim.
