import { describe, expect, test } from 'bun:test';
import { type JsonObject, isJsonObject } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { testContext } from '../testing.ts';
import {
  createPreference,
  getPreference,
  loadPreference,
  searchPreferences,
  updatePreference,
} from './preferences.ts';

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  items: [{ title: 'Coffee', quantity: 2, unit_price: 10.25 }],
  ...overrides,
});

function created(overrides: Record<string, unknown> = {}) {
  const harness = testContext();
  const result = createPreference(harness.context, body(overrides));
  if (!result.ok) throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  if (!isJsonObject(result.value.body)) throw new Error('expected a json object');
  return { harness, status: result.value.status, doc: result.value.body as JsonObject };
}

const failure = (overrides: Record<string, unknown>) => {
  const harness = testContext();
  const result = createPreference(harness.context, body(overrides));
  if (result.ok) throw new Error('expected a rejection');
  return result.error;
};

describe('createPreference', () => {
  test('returns 201 with the checkout URLs of this instance', () => {
    const { status, doc } = created();
    expect(status).toBe(201);
    expect(doc['init_point']).toBe(`http://127.0.0.1:8080/checkout/${String(doc['id'])}`);
    expect(doc['sandbox_init_point']).toBe(doc['init_point']);
    expect(String(doc['id'])).toStartWith('123456789-');
  });

  test('computes total_amount from quantity and unit price', () => {
    const { doc } = created({
      items: [
        { title: 'A', quantity: 3, unit_price: 0.1 },
        { title: 'B', quantity: 1, unit_price: 99.99 },
      ],
    });
    expect(doc['total_amount']).toBe(100.29);
  });

  test('normalizes items, payer and back_urls the way the API echoes them', () => {
    const { doc } = created({ payer: { email: 'payer@example.com' } });
    expect(doc['items']).toEqual([
      {
        id: null,
        title: 'Coffee',
        description: null,
        picture_url: null,
        category_id: null,
        quantity: 2,
        currency_id: 'BRL',
        unit_price: 10.25,
      },
    ]);
    expect(doc['back_urls']).toEqual({ success: '', pending: '', failure: '' });
    expect(isJsonObject(doc['payer']) && doc['payer']['email']).toBe('payer@example.com');
  });

  test('keeps metadata, which the vendored schema omits', () => {
    const { doc } = created({ metadata: { order: 'A-1', nested: { ok: true } } });
    expect(doc['metadata']).toEqual({ order: 'A-1', nested: { ok: true } });
  });

  test('persists the preference under its id', () => {
    const harness = testContext();
    const result = createPreference(harness.context, body());
    if (!result.ok) throw new Error('expected success');
    const id = (result.value.body as JsonObject)['id'] as string;
    expect(harness.context.store.documents.get('preference', id)).not.toBeNull();
  });
});

