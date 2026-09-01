# Deploying payground

payground is a test double. Everything below assumes that: the data is disposable, the
credentials it mints are fake, and no real card data or real money ever touches it.

## Before you expose this publicly

1. Set an admin token, or let `payground start` generate one. Do not pass
   `--no-admin-token` on a reachable instance.
2. Start with `--block-private-webhooks`, so a tenant cannot aim `notification_url` at
   your metadata service.
3. Put TLS in front of it. payground speaks plain HTTP and has no TLS configuration.
4. Set `--retention-days`, or the request history and webhook attempts grow forever.
5. Tell your users, in writing, that real card numbers and real personal data are not
   allowed. Nothing in payground is built to hold them.

## Running it

### Docker Compose

```sh
docker compose up -d
docker compose logs -f payground
```

The compose file keeps the SQLite database on a named volume
(`/data/payground.sqlite`), runs the container as the non-root `bun` user, and
health-checks `/_payground/health`. Set `PAYGROUND_BASE_URL` to the origin your
integrators will actually reach. It is embedded in Pix payloads, ticket URLs and checkout
links, so a wrong value produces QR codes that point at the wrong host.

### From the published package

```sh
bunx payground start --host 0.0.0.0 --db /var/lib/payground/payground.sqlite \
  --base-url https://payground.example.com --block-private-webhooks
```

Run it under a supervisor that sends `SIGTERM` (systemd, Kubernetes, Docker). `start`
handles `SIGINT` and `SIGTERM` by draining in-flight requests, stopping the retention
timer and closing the database, so the WAL is checkpointed and the file is consistent.

### Ephemeral instances for CI

`--db :memory:` keeps everything in RAM and leaves nothing behind:

```sh
payground start --port 0 --db :memory: &
```

Retention is skipped for `:memory:`, since there is no file to grow. For a fresh dataset
without restarting, `payground reset` drops payments, refunds, webhooks and idempotency
keys and keeps the credentials, so tests that captured a token at boot keep working.

## Configuration

Every flag of `payground start`:

| Flag                       | Env                        | Default                       | Effect |
| -------------------------- | -------------------------- | ----------------------------- | ------ |
| `--port <n>`               | `PAYGROUND_PORT`           | `8080`                        | Listening port. `0` picks a free one |
| `--host <addr>`            | `PAYGROUND_HOST`           | `127.0.0.1` (`0.0.0.0` in the image) | Bind address |
| `--db <path>`              | `PAYGROUND_DB`             | `.payground/payground.sqlite` (`/data/payground.sqlite` in the image) | SQLite file, or `:memory:` |
| `--base-url <url>`         | `PAYGROUND_BASE_URL`       | `http://<host>:<port>`        | Origin advertised in tickets, Pix payloads and checkout links |
| `--dashboard <dir>`        | `PAYGROUND_DASHBOARD`      | `dist/dashboard` next to the CLI | Prebuilt dashboard assets. Start fails if the directory you name has no `index.html` |
| `--admin-token <t>`        | `PAYGROUND_ADMIN_TOKEN`    | a random UUID, printed at boot | Token the control API requires |
| `--no-admin-token`         | none                       | off                           | Leaves the control API open |
| `--no-bootstrap`           | none                       | off                           | Starts without creating a default sandbox |
| `--rate-limit <n>`         | `PAYGROUND_RATE_LIMIT`     | off                           | Sustained requests per second, per sandbox |
| `--rate-burst <n>`         | `PAYGROUND_RATE_BURST`     | one second of `--rate-limit`  | How many requests a sandbox may spend at once |
| `--no-rate-limit`          | none                       | off                           | Disables throttling even when the environment configures it |
| `--retention-days <n>`     | `PAYGROUND_RETENTION_DAYS` | unset (keep everything)       | Prunes requests, audit, webhooks and payments older than `n` days, on boot and hourly after |
| `--drain-timeout <ms>`     | none                       | `10000`                       | How long shutdown waits for in-flight requests |
| `--strict`                 | none                       | off                           | Validates requests and responses against the vendored specification |
| `--block-private-webhooks` | none                       | off                           | Refuses webhook targets that resolve to a private address |

`--rate-burst` without `--rate-limit` is a usage error. `--retention-days` accepts 1 to
3650, `--drain-timeout` 0 to 600000, `--port` 0 to 65535; anything else fails at parse
time instead of starting with a surprising value.

`--strict` rejects requests the real Mercado Pago API would reject and records every
response that diverges from the specification. Run `payground doctor` afterwards to read
those findings; it exits 1 when a finding is blocking, so it can gate a pipeline. Strict
mode is for a CI instance, not for a shared box where a stricter-than-usual 400 would
confuse everyone.

## The admin token

