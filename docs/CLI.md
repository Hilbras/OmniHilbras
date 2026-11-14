# The CLI

`omnihilbras` is two things in one binary: with no verb it starts the gateway and the dashboard, and
with a verb it **asks a running gateway something**. This document is about the second half.

```bash
omnihilbras status              # is it up, what is it, what is wrong with it
omnihilbras providers zcode     # the accounts of a provider, and which are usable
omnihilbras test zcode          # probe every account of that provider
omnihilbras routing --problems  # who is ejected, who is waiting
omnihilbras keys                # the gateway's API keys
omnihilbras logs                # follow finished requests
```

Run `omnihilbras help` for the same list with the flags each verb takes.

## Why it exists next to the dashboard

The dashboard already shows all of this. The CLI exists for the two places a page cannot reach: a
**script** (a health check, a pre-flight before a test run) and an **agent** that needs to ask "which
account can serve this" without a browser. Both want the answer as data, which is why every verb takes
`--json`.

## Rules the verbs follow

- **A verb calls a route the gateway already serves.** Nothing reaches into the vault or the database, so
  a change to a route breaks the CLI and the dashboard in the same way rather than in two.
- **`--json` is the whole answer.** Nothing else is printed, no banner, no colour, so a script never
  parses a table. `logs --json` is one JSON object per line — a follower never finishes, so it cannot be
  one array.
- **Errors carry a next step.** A failure says what happened *and* what to do about it. "Cannot reach the
  gateway" is followed by the command that starts one.
- **Exit codes mean something:** `0` the command did what it said; `1` it did not work (a provider
  refused, a key is missing); `2` the command itself was wrong (unknown verb, unknown flag); `130`
  interrupted.
- **Nothing happens before the arguments are parsed.** Asking what a command does must not start
  anything — the reference implementation ran its runtime self-heal ahead of `--help`, so asking for help
  could install packages.
- **No dependencies.** Like the launcher, the CLI uses `node:` builtins only. Its dependency tree being
  empty is the point, not an aesthetic: it sits on the same trust footing as the launcher.

## Verbs

| Verb | What it does |
| --- | --- |
| `status [--strict]` | Gateway identity and version, how many providers report healthy, and the ones that do not. `--strict` exits `1` if any provider is unhealthy. |
| `providers [provider] [--all]` | Every saved **account** — which is what routing actually chooses between — with its enabled state, priority, model count, credential kind, and live routing state (ejected, waiting, last error). |
| `models [--provider <id>] [--limit <n>]` | The model ids the gateway serves, grouped by provider prefix. These are the ids a client pastes into its config, e.g. `zc/glm-5.3-flash`. |
| `test <provider or account> [--all]` | Probes accounts with `POST /v1/connections/:id/probe` — the same call the dashboard's Test button makes — so the two cannot disagree. A provider with several accounts tests **all** of them and exits `0` if any answered. |
| `keys [--mint <name>]` | Lists key metadata (id, name, prefix, state). `--mint` creates one and prints its secret **once**, because the gateway cannot return it again. |
| `routing [--problems]` | Live routing state: failures, ejection, rate-limit waits, measured latency, and each provider's strategy. `--problems` narrows to the ones with something to report. |
| `logs [--limit <n>]` | Follows `/v1/logs/stream`: one line per finished request. It carries time, model, provider, connection, outcome, attempt count and request id — **never prompt content or a credential**, which is what makes it safe to pipe. |

## Authentication

Management routes accept two kinds of caller, and the CLI uses whichever you have:

1. **A public API key** — `--api-key <key>` or `OMNIHILBRAS_API_KEY`. Preferred when present, because a
   caller who supplied a key meant it.
2. **The local dashboard token** — the per-launch token the gateway writes to
   `$XDG_CONFIG_HOME/omnihilbras/dashboard-token` (mode `0600`), presented with the local dashboard
   origin. This is the default for a local CLI, and it is the same trust the dashboard itself has: a
   process that can read that file can already read the vault.

Neither value is ever printed, echoed in an error, or written anywhere. Nothing about the CLI's output
contains key material; `keys` prints a prefix, and the one exception is a secret you just created, which
is shown once on purpose.

Point it elsewhere with `--gateway <url>` or `OMNIHILBRAS_GATEWAY_URL`. A remote gateway has no dashboard
token to find, so it needs an API key.

## Where the code lives

```
bin/omnihilbras.js        entry: dispatches a verb, or starts the servers
cli/index.mjs             argument parsing, the verb table, exit codes
cli/lib/config.mjs        where to talk, and what to talk with (the one place auth is decided)
cli/lib/client.mjs        one HTTP call, one error shape
cli/lib/output.mjs        colour, tables, and `--json`
cli/commands/*.mjs        one file per verb
```

### Adding a verb

Write `cli/commands/<name>.mjs` exporting `{ name, summary, usage, flags, run }`, add it to the table in
`cli/index.mjs`, and add a case to `tests/cli.test.js` that drives the built command against a fake
gateway. A verb's `flags` list is what stops an unknown flag being silently ignored — a dropped
`--strict` is a check that never ran, which is worse than one that is missing.
