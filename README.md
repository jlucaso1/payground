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
decline on demand, needs a public URL to deliver webhooks, and cannot be reset between test
runs. payground runs on your machine or in your CI and behaves like the real service, with
state. A payment you create exists, can be queried and searched, transitions between
statuses, expires, is refunded, is disputed, and emits signed webhooks.

It is not a webhook firing tool. A webhook only exists here because a resource actually
changed state.

Every known divergence from the real API is recorded in [FIDELITY.md](FIDELITY.md), which is
generated: it is impossible to add a divergence without writing its entry.

## Install

There is no npm package yet. Install from a clone, or run the Docker image.

### From a clone

```sh
git clone https://github.com/jlucaso1/payground
cd payground
bun install
bun run build     # bundles the CLI and the dashboard into packages/cli/dist
bun run start     # http://127.0.0.1:8080
```

Requires Bun 1.4 or newer. There are no runtime dependencies.

```
payground 0.1.0 listening on http://127.0.0.1:8080
  database        .payground/payground.sqlite
  sandbox         3c921762-1e23-4bdf-a791-2abe7d49c7bc (default)
  access token    TEST-16be44fc-b99d-49f6-892e-fbde43326f7b
  public key      TEST-45f60815-6dcc-4797-abdc-af851ed9acef
  webhook secret  0681a8d0-429a-4bd5-b227-e563f04cad6d
  dashboard       http://127.0.0.1:8080/_payground
  admin token     8e192924-dd49-4af6-b96a-c989a533608e
  rate limit      off
  health          http://127.0.0.1:8080/_payground/health
```

Two credentials matter. The access token is what your SDK sends to the emulated Mercado Pago
API; it lives in the database and survives restarts. The admin token guards payground's own
control API under `/_payground/`, and is random on every start unless you pass
`--admin-token` or set `PAYGROUND_ADMIN_TOKEN`.

A clone has no `payground` binary on `PATH`. Run any command below as
`bun packages/cli/src/index.ts <command>`, or alias it. Add sample data with
`bun packages/cli/src/index.ts seed`.

### Docker

```sh
docker compose up -d
docker compose logs payground     # the banner above, including the admin token
curl http://127.0.0.1:8080/_payground/health
```

The image runs as a non-root user, keeps the database on a named volume at
`/data/payground.sqlite`, and declares a `HEALTHCHECK` against `/_payground/health`.
Set `PAYGROUND_ADMIN_TOKEN` in `docker-compose.yml` if you want a stable token across
restarts. See [DEPLOY.md](DEPLOY.md) for reverse proxies, TLS, backups and the public
multi-tenant mode.

## CLI

```
payground start   [--port <n>] [--host <addr>] [--db <path>] [--base-url <url>]
                  [--dashboard <dir>] [--admin-token <t>] [--no-admin-token]
                  [--no-bootstrap] [--rate-limit <n>] [--rate-burst <n>]
                  [--no-rate-limit] [--retention-days <n>] [--drain-timeout <ms>]
                  [--strict] [--block-private-webhooks]
payground seed    [--db <path>] [--sandbox <id>] [--payments <n>] [--seed <n>]
payground doctor  [--db <path>] [--sandbox <id>] [--format text|json]
payground reset   [--db <path>] [--sandbox <id>]
payground sandbox list | create --name <name> | show <id> | delete <id>
payground export  --db <path> [--sandbox <id>] [--out <file>]
payground import  --db <path> --in <file> [--as <new-sandbox-id>] [--replace]
payground backup  --db <path> --out <file>
payground prune   --db <path> [--requests <days>] [--audit <days>] [--webhooks <days>]
                  [--payments <days>] [--dry-run]
payground build-dashboard [--out <dir>]
payground --version | --help
```

The `start` flags worth knowing: `--admin-token <t>` fixes the control API token instead of
generating one, and `--no-admin-token` removes the check entirely, which is only safe on a
private instance. `--rate-limit <n>` throttles a sandbox to n requests per second and is off
by default; `--rate-burst <n>` sets how many it may spend at once, defaulting to one second
of `--rate-limit`, and `--no-rate-limit` overrides whatever the environment configured.
`--retention-days <n>` prunes requests, audit, webhooks and payments older than n days, on
boot and hourly after that. `--drain-timeout <ms>` bounds how long shutdown waits for
in-flight requests, default 10000. `--no-bootstrap` starts with no sandbox at all.
`--strict` and `--block-private-webhooks` are covered below.

Environment variables: `PAYGROUND_DB` is read by `start`, `seed`, `doctor`, `reset` and
`sandbox`. `start` also reads `PAYGROUND_PORT`, `PAYGROUND_HOST`, `PAYGROUND_BASE_URL`,
`PAYGROUND_DASHBOARD`, `PAYGROUND_ADMIN_TOKEN`, `PAYGROUND_RATE_LIMIT`,
`PAYGROUND_RATE_BURST` and `PAYGROUND_RETENTION_DAYS`.

