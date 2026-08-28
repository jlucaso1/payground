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
];
