# Probes and one-off investigations

Throwaway probes do not live in the repository. When one is needed, run it from a local untracked
directory outside `Kernel/`, `src/` and `desktop/`.

The reason is not tidiness. A probe that sits in the gateway's source tree stops being
distinguishable from production: it gets read, copied, and eventually trusted. `qwen_probe3.mjs`
was committed under `Kernel/API/` for exactly that long, and the architecture review found it
there rather than where it was written.

## Rules

- A probe stays untracked, and it is **not** committed unless its finding is worth keeping.
- A finding worth keeping goes in `docs/SPEC-SDK.md`, with the measurement that produced it.
- Nothing in a probe is imported by the gateway, the dashboard or the desktop app, and nothing about
  it is on the dependency graph of a release.

## Running one

Probes that drive a browser need Playwright, which is a gateway dependency:

```bash
node /tmp/<probe>.mjs
```

Most are deliberately written to print their own evidence rather than assert, because a probe that
fails loudly on a live site has been pointed at the wrong thing.

## Operator tools that are kept

Two scripts are kept because they are repeatable and never run in CI:

```bash
pnpm audit:catalogs                 # refresh every saved model catalog; metadata reads, no inference
pnpm benchmark:gateway --n 100      # local adapter only: gateway overhead floor, no provider bill
```

`audit:catalogs` needs a running gateway and prints `verified N, unverified M`; it refuses to call
chat, streaming or a credential probe. `benchmark:gateway` runs against a loopback adapter that
answers immediately, so its number is the gateway's own work — not a provider's network time.
