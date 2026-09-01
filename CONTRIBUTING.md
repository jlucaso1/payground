# Contributing

## Setup

Bun 1.4 or newer. Nothing else is required.

```sh
bun install
```

Bun runs the TypeScript sources directly, so there is no build step for development.

## The dev loop

```sh
bun run typecheck       # tsc --noEmit, then tsc --noEmit -p packages/dashboard
bun run test            # bun test packages tools
bun run test:e2e        # bun test e2e
bun run build
```

`typecheck` runs twice on purpose. The dashboard needs `lib: DOM` and `jsx: react-jsx`, and
those settings must not leak into the server packages, so `packages/dashboard` has its own
`tsconfig.json` and its own pass.

`test:e2e` runs the official `mercadopago` npm SDK against a live emulator, which is why it
is a separate workspace with its own dependencies.

`build` writes `packages/cli/dist/payground.js` and `packages/cli/dist/dashboard/`. The
published package ships that `dist/` plus `preload.ts`, so nothing is compiled at install
time or at run time.

Three more scripts touch the vendored spec:

```sh
bun run spec:sync     # re-download the pinned upstream spec into spec/
bun run spec:gen      # emit generated/{types,validate,routes}.ts and FIDELITY.md
bun run spec:tables   # re-scrape the doc tables into spec/tables/ and generated/tables.ts
```

`spec:sync` and `spec:tables` reach the network. `spec:gen` does not.

## Architecture

Ports and adapters. Dependencies point inwards only.

```
packages/core         the domain: money, payments, the state machine, the port interfaces
packages/storage      the SQLite adapter that implements those ports
packages/mercadopago  the provider adapter: wire shapes, validation, route inventory
packages/server       HTTP, authentication, idempotency, the control API, webhook delivery
packages/dashboard    the React UI, which talks only to the control API
packages/cli          the command line, which composes the above
```

`core` knows nothing about Mercado Pago. It holds `Result<T, E>`, the injected `Clock`,
`IdGenerator` and `RandomSource` ports, the storage ports, and the payment state machine.
`TRANSITIONS` in `packages/core/src/payment/state.ts` is that machine as a data table:
if a transition is not listed there, it cannot happen. Amounts are `Minor`, a branded
integer; decimals exist only on the wire, through `fromDecimal` and `toDecimal`.

`packages/storage` is the SQLite adapter. `Storage.forSandbox(id)` is the only way to reach
a repository, so a cross-sandbox query cannot be written down.

`packages/mercadopago` is the provider adapter, with one service module per product under
`src/api/`. A service function takes a `ServiceContext` (the sandbox store, the clock, the
ids) plus the raw body, validates it, and returns a `Result`. It never touches HTTP.

`packages/server` composes everything. `src/routes/<product>.ts` is a route module and
`src/routes/index.ts` is the registry that lists them. The control API lives under
`/_payground` and never overlaps the emulated surface.

`packages/dashboard` is React, built by Bun's HTML bundler from `src/index.html`.

Relative imports carry the `.ts` extension. Cross-package imports use the `@payground/*`
aliases from `tsconfig.json`.

## The generated adapter

`spec/spec3.json` is the official Mercado Pago OpenAPI document, vendored from
`mercadopago/openapi` at the commit pinned in `tools/spec-sync/src/pin.ts`, with a sha256
per file in `spec/spec.lock.json`. `bun run spec:sync` re-downloads that commit and rewrites
the lock, so any upstream change shows up in the diff of both. `gen.test.ts` re-hashes the
vendored files against the lock, which catches a local edit to `spec/`. Bumping the pin in
`pin.ts` is a commit of its own.

`bun run spec:gen` reads `spec/spec3.json` and `spec/overlay.ts` and writes four files:

| File                                             | Contents                                   |
| ------------------------------------------------ | ------------------------------------------ |
| `packages/mercadopago/src/generated/types.ts`     | request and response shapes                |
| `packages/mercadopago/src/generated/validate.ts`  | validators that produce the real envelopes |
| `packages/mercadopago/src/generated/routes.ts`    | the 142 operations of the spec             |
| `FIDELITY.md`                                     | every known divergence, with its source    |

