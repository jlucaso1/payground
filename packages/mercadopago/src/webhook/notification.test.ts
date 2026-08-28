import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { deliveryHeaders, notification } from './notification.ts';
import { sign } from './signature.ts';

const INPUT = {
  id: 12345,
  type: 'payment',
  action: 'payment.updated',
  dataId: '1234567890',
  userId: 44444,
  liveMode: false,
  createdAt: Date.UTC(2015, 2, 25, 14, 4, 58, 396),
} as const;

describe('notification', () => {
  test('matches the documented body', () => {
    expect(notification(INPUT)).toEqual({
      id: 12345,
      live_mode: false,
      type: 'payment',
      date_created: '2015-03-25T10:04:58.396-04:00',
      user_id: 44444,
      api_version: 'v1',
      action: 'payment.updated',
      data: { id: '1234567890' },
    });
  });

  test('keeps the data id verbatim in the body', () => {
    expect(notification({ ...INPUT, dataId: 'ABC-Def' }).data.id).toBe('ABC-Def');
  });

  test('date_created pads every component', () => {
    expect(notification({ ...INPUT, createdAt: Date.UTC(2024, 0, 5, 7, 8, 9, 40) }).date_created).toBe(
      '2024-01-05T03:08:09.040-04:00',
    );
  });

  test('date_created rolls the day back across the offset', () => {
    expect(notification({ ...INPUT, createdAt: Date.UTC(2024, 0, 1, 2, 0, 0, 0) }).date_created).toBe(
      '2023-12-31T22:00:00.000-04:00',
    );
  });

  test('date_created always parses back to the same instant', () => {
    const rng = new SeededRandom(99);
    for (let i = 0; i < 500; i++) {
      const createdAt = rng.int(2_000_000_000) * 1000 + rng.int(1000);
      const value = notification({ ...INPUT, createdAt }).date_created;
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-04:00$/);
      expect(Date.parse(value)).toBe(createdAt);
    }
  });
});

describe('deliveryHeaders', () => {
  const headers = deliveryHeaders({
    requestId: 'req-1',
    ts: 1704067200,
    dataId: '1234567890',
    secret: 'payground-secret',
  });

  test('carries the transport headers', () => {
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('MercadoPago WebHook v1.0 payment');
    expect(headers['x-request-id']).toBe('req-1');
  });

  test('signs over the same request id it sends', () => {
    expect(headers['x-signature']).toBe(
      `ts=1704067200,v1=${sign({ dataId: '1234567890', requestId: 'req-1', ts: 1704067200, secret: 'payground-secret' })}`,
    );
  });
});
