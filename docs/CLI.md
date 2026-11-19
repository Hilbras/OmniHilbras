# The CLI

`omnihilbras` starts the gateway and the dashboard with no verb, and with a verb it **asks a running
gateway something**. Since `3.73.0` the published npm package contains the server, so both halves work
after only `npm i -g @hilbras/omnihilbras`:

```bash
omnihilbras                 # bundled gateway :20138, dashboard :20137, opens the dashboard
omnihilbras --no-browser    # same, without opening a browser
omnihilbras status          # ask the running gateway something
```

There are three entry points with one verb set:

- **The published CLI** (`cli/bin/omnihilbras.js`) starts the bundled `cli/server/main.mjs` on a bare
  invocation, or runs a verb itself.
- **The bundled launcher** (`cli/server/main.mjs`, staged at pack time) spawns the esbuild-bundled
  gateway and the static dashboard server, clears an occupied port when its holder is Node/Vite/pnpm,
  and shows an **arrow-key menu** (Open dashboard / Restart / Exit) under a live status header read from
  the gateway's `/health`. The menu and header are dependency-free (`cli/lib/menu.mjs`); off a terminal it
  falls back to a numbered prompt. With **`--background`** (alias `--detach`, `-b`) it starts the servers
  detached and exits, leaving them running to be controlled with `omnihilbras ps|stop`; their output goes to
  `bundled-*.log` under the state directory. A server that crashes after startup is **restarted a bounded
  number of times** (`cli/lib/restart-policy.mjs`), and a crash loop is reported rather than spun forever.
- **The checkout launcher** (`bin/omnihilbras.js`, private root package) runs `pnpm dev` and
  `pnpm dev:gateway` instead; it is used when the bundle is not staged and a checkout is registered.

The rest of this document is the verb set, which all three share.

```bash
omnihilbras status              # is it up, what is it, what is wrong with it
omnihilbras providers zcode     # the accounts of a provider, and which are usable
omnihilbras test zcode          # probe every account of that provider
omnihilbras routing --problems  # who is ejected, who is waiting
omnihilbras keys                # the gateway's API keys
omnihilbras logs                # follow finished requests
```

Run `omnihilbras help` for the same list with the flags each verb takes.

Installation, the tools each entry point needs, and removing every version of this project:
[`docs/INSTALL.md`](./INSTALL.md).

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
| `setup [--yes]` | First-run check with a menu: what is missing, install it (showing the command first), install the `omnihilbras` command itself, see the full report, deal with another version on this machine, or start the servers. `--yes` does the fixes without a terminal, which is also how the shortcut gets installed from a script. |
| `doctor [--installs]` | The same checks as a report, and **changes nothing** — safe in a script or on someone else's machine. Exits `1` if something blocking was found. |
| `status [--strict]` | Gateway identity and version, how many providers report healthy, and the ones that do not. `--strict` exits `1` if any provider is unhealthy. |
| `ps` | The **bundled run** this command started: its pids, ports, uptime, and whether each process is still alive and still *ours*, plus the gateway's health when it answers. Distinct from `status`, which asks a gateway what it is. |
| `open` | Opens the running bundled dashboard in a browser, at the port it actually listens on (from the run record, never a guess). Says so when nothing is running rather than opening a dead URL. |
| `stop [--force]` | Stops the bundled gateway and dashboard. Each pid is **verified to be ours before it is signalled** — a reused or foreign pid is reported and left alone unless `--force`. The counterpart to the launcher's Ctrl-C, for a run started in another terminal. |
| `restart [--force]` | `stop`, then start the bundled launcher again. Refuses rather than killing a foreign pid and starting a second copy. |
| `providers [provider] [--all]` | Every saved **account** — which is what routing actually chooses between — with its enabled state, priority, model count, credential kind, and live routing state (ejected, waiting, last error). |
| `models [--provider <id>] [--limit <n>]` | The model ids the gateway serves, grouped by provider prefix. These are the ids a client pastes into its config, e.g. `zc/glm-5.3-flash`. |
| `test <provider or account> [--all]` | Probes accounts with `POST /v1/connections/:id/probe` — the same call the dashboard's Test button makes — so the two cannot disagree. A provider with several accounts tests **all** of them and exits `0` if any answered. |
| `keys [--mint <name>]` | Lists key metadata (id, name, prefix, state). `--mint` creates one and prints its secret **once**, because the gateway cannot return it again. |
| `routing [--problems]` | Live routing state: failures, ejection, rate-limit waits, measured latency, and each provider's strategy. `--problems` narrows to the ones with something to report. |
| `logs [--limit <n>]` | Follows `/v1/logs/stream`: one line per finished request. It carries time, model, provider, connection, outcome, attempt count and request id — **never prompt content or a credential**, which is what makes it safe to pipe. |

`ps`, `open`, `stop` and `restart` are **local process control**, not gateway calls: they read the run record
the launcher writes to `$XDG_STATE_HOME/omnihilbras/bundled.json` and act on exactly the processes it started.
The record path and the "is this pid still ours?" check live in one module, `cli/lib/bundled-state.mjs`, shared
by the launcher and these verbs so the two cannot drift apart. A pid is never signalled on the strength of the
record alone — it is verified against its command line first, because a pid can be reused.

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
cli/lib/bundled-state.mjs the run record + ownership check, shared with the launcher (ps/open/stop/restart)
cli/commands/*.mjs        one file per verb
```

### Adding a verb

Write `cli/commands/<name>.mjs` exporting `{ name, summary, usage, flags, run }`, add it to the table in
`cli/index.mjs`, and add a case to `tests/cli.test.js` that drives the built command against a fake
gateway. A verb's `flags` list is what stops an unknown flag being silently ignored — a dropped
`--strict` is a check that never ran, which is worse than one that is missing.