describe('createPreference validation', () => {
  test('rejects a non-object body and a missing items array', () => {
    const harness = testContext();
    expect(createPreference(harness.context, 'nope').ok).toBe(false);
    expect(createPreference(harness.context, {}).ok).toBe(false);
  });

  test('rejects an empty item list', () => {
    expect(failure({ items: [] }).cause[0]?.code).toBe(2001);
  });

  test('rejects a blank title', () => {
    expect(failure({ items: [{ title: '   ', quantity: 1, unit_price: 5 }] }).cause[0]?.code).toBe(2002);
  });

  test('rejects a non-positive or fractional quantity', () => {
    expect(failure({ items: [{ title: 'A', quantity: 0, unit_price: 5 }] }).status).toBe(400);
    expect(failure({ items: [{ title: 'A', quantity: 1.5, unit_price: 5 }] }).status).toBe(400);
  });

  test('rejects a zero, negative or over-precise unit price', () => {
    expect(failure({ items: [{ title: 'A', quantity: 1, unit_price: 0 }] }).cause[0]?.code).toBe(2004);
    expect(failure({ items: [{ title: 'A', quantity: 1, unit_price: -5 }] }).cause[0]?.code).toBe(2004);
    expect(failure({ items: [{ title: 'A', quantity: 1, unit_price: 1.005 }] }).cause[0]?.code).toBe(2004);
  });

  test('rejects a relative back_url', () => {
    expect(failure({ back_urls: { success: '/done' } }).cause[0]?.code).toBe(2006);
  });

  test('rejects auto_return without back_urls.success', () => {
    const error = failure({ auto_return: 'approved', back_urls: { failure: 'https://shop.test/f' } });
    expect(error.message).toBe('invalid_auto_return');
    expect(error.cause[0]?.code).toBe(2011);
  });

  test('accepts auto_return when success is defined', () => {
    const { doc } = created({ auto_return: 'all', back_urls: { success: 'https://shop.test/ok' } });
    expect(doc['auto_return']).toBe('all');
  });

  test('rejects an unparseable or inverted expiration window', () => {
    expect(failure({ expiration_date_from: 'yesterday' }).cause[0]?.code).toBe(2009);
    expect(
      failure({
        expiration_date_from: '2024-02-01T00:00:00.000-03:00',
        expiration_date_to: '2024-01-01T00:00:00.000-03:00',
      }).cause[0]?.code,
    ).toBe(2009);
  });

  test('records expires with the window it was given', () => {
    const { doc } = created({
      expires: true,
      expiration_date_from: '2024-01-01T00:00:00.000-03:00',
      expiration_date_to: '2024-02-01T00:00:00.000-03:00',
    });
    expect(doc['expires']).toBe(true);
    expect(doc['expiration_date_to']).toBe('2024-02-01T00:00:00.000-03:00');
  });

  test('rejects an unknown excluded payment type and accepts a known one', () => {
    expect(
      failure({ payment_methods: { excluded_payment_types: [{ id: 'carrier_pigeon' }] } }).cause[0]?.code,
    ).toBe(2010);
    const { doc } = created({ payment_methods: { excluded_payment_types: [{ id: 'credit_card' }] } });
    expect(isJsonObject(doc['payment_methods']) && doc['payment_methods']['excluded_payment_types']).toEqual([
      { id: 'credit_card' },
    ]);
  });

  test('rejects a non-object metadata and a non-URL notification_url', () => {
    expect(failure({ metadata: ['a'] }).cause[0]?.code).toBe(2013);
    expect(failure({ notification_url: 'ftp://hooks.test' }).cause[0]?.code).toBe(2007);
  });

  test('rejects an oversized external_reference', () => {
    expect(failure({ external_reference: 'x'.repeat(257) }).cause[0]?.code).toBe(2008);
  });
});

describe('getPreference / updatePreference', () => {
  test('reads back exactly what was created', () => {
    const { harness, doc } = created();
    const found = getPreference(harness.context, doc['id'] as string);
    expect(found.ok && found.value.body).toEqual(doc);
  });

  test('reports 404 for an unknown id', () => {
    const harness = testContext();
    const result = getPreference(harness.context, 'missing');
    expect(!result.ok && result.error.status).toBe(404);
  });

  test('replaces the payload, keeps date_created and moves last_updated', () => {
    const { harness, doc } = created();
    harness.clock.advance(60_000);
    const updated = updatePreference(harness.context, doc['id'] as string, body({ items: [{ title: 'Tea', quantity: 1, unit_price: 5 }] }));
    if (!updated.ok || !isJsonObject(updated.value.body)) throw new Error('expected success');

    expect(updated.value.status).toBe(200);
    expect(updated.value.body['total_amount']).toBe(5);
    expect(updated.value.body['date_created']).toBe(doc['date_created']);
    expect(updated.value.body['last_updated']).not.toBe(doc['last_updated']);
  });

  test('rejects an update to an unknown preference before validating the body', () => {
    const harness = testContext();
    const result = updatePreference(harness.context, 'missing', {});
    expect(!result.ok && result.error.status).toBe(404);
  });

  test('rejects an invalid update and leaves the stored preference untouched', () => {
    const { harness, doc } = created();
    expect(updatePreference(harness.context, doc['id'] as string, { items: [] }).ok).toBe(false);
    const found = getPreference(harness.context, doc['id'] as string);
    expect(found.ok && (found.value.body as JsonObject)['total_amount']).toBe(20.5);
  });
});

