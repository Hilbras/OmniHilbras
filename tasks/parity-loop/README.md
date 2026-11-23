# 9router parity loop

A durable, stateful workflow that alternates whole-system comparison, provider-by-provider comparison,
implementation, verification and release until OmniHilbras is measurably at least as good as 9router.

## Files

- `tasks/parity-loop/state.json` — current cycle, current step, last reports, history. The only source of
  truth for where the loop is. Always read it before doing anything.
- `docs/reports/9router-parity-scorecard.md` — the 12 objective criteria and the stop condition.
- `docs/reports/parity-cycle-<N>-system.md` — step 1's full comparison + improvement plan.
- `docs/reports/parity-cycle-<N>-providers.md` — step 4's provider-by-provider comparison + plan.

## Six steps, repeated

1. **Full system comparison.** Read both trees at their current commits, including all prior parity
   reports. Produce `docs/reports/parity-cycle-<N>-system.md`: architecture, routing, providers, tools,
   streaming, credentials, security, UI, tests, release. End with a ranked, concrete improvement plan.
2. **Implement the plan.** Highest-impact item first. Keep boundaries: no plaintext credentials, no
   red-by-policy tests, no anti-bot spoofing copied from 9router.
3. **Verify and fix.** `pnpm verify`, full unit suite, relevant Playwright e2e, `pnpm app:smoke` when
   desktop code changes. Fix every failure before continuing.
4. **Provider comparison.** For every provider id in both trees, produce
   `docs/reports/parity-cycle-<N>-providers.md`: which exists in both, which only in one, and for each
   shared id the wire/credential/model/tool differences and what OH lacks. Rank the gaps.
5. **Test providers and fix.** Exercise each changed provider path with scripted transports; no live
   key is available. Fix failures, add guards, re-run step 3's gates.
6. **Ship and loop.** If behavior changed, run the full release ceremony (version bump by change size,
   commit, tag `v<version>`, push, GitHub release, npm publish from `cli/`, poll registry, release
   audit). Set `status: complete` and advance `cycle` in state, then go to step 1.

## Agents and internet

At most **one** subagent per cycle may use WebFetch/WebSearch/browser. It is the research agent for
steps 1 and 4; it must cite what it read. Every other subagent is local and read-only unless explicitly
assigned an implementation task. Never let two agents browse concurrently.

## Stop condition

After each cycle, re-score `docs/reports/9router-parity-scorecard.md` on evidence from both trees.
Stop only when **every** criterion is level 4 or 5 and OH is not behind 9router on any row. When that
is true, set `stopped: true` in state, write the final report, and pause the scheduled automation with
`CronPauseSelf`. If it is not true, advance the cycle and continue.

## Safety

Each cycle ships at most one release. Do not delete or overwrite existing reports. Do not commit
`.zcode/`. Never publish a version absent from GitHub or tag a commit not on main. If a cycle cannot
make progress or a gate stays red, keep the loop at that step with `status: blocked` and record why.
