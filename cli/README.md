# @hilbras/omnihilbras

**The OmniHilbras gateway client.** One part of
[a larger project](https://github.com/Hilbras/OmniHilbras) — see what this package is *not*, below.

```bash
npm i -g @hilbras/omnihilbras
omnihilbras status          # is a gateway running, and what does it say
omnihilbras providers       # every saved account, and which ones can serve
omnihilbras test zcode      # probe one account, or all of them
omnihilbras help            # the rest
```

## What this is, and what it is not

This package is the **client**: the verbs below, over HTTP, against a gateway on your machine. It has **no
dependencies** and does not download a runtime.

It **cannot start a server**, and that is not an oversight: a globally installed package has no checkout to
run. `omnihilbras` with no verb prints the help.

| You want | Get it from |
| --- | --- |
| The gateway, dashboard, desktop app, providers, routing | [The project](https://github.com/Hilbras/OmniHilbras) — [releases and installers](https://github.com/Hilbras/OmniHilbras/releases/latest) |
| A command that also **starts** the servers | A checkout: `npm link`, then `omnihilbras setup` |
| Just the verbs, against a gateway you already run | This package |

## Verbs

| Verb | What it answers |
| --- | --- |
| `setup` | First run: what is missing on this machine, install it (printing each command before running it), install the `omnihilbras` command, start the servers |
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
