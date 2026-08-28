# Contributing

## Requirements

Bun 1.4 or newer, and nothing else. payground has **zero runtime dependencies**; the only
`devDependencies` are TypeScript, the Bun types and what the React dashboard needs.

```sh
bun install
bun run typecheck
bun test packages tools
bun run test:e2e
```

## Architecture

Ports and adapters, in four layers that only ever point inwards.

```
packages/core         the domain: money, payments, the state machine, the port interfaces
packages/storage      the SQLite adapter that implements those ports
packages/mercadopago  the provider adapter: wire shapes, validation, routes, webhooks
packages/server       HTTP, authentication, idempotency, the control API, webhook delivery
packages/dashboard    the React UI, which talks only to the control API
packages/cli          the command line, which composes the above
```

- **`core` knows nothing about Mercado Pago.** It holds `Payment`, `PaymentStatus`,
  `PaymentCommand` and `apply()`, plus the ports (`Clock`, `IdGenerator`, `RandomSource`,
  the repositories). Status and reason travel together as one union, so an impossible pair
  cannot be constructed, and `TRANSITIONS` is the whole state machine as data: nothing
  transitions unless it is listed there.
- **The provider decides outcomes, the domain applies them.** `create()` takes a
  `PaymentDecision` it did not compute; the adapter derives that decision from the test
  cardholder table, the payment method and the injected faults. No provider logic leaks
  inwards.
- **Amounts are minor units.** `Minor` is a branded integer; decimals exist only on the
  wire, at the edges, through `fromDecimal`/`toDecimal`.
- **Failure is a value.** `Result<T, E>` everywhere in the domain and the adapters;
  exceptions are for programmer errors, not for a declined card.
- **Tenancy is structural.** `Storage.forSandbox(id)` is the only way to reach a
  repository, and a repository cannot express a cross-sandbox query.
- **The clock and randomness are injected.** Nothing in the domain reads `Date.now()` or
  `Math.random()`; tests drive `ManualClock`, `SeededIdGenerator` and `SeededRandom` from
  `@payground/core/testing.ts`.

### Imports

Relative imports carry the `.ts` extension; cross-package imports use the `@payground/*`
aliases declared in `tsconfig.json`. There is no build step for development — Bun runs the
TypeScript sources directly.

## The generated adapter

The wire layer is not hand-written. `packages/mercadopago/src/generated/` is produced from
the vendored upstream OpenAPI document and from scraped documentation tables:

| File            | Contents                                             |
| --------------- | ---------------------------------------------------- |
| `types.ts`      | Request and response shapes                          |
| `validate.ts`   | Validators that produce the real error envelopes     |
| `routes.ts`     | The route inventory of the upstream specification    |
| `tables.ts`     | Test cards, test cardholders, statuses and details   |

Do not edit those files: they are overwritten. Change the generator, or the overlay, and
regenerate.

### Regenerating

```sh
bun run spec:sync     # re-download the pinned upstream spec into spec/, refresh spec.lock.json
bun run spec:tables   # re-scrape the documentation tables into spec/tables/
bun run spec:gen      # emit packages/mercadopago/src/generated/* and FIDELITY.md
```

`spec:sync` fetches the commit pinned in `tools/spec-sync/src/pin.ts` and records a SHA-256
for every file, so a regeneration is reproducible and a silent upstream change is visible
in the diff. Bumping the pin is a deliberate commit of its own.

### The overlay, and FIDELITY.md

The upstream specification is incomplete and, in places, wrong: it omits
`point_of_interaction` (without which there is no Pix QR code), it under-specifies refund
statuses, and its Pix sample is not a valid EMV payload. `spec/overlay.ts` adds the
missing shapes back and records the behavioural divergences — each entry carries a note
and the source it came from.

`FIDELITY.md` is generated from that overlay by `spec:gen`. **Never edit it by hand.** It
exists so that adding a divergence without documenting it is impossible: the entry *is*
the mechanism, and the file is its rendering. If you make payground differ from the real
API on purpose, add a `DIVERGENCES` entry with a source, and regenerate.

## Tests

`bun:test`, colocated with the code (`foo.ts` next to `foo.test.ts`), except the dashboard,
which keeps its tests in `packages/dashboard/test/`.

- **Unit tests** cover the domain and each adapter in isolation, with the injected clock,
  ids and randomness, so no test is time- or order-dependent.
- **Storage tests** run against `Storage.open()` — an in-memory SQLite database with the
  real migrations applied. There is no mock repository: the adapter is cheap enough to use
  for real.
- **HTTP tests** start a real server on port `0` and speak to it with `fetch`, so routing,
  authentication and idempotency are exercised the way a client would.
- **Property and fuzz tests** (`*.fuzz.test.ts`) drive the state machine, the storage
  round-trip, the generated validators and the SSRF guard with seeded random input. A
  failing seed is reproducible; keep the seed in the test when you fix one.
- **End-to-end tests** (`bun run test:e2e`) run the *official* Mercado Pago Node SDK
  against payground, and decode the Pix QR code with a third-party decoder. They are the
  only tests allowed to depend on third-party packages, which is why `e2e` is its own
  workspace.
- **CLI tests** run each command against an in-memory database through an injected
  environment, and assert exit codes: `0` success, `1` failure, `2` bad usage.

New behaviour needs a test that fails without it. New divergence from the real API needs a
`FIDELITY.md` entry, which means an overlay or divergence entry with a source.

## Building and releasing

```sh
bun run build           # dist/payground.js (bundled CLI) + dist/dashboard (assets)
bun run build:cli
bun run build:dashboard
```

The published package ships `dist/` only: `payground start` finds the dashboard assets
next to the bundled CLI, so no build ever runs at install time or at runtime. The
Tailwind plugin is marked external in the bundle for that reason — `payground
build-dashboard` therefore only works from a checkout with the dev dependencies installed.

`Dockerfile` repeats the same two steps in a build stage and copies `dist/` into a slim
runtime image that runs as the non-root `bun` user.

## Style

- TypeScript at maximum strictness (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, …). `bun run typecheck` must pass.
- Make invalid states unrepresentable rather than validating them later.
- Comments explain *why*, and are worth writing when the reason is a quirk of the real
  API — with the link. Do not narrate the code.
- English everywhere: code, comments, commit messages.
