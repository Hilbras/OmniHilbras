# Migrating to 4.8.0

4.8 makes **provider connections faster**. Nothing existing changes: same routes, same adapters, same
errors, same credentials. The change is the socket underneath them.

## What was slow

Node's global `fetch` keeps an idle connection for **four seconds**. A provider conversation is a turn,
a tool call, then the next turn — often more than four seconds apart — so nearly every turn paid a fresh
TCP and TLS handshake. Measured on 2026-11-27 against a local TLS listener: four requests spaced 5.5 s
apart opened **four** connections through global `fetch` and **one** through a keep-alive agent. A
handshake that costs 10 ms on loopback costs 100–300 ms across an ocean.

There was a second lookup too. The destination check resolved and cached the provider hostname, then the
connection resolved it again — on a network whose resolver can stall for seconds on one name.

## What changed

Every gateway provider request now goes through `Kernel/API/src/core/provider-http.ts`:

- **One agent per protocol, shared by every adapter and every transport.** A chat turn and the health
  sweep for the same provider reuse the same socket.
- **A 90-second idle window.** Free sockets are destroyed after it, and the window is refreshed when a
  socket is returned, so an agent loop that pauses does not hand the handshake back and the pool does
  not grow without bound.
- **The destination check's judged address is dialled.** The check caches the addresses with its
  verdict and the connector's `lookup` reads them, so there is no second resolve. This also narrows the
  DNS-rebinding gap the check used to document: the connection cannot be answered differently from the
  check.
- **Compression is decoded in the pool** (gzip, deflate, brotli) and its headers stripped, because
  raw `http` does not decompress while `fetch` did. Adapters see the same bytes as before.
- **TLS sessions are cached** across new connections by Node's `https.Agent`.

## What you can observe

`GET /metrics` adds three process-lifetime counters:

```
omnihilbras_provider_http_requests_total
omnihilbras_provider_http_connections_total
omnihilbras_provider_http_reused_total
```

`reused / requests` is the fraction of provider calls that paid no handshake. It should rise with
normal traffic; a flat zero means the network or a proxy is closing keep-alive connections.

## If your network rejects keep-alive

```bash
OMNIHILBRAS_PROVIDER_POOL=off pnpm dev:gateway
```

restores the previous global-`fetch` behavior for that process. `OMNIHILBRAS_PROVIDER_KEEPALIVE_MS`
changes the idle window (default `90000`). `OMNIHILBRAS_DNS_CACHE_TTL_MS` still controls the destination
cache, and setting it to `0` also makes the connector resolve for itself.

## What did not change

- Requests still cost money; this release makes fewer of them gratuitous, not free.
- Timeouts, byte limits, stream idle and total deadlines are unchanged.
- The SDK's own default transport stays `fetch`-based, because the SDK is also bundled into a browser.
- Web-session drivers, OAuth token endpoints and the OpenCode local service keep the client they had.
