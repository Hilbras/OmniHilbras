# Migrating to 4.9.0

4.9 adds a **persistent gateway settings file**, and the first setting it carries is history trimming. Nothing
existing changes: a gateway with no file behaves exactly as before, and an exported environment variable still
wins over a value in the file.

## Why this exists

The connection work in 4.8.0 removed the handshake from every provider turn. The remaining slowness measured on
2026-11-27 was a different problem: one TokenRouter connection received **~850,000 input tokens per turn** and
took **12–56 s**, with provider cache reads at **0**, while an 8-token request through the same gateway answered
in **795 ms**. To the same host, DNS was 38–53 ms, TCP 46 ms and a new TLS handshake ~0.96 s; reused sockets
answered in 0.2–0.6 s. The socket was not the cost. The provider was prefilling an enormous prompt.

A client that sends that much context is usually an agent resending its whole conversation and tool output. The
gateway already had a trimmer for exactly this; it was reachable only through environment variables, which do
not survive the next launch. This release makes the setting durable.

## The file

`$XDG_CONFIG_HOME/omnihilbras/settings.json` (normally `~/.config/omnihilbras/settings.json`):

```json
{
  "historyTrim": {
    "maxInputTokens": 200000,
    "keepRecent": 8
  }
}
```

- `maxInputTokens` is an estimated-token threshold. Above it, whole old turns are replaced with retrieval
  markers; below it nothing is touched. It must be an integer from 1,000 to 10,000,000.
- `keepRecent` is optional; it is how many trailing messages stay verbatim and defaults to the gateway's own 8.
  It must be an integer from 0 to 200.
- System prompts, the first user ask, error-bearing tool results and the recent window are always kept.
- Replaced content keeps its role, `toolCallId` and tool-call structure, so tool pairing still validates.
- The original text behind a marker is retrievable through `GET /v1/token-saver/:id`.

Every gateway entry reads it at startup: the bundled CLI server, the desktop app (which forks the same
`main.js`), and a bare `node Kernel/API/dist/src/main.js`. A restart applies a change.

## Precedence and failure

- **An explicitly set environment variable wins, per key.** `OMNIHILBRAS_HISTORY_TRIM_TOKENS=50000 omnihilbras`
  overrides the file's threshold while still taking `keepRecent` from the file if only the threshold was set.
- A missing file contributes nothing.
- A file that is not valid JSON, or is not a JSON object, is printed on stderr and ignored; the gateway starts.
- An invalid value is named on stderr and dropped; a valid sibling key still applies.
- When the file contributes a trim threshold, startup prints the effective values to stderr, so a person can
  confirm what a running gateway loaded without opening the dashboard.

`/v1/settings` continues to report the effective configuration, so the dashboard's Settings page shows the
active `historyTrim` after a restart. No route changed.

## Choosing a threshold

The trade-off is context versus time: the provider still metered the tokens it was sent, and every token above
the threshold is a token the model can no longer see. `200000` is a starting point for a large-context model; a
coding agent that needs its recent tool output should keep `keepRecent` at 8 or higher. Lower values answer
sooner and forget more.

The gateway does not choose this for you. It is a policy about what the model is allowed to see, and a silent
default would be the kind of behavior change that is indistinguishable from a bug.
