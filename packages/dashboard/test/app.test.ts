import { describe, expect, test } from 'bun:test';
import { switchSandbox } from '../src/components/App.tsx';

describe('switchSandbox', () => {
  test('keeps the current section', () => {
    expect(switchSandbox({ name: 'webhooks', sandboxId: 'a' }, 'b')).toEqual({
      name: 'webhooks',
      sandboxId: 'b',
    });
    expect(switchSandbox({ name: 'faults', sandboxId: 'a' }, 'b')).toEqual({
      name: 'faults',
      sandboxId: 'b',
    });
    expect(switchSandbox({ name: 'resources', sandboxId: 'a' }, 'b')).toEqual({
      name: 'resources',
      sandboxId: 'b',
    });
  });

  test('falls back to the payment list from a payment detail', () => {
    expect(switchSandbox({ name: 'payment', sandboxId: 'a', paymentId: 'p' }, 'b')).toEqual({
      name: 'payments',
      sandboxId: 'b',
    });
  });

  test('lands on payments from a sandbox-less route', () => {
    expect(switchSandbox({ name: 'metrics' }, 'b')).toEqual({ name: 'payments', sandboxId: 'b' });
    expect(switchSandbox({ name: 'admin' }, 'b')).toEqual({ name: 'payments', sandboxId: 'b' });
  });
});
