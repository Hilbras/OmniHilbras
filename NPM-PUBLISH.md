# Publishing @hilbras/omnihilbras

The SDK is published to npm as **`@hilbras/omnihilbras`**. Do not confuse it
with `@hilbras/sdk`, which is a separate, unrelated project.

## Status

`@hilbras/omnihilbras@0.1.0` is published (GitHub tag `v0.1.0`).

## Publish a new version

1. Bump the version in `packages/omnihilbras-sdk/package.json`.
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
   cd packages/omnihilbras-sdk
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
