# Migrating to 4.4.0

4.4 adds two local quality tools: a versioned prompt registry and an eval runner. Neither changes an
existing request.

## Prompt registry

`POST /v1/prompts` creates a prompt; another `POST` with the same `id` appends a version. Activate an
older one with `POST /v1/prompts/:id/activate`; render with `POST /v1/prompts/:id/render` and a
`values` object. A missing variable is a refusal, not a `{{name}}` sent to a model. Prompts live in
`prompts.json` (or the `prompts` document in SQLite) and are content, not credentials.

## Eval runner

```bash
pnpm eval -- --cases Kernel/Eval/cases/smoke.json --model <model-id> --out report.json
```

It calls the gateway at `OMNIHILBRAS_GATEWAY_URL` (default `http://127.0.0.1:20138`) with
`OMNIHILBRAS_API_KEY` when required. **This makes real provider requests and costs money.** Scoring
is exact, contains, regex, JSON subset or numeric tolerance; no model judges another model. Cases
live under `Kernel/Eval/cases/`, and `pnpm test:eval` is part of `pnpm test` (it scores fixtures, no
network).

## Limits

- Batch items still run on the gateway; provider-native batch APIs are a later change.
- The eval runner does not retry a failed case, by design: a retry changes what is being measured.
