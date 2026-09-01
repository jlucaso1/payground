# payground

A stateful, self-hosted sandbox that speaks the Mercado Pago API. Bun, zero runtime
dependencies, one SQLite file.

> **Not affiliated with, endorsed by, or connected to Mercado Pago.** "Mercado Pago" is
> used only descriptively, to say which API this sandbox is compatible with.
>
> **Never send real card data, real credentials or real personal data to payground.**
> It is a test double: it stores what you send in plain SQLite, it is not PCI compliant,
> and it must never sit in front of real money.

## Why not the official sandbox

The official test environment cannot force a Pix to be approved, cannot produce a specific
decline on demand, needs a public URL to deliver webhooks, and cannot be reset between
test runs. payground runs on your machine or in your CI and behaves like the real service,
**with state**: a payment you create exists, can be queried and searched, transitions
between statuses, expires, is refunded, is disputed, and emits signed webhooks.

It is not a webhook firing tool. A webhook only exists here because a resource actually
changed state.

Every known divergence from the real API is recorded in [FIDELITY.md](FIDELITY.md), which
is generated — it is impossible to add a divergence without writing its entry.

## Quick start

### bunx

```sh
bunx payground start
```

```
payground 0.1.0 listening on http://127.0.0.1:8080
  database        .payground/payground.sqlite
  sandbox         2f1c…  (default)
  access token    TEST-…
  public key      TEST-…
  webhook secret  …
  dashboard       http://127.0.0.1:8080/_payground
  health          http://127.0.0.1:8080/_payground/health
```

The access token printed at startup is the one your SDK must use. Add sample data with
`bunx payground seed`.

### Docker

```sh
docker compose up -d
curl http://127.0.0.1:8080/_payground/health
```

The image runs as a non-root user, keeps the database on a named volume at
`/data/payground.sqlite`, and declares a `HEALTHCHECK` against `/_payground/health`.
See [DEPLOY.md](DEPLOY.md) for reverse proxies, TLS, backups and the public multi-tenant
mode.

### From source

```sh
bun install
bun run build          # bundles the CLI into dist/ and the dashboard into dist/dashboard
bun run start          # http://127.0.0.1:8080
```

Requires Bun 1.4 or newer. There are no runtime dependencies.

## CLI

```
payground start   [--port <n>] [--host <addr>] [--db <path>] [--base-url <url>]
                  [--dashboard <dir>] [--no-bootstrap] [--block-private-webhooks]
                  [--strict]
payground seed    [--db <path>] [--sandbox <id>] [--payments <n>] [--seed <n>]
payground doctor  [--db <path>] [--sandbox <id>] [--format text|json]
payground reset   [--db <path>] [--sandbox <id>]
payground sandbox list | create --name <name> | show <id> | delete <id>
payground build-dashboard [--out <dir>]
payground --version | --help
```

`start`, `seed`, `doctor`, `reset` and `sandbox` read `PAYGROUND_DB`; `start` also reads
`PAYGROUND_PORT`, `PAYGROUND_HOST`, `PAYGROUND_BASE_URL` and `PAYGROUND_DASHBOARD`.

`seed` is deterministic: the same `--seed` and the same clock always produce the same
payments, spread over every state — approved, pending, expired, declined, in review,
authorized, refunded, partially refunded, disputed and charged back. Seeding twice with
the same seed is refused rather than silently duplicated; run `payground reset` first.

Exit codes: `0` success, `1` failure, `2` bad usage.

## Pointing an SDK at payground

payground serves the real Mercado Pago paths (`/v1/payments`, …), so the only thing an SDK
needs is a different base URL. How well each official SDK supports that varies a lot, and
this is where the honesty matters.

### Node — needs a preload, there is no supported override

The Node SDK hard-codes its base URL and does not export `AppConfig`, so there is no
public API for pointing it elsewhere. This repository ships `preload.ts`, which reaches
into `mercadopago/dist/utils/config`, asserts the shape it expects and fails loudly if the
SDK layout changes:

```sh
PAYGROUND_URL=http://127.0.0.1:8080 bun --preload payground/preload.ts test
```

