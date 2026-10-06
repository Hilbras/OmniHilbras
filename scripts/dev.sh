#!/usr/bin/env bash
#
# Run the gateway and the dashboard together, and stop both when either exits.
#
# ## Why this exists
#
# `pnpm dev` and `pnpm dev:gateway` are separate commands, and running them means two terminals and a
# mental note about which one is still up. The failure that produces is quiet: the dashboard loads,
# every provider card says "not connected", and nothing says the gateway is not listening — because a
# browser asking a closed port gets a connection error the page renders as an empty state.
#
# The gateway is started first, and the dashboard only after its port answers, so the first page load
# is one that can already reach it.
#
# ## What it does not do
#
# It does not install dependencies, run migrations, or seed a connection. A script that "just runs
# everything" is a script whose failures are attributed to the wrong thing.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# The gateway's own defaults, and the port `vite.config.ts` proxies from. Overridable, because a
# machine already using :8787 or :5173 should not have to edit this file.
gateway_host="${OMNIHILBRAS_HOST:-127.0.0.1}"
gateway_port="${OMNIHILBRAS_PORT:-8787}"
dashboard_port="${DASHBOARD_PORT:-5173}"

pids=()
cleanup() {
  # `kill` on an already-dead pid is not an error worth printing, so the loop is guarded and the
  # wait is what reaps them. Anything still running after the TERM gets a second chance to exit
  # rather than leaving a port bound.
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "${pids[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

echo "==> building the SDK and starting the gateway on ${gateway_host}:${gateway_port}"
pnpm dev:gateway &
pids+=("$!")

# Wait for the port rather than sleeping a fixed interval: a fixed sleep is either too short on a
# cold build or wasted time on a warm one, and the dashboard's proxy needs the gateway to be up
# before the first request is made.
printf '==> waiting for the gateway'
for _ in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/${gateway_host}/${gateway_port}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    echo " — up"
    break
  fi
  printf '.'
  sleep 0.5
done
if ! (exec 3<>"/dev/tcp/${gateway_host}/${gateway_port}") 2>/dev/null; then
  echo
  echo "the gateway did not answer on ${gateway_host}:${gateway_port} after 60 s; check the output above" >&2
  exit 1
fi

echo "==> starting the dashboard on http://localhost:${dashboard_port}"
pnpm dev &
pids+=("$!")

# `wait -n` returns when the *first* child exits, which is what routes an exit through `cleanup`
# instead of leaving the other server running behind a prompt that never comes back.
wait -n