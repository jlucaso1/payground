import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SandboxId, webhookDeliveryId } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

const root = mkdtempSync(join(tmpdir(), 'payground-maintenance-fuzz-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SEED = 20260901;
const NOW = 1_700_000_000_000;
const ROUNDS = 8;

/** Everything an export must carry, beyond what the seed command writes. */
function decorate(path: string, sandbox: SandboxId, random: SeededRandom): void {
  const storage = Storage.open({ path });
  try {
    const store = storage.forSandbox(sandbox);
    const payments = store.payments.search({ limit: 1000 }).results;
    for (let index = 0; index < random.int(5); index += 1) {
      const payment = payments[random.int(payments.length)];
      if (payment === undefined) break;
      const id = webhookDeliveryId(`wh-${index}`);
      store.webhooks.insert({
        id,
        sandbox,
        sequence: index + 1,
        event: 'payment.updated',
        resourceType: 'payment',
        resourceId: payment.id,
        url: `https://example.test/hook/${random.int(1000)}`,
        status: random.int(2) === 0 ? 'delivered' : 'retrying',
        attempts: 1,
        requestHeaders: { 'x-signature': `v1=${random.int(1_000_000)}` },
        requestBody: JSON.stringify({ action: 'payment.updated', data: { id: payment.id } }),
        lastStatusCode: random.int(2) === 0 ? 200 : null,
        lastError: random.int(2) === 0 ? null : 'connection refused',
        responseBody: random.int(2) === 0 ? null : 'ok',
        nextAttemptAt: random.int(2) === 0 ? null : NOW + random.int(10_000),
        createdAt: NOW - random.int(100_000),
        updatedAt: NOW,
      });
      for (let attempt = 0; attempt <= random.int(3); attempt += 1) {
        store.webhooks.recordAttempt(id, {
          at: NOW - random.int(50_000),
          statusCode: random.int(2) === 0 ? 500 : null,
          error: random.int(2) === 0 ? 'timeout' : null,
          durationMs: random.int(400),
        });
      }
    }
    for (let index = 0; index < random.int(4); index += 1) {
      store.documents.insert({
        kind: 'preference',
        id: `pref-${index}`,
        sequence: index + 1,
        status: 'active',
        externalReference: random.int(2) === 0 ? null : `order-${random.int(500)}`,
        lookup: null,
        createdAt: NOW - random.int(100_000),
        updatedAt: NOW,
        expiresAt: random.int(2) === 0 ? null : NOW + random.int(100_000),
        doc: { items: [{ title: `item ${random.int(50)}`, quantity: 1 }] },
      });
    }
    store.faults.set({
      latencyMs: random.int(500),
      errorRate: random.int(100) / 100,
      unavailable: random.int(2) === 0,
      duplicateWebhooks: random.int(2) === 0,
      webhookFailureRate: random.int(100) / 100,
    });
  } finally {
    storage.close();
  }
}

test('export and import round-trip a randomly seeded sandbox exactly', async () => {
  const random = new SeededRandom(SEED);

  for (let round = 0; round < ROUNDS; round += 1) {
    const source = join(root, `${round}-source.sqlite`);
    const restored = join(root, `${round}-restored.sqlite`);
    const first = join(root, `${round}-first.json`);
    const second = join(root, `${round}-second.json`);

    const { env, err } = testEnv({ files: true, now: NOW });
    const payments = 1 + random.int(20);
    expect(await main(['seed', '--db', source, '--payments', String(payments), '--seed', String(random.int(1000))], env)).toBe(0);

    const storage = Storage.open({ path: source });
    const sandbox = storage.sandboxes.list()[0]?.id;
    storage.close();
    if (sandbox === undefined) throw new Error('the seed wrote no sandbox');
    decorate(source, sandbox, random);

    expect(await main(['export', '--db', source, '--out', first], env)).toBe(0);
    expect(await main(['import', '--db', restored, '--in', first], env)).toBe(0);
    expect(await main(['export', '--db', restored, '--out', second], env)).toBe(0);
    expect(err).toEqual([]);

    expect(await Bun.file(second).text()).toBe(await Bun.file(first).text());
  }
});