```js
import { MercadoPagoConfig, Payment } from 'mercadopago';

const client = new MercadoPagoConfig({ accessToken: process.env.PAYGROUND_TOKEN });
const payment = await new Payment(client).create({
  body: {
    transaction_amount: 100.5,
    payment_method_id: 'pix',
    payer: { email: 'payer@example.com' },
  },
});
```

Pin the SDK version if you rely on this: it is a private path, and it can move. Two more
things the SDK does that payground reproduces faithfully rather than smoothing over: it
mints its own `X-Idempotency-Key` per call, and a `requestOptions.idempotencyKey` you pass
once is pinned onto the client, so every later create replays the first response.

### PHP — supported

`MercadoPagoConfig` exposes a public static base URL:

```php
MercadoPago\MercadoPagoConfig::$BASE_URL = 'http://127.0.0.1:8080';
MercadoPago\MercadoPagoConfig::setAccessToken($_ENV['PAYGROUND_TOKEN']);
```

### Go — supported, through the HTTP client

The Go SDK takes a custom `*http.Client` via `config.WithHTTPClient`, so a transport that
rewrites the host is enough:

```go
type rewrite struct{ base *url.URL }

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme, req.URL.Host = r.base.Scheme, r.base.Host
	return http.DefaultTransport.RoundTrip(req)
}

base, _ := url.Parse("http://127.0.0.1:8080")
cfg, _ := config.New(token, config.WithHTTPClient(&http.Client{Transport: rewrite{base}}))
```

### Python — no supported override

The Python SDK offers no base URL hook and no injectable transport. Either call payground
over plain HTTP (`requests`/`httpx` against `/v1/payments`), or patch the SDK's internal
request module in your test setup and accept that it can break on upgrade.

### Plain HTTP

```sh
curl -X POST http://127.0.0.1:8080/v1/payments \
  -H "Authorization: Bearer $PAYGROUND_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -d '{"transaction_amount":100.5,"payment_method_id":"pix","payer":{"email":"payer@example.com"}}'
```

## Supported endpoints

The emulated Mercado Pago surface is served under its real paths. Authentication is the
real one: `Authorization: Bearer <access token>`, or `access_token` / `public_key` as a
query parameter.

| Method     | Path                        | Notes                                    |
| ---------- | --------------------------- | ---------------------------------------- |
| `POST`     | `/v1/payments`              | `X-Idempotency-Key` required             |
| `GET`      | `/v1/payments/search`       | `status`, `external_reference`, `payer.email`, `payment_method_id`, paging |
| `GET`      | `/v1/payments/{id}`         | Expiry is applied on read                |
| `PUT`      | `/v1/payments/{id}`         | Cancel, and capture an authorized payment |
| `POST`     | `/v1/payments/{id}/refunds` | Total or partial                         |
| `GET`      | `/v1/payments/{id}/refunds` |                                          |
| `POST`     | `/v1/card_tokens`           | Accepts a public key                     |
| `GET`      | `/v1/card_tokens/{id}`      | Accepts a public key                     |
| `GET`      | `/v1/payment_methods`       | Accepts a public key                     |

Payment methods: `pix`, `bolbradesco`, `bolbradesco_pec`, `pec`, `account_money`, and the
card brands `visa`, `master`, `amex`, `elo`, `hipercard`, `debvisa`, `debmaster`,
`debelo`. Pix payments carry a real, spec-correct EMV BR Code payload and QR image.

The authoritative list is the route table in `packages/server/src/app.ts`.

## Test cardholders and test cards

Outcomes are driven by the cardholder name on the card token, exactly as in the real
sandbox. The full table is 18 codes, not the 8 usually quoted:

| Code | Scenario                              |
| ---- | ------------------------------------- |
| APRO | Approved payment                      |
| OTHE | Declined for general error            |
| CONT | Pending payment                       |
| CALL | Declined with validation to authorize |
| FUND | Declined for insufficient amount      |
| SECU | Declined for invalid security code    |
| EXPI | Declined due to due date issue        |
| FORM | Declined due to form error            |
| CARD | Rejected for missing card_number      |
| INST | Rejected for invalid installments     |
| DUPL | Rejected for duplicate payment        |
| LOCK | Rejected for disabled card            |
| CTNA | Rejected for non-permitted card type  |
| ATTE | Rejected due to exceeded PIN attempts |
| BLAC | Rejected for being on the blacklist   |
| UNSU | Not supported                         |
| TEST | Used to apply amount rules            |

