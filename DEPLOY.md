# Deploying payground

payground is a test double. Everything below assumes that: the data is disposable, the
credentials it mints are fake, and no real card data or real money ever touches it.

## Self-hosting a single instance

### Docker Compose

```sh
docker compose up -d
docker compose logs -f payground
```

`docker-compose.yml` keeps the SQLite file on a named volume (`/data/payground.sqlite`),
runs the container as the non-root `bun` user, and health-checks `/_payground/health`.
Set `PAYGROUND_BASE_URL` to the origin your integrators will actually reach — it is
embedded in Pix payloads, ticket URLs and checkout links, so a wrong value produces
QR codes that point at the wrong host.

Recognised environment variables:

| Variable              | Default                      | Meaning                              |
| --------------------- | ---------------------------- | ------------------------------------ |
| `PAYGROUND_PORT`      | `8080`                       | Listening port                       |
| `PAYGROUND_HOST`      | `127.0.0.1` (`0.0.0.0` in the image) | Bind address                 |
| `PAYGROUND_DB`        | `.payground/payground.sqlite` (`/data/payground.sqlite` in the image) | SQLite file, or `:memory:` |
| `PAYGROUND_BASE_URL`  | derived from host and port   | Public origin advertised to clients  |
| `PAYGROUND_DASHBOARD` | `dist/dashboard` next to the CLI | Prebuilt dashboard assets        |
| `PAYGROUND_RETENTION_DAYS` | unset (keep everything) | Prune data older than this many days |

### From the published package

```sh
bunx payground start --host 0.0.0.0 --db /var/lib/payground/payground.sqlite \
  --base-url https://payground.example.com
```

Run it under a supervisor that sends `SIGTERM` (systemd, Kubernetes, Docker). `start`
handles `SIGINT` and `SIGTERM` by closing the HTTP server and the database, so the WAL is
checkpointed and the file is left consistent.

### Ephemeral instances for CI

`--db :memory:` keeps everything in RAM and leaves nothing behind:

```sh
payground start --port 0 --db :memory: &
```

For a fresh dataset without restarting, `payground reset` drops the data of every sandbox
and keeps the credentials, so tests that captured a token at boot keep working.

## Public, multi-tenant mode

One instance can serve many teams: a sandbox is a tenant, with its own access token,
public key, webhook secret and data. `Storage.forSandbox(id)` is the only way to reach a
repository and it cannot express a cross-sandbox query, so tenant isolation is structural.

A public deployment needs three decisions:

1. **Start bare.** `payground start --no-bootstrap` creates no default sandbox, so nobody
   inherits a token printed in a log.
2. **Protect the control API.** Everything under `/_payground/` — including the dashboard
   and the endpoints that force a transition, read a webhook secret or delete a sandbox —
   is unauthenticated by design, so that test suites can drive it without credentials.
   On a public instance it must sit behind authentication in the reverse proxy. The
   emulated Mercado Pago surface under `/v1/` is unaffected: it authenticates with the
   sandbox's own credentials.
3. **Stop webhook deliveries from reaching your network.** See the SSRF section below.

Sandboxes are cheap; give each pull request its own and delete it afterwards:

```sh
curl -X POST https://payground.example.com/_payground/sandboxes \
  -H 'Content-Type: application/json' -d '{"name":"pr-1234"}'
curl -X DELETE https://payground.example.com/_payground/sandboxes/$ID
```

## Reverse proxy and TLS

Terminate TLS at the proxy and forward to payground over loopback. Bind payground itself
to `127.0.0.1` so the only way in is through the proxy.

```nginx
server {
  listen 443 ssl http2;
  server_name payground.example.com;

  ssl_certificate     /etc/letsencrypt/live/payground.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/payground.example.com/privkey.pem;

  # The emulated API: authenticated by the sandbox's own access token.
  location /v1/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
  }

  # Control API and dashboard: unauthenticated upstream, so add authentication here.
  location /_payground/ {
    auth_basic           "payground";
    auth_basic_user_file /etc/nginx/payground.htpasswd;
    proxy_pass http://127.0.0.1:8080;
  }

  # Leave the health endpoint open for probes.
  location = /_payground/health {
    proxy_pass http://127.0.0.1:8080;
  }
}
```

