import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Sandbox, type WebhookDelivery, sandboxId } from '@payground/core';
import { ManualClock, SeededIdGenerator, SeededRandom } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { enqueue } from './enqueue.ts';
import { DEFAULT_LEASE_MS, claim, databaseOf, leaseOf, release, renew } from './lease.ts';
import { drain } from './runner.ts';

const sandbox: Sandbox = {
  id: sandboxId('s1'),
  name: 's1',
  accessToken: 'TEST-a',
  publicKey: 'TEST-p',
  webhookSecret: 'secret',
  liveMode: false,
  createdAt: 0,
};

const NOW = 1_000;

const files: string[] = [];
const closing: Storage[] = [];
afterEach(() => {
  for (const storage of closing.splice(0)) storage.close();
  for (const file of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }
});

function open(path?: string): Storage {
  const storage = Storage.open(path === undefined ? {} : { path });
  closing.push(storage);
  if (storage.sandboxes.list().length === 0) storage.sandboxes.create(sandbox);
  return storage;
}

function tempFile(name: string): string {
  const path = join(tmpdir(), `payground-lease-${name}-${process.pid}.sqlite`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  files.push(path);
  return path;
}

function queueOne(storage: Storage, url: string, now = NOW): WebhookDelivery {
  return enqueue({
    store: storage.forSandbox(sandbox.id),
    sandbox,
    ids: new SeededIdGenerator(),
    notice: { type: 'payment', action: 'payment.updated', dataId: '1', notificationUrl: url },
    now,
    collectorId: 7,
  }) as WebhookDelivery;
}

describe('delivery leasing', () => {
  test('a claimed delivery is invisible to another owner until the lease expires', () => {
    const storage = open();
    const db = databaseOf(storage.queue);
    const delivery = queueOne(storage, 'https://example.com/hook');

    expect(claim(db, { now: NOW, limit: 10, owner: 'a' })).toEqual([
      { sandbox: sandbox.id, id: delivery.id, owner: 'a', until: NOW + DEFAULT_LEASE_MS },
    ]);
    expect(claim(db, { now: NOW, limit: 10, owner: 'b' })).toEqual([]);
    expect(leaseOf(db, { sandbox: sandbox.id, id: delivery.id })).toEqual({
      until: NOW + DEFAULT_LEASE_MS,
      by: 'a',
    });

    // Still held one millisecond before it lapses, free once it has.
    expect(claim(db, { now: NOW + DEFAULT_LEASE_MS - 1, limit: 10, owner: 'b' })).toEqual([]);
    expect(claim(db, { now: NOW + DEFAULT_LEASE_MS, limit: 10, owner: 'b' })).toHaveLength(1);
    expect(leaseOf(db, { sandbox: sandbox.id, id: delivery.id })?.by).toBe('b');
  });

  test('release makes the delivery claimable again at once', () => {
    const storage = open();
    const db = databaseOf(storage.queue);
    queueOne(storage, 'https://example.com/hook');

    const lease = claim(db, { now: NOW, limit: 10, owner: 'a' })[0];
    expect(lease).toBeDefined();
    release(db, lease as NonNullable<typeof lease>);
    expect(leaseOf(db, lease as NonNullable<typeof lease>)).toEqual({ until: null, by: null });
    expect(claim(db, { now: NOW, limit: 10, owner: 'b' })).toHaveLength(1);
  });

  test('a lapsed holder can neither renew nor free its successor lease', () => {
    const storage = open();
    const db = databaseOf(storage.queue);
    queueOne(storage, 'https://example.com/hook');

    const stale = claim(db, { now: NOW, limit: 10, owner: 'a', leaseMs: 100 })[0] as NonNullable<
      ReturnType<typeof claim>[number]
    >;
    const taken = claim(db, { now: NOW + 100, limit: 10, owner: 'b' })[0] as typeof stale;
    expect(taken.owner).toBe('b');

    expect(renew(db, stale, NOW + 100)).toBeNull();
    release(db, stale);
    expect(leaseOf(db, stale)).toEqual({ until: taken.until, by: 'b' });
  });

  test('renewing keeps the delivery claimed past the original expiry', () => {
    const storage = open();
    const db = databaseOf(storage.queue);
    queueOne(storage, 'https://example.com/hook');

    const lease = claim(db, { now: NOW, limit: 10, owner: 'a', leaseMs: 100 })[0] as NonNullable<
      ReturnType<typeof claim>[number]
    >;
    const renewed = renew(db, lease, NOW + 50, 100);
    expect(renewed?.until).toBe(NOW + 150);
    expect(claim(db, { now: NOW + 100, limit: 10, owner: 'b' })).toEqual([]);
    expect(claim(db, { now: NOW + 150, limit: 10, owner: 'b' })).toHaveLength(1);
  });

  test('a delivery stranded in sending by a crashed instance is reclaimed once the lease lapses', () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const db = databaseOf(storage.queue);
    const delivery = queueOne(storage, 'https://example.com/hook');

    claim(db, { now: NOW, limit: 10, owner: 'crashed', leaseMs: 100 });
    store.webhooks.update({ ...delivery, status: 'sending', updatedAt: NOW });

    expect(claim(db, { now: NOW + 50, limit: 10, owner: 'b' })).toEqual([]);
    expect(claim(db, { now: NOW + 100, limit: 10, owner: 'b' })).toEqual([
      { sandbox: sandbox.id, id: delivery.id, owner: 'b', until: NOW + 100 + DEFAULT_LEASE_MS },
    ]);
  });

  test('a delivery that is not due yet is never claimed', () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const db = databaseOf(storage.queue);
    const delivery = queueOne(storage, 'https://example.com/hook');
    store.webhooks.update({ ...delivery, status: 'retrying', nextAttemptAt: NOW + 5_000, updatedAt: NOW });

    expect(claim(db, { now: NOW, limit: 10, owner: 'a' })).toEqual([]);
    expect(claim(db, { now: NOW + 5_000, limit: 10, owner: 'a' })).toHaveLength(1);
  });

  test('two storage handles on one file deliver a queued webhook exactly once', async () => {
    const path = tempFile('shared');
    const left = open(path);
    const right = open(path);

    let hits = 0;
    const receiver = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        hits += 1;
        return new Response('ok');
      },
    });

    try {
      queueOne(left, `${receiver.url.origin}/hook`);
      const clock = new ManualClock(NOW);
      const options = { clock, random: new SeededRandom(1), net: { allowPrivateAddresses: true } };
      const counts = await Promise.all([
        drain(left.queue, (ref) => left.forSandbox(ref.sandbox), {
          ...options,
          store: left.forSandbox(sandbox.id),
          owner: 'left',
        }),
        drain(right.queue, (ref) => right.forSandbox(ref.sandbox), {
          ...options,
          store: right.forSandbox(sandbox.id),
          owner: 'right',
        }),
      ]);

      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      expect(hits).toBe(1);
      expect(left.forSandbox(sandbox.id).webhooks.list()[0]?.status).toBe('delivered');
    } finally {
      await receiver.stop(true);
    }
  });

  test('the lease is released once the attempt finishes', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const db = databaseOf(storage.queue);
    const receiver = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });

    try {
      const delivery = queueOne(storage, `${receiver.url.origin}/hook`);
      await drain(storage.queue, () => store, {
        store,
        clock: new ManualClock(NOW),
        random: new SeededRandom(1),
        net: { allowPrivateAddresses: true },
      });
      expect(leaseOf(db, { sandbox: sandbox.id, id: delivery.id })).toEqual({ until: null, by: null });
    } finally {
      await receiver.stop(true);
    }
  });

  test('a delivery whose attempt throws keeps its lease so it can be reclaimed', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const db = databaseOf(storage.queue);
    const delivery = queueOne(storage, 'https://example.com/hook');
    const broken = {
      ...store,
      webhooks: {
        ...store.webhooks,
        get: () => delivery,
        update: () => {
          throw new Error('database went away mid-attempt');
        },
      },
    } as typeof store;

    expect(
      await drain(storage.queue, () => broken, {
        store: broken,
        clock: new ManualClock(NOW),
        random: new SeededRandom(1),
        owner: 'a',
        net: { allowPrivateAddresses: true },
      }),
    ).toBe(0);
    expect(leaseOf(db, { sandbox: sandbox.id, id: delivery.id })?.by).toBe('a');
  });
});