describe('searchPreferences', () => {
  test('answers with elements, next_offset and total', () => {
    const harness = testContext();
    createPreference(harness.context, body({ external_reference: 'A' }));
    harness.clock.advance(1000);
    createPreference(harness.context, body({ external_reference: 'B', payer: { email: 'b@example.com' } }));

    const all = searchPreferences(harness.context, new URLSearchParams());
    if (!all.ok || !isJsonObject(all.value.body)) throw new Error('expected success');
    expect(all.value.body['total']).toBe(2);
    expect(all.value.body['next_offset']).toBe(2);

    const byReference = searchPreferences(harness.context, new URLSearchParams('external_reference=B'));
    const elements = (byReference.ok && isJsonObject(byReference.value.body) ? byReference.value.body['elements'] : []) as JsonObject[];
    expect(elements).toHaveLength(1);
    expect(elements[0]?.['payer_email']).toBe('b@example.com');
    expect(elements[0]?.['external_reference']).toBe('B');
  });

  test('filters by payer email and honours limit', () => {
    const harness = testContext();
    createPreference(harness.context, body({ payer: { email: 'a@example.com' } }));
    createPreference(harness.context, body({ payer: { email: 'z@example.com' } }));

    const byEmail = searchPreferences(harness.context, new URLSearchParams('payer_email=z@example.com'));
    expect(byEmail.ok && isJsonObject(byEmail.value.body) && byEmail.value.body['total']).toBe(1);

    const limited = searchPreferences(harness.context, new URLSearchParams('limit=1'));
    if (!limited.ok || !isJsonObject(limited.value.body)) throw new Error('expected success');
    expect(limited.value.body['total']).toBe(2);
    expect((limited.value.body['elements'] as JsonObject[]).length).toBe(1);
  });

  test('rejects a non-numeric limit', () => {
    const harness = testContext();
    expect(searchPreferences(harness.context, new URLSearchParams('limit=abc')).ok).toBe(false);
  });
});

describe('preferenceView', () => {
  test('reports the expiry window against the clock', () => {
    const { harness, doc } = created({
      expires: true,
      expiration_date_from: new Date(1_700_000_000_000).toISOString(),
      expiration_date_to: new Date(1_700_000_600_000).toISOString(),
    });
    const id = doc['id'] as string;
    expect(loadPreference(harness.context, id)?.expired).toBe(false);
    harness.clock.advance(600_000);
    expect(loadPreference(harness.context, id)?.expired).toBe(true);
  });

  test('adds the shipping cost to the amount due', () => {
    const { harness, doc } = created({ shipments: { mode: 'not_specified', cost: 7.5 } });
    const view = loadPreference(harness.context, doc['id'] as string);
    expect(Number(view?.totalMinor)).toBe(2050);
    expect(Number(view?.shippingMinor)).toBe(750);
    expect(Number(view?.dueMinor)).toBe(2800);
  });
});

test('property: total_amount is the exact sum of the item lines', () => {
  const random = new SeededRandom(7);
  for (let round = 0; round < 200; round++) {
    const count = random.int(5) + 1;
    let expected = 0;
    const items = Array.from({ length: count }, () => {
      const cents = random.int(100_000) + 1;
      const quantity = random.int(9) + 1;
      expected += cents * quantity;
      return { title: `item ${cents}`, quantity, unit_price: cents / 100 };
    });

    const harness = testContext();
    const result = createPreference(harness.context, { items });
    if (!result.ok || !isJsonObject(result.value.body)) throw new Error('expected success');
    expect(result.value.body['total_amount']).toBe(expected / 100);
  }
});
