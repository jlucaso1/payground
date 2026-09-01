export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
create table sandboxes (
  id text primary key,
  name text not null,
  access_token text not null unique,
  public_key text not null unique,
  webhook_secret text not null,
  live_mode integer not null,
  created_at integer not null
) strict;

create table counters (
  sandbox_id text not null references sandboxes(id) on delete cascade,
  scope text not null,
  value integer not null,
  primary key (sandbox_id, scope)
) strict;

create table payments (
  sandbox_id text not null references sandboxes(id) on delete cascade,
  id text not null,
  sequence integer not null,
  state text not null,
  reason text not null,
  method_kind text not null,
  method_code text not null,
  card text,
  payer_email text not null,
  payer_first_name text,
  payer_last_name text,
  payer_document_type text,
  payer_document_number text,
  amount integer not null,
  captured_amount integer not null,
  refunded_amount integer not null,
  currency text not null,
  installments integer not null,
  binary_mode integer not null,
  capture_on_create integer not null,
  description text,
  external_reference text,
  notification_url text,
  metadata text not null,
  created_at integer not null,
  updated_at integer not null,
  settled_at integer,
  expires_at integer,
  primary key (sandbox_id, id)
) strict;

create unique index payments_sequence on payments (sandbox_id, sequence);
create index payments_state on payments (sandbox_id, state, created_at);
create index payments_external_reference on payments (sandbox_id, external_reference);
create index payments_expiry on payments (sandbox_id, expires_at) where expires_at is not null;

create table payment_events (
  sandbox_id text not null,
  payment_id text not null,
  seq integer not null,
  at integer not null,
  command text not null,
  from_state text not null,
  from_reason text not null,
  to_state text not null,
  to_reason text not null,
  primary key (sandbox_id, payment_id, seq),
  foreign key (sandbox_id, payment_id) references payments (sandbox_id, id) on delete cascade
) strict;

create table refunds (
  sandbox_id text not null references sandboxes(id) on delete cascade,
  id text not null,
  sequence integer not null,
  payment_id text not null,
  amount integer not null,
  status text not null,
  partial integer not null,
  created_at integer not null,
  primary key (sandbox_id, id),
  foreign key (sandbox_id, payment_id) references payments (sandbox_id, id) on delete cascade
) strict;

create unique index refunds_sequence on refunds (sandbox_id, sequence);
create index refunds_payment on refunds (sandbox_id, payment_id);

create table idempotency (
  sandbox_id text not null references sandboxes(id) on delete cascade,
  key text not null,
  fingerprint text not null,
  status integer not null,
  body text not null,
  created_at integer not null,
  primary key (sandbox_id, key)
) strict;
`,
  },
  {
    version: 2,
    name: 'documents-webhooks-timers',
    sql: `
create table documents (
  sandbox_id text not null references sandboxes(id) on delete cascade,
  kind text not null,
  id text not null,
  sequence integer not null,
  status text not null,
  external_reference text,
  lookup text,
  created_at integer not null,
  updated_at integer not null,
  expires_at integer,
  doc text not null,
  primary key (sandbox_id, kind, id)
) strict;

create unique index documents_sequence on documents (sandbox_id, kind, sequence);
create index documents_status on documents (sandbox_id, kind, status, created_at);
create index documents_external_reference on documents (sandbox_id, kind, external_reference);
create index documents_lookup on documents (sandbox_id, kind, lookup);

create table webhook_deliveries (
  sandbox_id text not null references sandboxes(id) on delete cascade,
  id text not null,
  sequence integer not null,
  event text not null,
  resource_type text not null,
  resource_id text not null,
  url text not null,
  status text not null,
  attempts integer not null,
  request_headers text not null,
  request_body text not null,
  last_status_code integer,
  last_error text,
  response_body text,
  next_attempt_at integer,
  created_at integer not null,
  updated_at integer not null,
  primary key (sandbox_id, id)
) strict;

create index webhook_pending on webhook_deliveries (status, next_attempt_at);
create index webhook_by_resource on webhook_deliveries (sandbox_id, resource_id);

create table webhook_attempts (
  sandbox_id text not null,
  delivery_id text not null,
  seq integer not null,
  at integer not null,
  status_code integer,
  error text,
  duration_ms integer not null,
  primary key (sandbox_id, delivery_id, seq),
  foreign key (sandbox_id, delivery_id) references webhook_deliveries (sandbox_id, id) on delete cascade
) strict;

create table fault_profiles (
  sandbox_id text primary key references sandboxes(id) on delete cascade,
  latency_ms integer not null,
  error_rate real not null,
  unavailable integer not null,
  duplicate_webhooks integer not null,
  webhook_failure_rate real not null
) strict;
`,
  },
  {
    version: 3,
    name: 'audit-history-leases',
    sql: `
create table audit_log (
  id text primary key,
  at integer not null,
  actor_kind text not null,
  actor_sandbox text,
  action text not null,
  target text not null,
  sandbox_id text,
  detail text not null
) strict;

create index audit_by_time on audit_log (at desc);
create index audit_by_sandbox on audit_log (sandbox_id, at desc);
create index audit_by_action on audit_log (action, at desc);

create table api_requests (
  id text primary key,
  at integer not null,
  sandbox_id text,
  method text not null,
  route text not null,
  path text not null,
  status integer not null,
  duration_ms integer not null,
  request_body text,
  response_body text,
  idempotency_key text,
  user_agent text
) strict;

create index api_requests_by_time on api_requests (at desc);
create index api_requests_by_sandbox on api_requests (sandbox_id, at desc);
create index api_requests_by_route on api_requests (route, at desc);
create index api_requests_by_status on api_requests (status, at desc);

-- Lease so two processes sharing a database cannot deliver the same webhook twice.
alter table webhook_deliveries add column leased_until integer;
alter table webhook_deliveries add column leased_by text;

create index webhook_lease on webhook_deliveries (status, next_attempt_at, leased_until);
`,
  },
];
