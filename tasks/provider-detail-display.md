# Provider page display — 3.93.1

## What changed

- A model row now puts the catalog facts on a second line under the model id: input and output prices
  (labelled `/M` because the stored prices are per million tokens), context window, max output, tools,
  reasoning, status, vision/modality, and the display name when the provider publishes one. Facts the
  provider did not state are not invented; a row with no metadata says so. The monospace model id under the
  name is kept above the facts line — it is the copy people use for the API, not redundant decoration.
- The account card now caps its row list at five visible accounts and scrolls for the rest, matching the
  accounts panel's existing affordance. The header still counts all accounts, so a sixth one is not hidden
  from the total.

## Verification

`pnpm test`, `pnpm verify`, `tests/provider-detail-display.test.js`, and the provider-detail button sweep
in `tests/e2e/buttons.spec.ts`. No live provider calls.
