# Migrating to 4.7.0

4.7 adds **TokenRouter** as a first-class provider. Nothing existing changes.

## Connecting

Add **TokenRouter** in Providers and paste an API key from
[tokenrouter.com](https://www.tokenrouter.com/). The base is `https://api.tokenrouter.com/v1`, the auth
is a bearer key, and the Check button reads the provider's own `/v1/models` with the candidate key —
that endpoint answers `401` without one, so a green result is a real authenticated read, not a public
page.

## Model ids

TokenRouter's catalog keeps its vendor namespace (`anthropic/claude-sonnet-4.6`, `openai/gpt-5.4`,
`google/gemini-3.6-flash`, `deepseek/deepseek-v4-pro`, …). The provider prefix is **`tkr/`**, so:

```
tkr/anthropic/claude-sonnet-4.6
```

routes to TokenRouter and sends `anthropic/claude-sonnet-4.6` upstream. Writing `anthropic/...` alone
routes to the Anthropic card, which is a different account and a different bill.

## What the card claims

Only what was measured: the endpoint, the authenticated catalog, the bearer wire and forced tool calls
(scripted contract). No model count, latency, request total, last-used time or model list is claimed
before a connection reports one. Embeddings and image generation are enabled because the reference
registry lists both service kinds; if your plan does not include them, the provider's own error is what
the request reports.