The published test card numbers, which payground accepts:

| Type        | Brand            | Number              | CVV  | Expiry |
| ----------- | ---------------- | ------------------- | ---- | ------ |
| Credit card | Mastercard       | 5480 8328 0103 3311 | 123  | 11/30  |
| Credit card | Visa             | 4235 6477 2802 5682 | 123  | 11/30  |
| Credit card | American Express | 3753 651535 56885   | 1234 | 11/30  |
| Debit card  | Elo              | 5067 7667 8388 8311 | 123  | 11/30  |

Both tables are generated from the scraped documentation and live in
`packages/mercadopago/src/generated/tables.ts`. These are the only card numbers you should
ever send anywhere, and payground is no exception.

## Webhooks

Set `notification_url` on the payment. Every state change of that payment enqueues a
delivery, which the background runner sends and retries with exponential backoff (6
attempts, from 30 seconds up to the documented 15 minute cadence, with a 22 second
acknowledgement timeout). A delivery counts as acknowledged on `200` or `201`.

The request is built once and retried byte for byte, as the real API does:

```
POST <notification_url>
content-type: application/json
user-agent: MercadoPago WebHook v1.0 payment
x-request-id: <uuid>
x-signature: ts=<unix seconds>,v1=<hmac>

{"id":1,"live_mode":false,"type":"payment","date_created":"…-04:00","user_id":…,
 "api_version":"v1","action":"payment.updated","data":{"id":"1000000001"}}
```

### Validating the signature

The manifest is `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, HMAC-SHA256 with the
sandbox's webhook secret. Blank components are omitted, and `data.id` is lowercased —
see [FIDELITY.md](FIDELITY.md) for why that choice keeps both readings valid.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const [ts, v1] = request.headers.get('x-signature').split(',').map((p) => p.split('=')[1]);
const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
const expected = createHmac('sha256', webhookSecret).update(manifest).digest('hex');
const valid = timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

Deliveries, attempts, status codes and bodies are visible in the dashboard and through the
control API, and can be replayed from either.

Webhook targets on private addresses are allowed by default, because delivering to
`localhost` is the whole point of a local sandbox. On a shared deployment, start with
`--block-private-webhooks`; see [DEPLOY.md](DEPLOY.md).

## Going to production

The question payground exists to answer is "when I flip my environment variables back to
the real Mercado Pago, will everything still work?". Two tools answer it, both driven by
the vendored OpenAPI specification.

**`payground doctor`** replays the recorded request history — every call payground
answered is stored, body included — against the specification and reports, for the
endpoints you actually used: which operations are faithfully emulated and which are still
stubs, which of your request bodies the real API would refuse, which responses payground
emits that the specification does not describe, and which of the known divergences in
[FIDELITY.md](FIDELITY.md) you are exposed to. It exits `1` when there is a blocking
finding, so it can gate a pipeline.

```sh
payground start --db ci.sqlite &
# … run your integration test suite against payground …
payground doctor --db ci.sqlite            # or --format json, or --sandbox <id>
```

```
payground doctor — 3 requests recorded in ci.sqlite

Operations used
  createPayment                   2  emulated (payments)
  searchPayments                  1  emulated (payments)

Requests the real API would reject
  POST /v1/payments  1 call  (PaymentRequest)
    not_a_real_field — not documented by the specification

Responses payground emits that the specification does not describe
  searchPayments 200  1 call
    results[].id — expected integer

Known divergences you are exposed to
  Payments — Payment `id` is a number on the resource and a string in search results
    https://github.com/mercadopago/sdk-nodejs — clients/payment/search/types.ts

Verdict: 1 blocking finding — this breaks against https://api.mercadopago.com:
  - 1 call to POST /v1/payments sends a body the real API would refuse: not_a_real_field not documented by the specification
