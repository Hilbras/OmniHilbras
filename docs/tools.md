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