Then start payground with the public origin, so Pix payloads and ticket URLs match what
clients can reach:

```sh
payground start --base-url https://payground.example.com --no-bootstrap
```

payground itself speaks plain HTTP and has no TLS configuration: give it a proxy.

## Backups, snapshots and retention

The whole state is one SQLite file (plus its WAL sidecars), and the CLI can act on it
without a `sqlite3` binary — which the runtime image does not ship.

### Whole-database backup

`payground backup` serialises the database through SQLite itself, so it is consistent even
while the server writes:

```sh
payground backup --db /data/payground.sqlite --out /backup/payground-$(date +%F).sqlite
```

Never copy `payground.sqlite` with `cp` while the process is running: you would capture a
torn snapshot. Restoring is a file copy with the service stopped:

```sh
docker compose stop payground
cp /backup/payground-2026-08-28.sqlite /var/lib/docker/volumes/…/payground.sqlite
docker compose start payground
```

Migrations run automatically on open and are recorded in `schema_migrations`, so restoring
an older file into a newer binary upgrades it in place. The reverse is not supported.

### Moving one sandbox between instances

`payground export` writes a self-describing JSON document — schema version, export time,
and each sandbox's credentials, payments, timelines, refunds, documents, webhook
deliveries and attempts. Request and audit logs are left out: they are operational noise.

```sh
payground export --db /data/payground.sqlite --sandbox $ID --out staging.json
payground import --db ./local.sqlite --in staging.json
```

`import` refuses a schema version it does not understand, and refuses to overwrite an
existing sandbox unless `--replace` is given. `--as <new-id>` restores the snapshot under
a different id, so it can sit next to the original; if the exported access token or public
key is already taken, a fresh pair is minted and reported.

A delivery that was still queued or retrying when the snapshot was taken is due again as
soon as a server opens the restored database, so importing a snapshot from a live instance
sends webhooks to the URLs recorded in it. `payground reset` first if that is not wanted.

### Retention

A shared instance grows forever: the request history keeps bodies, and every webhook
attempt is stored. Prune it, in days, per family of data:

```sh
payground prune --db /data/payground.sqlite --requests 7 --audit 30 --webhooks 14 --dry-run
payground prune --db /data/payground.sqlite --requests 7 --audit 30 --webhooks 14
```

`--dry-run` reports what would go without deleting it. `--payments <days>` also drops the
payments themselves, together with their timelines and refunds. `--webhooks` only touches
deliveries that are done — delivered or exhausted — so it never pulls a row out from under
the delivery runner.

`export`, `backup` and `prune` refuse a `--db` that does not exist, so a typo in a cron
line fails loudly instead of producing an empty snapshot.

To keep it automatic, `payground start --retention-days 30` (or `PAYGROUND_RETENTION_DAYS`)
prunes every family on boot and hourly after that.

Because the data is disposable by definition, "no backups at all, recreate the sandboxes"
is a legitimate strategy for CI deployments.

## Rate limiting

Off by default. A self-hosted instance has one user, and a limiter that fires during a
test run only makes the suite flaky, so throttling is opt-in:

```sh
payground start --rate-limit 50 --rate-burst 100
```

| Knob                          | Default        | Effect                                       |
| ----------------------------- | -------------- | -------------------------------------------- |
| `--rate-limit <n>` (`PAYGROUND_RATE_LIMIT`) | off | Sustained requests per second, per sandbox |
| `--rate-burst <n>` (`PAYGROUND_RATE_BURST`) | one second of `--rate-limit` | How many requests a sandbox may spend at once |
| `--no-rate-limit`             | —              | Turns it off again when the environment sets the variables |

