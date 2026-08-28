import { afterEach, describe, expect, test } from 'bun:test';
import {
  type JsonValue,
  type Payment,
  type PaymentDecision,
  apply,
  create,
  minor,
  paymentId,
  sandboxId,
  unwrap,
} from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { CARD, PIX, input } from '@payground/core/payment/fixture.ts';
import type { Storage } from './index.ts';
import { storageWith } from './fixture.ts';

let storage: Storage;
afterEach(() => storage.close());

const TEXT = ['', 'plain', "quote'and\"double", 'emoji 🧾 ok', 'ünïcödé', 'line\nbreak', 'null', '  spaced  '];

function json(rng: SeededRandom, depth = 0): JsonValue {
  const pick = rng.int(depth > 2 ? 5 : 7);
  switch (pick) {
    case 0:
      return TEXT[rng.int(TEXT.length)] as string;
    case 1:
      return rng.int(1_000_000) - 500_000;
    case 2:
      return rng.int(2) === 0;
    case 3:
      return null;
    case 4:
      return rng.int(1000) / 8;
    case 5:
      return Array.from({ length: rng.int(4) }, () => json(rng, depth + 1));
    default: {
      const out: Record<string, JsonValue> = {};
      for (let i = 0; i < rng.int(4); i++) out[`k${rng.int(20)}`] = json(rng, depth + 1);
      return out;
    }
  }
}

const DECISIONS: PaymentDecision[] = [
  { kind: 'settle' },
  { kind: 'authorize' },
  { kind: 'pending', reason: 'awaiting_payer' },
  { kind: 'pending', reason: 'awaiting_challenge' },
  { kind: 'review', reason: 'offline' },
  { kind: 'decline', reason: 'blacklisted' },
];

function random(rng: SeededRandom, index: number): Payment {
  const nullable = <T>(value: T): T | null => (rng.int(4) === 0 ? null : value);
  const created = 1_000 + rng.int(100_000);
  const metadata = json(rng, 2);
  return unwrap(
    create(
      input({
        id: paymentId(`p-${index}`),
        sandbox: sandboxId('a'),
        method: rng.int(2) === 0 ? PIX : CARD,
        amount: unwrap(minor(1 + rng.int(9_999_999))),
        currency: (['BRL', 'ARS', 'MXN'] as const)[rng.int(3)] as string,
        installments: 1 + rng.int(12),
        binaryMode: false,
        captureOnCreate: rng.int(2) === 0,
        description: nullable(TEXT[rng.int(TEXT.length)] as string),
        externalReference: nullable(`ref-${rng.int(1000)}`),
        notificationUrl: nullable('https://example.com/hook?a=1&b=2'),
        metadata: typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata : {},
        expiresAt: nullable(created + 1 + rng.int(100_000)),
        payer: {
          email: `p${rng.int(500)}@example.com`,
          firstName: nullable(TEXT[rng.int(TEXT.length)] as string),
          lastName: nullable('Silva'),
          documentType: nullable('CPF'),
          documentNumber: nullable('12345678909'),
        },
      }),
      DECISIONS[rng.int(DECISIONS.length)] as PaymentDecision,
      created,
    ),
  );
}

describe('persistence round trip', () => {
  test('survives 1500 randomly shaped payments unchanged', () => {
    const made = storageWith('a');
    storage = made.storage;
    const store = storage.forSandbox(sandboxId('a'));
    const rng = new SeededRandom(4242);

    for (let i = 0; i < 1_500; i++) {
      const original = random(rng, i);
      store.payments.insert(original, i + 1);
      expect(store.payments.get(original.id)).toEqual(original);
    }
    expect(store.payments.search({}).total).toBe(1_500);
  });

  test('every reachable status persists and reads back identically', () => {
    const made = storageWith('a');
    storage = made.storage;
    const store = storage.forSandbox(sandboxId('a'));
    const rng = new SeededRandom(99);
    const seen = new Set<string>();

    for (let i = 0; i < 800; i++) {
      let current = random(rng, i);
      store.payments.insert(current, i + 1);

      for (let step = 0; step < 6; step++) {
        const commands = [
          { type: 'settle' },
          { type: 'decline', reason: 'timeout' },
          { type: 'cancel', by: 'collector' },
          { type: 'capture', amount: null },
          { type: 'refund', amount: current.capturedAmount },
          { type: 'dispute' },
          { type: 'resolve', outcome: 'chargeback' },
          { type: 'review', reason: 'manual_review' },
        ] as const;
        const result = apply(current, commands[rng.int(commands.length)] as never, current.updatedAt + 1);
        if (!result.ok) continue;
        current = result.value.payment;
        store.payments.update(current);
        store.payments.record(result.value);
        seen.add(`${current.status.state}/${current.status.reason}`);
        expect(store.payments.get(current.id)).toEqual(current);
      }
      expect(store.payments.timeline(current.id).length).toBeGreaterThanOrEqual(0);
    }

    expect([...seen].sort()).toEqual([
      'cancelled/by_collector',
      'failed/timeout',
      'in_mediation/disputed',
      'in_review/manual_review',
      'refunded/refunded',
      'succeeded/settled',
    ]);
  });

  test('every status in the state machine survives a write and read', () => {
    const made = storageWith('a');
    storage = made.storage;
    const store = storage.forSandbox(sandboxId('a'));

    const walks: { type: string; commands: readonly unknown[]; decision: PaymentDecision }[] = [
      { type: 'pending', commands: [], decision: { kind: 'pending', reason: 'awaiting_payer' } },
      { type: 'authorized', commands: [], decision: { kind: 'authorize' } },
      { type: 'in_review', commands: [], decision: { kind: 'review', reason: 'contingency' } },
      { type: 'failed', commands: [], decision: { kind: 'decline', reason: 'expired_card' } },
      { type: 'succeeded', commands: [{ type: 'settle' }], decision: { kind: 'pending', reason: 'awaiting_payer' } },
      { type: 'cancelled', commands: [{ type: 'cancel', by: 'payer' }], decision: { kind: 'pending', reason: 'awaiting_payer' } },
      {
        type: 'charged_back',
        commands: [{ type: 'settle' }, { type: 'dispute' }, { type: 'resolve', outcome: 'chargeback' }],
        decision: { kind: 'pending', reason: 'awaiting_payer' },
      },
    ];

    const reached: string[] = [];
    walks.forEach((walk, i) => {
      let current = unwrap(create(input({ id: paymentId(`w-${i}`), sandbox: sandboxId('a') }), walk.decision, 1_000));
      store.payments.insert(current, i + 1);
      let at = 1_000;
      for (const command of walk.commands) {
        at += 1;
        const result = apply(current, command as never, at);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        current = result.value.payment;
        store.payments.update(current);
        store.payments.record(result.value);
      }
      expect(store.payments.get(current.id)).toEqual(current);
      reached.push(current.status.state);
    });

    expect(reached).toEqual([
      'pending',
      'authorized',
      'in_review',
      'failed',
      'succeeded',
      'cancelled',
      'charged_back',
    ]);
  });
});
