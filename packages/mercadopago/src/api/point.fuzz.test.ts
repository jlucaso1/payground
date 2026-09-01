import { expect, test } from 'bun:test';
import { type JsonObject, isJsonObject } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { testContext } from '../testing.ts';
import { searchPayments } from './payments.ts';
import {
  INTENT_TRANSITIONS,
  type IntentCommand,
  type IntentState,
  createPointPaymentIntent,
  driveIntent,
  getPointPaymentIntent,
  isIntentState,
  isIntentTerminal,
  nextIntentState,
} from './point.ts';

const COMMANDS: readonly IntentCommand[] = ['deliver', 'process', 'finish', 'cancel', 'fail'];
const DEVICES = ['PAX_A910__SMARTPOS1471016179', 'PAX_A910__SMARTPOS1471016180'] as const;

const view = (result: ReturnType<typeof getPointPaymentIntent>): JsonObject => {
  if (!result.ok || !isJsonObject(result.value.body)) throw new Error('expected an intent');
  return result.value.body;
};

const stateOf = (body: JsonObject): IntentState => {
  const state = body['state'];
  if (typeof state !== 'string' || !isIntentState(state)) throw new Error(`bad state ${String(state)}`);
  return state;
};

/**
 * Walks random command sequences over the reader state machine and checks that the stored
 * intent never leaves the transition table, and that a FINISHED intent always has a payment.
 */
test('random command sequences keep the intent state machine consistent', () => {
  const { context } = testContext();
  const rng = new SeededRandom(20240917);
  const open = new Map<string, string>();
  const model = new Map<string, IntentState>();
  let finished = 0;

  for (let step = 0; step < 600; step++) {
    const device = DEVICES[rng.int(DEVICES.length)] as string;
    const active = open.get(device);

    if (active === undefined) {
      const created = createPointPaymentIntent(context, device, { amount: 100 + rng.int(5000) });
      expect(created.ok).toBe(true);
      if (!created.ok || !isJsonObject(created.value.body)) throw new Error('unreachable');
      const id = created.value.body['id'] as string;
      expect(stateOf(created.value.body)).toBe('OPEN');
      open.set(device, id);
      model.set(id, 'OPEN');
      continue;
    }

    const before = model.get(active) as IntentState;
    const command = COMMANDS[rng.int(COMMANDS.length)] as IntentCommand;
    const expected = nextIntentState(before, command);
    const moved = driveIntent(context, active, command);

    expect(moved.ok).toBe(expected.ok);
    const after = stateOf(view(getPointPaymentIntent(context, active)));

    if (!expected.ok) {
      // A rejected command must leave the record exactly as it was.
      expect(after).toBe(before);
      expect(moved.ok ? 0 : moved.error.status).toBe(409);
      continue;
    }

    expect(after).toBe(expected.value);
    model.set(active, after);

    if (after === 'FINISHED') {
      finished++;
      const payment = view(getPointPaymentIntent(context, active))['payment'];
      expect(isJsonObject(payment) && typeof payment['id'] === 'number').toBe(true);
    }

    if (isIntentTerminal(after)) open.delete(device);
  }

  // Every intent that reached a terminal state stayed there, and only FINISHED made a payment.
  for (const [id, state] of model) {
    expect(stateOf(view(getPointPaymentIntent(context, id)))).toBe(state);
    const payment = view(getPointPaymentIntent(context, id))['payment'];
    const hasPayment = isJsonObject(payment) && typeof payment['id'] === 'number';
    expect(hasPayment).toBe(state === 'FINISHED');
  }

  expect(finished).toBeGreaterThan(0);
  const searched = searchPayments(context, new URLSearchParams({ limit: '1' }));
  if (!searched.ok || !isJsonObject(searched.value.body)) throw new Error('unreachable');
  const paging = searched.value.body['paging'];
  expect(isJsonObject(paging) ? paging['total'] : 0).toBe(finished);

  // The table is exhaustive: nothing outside it was ever accepted.
  for (const [state, commands] of Object.entries(INTENT_TRANSITIONS)) {
    for (const command of COMMANDS) {
      const allowed: readonly string[] = commands;
      expect(nextIntentState(state as IntentState, command).ok).toBe(allowed.includes(command));
    }
  }
});
