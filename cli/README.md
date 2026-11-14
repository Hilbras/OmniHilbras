# @hilbras/omnihilbras

The OmniHilbras gateway client.

```bash
npm i -g @hilbras/omnihilbras
omnihilbras setup      # check this machine, install what is missing
omnihilbras status     # is the gateway up, and what is it reporting
omnihilbras providers  # every saved account, and which ones can serve
omnihilbras test <p>   # probe one account, or all of them
omnihilbras help       # the rest
```

It talks to a running gateway over HTTP — by default `127.0.0.1:20138`, or `--gateway <url>` /
`OMNIHILBRAS_GATEWAY_URL`. It does **not** start one: the desktop application and a source checkout both
do that, and this package is the client for either.

No dependencies. Every verb takes `--json` so a script never parses a table. Management routes need either
a public API key (`--api-key`, `OMNIHILBRAS_API_KEY`) or the local dashboard token the gateway writes on
start; neither is ever printed.

Full reference: <https://github.com/Hilbras/OmniHilbras/blob/main/docs/CLI.md>.
