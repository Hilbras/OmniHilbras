# Publishing @hilbras/omnihilbras

The SDK is published to npm as **`@hilbras/omnihilbras`**. Do not confuse it
with `@hilbras/sdk`, which is a separate, unrelated project.

## Status

**Publishing is suspended.** The Kernel restructure dissolved the single SDK
manifest: the SDK is now one private package per provider under `Kernel/SDK/`,
each versioned `0.1.0`, and `Kernel/API` — the gateway — is private too. There
is no manifest to publish until a new publishing story is chosen, and until
then a release ends at the tag and the GitHub release. The npm registry may hold
later versions from a different tag lineage; this checkout has no publishable
manifest, so its own release trail ends at the tag. The steps below describe the
process before the restructure and are kept for when that story exists — their
paths name the tree as it was.

## Version bumps

Pick the bump by the size of the change: breaking → `x.0.0`, new capability →
`0.x.0`, fix or docs → `0.0.x`. Bump the version in `package.json`,
`Kernel/SDK/package.json`, and `Kernel/API/gateway/package.json`
together, then tag `v<version>` and publish.

## Publish a new version

1. Bump the version in `Kernel/SDK/package.json`.
2. Build and verify:

   ```bash
   pnpm install
   pnpm typecheck
   pnpm test
   pnpm build
   ```

3. Commit, tag, and push.
4. Publish:

   ```bash
   cd Kernel/SDK
   npm publish --access public
   ```

`prepublishOnly` rebuilds the SDK, so the tarball always matches source.

## Verify

```bash
npm view @hilbras/omnihilbras version
npm i @hilbras/omnihilbras
node -e "import('@hilbras/omnihilbras').then(m => console.log(Object.keys(m).length, 'exports'))"
```

A newly published version can take a few minutes to appear on the read path
even though `npm publish` already reported success; the registry search index
updates first.
