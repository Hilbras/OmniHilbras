# Migrating to 4.2.0

4.2 makes the gateway defensible when it is exposed to agents and adds trace export. Both are opt-in;
a gateway with no policy, no collector and no plugin tool policy behaves exactly as it did in 4.1.

## Guardrails

`GET /v1/guardrails` reads the policy; `PUT` replaces it. Rules are data:

```json
{
  "enabled": true,
  "dryRun": true,
  "rules": [
    { "id": "no-secrets", "action": "redact", "patterns": ["secret", "email"] },
    { "id": "no-project-x", "action": "block", "text": "project-x" },
    { "id": "budget-shape", "action": "limit", "maxMessages": 200, "maxTools": 64 }
  ]
}
```

Start with `dryRun: true`, read the `x-omnihilbras-guardrail` header and the rule ids, then turn
`dryRun` off. A `block` refuses with `422 GUARDRAIL_BLOCKED`; a `flag` or `injection` never refuses.
Request rules run before dispatch; response rules scan a non-streaming answer. **A streaming answer
cannot be recalled** — bytes already sent are not unsent.

## Trace export

Set `OMNIHILBRAS_OTEL_ENDPOINT` to an OTLP/HTTP JSON receiver. Prompts are excluded; only model,
provider, token counts, latency, outcome, key id and workspace id are exported. The exporter is
bounded and fails open.

## MCP plugin tools

A plugin entry in `mcp-plugins.json` may declare `tools.allow` and `tools.ask`. An allow list also
filters `tools/list`; a tool in `ask` needs a one-shot token from
`POST /v1/mcp/plugins/approvals/:id`, presented as `x-omnihilbras-approval`. The token is bound to one
plugin, valid for five minutes, and consumed by the next call.

## Limits

- The policy is global; per-key scoping of rules is not exposed yet (a rule may carry `keys`, which
  the engine honours when a key id is known).
- Streaming response scanning reports; it does not stop a stream.
- Injection detection is a phrase heuristic, not a classifier.
