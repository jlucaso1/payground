import { expect, test } from 'bun:test';
import { type Sandbox, sandboxId } from '@payground/core';
import { SeededIdGenerator, SeededRandom } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { enqueue } from './enqueue.ts';
import { type Lease, claim, databaseOf, leaseOf, release, renew } from './lease.ts';

const SEED = 20_260_901;
const OWNERS = ['a', 'b', 'c', 'd'] as const;
const DELIVERIES = 8;
const STEPS = 400;

const sandbox: Sandbox = {
  id: sandboxId('s1'),
  name: 's1',
  accessToken: 'TEST-a',
  publicKey: 'TEST-p',
  webhookSecret: 'secret',
  liveMode: false,
  createdAt: 0,
};

/**
 * Deliveries are never attempted here, so they stay due for the whole run: every step the
 * whole set is eligible and only the lease decides who may take it.
 */
test('leases never overlap and always come back after they expire', () => {
  const storage = Storage.open();
  storage.sandboxes.create(sandbox);
  const store = storage.forSandbox(sandbox.id);
  const db = databaseOf(storage.queue);
  const ids = new SeededIdGenerator();
  const random = new SeededRandom(SEED);

  for (let i = 0; i < DELIVERIES; i++) {
    enqueue({
      store,
      sandbox,
      ids,
      notice: { type: 'payment', action: 'payment.updated', dataId: String(i), notificationUrl: 'https://example.com/hook' },
      now: 0,
      collectorId: 7,
    });
  }

  const held = new Map<string, Lease>();
  let now = 0;
  let claims = 0;

  for (let step = 0; step < STEPS; step++) {
    now += random.int(200);
    const owner = OWNERS[random.int(OWNERS.length)] as string;
    const action = random.int(12);

    if (action < 6) {
      const leaseMs = 50 + random.int(400);
      for (const ref of claim(db, { now, limit: 1 + random.int(3), owner, leaseMs })) {
        const current = held.get(ref.id);
        // Nobody may hold a live lease on a delivery another owner just claimed.
        expect(current === undefined || current.until <= now).toBe(true);
        held.set(ref.id, ref);
        claims += 1;
      }
    } else if (action < 8) {
      const mine = [...held].filter(([, lease]) => lease.owner === owner);
      const entry = mine[random.int(Math.max(mine.length, 1))];
      if (entry !== undefined) {
        // A holder whose lease was taken over cannot renew; the shadow then keeps the
        // successor's entry, which the next claim must still respect.
        const renewed = renew(db, entry[1], now, 50 + random.int(400));
        if (renewed !== null) held.set(entry[0], renewed);
      }
    } else if (action < 10) {
      const mine = [...held].filter(([, lease]) => lease.owner === owner);
      const entry = mine[random.int(Math.max(mine.length, 1))];
      if (entry !== undefined) {
        release(db, entry[1]);
        held.delete(entry[0]);
      }
    } else {
      // A crash: the leases stay live in the database until they lapse, but nobody
      // will ever release them, so the shadow keeps them under an owner that is gone.
      for (const [id, lease] of held) {
        if (lease.owner === owner) held.set(id, { ...lease, owner: `${owner}-crashed` });
      }
    }
  }

  expect(claims).toBeGreaterThan(DELIVERIES);

  // Once every lease has lapsed, all of them are claimable again by a fresh owner.
  const after = Math.max(now, ...[...held.values()].map((lease) => lease.until)) + 1;
  const reclaimed = claim(db, { now: after, limit: DELIVERIES, owner: 'e' });
  expect(reclaimed).toHaveLength(DELIVERIES);
  for (const ref of reclaimed) expect(leaseOf(db, ref)?.by).toBe('e');

  storage.close();
});
