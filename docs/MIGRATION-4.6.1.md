# Migrating to 4.6.1

A launcher crash fix. No data migration.

## The defect

`omnihilbras` 4.6.0 crashed on startup with:

```
ReferenceError: currentRunId is not defined
    at clearPidFile (server/main.mjs:202)
```

`clearPidFile` called `clearBundledRecordIf(currentRunId)` with a name that was never declared. It was
reached only when a `bundled.json` from an earlier run existed and had to be cleared at startup, which
is why a clean install started and a machine with a previous run did not.

## The fix

The launcher now declares `currentRunId`, writes it into `bundled.json` as `runId`, and clears a
record only when the id matches — so a second launcher shutting down cannot delete a newer run's
record. A record written by an older launcher carries no `runId`; it is cleared unconditionally after
the ownership check has verified its pids, which is the only case where that is safe.

`scripts/smoke-cli-server.mjs` now seeds a pre-4.6.1 record before starting, so the startup path that
crashed is exercised on every verify rather than only on machines with history.

## What to do

`npm install -g @hilbras/omnihilbras@4.6.1`. If a stale record is left from a crashed 4.6.0 run,
`omnihilbras` will now stop its recorded pids (verified ours) and clear it. A record whose pids are
foreign is left alone and reported, as before.