`seed` is deterministic: the same `--seed` and the same clock always produce the same
payments, spread over every state (approved, pending, expired, declined, in review,
authorized, refunded, partially refunded, disputed, charged back). Seeding twice with the
same seed is refused rather than silently duplicated; run `payground reset` first.

Exit codes: `0` success, `1` failure, `2` bad usage.

## Pointing an SDK at payground

payground serves the real Mercado Pago paths (`/v1/payments`, and the rest), so the only
thing an SDK needs is a different base URL. How well each official SDK supports that varies
a lot, and this is where the honesty matters.

### Node: needs a preload, there is no supported override

The Node SDK hard-codes its base URL and does not export `AppConfig`, so there is no public
API for pointing it elsewhere. This repository ships `preload.ts`, which reaches into
`mercadopago/dist/utils/config`, asserts the shape it expects and fails loudly if the SDK
layout changes. Reference it by path from your clone:

```sh
PAYGROUND_URL=http://127.0.0.1:8080 bun --preload /path/to/payground/preload.ts test
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

### PHP: supported

`MercadoPagoConfig` exposes a public static base URL:

```php
MercadoPago\MercadoPagoConfig::$BASE_URL = 'http://127.0.0.1:8080';
MercadoPago\MercadoPagoConfig::setAccessToken($_ENV['PAYGROUND_TOKEN']);
```

### Go: supported, through the HTTP client

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

### Python: no supported override

The Python SDK offers no base URL hook and no injectable transport. Either call payground
over plain HTTP (`requests` or `httpx` against `/v1/payments`), or patch the SDK's internal
request module in your test setup and accept that it can break on upgrade.

### Plain HTTP

```sh
curl -X POST http://127.0.0.1:8080/v1/payments \
  -H "Authorization: Bearer $PAYGROUND_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -d '{"transaction_amount":100.5,"payment_method_id":"pix","payer":{"email":"payer@example.com"}}'
```

## Emulated API surface

142 operations of the vendored official OpenAPI specification, served under their real
paths. Authentication is the real one: `Authorization: Bearer <access token>`, or
`access_token` / `public_key` as a query parameter.

| Product | Ops | Paths |
| ------- | --: | ----- |
| Payments | 6 | `/v1/payments`, `/v1/payments/search`, `/v1/payments/{id}`, `/v1/payments/{id}/refunds` |
| Orders | 10 | `/v1/orders` and its `process`, `capture`, `cancel`, `refund`, `transactions` actions |
| Checkout Pro | 8 | `/checkout/preferences`, `/merchant_orders`, `/checkout/{id}` |
| Subscriptions | 11 | `/preapproval_plan`, `/preapproval`, `/authorized_payments` |
| Cards and methods | 3 | `/v1/card_tokens`, `/v1/card_tokens/{id}`, `/v1/payment_methods` |
| Customers | 15 | `/v1/customers`, plus their cards and addresses |
| Disputes | 7 | `/v1/chargebacks/{id}`, `/v1/advanced_payments`, refund and cancellation detail |
| Identity and OAuth | 3 | `/oauth/token`, `/v1/identification_types`, `/v1/payment_methods/installments` |
| Stores and POS | 11 | `/users/{uid}/stores`, `/pos`, `/pos/{id}/qr` |
| Point | 12 | `/point/integration-api/...`, `/terminals/v1/...` |
| In-store QR | 10 | `/instore/qr/...`, `/instore/orders/...`, `/mpmobile/instore/qr/...` |
| Wallet Connect | 6 | `/v2/wallet_connect/agreements`, `/discounts`, `/coupons` |
| Payouts | 5 | `/v1/payouts`, `/v1/transaction-intents` |
| Claims | 13 | `/post-purchase/v1/claims/...` |
| Release report | 11 | `/v1/account/release_report/...` |
| Settlement report | 11 | `/v1/account/settlement_report/...` |

The authoritative registry is `packages/server/src/routes/index.ts`, not `app.ts`. Each
module declares the specification operations it serves and the ones still pending; every
pending list is currently empty. A few modules also register control routes, for instance
Point exposes `/_payground/sandboxes/{id}/point/intents` so a test can drive a terminal.

Payment methods accepted on a payment: `pix`, `bolbradesco`, `bolbradesco_pec`, `pec`,
`account_money`, and the card brands `visa`, `master`, `amex`, `elo`, `hipercard`,
`debvisa`, `debmaster`, `debelo`. Pix payments carry a real, spec-correct EMV BR Code
payload and QR image.

## Test cardholders and test cards

Outcomes are driven by the cardholder name on the card token, exactly as in the real
sandbox. The full table is 17 codes, not the 8 usually quoted:

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

{"id":1,"live_mode":false,"type":"payment","date_created":"...-04:00","user_id":...,
 "api_version":"v1","action":"payment.updated","data":{"id":"1000000001"}}
```