Every route under `/_payground/` requires the admin token, except `/_payground/health`,
`/_payground/ready` and the dashboard shell that the browser loads before you type the
token in. That covers the routes that list sandboxes, read any tenant's access token and
webhook secret, force a payment to approved, set fault profiles, replay webhooks, read
metrics and delete a sandbox.

`payground start` generates a random token when you do not supply one and prints it in
the boot banner:

```
  admin token     05d2c208-944e-442f-86ce-eb96e87951a6
```

A generated token changes on every restart, which is fine for a laptop and useless for a
deployment. Pin it:

```sh
payground start --admin-token "$(openssl rand -hex 32)"
PAYGROUND_ADMIN_TOKEN="$(cat /etc/payground/admin-token)" payground start
```

Send it as `Authorization: Bearer <token>`, as `X-Payground-Admin-Token: <token>`, or as
an `admin_token` query parameter. Prefer a header: query strings end up in proxy access
logs and browser history. Tokens of equal length are compared in constant time. A missing
or wrong token gets
`401` with `{"error":"unauthorized"}`.

```sh
curl -sS -X POST http://127.0.0.1:8991/_payground/sandboxes \
  -H "Authorization: Bearer $PAYGROUND_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"pr-1234"}'
```

```json
{"id":"a35145c3-8abc-4a4a-a6dd-a95fef0a58c8","name":"pr-1234","accessToken":"TEST-9c774cff-0f0b-4ced-8ac2-b3f3ab0600bf","publicKey":"TEST-fce5c944-d098-451f-9e5c-100332b8d85c","webhookSecret":"c26ee9b9-1878-4ad4-a413-97ffc220568e","liveMode":false,"createdAt":1788288599502}
```

The same request without the header returns `401`.

`--no-admin-token` exists for a local run where a test suite drives the control API and
a shared secret is only friction. It leaves every route above open to anyone who can
reach the port. Bind to `127.0.0.1` if you use it.

The emulated Mercado Pago surface under `/v1/` is unaffected by the admin token: it
authenticates with the sandbox's own access token, as the real API does.

A reverse proxy with its own authentication is still worth having. It is a second lock on
the same door, not a replacement for the token.

## Reverse proxy and TLS

Terminate TLS at the proxy and forward to payground over loopback. Bind payground itself
to `127.0.0.1` so the only way in is through the proxy.

```nginx
server {
  listen 443 ssl http2;
  server_name payground.example.com;

  ssl_certificate     /etc/letsencrypt/live/payground.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/payground.example.com/privkey.pem;

  # The emulated API, authenticated by the sandbox's own access token. It is wider than
  # /v1: /checkout/preferences, /merchant_orders, /preapproval, /pos, /instore, /point,
  # /post-purchase, /oauth/token and /payments/{id}/ticket all live at the root, so pass
  # everything through rather than listing prefixes.
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
  }

  # Control API and dashboard: the admin token guards them upstream. Basic auth here
  # keeps unauthenticated traffic off the process entirely. The exact-match probes below
  # are matched first by nginx, so they stay open.
  location ^~ /_payground {
    auth_basic           "payground";
    auth_basic_user_file /etc/nginx/payground.htpasswd;
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
  }

  # Probes: no admin token, so restrict them to your monitoring.
  location = /_payground/health { proxy_pass http://127.0.0.1:8080; }
  location = /_payground/ready  { proxy_pass http://127.0.0.1:8080; }
}
```

Then start payground with the public origin, so Pix payloads and ticket URLs match what
clients can reach:

```sh
payground start --base-url https://payground.example.com --no-bootstrap \
  --block-private-webhooks
```

## Many teams on one instance

A sandbox is a tenant, with its own access token, public key, webhook secret and data.
`Storage.forSandbox(id)` is the only way to reach a repository and it cannot express a
cross-sandbox query, so tenant isolation is structural.

Start a shared instance with `--no-bootstrap`, so no default sandbox exists and nobody
inherits a token printed in a log. Sandboxes are cheap: give each pull request its own
and delete it afterwards.

```sh
curl -X DELETE https://payground.example.com/_payground/sandboxes/$ID \
  -H "Authorization: Bearer $PAYGROUND_ADMIN_TOKEN"
```

## Running more than one instance

Several processes can serve the same database. Webhook deliveries are leased: a delivery
runner takes rows in an `immediate` transaction that stamps `leased_until` and
`leased_by`, so two instances never pick up the same notification, and a row left
`sending` by a crashed process becomes claimable again once its lease expires (60
seconds). No coordination service is involved.

The constraint is the storage. State is one SQLite file, so every instance must mount the
same filesystem and that filesystem must implement POSIX locking correctly. Local disk
and a block volume attached to one machine are fine. NFS, SMB and most network filesystems
are not: their locking is where SQLite corruption comes from. If you need instances on
separate machines, you do not have a deployment payground supports.

