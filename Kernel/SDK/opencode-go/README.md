# opencode-go

Standalone provider for **OpenCode Go**, the subscription lane at `https://opencode.ai/zen/go`.

Build with `pnpm build` from this folder.

Go is a sibling of `opencode-zen` and `opencode-console`, not a mode of either: it has its own base path, its own
usage endpoint, and its own required headers. It used to be one `ZenAdapter` instantiated with a different base,
which is why its requests went out without the CLI identity headers the lane requires — the upstream answered
"Request is missing x-opencode-session and cannot be routed efficiently". This package owns that contract.