Never hand-edit those four. They are overwritten on every run. `generated/tables.ts` is
also generated, by `spec:tables` from the scraped tables in `spec/tables/`.

The spec is shallow in places. `Payment` declares 29 properties against roughly 80 on the
wire, and `point_of_interaction` is missing entirely, which is the whole Pix QR payload.
`spec/overlay.ts` holds that diff, and every entry carries a `note` and the `source` URL
its shape came from. Behaviour that is not schema-shaped goes in `DIVERGENCES` in the same
file. `FIDELITY.md` is the rendering of both, so adding a divergence without documenting it
is not possible.

CI runs `bun run spec:gen && git diff --exit-code`. Changing the generator or the overlay
without regenerating fails the build.

## Adding an operation

Every operation in the spec must be claimed by exactly one route module, either in
`operations` or in `pending` with a reason. `packages/server/src/routes.test.ts` asserts
this, so an operation cannot be forgotten quietly. All 142 are currently in `operations`.

1. Write the service function in `packages/mercadopago/src/api/<product>.ts`. Return a
   `Result`; take the clock and the ids from the `ServiceContext`. There is no random
   source at this layer: randomness lives in the server runtime.
2. In `packages/server/src/routes/<product>.ts`, add the `operationId` to `operations`
   (removing it from `pending` if it was there) and register the route in `routes()`.
   If the product is new, add its module to `packages/server/src/routes/index.ts`.
3. If the spec omits fields the real API returns, add them to `spec/overlay.ts` with a
   source and run `bun run spec:gen`.
4. Add tests. `bun test packages tools`.

## Tests

`bun:test`, colocated: `foo.test.ts` next to `foo.ts`. The dashboard is the exception and
keeps its tests in `packages/dashboard/test/`.

Property tests are named `*.fuzz.test.ts` and hold their seed in the file, as a literal
passed to `SeededRandom`. When a seed finds a bug, keep that seed.

For HTTP tests, use `startTestServer()` from `packages/server/src/testing.ts`. It binds
port 0, gives you `api()` and `control()` helpers, a `ManualClock` you control and manual
webhook draining.

Determinism is a hard rule:

- No `Date.now()` and no `Math.random()` in production code. Take a `Clock`, an
  `IdGenerator` or a `RandomSource`.
- Tests use `ManualClock`, `SeededIdGenerator` and `SeededRandom` from
  `@payground/core/testing.ts`.
- No sleeps. Advance the clock instead.

Storage tests run against `Storage.open()`, an in-memory database with the real migrations
applied. There is no mock repository.

New behaviour needs a test that fails without it.

## Style

- Zero runtime dependencies is a hard constraint. `dependencies` stays empty in every
  package manifest, including the workspace root. The only third-party packages are dev
  dependencies: TypeScript, the Bun types, React and Tailwind for the dashboard, and, in
  `e2e`, the Mercado Pago SDK plus the QR and Pix decoders the tests check its output with.
- TypeScript at maximum strictness: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`. `bun run typecheck` must pass.
- Make invalid states unrepresentable instead of validating them later. `PaymentStatus`
  carries the state and its reason as one union, so an impossible pair cannot be built.
- Errors are values. Return `Result`. Exceptions are for programmer bugs.
- Comment only where the reason is not obvious from the code. A comment about real API
  behaviour cites the URL it came from.
- English everywhere: code, comments, commit messages. One line per commit message.

## Reporting a fidelity bug

A fidelity bug is payground behaving differently from the real Mercado Pago API. A useful
report has four parts:

1. The request: method, path, headers that matter, and the body.
2. What payground returned: status code and body, verbatim.
3. What the real API returns for the same request.
4. The evidence: a link to the Mercado Pago documentation page, the relevant OpenAPI
   operation, the SDK source, or a redacted response you captured yourself.

Point 4 is the one that turns a report into a fix. Without a source, a change to match your
observation cannot be recorded in `FIDELITY.md`, and it will not be merged.
