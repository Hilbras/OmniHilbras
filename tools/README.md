# tools

Throwaway probes and one-off investigations live here, not in `apps/` or `packages/`.

The reason is not tidiness. A probe that sits in the gateway's source tree stops being
distinguishable from production: it gets read, copied, and eventually trusted. `qwen_probe3.mjs`
was committed under `apps/gateway/` for exactly that long, and the architecture review found it
there rather than where it was written.

## Rules

- A probe goes here, and it does **not** get committed unless its finding is worth keeping.
- A finding worth keeping goes in `docs/SPEC-SDK.md`, with the measurement that produced it.
- Nothing in here is imported by `apps/` or `packages/`, and nothing in here is on the
  dependency graph of a release.

## Running one

Probes that drive a browser need Playwright, which is a gateway dependency:

```bash
node tools/<probe>.mjs
```

Most of them are deliberately written to print their own evidence rather than assert, because a
probe that fails loudly on a live site is a probe that has been pointed at the wrong thing.
