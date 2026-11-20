# @hilbras/omnihilbras

**The OmniHilbras command: gateway, dashboard and client in one install.** One part of
[a larger project](https://github.com/Hilbras/OmniHilbras).

```bash
npm i -g @hilbras/omnihilbras
omnihilbras                 # starts the gateway and dashboard, opens the dashboard
omnihilbras status          # or ask a running gateway something
omnihilbras providers       # every saved account, and which ones can serve
omnihilbras test zcode      # probe one account, or all of them
omnihilbras help            # the rest
```

## What is installed

Bare `omnihilbras` is a launcher. It starts two processes that ship in the package:

- `server/gateway.mjs` — the gateway, bundled from the workspace by esbuild;
- `server/static.mjs` — a small static server for the built dashboard, which points at the gateway.

It waits for both ports, prints a summary, opens `http://localhost:20137/dashboard`, then shows a framed
terminal panel: a live status header (dashboard, gateway, health, uptime), grouped shortcuts to the dashboard,
providers, models, usage and logs, and a restart/exit section. `↑↓` or `j/k` move the highlight, `1`–`9` jump
to a row, `Enter` selects, `Esc` stops both. The header asks `/health` on every redraw, so a gateway that did
not answer reads as unknown rather than healthy. `Ctrl-C` stops both. If a port is already held by
a Node/Vite/pnpm process it is stopped first; a different program is left alone unless you pass
`--force`.

The **verbs** below are the other half: they call the gateway's routes, so a change to a route breaks
the CLI and the dashboard in the same way. Check `omnihilbras status --json` to see the running gateway.

| You want | Get it from |
| --- | --- |
| The gateway, dashboard and CLI in one command | `npm i -g @hilbras/omnihilbras`, then `omnihilbras` |
| A packaged desktop app | [Releases and installers](https://github.com/Hilbras/OmniHilbras/releases/latest) |
| To run from source | [The project](https://github.com/Hilbras/OmniHilbras) |

## Verbs

| Verb | What it answers |
| --- | --- |
| `setup` | First run: what is missing on this machine, install it (printing each command before running it), install the `omnihilbras` command, and start the servers when this is a checkout (the published client has none to start) |
| `doctor` | The same checks as a report that **changes nothing** — safe in a script or on someone else's machine |
| `status` | Is the gateway up, what version, which providers are unhealthy (`--strict` exits `1`) |
| `providers` | Every saved account: enabled, priority, credential kind, models, ejection, last error |
| `models` | The served model ids, grouped by provider prefix |
| `test` | Probe one account, or every account of a provider |
| `keys` | Key metadata; `--mint` creates one and prints the secret once |
| `routing` | Live routing state: failures, ejection, waits, latency, strategy |
| `logs` | Follow finished requests — model, provider, account, outcome, attempts, error code |

Every verb takes **`--json`**, which prints the answer as data and nothing else, so a script never parses a
table. Exit codes mean something: `0` worked, `1` did not, `2` the command was wrong, `130` interrupted.

## Authentication

Point it at a gateway with `--gateway <url>` or `OMNIHILBRAS_GATEWAY_URL` (default `127.0.0.1:20138`).
Management routes accept either:

- a public API key — `--api-key <key>` or `OMNIHILBRAS_API_KEY`; or
- the local dashboard token the gateway writes on start, which is the default when you run it on the same
  machine.

Neither is ever printed, echoed in an error, or written anywhere.

## A note on the name

Versions **before `3.0.0`** under this name are a different program — the previous project, described by its
own manifest as *"OmniHilbras CLI - Start and manage OmniHilbras server"*, whose `omnihilbras` **did** start a
server. They are deprecated, because this package is the client and behaves differently on purpose.

## Links

- [The project](https://github.com/Hilbras/OmniHilbras) · [releases](https://github.com/Hilbras/OmniHilbras/releases/latest)
- [`docs/CLI.md`](https://github.com/Hilbras/OmniHilbras/blob/main/docs/CLI.md) — the full CLI reference
- [`docs/INSTALL.md`](https://github.com/Hilbras/OmniHilbras/blob/main/docs/INSTALL.md) — installing and uninstalling, including the command this package installs
- [`docs/SPEC-SDK.md`](https://github.com/Hilbras/OmniHilbras/blob/main/docs/SPEC-SDK.md) — the gateway's routes and contracts

MIT.
