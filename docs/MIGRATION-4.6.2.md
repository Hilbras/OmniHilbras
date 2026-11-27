# Migrating to 4.6.2

A second launcher fix, found by testing the published 4.6.1 tarball rather than the source.

## What 4.6.1 missed

4.6.1 made startup work when a previous run was recorded, but two related defects remained:

- **Shutdown referenced undeclared names.** `shutdown()` called `waitGone` and `alive`; the module imports
  `waitPidGone` and `isPidAlive`. Ctrl-C or a cascade after `stop` printed
  `ReferenceError: waitGone is not defined` and exited with a stack trace.
- **The record never named the supervisor.** `stopBundledServers` stops a recorded supervisor first, but
  the launcher never wrote `supervisorPid`, so `omnihilbras stop` killed only the children — and the
  supervisor, still alive, read that as a crash and restarted them.

## The fix

`shutdown` uses the imported helpers; the record carries `supervisorPid: process.pid`; and
`scripts/smoke-cli-server.mjs` now requires the launcher to exit **0**, print `Stopped.`, and contain no
`ReferenceError`/`is not defined` before the smoke passes. It also asserts `stop` cleared the record and
the servers stay down.

## What to do

`npm install -g @hilbras/omnihilbras@4.6.2`. A stale record from 4.6.0/4.6.1 is handled as in 4.6.1:
verified pids are stopped, foreign pids are left alone and reported.
