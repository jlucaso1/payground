import { describe, expect, test } from 'bun:test';
import { type PaymentState, TERMINAL, TRANSITIONS, isAllowed, isTerminal } from './state.ts';

const STATES = Object.keys(TRANSITIONS) as PaymentState[];

describe('transition table', () => {
  test('covers every state exactly once', () => {
    expect(new Set(STATES).size).toBe(STATES.length);
    expect(STATES).toHaveLength(9);
  });

  test('terminal states have no outgoing commands', () => {
    for (const state of TERMINAL) expect(TRANSITIONS[state]).toEqual([]);
    for (const state of STATES) expect(isTerminal(state)).toBe(TRANSITIONS[state].length === 0);
  });

  test('lists no command twice for a state', () => {
    for (const state of STATES) {
      const commands = TRANSITIONS[state] as readonly string[];
      expect(new Set(commands).size).toBe(commands.length);
    }
  });

  test('only pending can expire or be declined from a waiting state', () => {
    expect(isAllowed('pending', 'expire')).toBe(true);
    expect(isAllowed('authorized', 'expire')).toBe(true);
    expect(isAllowed('succeeded', 'expire')).toBe(false);
    expect(isAllowed('refunded', 'refund')).toBe(false);
  });

  test('refund and dispute are only reachable from succeeded', () => {
    for (const state of STATES) {
      expect(isAllowed(state, 'refund')).toBe(state === 'succeeded');
      expect(isAllowed(state, 'dispute')).toBe(state === 'succeeded');
    }
  });
});
