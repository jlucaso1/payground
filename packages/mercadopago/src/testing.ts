import { type Sandbox, sandboxId } from '@payground/core';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import type { EventNotice, ServiceContext } from './api/context.ts';

export interface TestHarness {
  context: ServiceContext;
  clock: ManualClock;
  sandbox: Sandbox;
  events: EventNotice[];
}

/** Test-only: a real sqlite-backed ServiceContext with a deterministic clock and ids. */
export function testContext(now = 1_700_000_000_000): TestHarness {
  const storage = Storage.open();
  const clock = new ManualClock(now);
  const ids = new SeededIdGenerator();
  const sandbox: Sandbox = {
    id: sandboxId(ids.uuid()),
    name: 'test',
    accessToken: 'TEST-token',
    publicKey: 'TEST-public',
    webhookSecret: 'secret',
    liveMode: false,
    createdAt: now,
  };
  storage.sandboxes.create(sandbox);

  const events: EventNotice[] = [];
  return {
    clock,
    sandbox,
    events,
    context: {
      store: storage.forSandbox(sandbox.id),
      sandbox,
      clock,
      ids,
      baseUrl: 'http://127.0.0.1:8080',
      collectorId: 123456789,
      events: { emit: (notice) => events.push(notice) },
    },
  };
}
