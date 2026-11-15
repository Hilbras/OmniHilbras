# Publishing `@hilbras/omnihilbras`

This is the process for the **one** publishable manifest in this repository: `cli/`. Everything else —
`Kernel/API`, every package under `Kernel/SDK/` — is `private: true` and is not published.

## What the published package is, and is not

It is the gateway **client**: the verbs in [`docs/CLI.md`](./docs/CLI.md) — `status`, `providers`, `models`,
`test`, `keys`, `routing`, `logs`, `setup`, `doctor`.

It **cannot start a server**. A globally installed package has no checkout to run, so `omnihilbras` with no
verb prints the help rather than launching anything. The server ships as the desktop app, and a command that
also starts the servers comes from `npm link` in a checkout plus `omnihilbras setup`.

That distinction is not a footnote. The name previously held a different program — `2.9.x`, "OmniHilbras CLI
- Start and manage OmniHilbras server" — whose `omnihilbras` *did* start a server. Publishing over `latest`
changed what the name does for anyone on those versions, so they are deprecated with a message saying so,
and `docs/INSTALL.md` leads with it.

## Publish a version

1. Bump the version, in every manifest the release touches:

   ```bash
   # package.json and Kernel/API/package.json, then the derived copies:
   pnpm version:fix     # rewrites cli/package.json, the README headline and the client-version constant
   pnpm version:check
   ```

   `scripts/check-version.mjs` includes `cli/package.json` for exactly this reason: a globally installed
   package reports its own manifest's version, so a mismatch would make `omnihilbras --version` contradict
   the release it came from.

2. Run the gate:

   ```bash
   pnpm verify          # version, typecheck, tests, build, bundle budget
   ```

3. Commit, tag, push, and create the release — `AGENTS.md` has the order, and the definition of done ends
   after the publish is *confirmed*, not after the tag.

4. Publish:

   ```bash
   cd cli
   npm publish --access public
   ```

   No `prepublishOnly` build: this package is plain ESM with **no dependencies**, so what is in the tree is
   what ships. (The old process built an SDK here; there is no build step left to get wrong.)

5. Confirm — this step is not a formality:

   ```bash
   npm view @hilbras/omnihilbras@<version> version   # poll until it echoes the version
   npm view @hilbras/omnihilbras dist-tags           # latest should point at it
   ```

   **`npm publish` reporting success is not evidence the version exists.** It has printed
   `+ @hilbras/omnihilbras@<version>` while the version was absent twice in this project's history; the
   tarball is staged and finalised minutes later, and a re-publish inside that window fails with
   `409 Cannot publish over previously staged version`. Measured for 3.50.0: **five `E404`s over ~75
   seconds** before the registry answered.

6. Install it the way a stranger would, which is the only check that exercises the published artefact
   rather than the working tree:

   ```bash
   npm i -g --prefix /tmp/regcheck @hilbras/omnihilbras
   /tmp/regcheck/bin/omnihilbras --version
   /tmp/regcheck/bin/omnihilbras help
   ```

   If the shortcut is missing or the version disagrees, the release is not done.

## Deprecating an old range

The previous project occupies `<3.0.0` and cannot be unpublished (npm refuses after 72 hours), so it is
deprecated instead:

```bash
npm deprecate "@hilbras/omnihilbras@<3.0.0" "Superseded by 3.x, which is a different thing. …"
```

The message must say what changed — that 3.x is the client and does not start a server — because a bare
"upgrade" tells the person nothing about why their working command would behave differently. To reverse it:

```bash
npm deprecate "@hilbras/omnihilbras@<3.0.0" ""
```