It is a token bucket keyed by sandbox id, so the budget is per tenant: a project looping
over `/v1/payments/search` cannot starve the others. The whole emulated Mercado Pago
surface counts against the budget — `/v1/`, `/checkout/preferences`, merchant orders,
subscriptions — while the control API under `/_payground/` and the health endpoint do not,
so an operator can still reach a throttled instance. Buckets left idle are dropped, so the
memory the limiter uses tracks the number of *active* sandboxes, not the number that ever
existed.

A single sandbox can be given its own budget with `setLimit(sandboxId, { ratePerSecond,
burst })` on the limiter returned by `createTokenBucketLimiter`, for the tenant that
legitimately needs more (or less) than everyone else. That is a library knob — it is only
reachable when you embed `createApp`/`createServer` yourself, there is no CLI flag and no
control route for it — and the override lives in memory, so a restart returns the sandbox
to the global setting.

A refused request gets `429` with the provider's error envelope and a `Retry-After` in
whole seconds, never zero. That matters for fidelity: the official Mercado Pago SDK lists
`429` in `DEFAULT_RETRY_ON` and honours `Retry-After`, so a client that behaves well in
production backs off here too, which is what keeps a shared staging box usable.

The limiter runs after authentication, so it caps what a *tenant* can spend; it is not a
defence against an unauthenticated flood. Connection limits belong in the reverse proxy.

Pick the burst generously. A checkout flow is several calls back to back (create a
preference, create the payment, poll it), and a burst smaller than that turns a normal
flow into a `429` even though the sustained rate is fine.

## SSRF: webhook targets

Webhook URLs are supplied by whoever creates a payment, and payground connects to them.
That is a server-side request forgery surface, and it is guarded in
`packages/server/src/net/index.ts` by `SafeFetchPolicy`:

- Only `http` and `https`.
- DNS is resolved first, and **every** returned record must pass the address check, so a
  rebinding server that answers with one public and one private address is rejected.
- The connection is made to the validated IP, not to the hostname again, which closes the
  TOCTOU window between resolution and connection.
- Loopback, link-local, private, CGNAT, multicast and reserved ranges are blocked
  (`isBlockedAddress`), in IPv4 and IPv6, including IPv4-mapped forms.
- Responses are capped (1 MiB by default) and the attempt times out after 22 seconds.

The knobs:

| Knob                             | Default            | Effect                                        |
| -------------------------------- | ------------------ | --------------------------------------------- |
| `allowPrivateWebhookTargets` (`createApp`) | `true`    | Self-host escape hatch: delivering to `localhost` is the point |
| `payground start --block-private-webhooks` | —         | Sets it to `false`: user-supplied URLs can no longer reach internal services |
| `SafeFetchPolicy.allowlist`      | empty              | Hostnames always permitted even when private   |
| `SafeFetchPolicy.maxResponseBytes` | 1 MiB            | Cap on the response payground reads back       |

**Run a public instance with `--block-private-webhooks`.** Without it, any user of your
instance can point `notification_url` at your metadata service or an internal admin panel
and read the first kilobytes of the response from the delivery log.

If a shared deployment still needs one internal target — a staging receiver, say — the
allowlist is the narrow tool for it; it is exposed programmatically through `createApp`,
not on the command line, because an allowlist entry is a deliberate hole.

## Operating notes

- **Health:** `GET /_payground/health` returns `{"status":"ok","version":…,"uptime_ms":…}`.
  It never touches the database, so it answers even under load; it is a liveness probe,
  not a readiness probe.
- **Faults on purpose:** the fault profile (latency, error rate, unavailability, duplicate
  and failing webhooks) is per sandbox and persisted. A tenant that leaves `unavailable`
  on will keep getting `503` after a restart; that is deliberate, and clearing it is a
  `PUT /_payground/sandboxes/{id}/faults` away.
- **Webhook retries** are attempted by a background runner every second, so a stopped
  instance simply resumes the queue when it comes back.
- **Logs** go to stdout, which is where a container runtime wants them.
