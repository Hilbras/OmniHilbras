# Publishing `@hilbras/omnihilbras`

This is the process for the **one** publishable manifest in this repository: `cli/`. Everything else —
`Kernel/API`, every package under `Kernel/SDK/` — is `private: true` and is not published.

## What the published package is, and is not

It is the gateway **client**: the verbs in [`docs/CLI.md`](./docs/CLI.md) — `status`, `providers`, `models`,
`test`, `keys`, `routing`, `logs`, `setup`, `doctor`.

Since `3.73.0` it also **starts the servers**. `npm pack` runs `prepack`, which stages `cli/server/` with
an esbuild-bundled gateway, the built dashboard and the locales; bare `omnihilbras` then starts both halves
on `127.0.0.1:20138` and `localhost:20137`, clears an occupied port when its holder looks like this
project's runtime, and shows a small menu. The desktop app remains the other way to run the server.

That history is not a footnote. The name previously held a different program — `2.9.x`, "OmniHilbras CLI
- Start and manage OmniHilbras server" — whose `omnihilbras` *did* start a server. Between `3.0.0` and
`3.72.0` the package was verbs only, and publishing over `latest` changed what the name did for anyone on
those versions; they are deprecated with a message saying so, and `docs/INSTALL.md` leads with it. From
`3.73.0` the bare command starts a server again, but the vault format, ports and verbs are this project's.

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

## A missed publish is recorded, not repaired with old code

If a tag reaches npm late — or never — after a later version has shipped, do **not** publish the old
tag's code to close the bookkeeping gap. npm publishes forward, so that would put superseded code on
the registry under a version people may still install. Record it in `knownGaps` in
`scripts/audit-release-trail.mjs` with a why-sentence and a pinned count in
`tests/release-trail.test.js`, as was done for `3.70.0` (superseded by `3.71.0`) and for `3.96.0`
(superseded by `3.97.0`; the cycle-5 audit found `npm view @hilbras/omnihilbras@3.96.0 version`
returned E404 while `3.97.0` resolved). A gap that is still current — a tag whose code is what users
should get — is a publish, not an exemption. `pnpm release:audit` distinguishes the two: a recorded
gap is a line of context, a new one fails the command.

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
