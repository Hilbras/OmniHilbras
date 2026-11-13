# DeepSeek Web — the contract, captured from the live client

**How this was obtained.** A dedicated-profile Brave (`--user-data-dir=~/.cache/omnihilbras-rea/brave-deepseek
--remote-debugging-port=9222`), signed into `chat.deepseek.com` by the operator, driven over CDP by a
Playwright script that recorded `Network.requestWillBeSent` / `responseReceived` / `finished` for every
`/api/*` call, including the SSE body via `Network.getResponseBody`. Three runs: default, `DeepThink`
on, `Search` toggled. Raw captures, redacted, are beside this file in `deepseek-web-captures/`.

**Why CDP and not REA's own capture.** REA was used for what it is built for — `list-browser-targets`
and `analyze-web-bundle` against the same endpoint — but its browser evidence deliberately omits
**raw request headers, bodies and streamed payloads**, which is exactly the thing being reverse
engineered here. Both were run; the payloads come from CDP.

## The turn, end to end

```
POST /api/v0/chat/create_pow_challenge   {"target_path":"/api/v0/chat/completion"}
POST /api/v0/chat/completion             { ...see body below... }   → 200 text/event-stream
POST /api/v0/telemetry                   (fire and forget, not required to answer)
```

The completion body, verbatim field names, from the default run:

```json
{
  "chat_session_id": "<redacted>",
  "parent_message_id": 2,
  "model_type": null,
  "prompt": "Reply with exactly: PING-…",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": true,
  "action": null,
  "preempt": false,
  "shumei_device_id": "<redacted>"
}
```

`thinking_enabled` and `search_enabled` are **independent booleans**, and `model_type` stayed `null` in
all three runs — the model is not chosen per request in this client. `parent_message_id` is the id of
the assistant message the turn replies to: the three runs used `2`, then `4`, then `6`, so a
conversation is a chain, not a fresh session per question.

Headers the client sent on the completion (values kept except credentials and fingerprints):

| Header | Value |
| --- | --- |
| `x-client-version` | `2.8.0` |
| `x-client-bundle-id` | `com.deepseek.chat` |
| `x-client-platform` | `web` |
| `x-client-locale` | **`en_US`** — underscore, not `en-US` |
| `x-client-timezone-offset` | `10800` (seconds; note the sign flips the usual JS value) |
| `x-device-id` | a UUID |
| `x-device-model` | empty string |
| `x-ds-pow-response` | base64 of the solved challenge |
| `x-hif-leim` | **absent** — the attestation header this adapter already omits was not sent for completion either |

## The stream

```
event: ready            {"request_message_id":5,"response_message_id":6,"model_type":"default"}
event: update_session   {"updated_at":1794578534.089747}
data: {"v":{"response":{ …message with fragments:[{type:"THINK",…}] …}}}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
data: {"v":" answer"}                       ← shorthand: append to the last fragment
data: {"p":"response/fragments","v":[ …whole fragment array… ]}
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":153},{"p":"quasi_status","v":"FINISHED"}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}
event: update_session   {"updated_at":1794578534.3617709}
event: close            {"click_behavior":"none","auto_resume":false}
```

Four frame shapes, all present in one short answer:

1. a whole response object (`v.response`), which declares the fragment list;
2. a **path patch** `{p, o, v}` with `APPEND` / `SET`;
3. a bare `{"v": " text"}` — append with no path;
4. a **batch** `{p:"response", o:"BATCH", v:[{p,v}…]}` carrying `accumulated_token_usage` and
   `quasi_status`, i.e. metadata that is never text.

**Thinking is a fragment type, not a channel.** With `thinking_enabled: true` the response carries
`fragments: [{type:"THINK", content:"…"}, {type:"RESPONSE", content:"…"}]`, and the untyped append
frames belong to whichever fragment is last. That is the whole mechanism for separating reasoning from
the answer — and it means the client's own `THINK`/`RESPONSE` boundary is the one to follow.

Also observed: `search_triggered`, `search_enabled`, `references[]` per fragment, `stage_id`,
`auto_continue`, `extra_search_providers`. `event: close` carries `auto_resume`, which is the client's
"the answer was cut off, offer to continue" path — a client that ignores it silently truncates.

## What our adapter does differently

Measured against `Kernel/SDK/deepseek-web/adapter/index.ts`:

