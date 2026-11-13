# Qwen Web — what a signed-in turn actually is, and why replaying it fails

**How this was obtained.** The operator signed in at `chat.qwen.ai` in the CDP-profile Brave
(`127.0.0.1:9222`), REA analysed the page (`list-browser-targets`, `analyze-web-bundle`), and a
Playwright CDP session recorded every `/api/*` call of one real turn — headers, bodies and response
bodies. The raw record is beside this file in `qwen-web-captures/turn.json`, redacted for cookies and
the baxia tokens.

REA's static pass is worth reporting on its own: **13 scripts analysed, 0 endpoint candidates, 1
route.** The bundle yields nothing by pattern — every endpoint below came from live traffic, which is
the honest reason to have driven the page at all.

## The turn, in order

```
POST /api/v2/users/status                                  → 200  telemetry only
POST /api/v2/chats/new                                     → 200  {"data":{"id":"a06cf2d9-…"}}
GET  /api/v2/chats/pinned                                  → 200
POST /api/v2/chat/completions?chat_id=a06cf2d9-…           → 200  text/event-stream
GET  /api/v2/chats/?page=1&exclude_project=true            → 200
```

`chats/new` and the completion body, verbatim:

```json
// POST /api/v2/chats/new
{"chatId":"","models":["qwen3.7-plus"],"project_id":"","timestamp":1794593652223,
 "chat_type":"t2t","chat_mode":"normal"}

// POST /api/v2/chat/completions?chat_id=<id>
{"stream":true,"version":"2.1","incremental_output":true,"chatId":"<id>","parentId":"",
 "chat_id":"<id>","chat_mode":"normal","model":"qwen3.7-plus","parent_id":null,
 "messages":[{"role":"user","content":"Reply with exactly: …","fid":"<uuid>",
   "childrenIds":["<uuid>"],"files":[],"models":["qwen3.7-plus"],"chat_type":"t2t",
   "feature_config":{"thinking_enabled":true,"output_schema":"phase","research_mode":"normal",
     "auto_thinking":true,"thinking_mode":"Auto","thinking_format":"summary","auto_search":true},
   "extra":{"meta":{"subChatType":"t2t"}},"sub_chat_type":"t2t"}],
 "timestamp":1794593656}
```

**The thinking and search toggles are here, not in a header** — `feature_config.thinking_enabled`,
`auto_thinking`, `thinking_mode` (`"Auto"` / `"Off"`), `auto_search`. That is what the UI's DeepThink
and Search switches send.

## The gate, measured

Every `/api/v2` call except `users/status` carries three headers, and the first one is the whole story:

| Header | Observed | Nature |
| --- | --- | --- |
| `bx-ua` | **1664, 1676, 1700, 1712 chars — different on every request** | Alibaba baxia's signed payload, computed per request |
| `bx-umidtoken` | 68 chars, **identical across all of them** | the device token, stable per browser profile |
| `bx-v` | `2.5.37` | the baxia SDK version |

Replaying the turn from outside the page, with the session's **own live cookies**:

| Request | Answer |
| --- | --- |
| cookie only | `200` `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],"data":{"url":"…/_____tmd_____/punish?x5secdata=…"}}` |
| cookie + `Authorization: Bearer <session token>` | identical refusal |
| cookie + **a real `bx-ua` captured from this very session seconds earlier**, plus its `bx-umidtoken` | identical refusal, with a fresh `x5secdata` |

Three things follow, and they are the point of this document:

1. **The status code lies.** HTTP `200`, and the body is a refusal. A client that checks `response.ok`
   reports a working provider and an empty answer.
2. **The cookie and the bearer token are not the gate.** Both were present in the reproductions.
3. **`bx-ua` is bound to the request, not to the session.** A signature the page itself minted, replayed
   immediately from the same machine with the same cookies, is refused. Reuse is exactly what it is
   built to detect.

So Qwen Web is behind a **per-request signature**, and unlike DeepSeek's hCaptcha (once per sign-in)
this one is per turn. Nothing a server can compute, and nothing it can capture and hold, produces a
working turn.

## What that means for `Kernel/SDK/qwen-web`

Our adapter already documents this shape and does not pretend otherwise — it reads the refusal out of
the body rather than the status, and `probeQwenWeb` reports the gate's answer instead of a verdict.
What this capture adds:

| | Live client | Our adapter |
| --- | --- | --- |
| `bx-ua` / `bx-umidtoken` / `bx-v` | sent on every call | **not sent** — and cannot be, honestly |
| chat creation | `POST /api/v2/chats/new` then `completions?chat_id=` | single completion call |
| thinking / search switches | `feature_config` in the body | not sent |
| default model | `qwen3.7-plus` | catalog from `GET /api/v2/models/` |
| refusal detection | — | already correct: reads `ret` from a 200 |

The gap is not a missing field. It is a signature we cannot produce, so the honest options are the
two this project has already used elsewhere:

- **a browser in the loop** — the `ChatGptWebDriver` pattern already in this repo: the gateway drives a
  real signed-in page and reads the answer back, instead of impersonating the client;
- **or leave the provider as a probe** that reports what it is: connected, authenticated, and refused
  by a gate no client can pass.

## Not established

- **The SSE frame format.** Two routes were tried and both came back empty, which is worth stating
  precisely rather than as "not captured":
  - `Network.getResponseBody` on the finished request returns **0 characters** — Chrome does not buffer a
    streaming response the way it buffers a completed one;
  - `Network.dataReceived` carries **`dataLength` only, no `data`** in this build (Chrome 157 via
    Playwright 1.65), so the chunks cannot be reassembled from it.

  Reading the frames needs either `Fetch.enable` response interception or a page-level hook on `fetch`,
  and a page hook is a mutation of the app under observation — which this pass did not need, because the
  question it was asked (what gates a turn) is answered without it. So: the request shape above is
  measured, the response is `text/event-stream`, and **how the tokens are framed inside it is unknown**.
- Whether the UI's model picker sends anything else on `chats/new` when the model changes.
- Whether a session resident in a real browser is refused *sometimes* — this capture shows one turn
  succeed in the page and three replays refused, not a rate.

---

# Can a browser driver serve a turn? Measured: yes

The gate refuses every out-of-page request, so the remaining question was whether driving the page
works. It does, on the same signed-in session:

1. the composer is `textarea.message-input-textarea` ("Ask Qwen");
2. typing and pressing Enter sends the turn **from the page**, which mints its own `bx-ua` — no
   replay, no signature to forge;
3. the answer renders in the page and is readable from a stable node chain:

```
.chat-response-message-render-flow
  └ div
    └ .response-message-content.t2t        ← the assistant turn
      └ .custom-qwen-markdown
        └ .qwen-markdown
          └ p / span.qwen-markdown-text    ← the text nodes
```

A prompt sent this way was answered (`POC-1794595920689` came back as the page's own text), while the
same prompt replayed over HTTP was refused. That is the difference between impersonating the client and
using it.

Two things the page does on its own that a driver must tolerate rather than fight: an update modal
("Qwen4-Max is now in preview") that sits over the composer until dismissed, and a "Thinking completed"
step rendered before the answer — both seen in the captured text.

What a driver still needs, none of it proven yet: a persistent profile the operator signs into once,
detection of "the stream stopped" (the text stops changing, or the stop button disappears), and the
per-turn cost of a browser process — the same shape and the same cost as `chatgptWeb.ts`, which is the
template for it.
