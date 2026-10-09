# SDK package validation

Phase 2.3 and 2.4 evidence for `@hilbras/omnihilbras` 1.77.2. Each claim below was run here.

## Tarball contents

`npm pack` produces `hilbras-omnihilbras-1.77.2.tgz` (222 KB) containing `dist/` (112 files), `brand/` (4),
`README.md` and `package.json`. Nothing from `src/`, `test/`, or env files is included.

Source maps are present (56). Each map names `../src/*.ts` but embeds no `sourcesContent`, and `src/` is not
shipped, so the maps reveal no source. They point at files a consumer cannot open.

## Clean consumer

A new project with no monorepo around it installed the tarball and:

- imported 147 named exports, with `FetchHttpTransport`, `ProviderError`, `ProviderRegistry`, `InMemorySecretStore`,
  `isPrivateHostname` and `assertSafeProviderRequestUrl` all present;
- completed a real `FetchHttpTransport.request` round trip;
- type-checked a TypeScript consumer against the packed declarations, including the `checkDestination` option,
  with `tsc --module nodenext` (typescript 5, `skipLibCheck`).

## Node.js runtimes

The tarball declares `engines.node: ">=20"`. Tested here, with the smoke test above:

| Runtime | Result |
| --- | --- |
| 18.20.8 | loads, round trip passes (below the declared floor) |
| 22.23.3 | loads, round trip passes |
| 24.21.0 | loads, round trip passes |
| 26.10.0 | loads, round trip passes |
| 20.x | **not installed here; not tested** |

The declared floor (20) is not the version tested. The package runs on 18 as well, so the floor is looser than the
evidence. Node 20 must be installed and tested before the floor is either confirmed or changed. Changing
`engines` is a compatibility decision and is left to the maintainer.

## Notes on the earlier check

An export name used in a first pass, `LocalSecretStore`, does not exist. The SDK exports `InMemorySecretStore` and
the `SecretStore` interface. The mismatch was in the check, not the package.
