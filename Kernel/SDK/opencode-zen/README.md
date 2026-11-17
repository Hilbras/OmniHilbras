# opencode-zen

Standalone provider for **OpenCode Zen** (`https://opencode.ai/zen`), pay-as-you-go.

Build with `pnpm build` from this folder.

Split from a single `zen` package that also served OpenCode Go: two lanes with different bases, different
entitlements and different header contracts are two providers, not one class with a flag.
