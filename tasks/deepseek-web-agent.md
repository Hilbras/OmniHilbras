# DeepSeek Web: full agent support

Status: complete — released as `v3.8.0`.

## Objective

Turn the current DeepSeek Web adapter from text+reasoning into an agent-capable
provider:

- tool calls in both non-streaming and streaming turns
- image attachments through the DeepSeek web upload endpoint
- prompt compaction for long chats
- bounded chat-session reuse
- clear failure semantics when a tool round or image upload fails

The old study target is `/home/gin/work/omnihilbras imp/deepseek-openai-proxy`.
Its useful ideas are ported; its defects are not.

## Current state

`Kernel/SDK/deepseek-web/adapter/index.ts` supports:

- `userToken` → `accessToken` exchange
- PoW via the audited pure-JS solver
- 14 model modes
- SSE decoding, reasoning, usage and one-chunk streaming
- request-line validation and body-refusal detection

It does **not** support:

- `request.tools`: tools are ignored, so a coding agent never receives a
  `tool_calls` response
- image content parts: `ref_file_ids` is always `[]`
- prompt compaction: long histories are flattened without a bound
- session reuse: every turn creates a new chat session

## Design

### 1. Prompt builder and DSML tools

Add exported helpers:

- `normalizeDeepSeekDsml(text)`
- `parseDeepSeekDsml(text)` → `{ content, toolCalls } | null`
- `buildDeepSeekPrompt(messages, tools)` → string

The prompt tells the model the exact DSML shape when `tools.length > 0`:

```text
<||DSML|| calls>
<||DSML|| invoke name="tool_name">
<||DSML|| parameter name="arg">value</||DSML|| parameter>
</||DSML|| invoke>
</||DSML|| calls>
```

History serialisation:

- system messages become instructions
- assistant `toolCalls` are replayed as DSML invocations
- `tool` messages become `[TOOL RESULT for <name/id>]`
- image-only content contributes no text
- normal turns keep role labels

Parser rules:

- normalise fullwidth `｜` and arbitrary whitespace
- accept `calls`, `tool_calls`, and a bare `invoke`
- parse multiple invocations and multiple parameters
- `string="true"` forces a string; otherwise JSON-parse, then fall back to raw
- generate `call_<random>` ids, sequential indices
- return text before the first tool tag as `content`

### 2. Tool rounds

`chat`:

- parse the decoded answer
- if tool calls exist, set `message.toolCalls`, content before the call (or
  `null`), and `finishReason: 'tool_calls'`
- otherwise keep the normal answer

`streamChat`:

- with the existing one-chunk DeepSeek transport, emit one chunk carrying
  content, reasoning, `toolCalls`, the usage and `finishReason`
- never emit a tool call and then claim `stop`

Tool results are replayed into the next prompt, so an agent can complete a
multi-round loop.

### 3. Images

Accept `image_url` content parts:

- `data:image/(png|jpeg|webp|gif);base64,...`
- `https:` URLs only
- reject `http:`, localhost, private, link-local and metadata addresses
- cap each image at 8 MB and each request at 4 images
- set a 15-second fetch timeout

Upload:

```text
POST https://chat.deepseek.com/api/v0/file/upload_file
multipart/form-data, field `file`
```

Use the access token and the same browser fingerprint as the completion. Poll
`/api/v0/file/fetch_files?file_ids=...` briefly for readiness. Pass unique ids in
`ref_file_ids`.

The upload endpoint was checked against the live host: `/file/upload_file`
answers JSON `INVALID_TOKEN` without a credential; `/file/upload` answers an HTML
page. Use `upload_file`.

### 4. Prompt compaction

When the flattened history is over 60,000 characters:

- keep the tools instruction intact
- keep the most recent 12 messages intact
- truncate older tool results at 1,200 characters
- truncate older ordinary messages at 3,000 characters
- append explicit `...[truncated]...` markers

Never truncate the current user turn.

### 5. Session reuse

Cache `{ sessionId, at }` by a stable hash of the userToken, not by the raw
token:

- TTL 15 minutes
- maximum 100 entries
- evict expired entries before inserting
- delete the entry on any 401/403 from session or completion
- still send `parent_message_id: null`; history travels in the prompt

### 6. Errors

- image rejected/fetch failed → `INVALID_REQUEST`, naming the image problem
- upload HTTP 401/403 → `AUTHENTICATION_FAILED`
- upload 429 → `RATE_LIMITED`
- upload 5xx → `PROVIDER_UNAVAILABLE`
- tool parse with no answer and no calls → `PROVIDER_REQUEST_FAILED`
- never return a successful-looking answer for a failed tool/image operation

### 7. PoW

Keep the existing pure-JS `deepseek-pow.ts`. Do not vendor the study project's
opaque 26 KB WASM binary: it has no source, license, or build provenance. If a
future benchmark shows the pure-JS solver is too slow, add a source-backed
solver with tests.

## Files

- `Kernel/SDK/deepseek-web/adapter/index.ts`
- `Kernel/SDK/deepseek-web/lib/types.ts` only if a shared type is missing
- `Kernel/SDK/tests/deepseek-web.test.js`
- `Kernel/SDK/tests/deepseek-tools.test.js` — new parser/tool-round tests
- `Kernel/SDK/tests/deepseek-images.test.js` — new upload/security tests
- `docs/SPEC-SDK.md` — provider capabilities, tool and image behavior
- `README.md`, `tasks/plan.md`, release notes

## Tests

- DSML normalisation, multiple calls, parameter types, partial tags
- non-streaming tool call produces `finish_reason: tool_calls`
- streaming tool call carries `toolCalls` and the same finish reason
- tool result replay is visible in a second prompt
- data URI decode and size/MIME checks
- remote image allowlist rejects localhost/private/http
- upload response, file-id polling and `ref_file_ids`
- session reuse: two turns create one session
- auth failure clears both access token and session cache
- long-history compaction keeps the latest turn and adds markers
- no tool output when no tools were requested

## Verification and release

- `pnpm verify`
- browser check: a tool-enabled DeepSeek Web chat reaches a tool call
- Android APK builds at `3.8.0`
- commit, tag `v3.8.0`, push, create release, attach APK
- confirm GitHub Actions verify and desktop workflow succeed

Live DeepSeek turns are not part of CI. Tests use mocked HTTP and recorded frame
shapes; a real turn needs a signed-in DeepSeek account and is not claimed as
passing.

## Explicit non-goals

- Native DeepSeek function calling: the web endpoint has no such field; DSML is
  prompt-level and is labelled as such.
- Porting the opaque WASM PoW binary.
- Forwarding temperature/top_p/max_tokens: DeepSeek's web completion endpoint
  does not accept them in the current payload.