### Validating the signature

The manifest is `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, HMAC-SHA256 with the
sandbox's webhook secret. Blank components are omitted, and `data.id` is lowercased. See
[FIDELITY.md](FIDELITY.md) for why that choice keeps both readings valid.

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

The question payground exists to answer is "when I flip my environment variables back to the
real Mercado Pago, will everything still work?". Two tools answer it, both driven by the
vendored OpenAPI specification.

`payground doctor` replays the recorded request history against the specification. Every
call payground answered is stored, body included. For the endpoints you actually used it
reports which operations are faithfully emulated and which are still stubs, which of your
request bodies the real API would refuse, which responses payground emits that the
specification does not describe, and which of the known divergences in
[FIDELITY.md](FIDELITY.md) you are exposed to. It exits `1` on a blocking finding, so it can
gate a pipeline.

```sh
payground start --db ci.sqlite &
# run your integration test suite against payground
payground doctor --db ci.sqlite            # or --format json, or --sandbox <id>
```

```
payground doctor: 2 requests recorded in ci.sqlite

Operations used
  createPayment                   1  emulated (payments)
  searchPayments                  1  emulated (payments)

Requests the real API would reject
  POST /v1/payments  1 call  (PaymentRequest)
    not_a_real_field: not documented by the specification

Responses payground emits that the specification does not describe
  searchPayments 200  1 call
    results[].id: expected integer

Known divergences you are exposed to
  Payments: Payment `id` is a number on the resource and a string in search results
    https://github.com/mercadopago/sdk-nodejs, clients/payment/search/types.ts
  [24 more]

Verdict: 1 blocking finding. This breaks against https://api.mercadopago.com:
  - 1 call to POST /v1/payments sends a body the real API would refuse: not_a_real_field not documented by the specification
```

Request bodies are kept in the history so the doctor can replay them. `card_number`,
`security_code` and `cvv` are redacted before they are written, and a body over the history
size limit is dropped rather than truncated. The same report is served as JSON at
`GET /_payground/parity`, optionally narrowed with `?sandbox=<id>`.

`payground start --strict` turns the report into a gate at request time. Every request body
is validated against the specification before it is handled, and anything the real API would
refuse (an undocumented field, a value outside an enum, a missing required field) is
answered with `400` instead of being accepted. Credentials are still checked first, so a
strict instance never turns a `401` into a `400`. In strict mode the responses payground
emits are validated too; a divergence there is recorded in the parity report rather than
failing the call, which is how payground finds its own drift.

Strict mode is off by default. payground is deliberately more permissive than the real API,
so that a test suite is not blocked by a field the vendored specification simply does not
document yet.

## Control API

payground's own API lives under `/_payground/` and is never mixed with the emulated surface.
It is what the dashboard talks to, and what a test suite uses to force a state.

Every route below except `/_payground/health` and `/_payground/ready` requires the admin
token, sent as `Authorization: Bearer <admin token>`, as `X-Payground-Admin-Token`, or as an
`admin_token` query parameter. A missing or wrong token returns `401`. The token is
generated and printed at startup; `--no-admin-token` disables the check, which is only safe
on a private instance.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/_payground/health` | Status, version, uptime. No token |
| `GET` | `/_payground/ready` | Readiness, including migrations. `503` when not ready. No token |
| `GET` `POST` | `/_payground/sandboxes` | List, create (`{"name":"..."}`) |
| `GET` `PUT` `DELETE` | `/_payground/sandboxes/{id}` | Show, rename, delete |
| `POST` | `/_payground/sandboxes/{id}/reset` | Drop the data, keep the credentials |
| `GET` | `/_payground/sandboxes/{id}/payments` | `state`, `method`, `external_reference`, paging |
| `GET` | `/_payground/sandboxes/{id}/payments/{pid}` | Payment, timeline and refunds |
| `POST` | `/_payground/sandboxes/{id}/payments/{pid}/actions` | Force a transition |
| `GET` | `/_payground/sandboxes/{id}/webhooks` | Deliveries and attempts |
| `POST` | `/_payground/sandboxes/{id}/webhooks/{wid}/replay` | Replay a delivery |
| `GET` `PUT` | `/_payground/sandboxes/{id}/faults` | Latency, error rate, unavailability, duplicate and failing webhooks |
| `GET` | `/_payground/sandboxes/{id}/documents/kinds` | The 26 stored resource kinds, with a count each |
| `GET` | `/_payground/sandboxes/{id}/documents` | Browse one kind: `kind` (required), `status`, `external_reference`, `q`, paging |
| `GET` | `/_payground/sandboxes/{id}/documents/{kind}/{docId}` | One stored resource |
| `GET` `DELETE` | `/_payground/requests` | Request history across sandboxes; `DELETE` purges by age |
| `GET` | `/_payground/requests/{id}` | One recorded request, headers and bodies |
| `GET` `DELETE` | `/_payground/audit` | Audit trail; `DELETE` purges by age |
| `GET` | `/_payground/sandboxes/{id}/requests` | Request history of one sandbox |
| `GET` | `/_payground/sandboxes/{id}/audit` | Audit trail of one sandbox |
| `GET` | `/_payground/parity` | Parity report (`?sandbox=<id>`) |
| `GET` | `/_payground/metrics` | Prometheus text, or `?format=json` for a summary |
| `GET` | `/_payground/sandboxes/{id}/metrics` | Per-sandbox rollup, in JSON |

