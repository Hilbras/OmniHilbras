#!/usr/bin/env bash
#
# Run the gateway and the dashboard together, in one terminal.
#
# ## Why this exists
#
# `pnpm dev` and `pnpm dev:gateway` are separate commands, and running them means two terminals and a
# mental note about which one is still up. The failure that produces is quiet: the dashboard loads,
# every provider card says "not connected", and nothing says the gateway is not listening — because a
# browser asking a closed port gets a connection error the page renders as an empty state.
#
# ## Why it is a shim
#
# The work is in `bin/omnihilbras.js`, which is also what `omnihilbras` runs after `npm link`. This
# script stays as the path that needs no install step, and it delegates so there is one implementation
# of "start both, wait until they answer, stop them together" rather than two that drift.
#
# The original bash version had the same shape and the same reasoning: the gateway starts first and the
# dashboard only after its port answers, so the first page load is one that can already reach it. What
# the node version adds is a command people can type, browser launch, a PID file so a second run
# reclaims its own ports, and a refusal — rather than an obscure bind failure — when a port belongs to
# something else.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$root/bin/omnihilbras.js" "$@"