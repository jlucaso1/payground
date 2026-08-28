# payground

A stateful, self-hosted sandbox that speaks the Mercado Pago API.

The official sandbox cannot force a Pix to be approved, cannot produce a specific error
on demand, and needs a public URL to deliver webhooks. payground runs locally and
behaves like the real service, **with state**: a payment you create exists, can be
queried, transitions between statuses, expires, is refunded, and emits signed webhooks.

It is not a webhook firing tool. A webhook only exists here because a resource actually
changed state.

> Not affiliated with, endorsed by, or connected to Mercado Pago. "Mercado Pago" is used
> only descriptively, to say which API this sandbox is compatible with.
> **Never send real card data to payground.**

## Status

Under construction. See `FIDELITY.md` for known divergences from the real API.

## Requirements

Bun 1.4 or newer. No runtime dependencies.

## Usage

```sh
bun install
bun run start          # http://127.0.0.1:8080
curl http://127.0.0.1:8080/_payground/health
```

The emulated Mercado Pago surface is served under its real paths (`/v1/payments`, …).
payground's own control API lives under `/_payground/` and is never mixed with it.

## Development

```sh
bun run typecheck
bun test packages tools
bun run test:e2e       # runs the official Mercado Pago SDK against the emulator
```

## License

MIT