Rolling restarts work: `GET /_payground/ready` queries the database and counts applied
migrations, so a new instance reports `503` until its schema is current, and shutdown
drains in-flight requests before closing (`--drain-timeout`, default 10 seconds). Point
the load balancer at `/_payground/ready` and the health check at `/_payground/health`.

The rate limiter is per process and in memory. Two instances with `--rate-limit 50` give
each sandbox up to 100 requests per second in total. Divide by the instance count, or put
the real limit in the proxy.

## Rate limiting

Off by default. A self-hosted instance has one user, and a limiter that fires during a
test run only makes the suite flaky.

```sh
payground start --rate-limit 50 --rate-burst 100
```

It is a token bucket keyed by sandbox id, so the budget is per tenant: a project looping
over `/v1/payments/search` cannot starve the others. The emulated Mercado Pago surface
counts against the budget (`/v1/`, `/checkout/preferences`, merchant orders,
subscriptions); the control API under `/_payground/` does not, so an operator can still
reach a throttled instance. Idle buckets are dropped, so memory tracks the number of
active sandboxes, not the number that ever existed.

With `--rate-limit 5` and no `--rate-burst`, the sixth call in the same second is
refused:

```
200 200 200 200 200 429 429 429
```

A refused request gets `429` with the provider's error envelope and a `Retry-After`
rounded up to whole seconds. The official Mercado Pago SDK lists `429` in `DEFAULT_RETRY_ON`
and honours `Retry-After`, so a client that behaves well in production backs off here too.

Pick the burst generously. A checkout flow is several calls back to back, and a burst
smaller than that turns a normal flow into a `429` even though the sustained rate is fine.

The limiter runs after authentication, so it caps what a tenant can spend. It is not a
defence against an unauthenticated flood; connection limits belong in the reverse proxy.

## Webhook targets and SSRF

Webhook URLs are supplied by whoever creates a payment, and payground connects to them.
`packages/server/src/net/index.ts` guards that:

- Only `http` and `https` are accepted, and the method must be a valid HTTP token.
- The hostname is resolved first, with every A and AAAA record returned. All of them must
  pass the address check, so a rebinding server that answers with one public and one
  private address is rejected outright.
- Blocked ranges are loopback, link-local, private, CGNAT, multicast and reserved, in
  IPv4 and IPv6, including IPv4-mapped IPv6 forms such as `::ffff:127.0.0.1`.
- The connection goes to the validated IP, never a second lookup of the hostname, with
  the original hostname passed as the TLS SNI so certificate validation still works. That
  closes the window between resolution and connection.
- The response is capped at 1 MiB and the attempt times out after 22 seconds.

Private targets are allowed by default, because delivering to `http://localhost:3000/hook`
is the whole point of a local sandbox. `--block-private-webhooks` turns the address check
on. Run a public instance with it. Without it, any user of your instance can point
`notification_url` at your cloud metadata endpoint or an internal admin panel and read the
response body out of the delivery log.

There is no way to allow one internal host while blocking the rest. `SafeFetchPolicy` has
an `allowlist` field, but nothing plumbs it through `createApp`, so on a public instance
the choice is all private targets or none.

## Observability

`GET /_payground/health` returns liveness without touching the database, so it answers
under load:

```json
{"status":"ok","version":"0.1.0","uptime_ms":5736}
```

`GET /_payground/ready` runs a query and compares applied migrations against the ones the
binary expects. `200` when ready, `503` when not:

```json
{"ready":true,"checks":{"database":true,"migrations":true},"migrations":{"applied":3,"expected":3}}
```

`GET /_payground/metrics` needs the admin token and serves Prometheus text by default:

```
# HELP payground_api_request_duration_ms Emulated API request latency in milliseconds.
# TYPE payground_api_request_duration_ms histogram
payground_api_request_duration_ms_bucket{method="GET",route="/v1/payments/search",sandbox="9df03136-8288-4ddd-b2b9-07a53147d8b1",status="200",le="1"} 1
# HELP payground_webhook_queue_depth Webhook deliveries still waiting to be delivered, by sandbox.
# TYPE payground_webhook_queue_depth gauge
payground_webhook_queue_depth{sandbox="9df03136-8288-4ddd-b2b9-07a53147d8b1"} 0
```

Add `?format=json` for a summary the dashboard uses, with request counts, error rate and
latency quantiles per route:

```json
{"at":1788288516471,"requests":1,"errors":0,"errorRate":0,"latency":{"p50":0.5,"p95":0.95,"p99":0.99},"routes":[{"route":"/v1/payments/search","method":"GET","requests":1,"errors":0,"errorRate":0,"latency":{"p50":0.5,"p95":0.95,"p99":0.99}}]}
```

