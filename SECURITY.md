# Security Policy

payground emulates the Mercado Pago API so you can develop and test against something that
behaves like the real thing. It is a test double. It is not PCI compliant, it must never sit
in front of real money, and no real card number, real credential or real personal data should
ever be sent to it. Use the documented test cards instead.

## Supported versions

The project is at 0.1.0 and pre-1.0. Only the latest release receives security fixes. There
are no backports to earlier tags. If you are running an older build, upgrade first and check
whether the issue still reproduces.

## Reporting a vulnerability

Report privately. Do not open a public issue.

- Preferred: GitHub Security Advisories on `jlucaso1/payground`, through the Security tab,
  "Report a vulnerability".
- Alternative: gustavolopes2013.gl@gmail.com.

Include a description of the flaw, the steps or a script that reproduces it, the payground
version and flags the instance was started with, and what an attacker gains. A minimal
reproduction against a local instance is worth more than a scanner report.

This is a single-maintainer project. Expect an acknowledgement within about a week and an
assessment within about two weeks. Fixes ship in the next release, and you will be credited
in the advisory unless you ask otherwise. There is no bug bounty and no payment.

Never include real card numbers, real access tokens or real personal data in a report or in
an issue. If you found such data in a public instance, say that it exists and where, without
pasting it.

## In scope

- **Authentication bypass on the control API.** Everything under `/_payground/`, apart from
  `/_payground/health` and the dashboard shell, is wrapped by `admin` in
  `packages/server/src/app.ts`, which calls `requireAdmin` in
  `packages/server/src/control/auth.ts`. The token is compared with `timingSafeEqual` after a
  length check, and is accepted as a `Bearer` header, an `x-payground-admin-token` header or
  an `admin_token` query parameter. Any route under `/_payground/` that answers without a
  valid token, any way to make the comparison succeed without knowing the token, or any leak
  of the token itself is in scope. The token is generated with `crypto.randomUUID()` at boot
  unless `--admin-token` or `PAYGROUND_ADMIN_TOKEN` is given, or `--no-admin-token` turns the
  gate off (`packages/cli/src/commands/start.ts`).
- **SSRF or request forgery through webhook delivery.** `safeFetch` in
  `packages/server/src/net/index.ts` restricts the scheme to `http` and `https`, resolves the
  hostname with `dns.lookup({ all: true })`, and requires every returned A and AAAA record to
  pass `isBlockedAddress` in `packages/server/src/net/address.ts`. That classifier rejects
  loopback, `0.0.0.0/8`, RFC 1918 ranges, link-local, CGNAT `100.64.0.0/10`, multicast,
  `240.0.0.0/4`, the broadcast address, `::`, `::1`, unique-local `fc00::/7`, link-local
  `fe80::/10`, IPv6 multicast, and IPv4 addresses hidden inside IPv6 through the IPv4-mapped,
  IPv4-compatible and NAT64 `64:ff9b::/96` forms. The socket is then opened against the
  address that was validated, with the hostname passed only as the TLS `serverName`, so a
  second DNS answer cannot swap the destination between the check and the connection. Report
  any input that reaches a host the classifier should have rejected, any parser trick that
  slips an address past `parseIPv4` or `parseIPv6`, and any way to splice a second request
  into the connection through the method, the path or a header (`packages/server/src/net/http.ts`
  builds the request line by hand and `isValidMethod` guards it).
- **Webhook signatures that should not verify.** `packages/mercadopago/src/webhook/signature.ts`
  builds the `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` manifest and signs it with
  HMAC-SHA256 over the sandbox's webhook secret. A signature that the official
  `mercadopago` SDK validator accepts while payground did not produce it, a manifest that can
  be forged by choosing header values, or a way to read a sandbox's webhook secret without the
  admin token, are all in scope.
