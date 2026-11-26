# Migrating to 4.3.0

4.3 adds deferred work, signed notifications and a cache that is honest about where it applies. Every
addition is opt-in or off by default.

## Batches

`POST /v1/batches` with `{ "requests": [{ "custom_id": "a", "body": { "model": "...", "messages": [...] } }] }`
returns `202` and a durable record. Poll `GET /v1/batches/:id` or subscribe a webhook. Items run with
bounded concurrency through the ordinary routing, budget gate and usage accounting. A gateway
restarted mid-batch marks it `interrupted`; it does not claim success. Provider-native batch APIs
are not used yet.

## Webhooks

`POST /v1/webhooks` with `{ "url": "https://…", "events": ["batch.completed"] }` returns the signing
secret once. Every delivery carries `x-omnihilbras-event`, `x-omnihilbras-timestamp` and
`x-omnihilbras-signature` = `sha256=HMAC(secret, "<timestamp>.<body>")`. Retries back off; failed
deliveries are listed. Only `https` public destinations are called; `OMNIHILBRAS_WEBHOOK_ALLOW_LOCAL=1`
allows a local receiver explicitly.

## Rerank

`POST /v1/rerank` is served only by a connection whose adapter declares `rerank`. No provider in the
catalogue declares it today, so the route answers `501 NOT_SUPPORTED` instead of inventing scores.

## Cache

The exact cache stays a direct-service-call feature. **Client requests are never deduplicated** — an
invariant `load.test.js` pins — so no HTTP response is served from it. What changed is what the cache
can do for a direct caller: full-request keys (tools, tool format, seed, provider), configurable TTL
and size, optional persistence, and an opt-in local similarity layer:

- `OMNIHILBRAS_RESPONSE_CACHE_TTL_MS`, `_ENTRIES`, `_PERSIST=1`
- `OMNIHILBRAS_SEMANTIC_CACHE=1`, `_THRESHOLD` (default 0.92), `_TTL_MS`
- `DELETE /v1/cache` empties it.

The similarity layer uses a local hashed-token embedding: it catches near-duplicate phrasing, not
synonyms, and is off by default.