| | Live client | Our adapter | Consequence |
| --- | --- | --- | --- |
| `parent_message_id` | previous assistant message id | always `null` | every turn claims to answer the first message |
| `shumei_device_id` | present, per device | **absent** | an anti-bot signal we do not send |
| `model_type` | `null` | `expert` / `default` | a value the client does not send |
| `action` | `null` | omitted | probably equivalent |
| `x-client-version` | `2.8.0` | `2.0.0` | a stamp three minor versions stale |
| `x-client-locale` | `en_US` | `en-US` | format differs |
| `x-device-id` | UUID | absent | — |
| `x-device-model` | empty string | absent | — |
| SSE frames | 4 shapes | handles `v.response`, `response/fragments`, `BATCH`, `status`, and the bare string | matches, including the `THINK`/`RESPONSE` split |
| Session | one per conversation, chained | **new session** (`chat_session/create`) per request, history flattened into `prompt` | each request pays a session creation and the server sees a first turn every time |

Two latent defects found while reading, independent of the capture:

- `proofOfWork` defaults `target_path` to **`/api/v2/chat/completion`** while the request goes to
  `/api/v0/chat/completion`. The server has always echoed `target_path` in the challenge so far, so the
  default has never been used — but a challenge without it would bind the proof to a path we do not call.
- The adapter creates a session per request; the captured client reuses one and chains
  `parent_message_id`. Whether chaining changes the answer (vs. flattening the history into `prompt`,
  which our adapter does) is **not established by this capture** and would need an A/B against the live
  endpoint.

## What is not established

- Whether DeepSeek enforces `shumei_device_id`, `x-device-id` or the version stamp. They are sent by the
  client; no refusal has been observed from omitting them, and this capture does not test that.
- Model selection: `model_type` was `null` for every run, so where the UI's model choice enters the wire
  is not answered here.
- File upload (`/api/v0/file/upload_file`, `/api/v0/file/fetch_files`) and `ref_file_ids` were not
  exercised — `ref_file_ids` was empty in all three runs.

---

# The sign-in flow, captured

Recorded over CDP while the operator signed out and signed back in on `chat.deepseek.com`
(`scripts/capture-deepseek-auth.mjs`; raw redacted in `deepseek-web-captures/auth.json`).

```
POST /api/v0/users/logout                        → 200
POST /api/v0/users/login                         → 202 text/html        ← first attempt
POST /api/v0/users/login                         → 200 {biz_code:14, biz_msg:"MFA_VERIFICATION_CODE_REQUIRED",
                                                        biz_data:{mfa_session_id}}
POST /api/v0/users/create_guest_challenge        → 200  PoW challenge for the *next* path
POST /api/v0/users/mfa/create_verification_code  → 200  sends the emailed code
POST /api/v0/users/mfa/check_verification_code   → 200  user.token  ← the session token
POST /api/v0/users/auth_token/check_device       → 200  {rotate: null}
POST /api/v0/users/mfa/trusted_device/register   → 200  WebAuthn (ES256) registration
POST /api/v0/users/mfa/trusted_device/verify     → 200  {credential_id, expire_at}
```

## Two steps a server cannot perform

**1. The credential POST is an opaque blob.** `POST /api/v0/users/login` carries **224 bytes** with
`content-type: application/json` and no `Content-Encoding` — not JSON, and identical in length on the
retry after the 202. Whatever turns `{email, password}` into those bytes happens inside the client, and
nothing in this capture fetches a key from the server for it.

**2. Requesting the code needs an hCaptcha token.** `mfa/create_verification_code` is plain JSON —
`{"mfa_session_id": …, "hcaptcha_token": "P1_eyJhbGci…"}` — and that token is a JWT minted by hCaptcha
on DeepSeek's own origin, against their sitekey. It is domain-bound by design; producing one from our
process is precisely what it exists to prevent.

So a headless credential login is **not reproducible**, and that is a measurement, not a preference.

## What the flow does give us

- **The credential that comes out is the same `userToken`** the current `deepseek-web` provider already
  consumes: `biz_data.user.token`.
- **There is no refresh token.** `auth_token/check_device` answers `{"rotate": null}`; nothing else in
  the flow returns one. When DeepSeek invalidates the session, the session is over and only a fresh
  sign-in recovers it.
- **A trusted-device credential is registered at the end** (WebAuthn/ES256, `expire_at` about a year
  out). It belongs to the browser profile that performed the ceremony, which is why the second sign-in
  in that profile would skip the emailed code — and why a different client does not get that.
- **The model catalogue comes from `GET /api/v0/client/settings?did=…&scope=model`** →
  `settings.model_configs[].value[]` with `model_type: "default" | "expert"`. This answers yesterday's
  open question about where model choice lives: it is server-delivered settings, not a field on the
  completion request.