- **Data leaking across sandbox boundaries.** A sandbox is a tenant with its own access token,
  public key, webhook secret and rows. A request authenticated for one sandbox that reads or
  mutates another sandbox's data is a bug worth reporting.
- **Secrets in the request history or the audit trail.** `packages/server/src/routes/control-history.ts`
  redacts recorded request and response bodies before returning them: keys matching
  `number`, `card_number`, `security_code`, `cvv`, `cvc`, `password` or anything ending in
  `secret` or `token` become `[redacted]`, and free text is scanned for digit runs of 13 to 19
  digits that pass Luhn. If a card number, an access token or a webhook secret survives that
  pass and reaches `/_payground/requests/:id` or `/_payground/audit`, report it.
- **Path traversal in the file endpoints.** The dashboard is served from disk by
  `packages/server/src/dashboard.ts`, which strips the `/_payground/` prefix and refuses any
  path containing `..`. A request that reads a file outside the dashboard root is in scope.
- Anything that lets payground be used as a relay to attack a third party, or that gives
  remote code execution on the host.

## Out of scope

payground is a test double, so some things that look alarming are the design.

- **Test card metadata is stored in plain SQLite.** Tokenisation in
  `packages/mercadopago/src/api/card-tokens.ts` keeps only the first six digits, the last four,
  the expiry, the brand and the cardholder. The full PAN is never written anywhere. There is
  no encryption at rest for what remains, and there is not meant to be: it is fake data from
  the published test cards.
- **Webhook targets on private addresses are allowed by default.** `allowPrivateWebhookTargets`
  defaults to `true` in `packages/server/src/app.ts` because the normal case is delivering to
  `http://localhost:3000/webhooks` on your own machine. Start with `--block-private-webhooks`
  to switch the classifier on for a shared or internet-facing instance. A report that says
  "payground delivers to 127.0.0.1" is describing the default, not a flaw.
- **An open control API on a public instance.** `--no-admin-token` leaves the gate off and
  says so on the startup line for the admin token. Choosing that, or putting the instance on
  the internet without a proxy in front, is a deployment decision.
- **Denial of service against a local emulator.** Resource exhaustion, slow requests, large
  bodies and unbounded growth of the request history are not treated as vulnerabilities. Rate
  limiting is off by default on purpose, and retention is pruned with `payground prune`.
- **Missing TLS.** payground speaks plain HTTP and has no TLS configuration. Terminate TLS in
  a reverse proxy.
- Differences between payground and the real Mercado Pago API. Those are fidelity issues:
  see [FIDELITY.md](FIDELITY.md) and open a normal issue.
- Findings from an automated scanner with no working reproduction against payground.

## Hardening a shared instance

If more than one person can reach your instance, work through
[DEPLOY.md](DEPLOY.md) and check the following.

1. Keep the admin token. Do not pass `--no-admin-token`. Set `PAYGROUND_ADMIN_TOKEN` to a
   value you control rather than reading the generated one out of the startup log, and treat
   it as a secret: it can read every sandbox's credentials and force any payment to approved.
2. Start with `--block-private-webhooks` so webhook delivery cannot reach the rest of your
   network.
3. Start with `--no-bootstrap` so no default sandbox exists with credentials printed in a log
   that others may read. Create one sandbox per team or per pull request and delete it
   afterwards.
4. Bind to `127.0.0.1` and put a reverse proxy in front that terminates TLS. Leave
   `/_payground/health` reachable for probes.
5. Set `--base-url` to the origin clients actually reach, so Pix payloads and ticket URLs are
   not pointing somewhere else.
6. Prune the request history and the audit trail, with `--retention-days` or a scheduled
   `payground prune`. Recorded bodies are redacted, not absent.
7. Turn on `--rate-limit` if the instance is exposed.

## What payground is for

Local development, CI and shared staging. Fake credentials, fake cards, disposable data.
See [README.md](README.md) for what it emulates. If real money or real cardholder data is
anywhere near it, stop and remove it.