Actions: `settle`, `review`, `decline` (`reason`), `expire`, `cancel` (`by`), `capture`
(`amount`), `refund` (`amount`), `dispute`, `resolve` (`outcome`). Only transitions the
state machine allows are accepted; anything else returns `409`.

`{pid}` is payground's own payment id, the `id` field of
`GET /_payground/sandboxes/{id}/payments`, not the numeric id the emulated API returns (that
one is `sequence`).

```sh
curl -X POST http://127.0.0.1:8080/_payground/sandboxes/$SANDBOX/payments/$PAYMENT/actions \
  -H "Authorization: Bearer $PAYGROUND_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"type":"settle"}'
```

> The admin token can read every tenant's credentials, create sandboxes and force any
> payment to approved. Treat it as a secret, and see [DEPLOY.md](DEPLOY.md) before exposing
> `/_payground/` on a shared deployment.

## Metrics

`GET /_payground/metrics` exposes the in-process registry in the Prometheus text exposition
format (`text/plain; version=0.0.4`). It needs the admin token like the rest of the control
API.

| Metric                              | Type      | Labels                             |
| ----------------------------------- | --------- | ---------------------------------- |
| `payground_api_requests_total`       | counter   | `route`, `method`, `status`, `sandbox` |
| `payground_api_request_duration_ms`  | histogram | `route`, `method`, `status`, `sandbox` |
| `payground_webhook_deliveries`       | gauge     | `sandbox`, `status`                |
| `payground_webhook_queue_depth`      | gauge     | `sandbox`                          |

`route` is the spec path (`/v1/payments/:id`), never a real identifier, so the label
cardinality stays bounded. `sandbox` is `anonymous` for an unauthenticated call. The webhook
series are derived from the stored deliveries, where `status` is one of `queued`, `sending`,
`delivered`, `retrying` or `exhausted`; queue depth counts the ones not yet delivered or
exhausted. They are gauges because a delivery moves between statuses, and they only see the
most recent 1000 deliveries per sandbox, so they saturate there.

`?format=json` returns a summary instead: request and error totals, the error rate, p50, p95
and p99 estimated from the histogram buckets, and the same broken down per route.
`GET /_payground/sandboxes/{id}/metrics` is the same summary for one sandbox, plus its
webhook counts.

```yaml
scrape_configs:
  - job_name: payground
    metrics_path: /_payground/metrics
    authorization:
      credentials: <admin token>
    static_configs:
      - targets: ['127.0.0.1:8080']
```

## Dashboard

A React dashboard is served at `/_payground` whenever prebuilt assets are found: shipped in
`packages/cli/dist/dashboard` after `bun run build` and in the Docker image, built on demand
with `payground build-dashboard`, or pointed at with `--dashboard <dir>`. It lists payments,
shows a payment's timeline, forces transitions, inspects and replays webhook deliveries, and
edits the fault profile.

## Multi-tenancy

A sandbox is a tenant: its own credentials, and its own data. Every repository is opened
through `Storage.forSandbox(id)` and cannot express a cross-sandbox query, so isolation is
structural rather than a filter someone can forget.

```sh
payground sandbox create --name ci-pr-1234
payground seed --sandbox <id> --payments 20
payground reset --sandbox <id>
```

One instance can therefore back an entire CI fleet: one sandbox per pull request, each with
its own access token, webhook secret and payments. `payground start --no-bootstrap` starts
with no sandbox at all, for a deployment where every tenant is created explicitly.

## Development

```sh
bun run typecheck
bun test packages tools    # unit tests
bun run test:e2e           # runs the official Mercado Pago SDK against the emulator
```

[CONTRIBUTING.md](CONTRIBUTING.md) describes the architecture, the code generation pipeline
and the test conventions.

## License

MIT, see [LICENSE](LICENSE).
