import { afterEach, describe, expect, test } from 'bun:test';
import type { SandboxId } from '@payground/core';
import { SeededIdGenerator } from '@payground/core/testing.ts';
import type { Storage } from '@payground/storage';
import { startTestServer } from '../testing.ts';
import * as control from './api.ts';

let server: ReturnType<typeof startTestServer> | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

function start() {
  server = startTestServer();
  const ids = new SeededIdGenerator(900_000);
  const storage = server.storage;
  const deps: control.ControlDeps = {
    storage,
    now: () => server?.clock.now() ?? 0,
    uuid: () => ids.uuid(),
    notify: () => undefined,
    audit: storage.audit,
  };
  return { app: server, deps, storage };
}

const actions = (storage: Storage) => storage.audit.search({}).results.map((entry) => entry.action);

const pix = {
  transaction_amount: 100,
  payment_method_id: 'pix',
  payer: { email: 'payer@example.com' },
  notification_url: 'http://127.0.0.1:9/hook',
};

describe('control API audit trail', () => {
  test('records the sandbox lifecycle with an admin actor', () => {
    const { deps, storage } = start();
    const created = control.createSandbox(deps, { name: 'audited' }).body as { id: string };

    const entry = storage.audit.search({ action: 'sandbox.created' }).results[0];
    expect(entry).toMatchObject({ actor: { kind: 'admin' }, target: created.id, sandbox: created.id });
    expect(entry?.detail['name']).toBe('audited');

    control.resetSandbox(deps, created.id);
    control.deleteSandbox(deps, created.id);
    expect(actions(storage)).toEqual(['sandbox.deleted', 'sandbox.reset', 'sandbox.created']);
  });

  test('a failed mutation records nothing', () => {
    const { deps, storage } = start();
    expect(control.resetSandbox(deps, 'missing').status).toBe(404);
    expect(control.deleteSandbox(deps, 'missing').status).toBe(404);
    expect(control.setFaults(deps, 'missing', {}).status).toBe(404);
    expect(control.replayWebhook(deps, 'missing', 'x').status).toBe(404);
    expect(storage.audit.search({}).total).toBe(0);
  });

  test('records fault changes with the profile that was applied', () => {
    const { app, deps, storage } = start();
    control.setFaults(deps, app.sandboxId, { latencyMs: 25, unavailable: true });

    const entry = storage.audit.search({ action: 'faults.updated' }).results[0];
    expect(entry?.detail).toMatchObject({ latencyMs: 25, unavailable: true, errorRate: 0 });
    expect(entry?.sandbox).toBe(app.sandboxId as SandboxId);
  });

  test('records a forced payment transition and a webhook replay', async () => {
    const { app, deps, storage } = start();
    expect((await app.api('POST', '/v1/payments', { body: pix })).status).toBe(201);

    const store = storage.forSandbox(app.sandboxId as SandboxId);
    const paymentId = store.payments.search({}).results[0]?.id ?? '';
    expect(control.actOnPayment(deps, app.sandboxId, paymentId, { type: 'settle' }).status).toBe(200);

    const forced = storage.audit.search({ action: 'payment.forced' }).results[0];
    expect(forced).toMatchObject({ target: paymentId, sandbox: app.sandboxId, actor: { kind: 'admin' } });
    expect(forced?.detail['command']).toBe('settle');
    expect(forced?.detail['from']).toBe('pending');

    const delivery = store.webhooks.list()[0];
    expect(delivery).toBeDefined();
    expect(control.replayWebhook(deps, app.sandboxId, delivery?.id ?? '').status).toBe(200);
    expect(storage.audit.search({ action: 'webhook.replayed' }).results[0]?.target).toBe(delivery?.id);
  });

  test('an invalid transition is not audited', async () => {
    const { app, deps, storage } = start();
    await app.api('POST', '/v1/payments', { body: pix });
    const store = storage.forSandbox(app.sandboxId as SandboxId);
    const paymentId = store.payments.search({}).results[0]?.id ?? '';

    expect(control.actOnPayment(deps, app.sandboxId, paymentId, { type: 'resolve' }).status).toBe(409);
    expect(storage.audit.search({ action: 'payment.forced' }).total).toBe(0);
  });

  test('without an audit log the control API still works', () => {
    const { deps, storage } = start();
    const bare: control.ControlDeps = {
      storage: deps.storage,
      now: deps.now,
      uuid: deps.uuid,
      notify: deps.notify,
    };
    expect(control.createSandbox(bare, { name: 'x' }).status).toBe(201);
    expect(storage.audit.search({}).total).toBe(0);
  });
});
