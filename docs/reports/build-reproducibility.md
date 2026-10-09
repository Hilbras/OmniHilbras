# Build reproducibility

Phase 2.2 evidence. Measured on a fresh `git clone` of commit `1149759`, outside the working tree.

| Step | Command | Result |
| --- | --- | --- |
| Install from the lockfile | `pnpm install --frozen-lockfile` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Pins

- **pnpm**: `12.5.1`, set in `package.json` (`packageManager`) and in CI (`pnpm/action-setup`). Consistent.
- **Node**: `24` in CI. The root declares `engines.node: ">=24"`. Consistent for the root.
- **Lockfile**: `pnpm-lock.yaml`, `lockfileVersion: '9.0'`. CI installs with `--frozen-lockfile`, so a drifted lockfile fails the build.

## Gaps

- **No `.nvmrc` or `.node-version`.** A local checkout does not select Node 24 by itself. A contributor on Node 22
  can build and get different results from CI without any warning. Adding `.nvmrc` with `24` closes this.
- **Declared floors differ by package.** The root needs Node 24. The SDK declares `>=20` and was tested on 20.20.2,
  18, 22, 24 and 26 (see `sdk-package-validation.md`). The two are not in conflict, but they are not the same claim.
- **Tool versions outside the lockfile are not checked.** The verify job trusts whatever `node` and `pnpm` the runner
  provides, within the pins above.