Every series is labelled by sandbox, so a Grafana panel can break traffic down per tenant.
`GET /_payground/sandboxes/{id}/metrics` gives one sandbox's summary plus its webhook
counts.

Prometheus, with the token in a file so it stays out of the config:

```yaml
scrape_configs:
  - job_name: payground
    metrics_path: /_payground/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/payground-admin-token
    static_configs:
      - targets: ['payground.example.com']
```

Logs go to stdout, which is where a container runtime wants them.

## Backups, snapshots and retention

The whole state is one SQLite file plus its WAL sidecars, and the CLI acts on it without a
`sqlite3` binary, which the runtime image does not ship. `backup`, `export` and `prune`
refuse a `--db` that does not exist, so a typo in a cron line fails loudly instead of
producing an empty snapshot.

### Whole-database backup

`payground backup` serialises the database through SQLite itself, uncheckpointed WAL
frames included, so it is consistent even while the server writes:

```sh
payground backup --db /data/payground.sqlite --out /backup/payground-$(date +%F).sqlite
```

```
wrote 208896 bytes to /backup/payground-2026-08-28.sqlite
```

`--out` is required, and it refuses to write over the database or its `-wal` and `-shm`
sidecars. Never copy `payground.sqlite` with `cp` while the process runs: you would
capture a torn snapshot. Restoring is a file copy with the service stopped:

```sh
docker compose stop payground
VOLUME=$(docker volume inspect -f '{{.Mountpoint}}' payground_payground-data)
rm -f "$VOLUME"/payground.sqlite-wal "$VOLUME"/payground.sqlite-shm
cp /backup/payground-2026-08-28.sqlite "$VOLUME"/payground.sqlite
docker compose start payground
```

Delete the `-wal` and `-shm` sidecars as shown: SQLite may replay a leftover WAL on top of
the file you just restored. The volume name comes from the compose project, so check it
with `docker volume ls` before running this.

Migrations run automatically on open and are recorded in `schema_migrations`, so restoring
an older file into a newer binary upgrades it in place. The reverse is not supported.

### Moving one sandbox between instances

`payground export` writes a self-describing JSON document: schema version, export time,
and each sandbox's credentials, payments, timelines, refunds, documents, webhook
deliveries and attempts. Request and audit logs are left out, being operational noise
rather than sandbox state. Without `--out` it writes to stdout, so it pipes.

```sh
payground export --db /data/payground.sqlite --sandbox $ID --out staging.json
payground import --db ./local.sqlite --in staging.json
```

```
exported 1 sandbox and 0 rows to staging.json
```

`import` creates the target database if it is absent, refuses a schema version it does not
understand, and refuses to overwrite an existing sandbox unless `--replace` is given.
`--as <new-id>` restores the snapshot under a different id so it can sit next to the
original; if the exported access token or public key is already taken, a fresh pair is
minted and reported.

A delivery that was still queued or retrying when the snapshot was taken is due again as
soon as a server opens the restored database, so importing a snapshot from a live instance
sends webhooks to the URLs recorded in it. Run `payground reset` first if that is not what
you want.

### Retention

A shared instance grows forever: the request history keeps response bodies up to 16 KiB
each, and every webhook attempt is stored. Prune it, in days, per family of data:

```sh
payground prune --db /data/payground.sqlite --requests 7 --audit 30 --webhooks 14 --dry-run
payground prune --db /data/payground.sqlite --requests 7 --audit 30 --webhooks 14
```

`--dry-run` runs the same counting queries and prints the same per-table report, then
deletes nothing:

```
would delete 3 rows
  api_requests         3
```

At least one of `--requests`, `--audit`, `--webhooks` and `--payments` is required.
`--payments <days>` also drops the payments themselves, together with their timelines and
refunds. `--webhooks <days>` only touches deliveries whose status is `delivered` or
`exhausted`, and their attempts; a delivery still `queued`, `retrying` or `sending`
survives at any age, so pruning never pulls a row out from under the delivery runner.

For the automatic version, `payground start --retention-days 30` (or
`PAYGROUND_RETENTION_DAYS`) prunes every family on boot and hourly after that, and logs a
line when it removes anything.

Because the data is disposable by definition, "no backups at all, recreate the sandboxes"
is a legitimate strategy for a CI deployment.

## Operating notes

- Faults are per sandbox and persisted. A tenant that leaves `unavailable` on will keep
  getting `503` after a restart. Clearing it is a `PUT /_payground/sandboxes/{id}/faults`
  away.
- Webhook retries are attempted by a background runner every second, so a stopped instance
  resumes the queue when it comes back.
- `payground doctor` replays the recorded request history against the vendored
  specification and reports what would break against the real API. Useful as a nightly job
  on a shared instance.
