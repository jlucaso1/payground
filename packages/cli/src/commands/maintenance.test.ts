import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SandboxId, sandboxId, webhookDeliveryId } from '@payground/core';
import { Storage } from '@payground/storage';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

const root = mkdtempSync(join(tmpdir(), 'payground-maintenance-'));
let counter = 0;
const temporary = (name: string): string => join(root, `${++counter}-${name}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function seeded(payments = 6): Promise<{ db: string; sandbox: SandboxId }> {
  const db = temporary('seeded.sqlite');
  const { env } = testEnv({ files: true, now: NOW });
  expect(await main(['seed', '--db', db, '--payments', String(payments), '--seed', '3'], env)).toBe(0);
  const storage = Storage.open({ path: db });
  const sandbox = storage.sandboxes.list()[0];
  if (sandbox === undefined) throw new Error('the seed wrote no sandbox');
  const store = storage.forSandbox(sandbox.id);
  const payment = store.payments.search({ limit: 1 }).results[0];
  if (payment === undefined) throw new Error('the seed wrote no payment');
  store.webhooks.insert({
    id: webhookDeliveryId('wh-1'),
    sandbox: sandbox.id,
    sequence: 1,
    event: 'payment.updated',
    resourceType: 'payment',
    resourceId: payment.id,
    url: 'https://example.test/hook',
    status: 'delivered',
    attempts: 1,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: '{"action":"payment.updated"}',
    lastStatusCode: 200,
    lastError: null,
    responseBody: 'ok',
    nextAttemptAt: null,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
  });
  store.webhooks.recordAttempt(webhookDeliveryId('wh-1'), {
    at: NOW - 2 * DAY,
    statusCode: 200,
    error: null,
    durationMs: 12,
  });
  storage.close();
  return { db, sandbox: sandbox.id };
}

interface Snapshot {
  payments: unknown;
  timelines: unknown;
  refunds: unknown;
  webhooks: unknown;
  attempts: unknown;
}

function readBack(db: string, id: SandboxId): Snapshot {
  const storage = Storage.open({ path: db });
  try {
    const store = storage.forSandbox(id);
    const payments = store.payments.search({ limit: 1000, order: 'asc' }).results;
    return {
      payments,
      timelines: payments.map((payment) => store.payments.timeline(payment.id)),
      refunds: payments.map((payment) => store.refunds.listFor(payment.id)),
      webhooks: store.webhooks.list(1000),
      attempts: store.webhooks.list(1000).map((delivery) => store.webhooks.attempts(delivery.id)),
    };
  } finally {
    storage.close();
  }
}

describe('export', () => {
  test('writes a self-describing document', async () => {
    const { db, sandbox } = await seeded();
    const out = temporary('export.json');
    const { env, out: lines } = testEnv({ files: true, now: NOW });

    expect(await main(['export', '--db', db, '--out', out], env)).toBe(0);
    expect(lines.join('\n')).toContain(`rows to ${out}`);

    const document = (await Bun.file(out).json()) as {
      schema: number;
      exportedAt: number;
      generator: string;
      sandboxes: { sandbox: { id: string }; tables: Record<string, unknown[]> }[];
    };
    expect(document.schema).toBe(1);
    expect(document.exportedAt).toBe(NOW);
    expect(document.generator).toStartWith('payground ');
    expect(document.sandboxes).toHaveLength(1);
    expect(document.sandboxes[0]?.sandbox.id).toBe(sandbox);
    expect(document.sandboxes[0]?.tables['payments']).toHaveLength(6);
    expect(document.sandboxes[0]?.tables['webhook_deliveries']).toHaveLength(1);
    expect(document.sandboxes[0]?.tables['webhook_attempts']).toHaveLength(1);
  });

  test('--sandbox picks one sandbox and an unknown one fails without writing', async () => {
    const { db } = await seeded();
    const out = temporary('missing.json');
    const { env, err } = testEnv({ files: true });
    expect(await main(['export', '--db', db, '--sandbox', 'nope', '--out', out], env)).toBe(1);
    expect(err[0]).toBe('sandbox not found: nope');
    expect(existsSync(out)).toBe(false);
  });

  test('refuses an in-memory database', async () => {
    const { env, err } = testEnv({ files: true });
    expect(await main(['export', '--db', ':memory:'], env)).toBe(1);
    expect(err[0]).toContain('holds nothing between processes');
  });

  test('refuses to create the database it was pointed at', async () => {
    const missing = temporary('absent.sqlite');
    const { env, err } = testEnv({ files: true });
    expect(await main(['export', '--db', missing, '--out', temporary('o.json')], env)).toBe(1);
    expect(err[0]).toBe(`no database at ${missing}`);
    expect(existsSync(missing)).toBe(false);
  });

  test('an unknown option is a usage error', async () => {
    const { env } = testEnv({ files: true });
    expect(await main(['export', '--nope'], env)).toBe(2);
  });
});

describe('import', () => {
  test('round-trips a sandbox into a fresh database', async () => {
    const { db, sandbox } = await seeded();
    const out = temporary('roundtrip.json');
    const restored = temporary('restored.sqlite');
    const { env } = testEnv({ files: true, now: NOW });

    expect(await main(['export', '--db', db, '--out', out], env)).toBe(0);
    expect(await main(['import', '--db', restored, '--in', out], env)).toBe(0);

    expect(readBack(restored, sandbox)).toEqual(readBack(db, sandbox));

    const source = Storage.open({ path: db });
    const target = Storage.open({ path: restored });
    expect(target.sandboxes.get(sandbox)).toEqual(source.sandboxes.get(sandbox));
    source.close();
    target.close();
  });

  test('refuses a corrupt file', async () => {
    const broken = temporary('broken.json');
    await Bun.write(broken, '{"schema": 1, "sandbo');
    const { env, err } = testEnv({ files: true });
    expect(await main(['import', '--db', temporary('t.sqlite'), '--in', broken], env)).toBe(1);
    expect(err[0]).toContain('cannot read the export');
  });

  test('refuses a schema version it does not understand', async () => {
    const future = temporary('future.json');
    await Bun.write(future, JSON.stringify({ schema: 99, sandboxes: [] }));
    const { env, err } = testEnv({ files: true });
    expect(await main(['import', '--db', temporary('t.sqlite'), '--in', future], env)).toBe(1);
    expect(err[0]).toContain('unsupported export schema version 99');
  });

  test('refuses a document that is not an export', async () => {
    const alien = temporary('alien.json');
    await Bun.write(alien, JSON.stringify({ hello: 'world' }));
    const { env, err } = testEnv({ files: true });
    expect(await main(['import', '--db', temporary('t.sqlite'), '--in', alien], env)).toBe(1);
    expect(err[0]).toContain('not a payground export');
  });

  test('refuses a colliding sandbox id unless --replace is passed', async () => {
    const { db, sandbox } = await seeded();
    const out = temporary('collide.json');
    const { env, err } = testEnv({ files: true, now: NOW });
    expect(await main(['export', '--db', db, '--out', out], env)).toBe(0);

    expect(await main(['import', '--db', db, '--in', out], env)).toBe(1);
    expect(err[0]).toContain('already exists; pass --replace');
    expect(readBack(db, sandbox).payments).toHaveLength(6);

    expect(await main(['import', '--db', db, '--in', out, '--replace'], env)).toBe(0);
    expect(readBack(db, sandbox).payments).toHaveLength(6);
  });

  test('--as loads a snapshot next to the original with fresh credentials', async () => {
    const { db, sandbox } = await seeded();
    const out = temporary('as.json');
    const { env, out: lines } = testEnv({ files: true, now: NOW });
    expect(await main(['export', '--db', db, '--out', out], env)).toBe(0);
    expect(await main(['import', '--db', db, '--in', out, '--as', 'copy'], env)).toBe(0);
    expect(lines.join('\n')).toContain('credentials regenerated');

    const storage = Storage.open({ path: db });
    try {
      const original = storage.sandboxes.get(sandbox);
      const copy = storage.sandboxes.get(sandboxId('copy'));
      expect(copy).not.toBeNull();
      expect(copy?.accessToken).not.toBe(original?.accessToken);
      expect(storage.forSandbox(sandboxId('copy')).payments.search({ limit: 1000 }).total).toBe(6);
      expect(storage.forSandbox(sandbox).payments.search({ limit: 1000 }).total).toBe(6);
    } finally {
      storage.close();
    }
  });

  test('--in is required', async () => {
    const { env, err } = testEnv({ files: true });
    expect(await main(['import', '--db', temporary('t.sqlite')], env)).toBe(2);
    expect(err[0]).toBe('--in <file> is required');
  });
});

describe('backup', () => {
  test('writes a snapshot that opens as a database', async () => {
    const { db, sandbox } = await seeded();
    const out = temporary('backup.sqlite');
    const { env, out: lines } = testEnv({ files: true });
    expect(await main(['backup', '--db', db, '--out', out], env)).toBe(0);
    expect(lines[0]).toContain(`bytes to ${out}`);
    expect(readBack(out, sandbox)).toEqual(readBack(db, sandbox));
  });

  test('--out is required', async () => {
    const { env, err } = testEnv({ files: true });
    expect(await main(['backup', '--db', temporary('t.sqlite')], env)).toBe(2);
    expect(err[0]).toBe('--out <file> is required');
  });

  test('refuses to write over the database it reads', async () => {
    const { db } = await seeded();
    const { env, err } = testEnv({ files: true });
    expect(await main(['backup', '--db', db, '--out', db], env)).toBe(2);
    expect(err[0]).toContain('would overwrite the database');
    expect(await main(['backup', '--db', db, '--out', `${db}-wal`], env)).toBe(2);
  });
});

describe('prune', () => {
  async function withLogs(): Promise<{ db: string; sandbox: SandboxId }> {
    const seededDb = await seeded();
    const storage = Storage.open({ path: seededDb.db });
    for (let index = 0; index < 3; index += 1) {
      storage.requests.record({
        id: `req-${index}`,
        at: NOW - (index + 1) * DAY,
        sandbox: seededDb.sandbox,
        method: 'GET',
        route: '/v1/payments',
        path: '/v1/payments',
        status: 200,
        durationMs: 1,
        requestBody: null,
        responseBody: null,
        idempotencyKey: null,
        userAgent: null,
      });
      storage.audit.record({
        id: `audit-${index}`,
        at: NOW - (index + 1) * DAY,
        actor: { kind: 'admin' },
        action: 'sandbox.reset',
        target: 'sandbox',
        sandbox: seededDb.sandbox,
        detail: {},
      });
    }
    storage.close();
    return seededDb;
  }

  test('--dry-run reports without deleting', async () => {
    const { db } = await withLogs();
    const { env, out } = testEnv({ files: true, now: NOW });
    expect(await main(['prune', '--db', db, '--requests', '0', '--audit', '0', '--dry-run'], env)).toBe(0);
    expect(out[0]).toBe('would delete 6 rows');

    const after = testEnv({ files: true, now: NOW });
    expect(await main(['prune', '--db', db, '--requests', '0', '--audit', '0', '--dry-run'], after.env)).toBe(0);
    expect(after.out[0]).toBe('would delete 6 rows');
  });

  test('deletes rows older than the cutoff and reports per table', async () => {
    const { db } = await withLogs();
    const { env, out } = testEnv({ files: true, now: NOW });
    expect(await main(['prune', '--db', db, '--requests', '2'], env)).toBe(0);
    expect(out[0]).toBe('deleted 1 rows');
    expect(out.join('\n')).toContain('api_requests');

    const storage = Storage.open({ path: db });
    expect(storage.requests.search({ limit: 100 }).total).toBe(2);
    storage.close();
  });

  test('pruning payments takes their timeline, refunds and webhooks along', async () => {
    const { db, sandbox } = await withLogs();
    const { env, out } = testEnv({ files: true, now: NOW });
    expect(await main(['prune', '--db', db, '--payments', '0', '--webhooks', '0'], env)).toBe(0);
    expect(out.join('\n')).toContain('payment_events');

    const snapshot = readBack(db, sandbox);
    expect(snapshot.payments).toEqual([]);
    expect(snapshot.webhooks).toEqual([]);
  });

  test('leaves a delivery the runner may still be sending alone', async () => {
    const { db, sandbox } = await seeded();
    const storage = Storage.open({ path: db });
    const delivery = storage.forSandbox(sandbox).webhooks.get(webhookDeliveryId('wh-1'));
    if (delivery === null) throw new Error('the fixture wrote no delivery');
    storage.forSandbox(sandbox).webhooks.update({ ...delivery, status: 'retrying' });
    storage.close();

    const { env } = testEnv({ files: true, now: NOW });
    expect(await main(['prune', '--db', db, '--webhooks', '0'], env)).toBe(0);
    expect(readBack(db, sandbox).webhooks).toHaveLength(1);
  });

  test('needs at least one selector', async () => {
    const { env, err } = testEnv({ files: true });
    expect(await main(['prune', '--db', temporary('t.sqlite')], env)).toBe(2);
    expect(err[0]).toContain('nothing to prune');
  });

  test('rejects a non-numeric age', async () => {
    const { env, err } = testEnv({ files: true });
    expect(await main(['prune', '--db', temporary('t.sqlite'), '--requests', 'soon'], env)).toBe(2);
    expect(err[0]).toContain('--requests must be an integer');
  });
});

describe('start --retention-days', () => {
  test('prunes on boot', async () => {
    const { db } = await seeded();
    const storage = Storage.open({ path: db });
    storage.requests.record({
      id: 'old',
      at: NOW - 30 * DAY,
      sandbox: null,
      method: 'GET',
      route: '/v1/payments',
      path: '/v1/payments',
      status: 200,
      durationMs: 1,
      requestBody: null,
      responseBody: null,
      idempotencyKey: null,
      userAgent: null,
    });
    storage.close();

    const { env, out } = testEnv({ files: true, now: NOW });
    expect(await main(['start', '--port', '0', '--db', db, '--retention-days', '7'], env)).toBe(0);
    expect(out.join('\n')).toContain('retention       7 days');
    expect(out.join('\n')).toContain('pruned 1 rows older than 7 days');

    const after = Storage.open({ path: db });
    expect(after.requests.search({ limit: 10 }).total).toBe(0);
    after.close();
  });

  test('is a no-op on an in-memory database', async () => {
    const { env, out } = testEnv({ files: true, now: NOW });
    expect(await main(['start', '--port', '0', '--db', ':memory:', '--retention-days', '7'], env)).toBe(0);
    expect(out.join('\n')).toContain('keeps nothing to prune');
  });

  test('rejects an invalid age', async () => {
    const { env, err } = testEnv({ files: true });
    expect(await main(['start', '--port', '0', '--retention-days', '0'], env)).toBe(2);
    expect(err[0]).toContain('--retention-days must be an integer');
  });
});