```

Request bodies are kept in the history so the doctor can replay them; `card_number`,
`security_code` and `cvv` are redacted before they are written, and a body over the
history size limit is dropped rather than truncated. The same report is served as JSON at
`GET /_payground/parity` (control API, admin token), optionally narrowed with
`?sandbox=<id>`.

**`payground start --strict`** turns the report into a gate at request time: every request
body is validated against the specification before it is handled, and anything the real
API would refuse — an undocumented field, a value outside an enum, a missing required
field — is answered with `400` instead of being accepted. Credentials are still checked
first, so a strict instance never turns a `401` into a `400`. In strict mode the responses
payground emits are validated too; a divergence there is recorded in the parity report
rather than failing the call, which is how payground finds its own drift.

Strict mode is **off by default**: payground is deliberately more permissive than the real
API, so that a test suite is not blocked by a field the vendored specification simply does
not document yet.

## Control API

payground's own API lives under `/_payground/` and is never mixed with the emulated
surface. It is what the dashboard talks to, and what a test suite uses to force a state.

| Method       | Path                                                | Purpose                                |
| ------------ | --------------------------------------------------- | -------------------------------------- |
| `GET`        | `/_payground/health`                                | Status, version, uptime                |
| `GET/POST`   | `/_payground/sandboxes`                             | List, create (`{"name":"…"}`)          |
| `DELETE`     | `/_payground/sandboxes/{id}`                        | Delete a sandbox                       |
| `POST`       | `/_payground/sandboxes/{id}/reset`                  | Drop the data, keep the credentials    |
| `GET`        | `/_payground/sandboxes/{id}/payments`               | `state`, `method`, `external_reference`, paging |
| `GET`        | `/_payground/sandboxes/{id}/payments/{pid}`         | Payment, timeline and refunds          |
| `POST`       | `/_payground/sandboxes/{id}/payments/{pid}/actions` | Force a transition                     |
| `GET`        | `/_payground/parity`                                | Parity report (`?sandbox=<id>`)        |
| `GET`        | `/_payground/sandboxes/{id}/webhooks`               | Deliveries and attempts                |
| `POST`       | `/_payground/sandboxes/{id}/webhooks/{wid}/replay`  | Replay a delivery                      |
| `GET/PUT`    | `/_payground/sandboxes/{id}/faults`                 | Latency, error rate, unavailability, duplicate and failing webhooks |

Actions: `settle`, `review`, `decline` (`reason`), `expire`, `cancel` (`by`), `capture`
(`amount`), `refund` (`amount`), `dispute`, `resolve` (`outcome`). Only transitions the
state machine allows are accepted; anything else returns `409`.

```sh
curl -X POST http://127.0.0.1:8080/_payground/sandboxes/$SANDBOX/payments/$PAYMENT/actions \
  -H 'Content-Type: application/json' -d '{"type":"settle"}'
```

> The control API is **unauthenticated by design**, so that a test suite does not need
> credentials to drive it. Never expose `/_payground/` on a public deployment without
> putting authentication in front of it — see [DEPLOY.md](DEPLOY.md).

## Dashboard

A React dashboard is served at `/_payground` whenever prebuilt assets are found: shipped
in `dist/dashboard` for published and Docker installs, or built from a checkout with
`payground build-dashboard`, or pointed at with `--dashboard <dir>`. It lists payments,
shows a payment's timeline, forces transitions, inspects and replays webhook deliveries,
and edits the fault profile.

## Multi-tenancy

A sandbox is a tenant: its own credentials, and its own data. Every repository is opened
through `Storage.forSandbox(id)` and cannot express a cross-sandbox query, so isolation is
structural rather than a filter someone can forget.

```sh
payground sandbox create --name ci-pr-1234
payground seed --sandbox <id> --payments 20
payground reset --sandbox <id>
```

One instance can therefore back an entire CI fleet: one sandbox per pull request, each
with its own access token, webhook secret and payments. `payground start --no-bootstrap`
starts with no sandbox at all, for a deployment where every tenant is created explicitly.

## Development

```sh
bun run typecheck
bun test packages tools
bun run test:e2e       # runs the official Mercado Pago SDK against the emulator
```

[CONTRIBUTING.md](CONTRIBUTING.md) describes the architecture, the code generation
pipeline and the test conventions.

## License

MIT
