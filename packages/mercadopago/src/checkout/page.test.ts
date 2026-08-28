import { describe, expect, test } from 'bun:test';
import { type JsonObject, isJsonObject } from '@payground/core';
import type { ServiceContext } from '../api/context.ts';
import { orderForPreference } from '../api/merchant-orders.ts';
import { getPayment } from '../api/payments.ts';
import { createPreference } from '../api/preferences.ts';
import { testContext } from '../testing.ts';
import { checkoutPage, checkoutSubmit, returnParams } from './page.ts';

const BACK_URLS = {
  success: 'https://shop.test/ok',
  pending: 'https://shop.test/wait',
  failure: 'https://shop.test/no',
};

function preference(context: ServiceContext, overrides: Record<string, unknown> = {}): string {
  const result = createPreference(context, {
    items: [{ title: 'Coffee', quantity: 2, unit_price: 10.25 }],
    back_urls: BACK_URLS,
    ...overrides,
  });
  if (!result.ok || !isJsonObject(result.value.body)) throw new Error('expected success');
  return result.value.body['id'] as string;
}

function html(context: ServiceContext, id: string): string {
  const rendered = checkoutPage(context, id);
  if (!rendered.ok) throw new Error('expected a page');
  return rendered.value.html;
}

function submit(context: ServiceContext, id: string, form: Record<string, string>) {
  const result = checkoutSubmit(context, id, new URLSearchParams(form));
  if (!result.ok) throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  return result.value;
}

const payment = (context: ServiceContext, id: number): JsonObject => {
  const found = getPayment(context, String(id));
  if (!found.ok || !isJsonObject(found.value.body)) throw new Error('expected a payment');
  return found.value.body;
};

describe('checkoutPage', () => {
  test('reports 404 for an unknown preference', () => {
    const { context } = testContext();
    const result = checkoutPage(context, 'missing');
    expect(!result.ok && result.error.status).toBe(404);
  });

  test('shows the items, the total and every outcome', () => {
    const { context } = testContext();
    const body = html(context, preference(context));

    expect(body).toContain('<td>Coffee</td>');
    expect(body).toContain('BRL 20.50');
    for (const outcome of ['pix', 'card_approved', 'card_rejected', 'pending']) {
      expect(body).toContain(`value="${outcome}"`);
    }
    expect(body).toContain('method="post"');
  });

  test('adds the shipping cost to the displayed total', () => {
    const { context } = testContext();
    const body = html(context, preference(context, { shipments: { mode: 'not_specified', cost: 4.5 } }));
    expect(body).toContain('BRL 4.50');
    expect(body).toContain('BRL 25.00');
  });

  test('carries no script, so the page has no javascript execution context', () => {
    const { context } = testContext();
    expect(html(context, preference(context))).not.toContain('<script');
  });

  test('escapes a hostile item title', () => {
    const { context } = testContext();
    const id = preference(context, {
      items: [{ title: '</script><img src=x onerror="alert(1)">', quantity: 1, unit_price: 1 }],
    });
    const body = html(context, id);

    expect(body).not.toContain('<img');
    expect(body).not.toContain('onerror="');
    expect(body).toContain('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  test("escapes a payer email that tries to break out of the input's value attribute", () => {
    const { context } = testContext();
    const id = preference(context, { payer: { email: '"><b>x@e.test' } });
    const body = html(context, id);
    expect(body).toContain('value="&quot;&gt;&lt;b&gt;x@e.test"');
  });

  test('keeps unicode in item titles intact', () => {
    const { context } = testContext();
    const id = preference(context, { items: [{ title: 'Café ☕ 日本語', quantity: 1, unit_price: 1 }] });
    expect(html(context, id)).toContain('<td>Café ☕ 日本語</td>');
  });

  test('hides the outcomes excluded by the preference', () => {
    const { context } = testContext();
    const id = preference(context, {
      payment_methods: { excluded_payment_types: [{ id: 'credit_card' }, { id: 'ticket' }] },
    });
    const body = html(context, id);
    expect(body).toContain('value="pix"');
    expect(body).not.toContain('value="card_approved"');
    expect(body).not.toContain('value="pending"');
  });

  test('offers nothing when every payment type is excluded', () => {
    const { context } = testContext();
    const id = preference(context, {
      payment_methods: {
        excluded_payment_types: [{ id: 'credit_card' }, { id: 'ticket' }, { id: 'bank_transfer' }],
      },
    });
    expect(html(context, id)).toContain('No payment method is available');
  });

  test('renders an expired notice outside the validity window', () => {
    const { context, clock } = testContext();
    const id = preference(context, {
      expires: true,
      expiration_date_to: new Date(1_700_000_600_000).toISOString(),
    });
    expect(html(context, id)).toContain('value="pix"');

    clock.advance(600_000);
    const body = html(context, id);
    expect(body).toContain('outside its validity window');
    expect(body).not.toContain('<form');
  });
});

describe('checkoutSubmit', () => {
  test('creates a pending Pix payment and opens the merchant order', () => {
    const { context } = testContext();
    const id = preference(context, { external_reference: 'cart-1' });
    const result = submit(context, id, { outcome: 'pix' });

    const order = orderForPreference(context, id);
    expect(order?.doc['order_status']).toBe('payment_required');
    expect((order?.doc['payments'] as JsonObject[])[0]?.['status']).toBe('pending');

    const redirect = new URL(result.redirect ?? '');
    expect(redirect.origin + redirect.pathname).toBe('https://shop.test/wait');
    expect(Object.fromEntries(redirect.searchParams)).toEqual({
      collection_id: '1000000001',
      collection_status: 'pending',
      payment_id: '1000000001',
      status: 'pending',
      external_reference: 'cart-1',
      payment_type: 'bank_transfer',
      merchant_order_id: String(order?.sequence),
      preference_id: id,
      site_id: 'MLB',
      processing_mode: 'aggregator',
      merchant_account_id: 'null',
    });
  });

  test('approves a card payment and closes the merchant order', () => {
    const { context } = testContext();
    const id = preference(context);
    const result = submit(context, id, { outcome: 'card_approved' });

    expect(result.redirect).toContain('https://shop.test/ok?');
    expect(result.redirect).toContain('payment_type=credit_card');

    const order = orderForPreference(context, id);
    expect(order?.doc['order_status']).toBe('paid');
    expect(order?.doc['paid_amount']).toBe(20.5);
  });

  test('rejects a card payment with the reason that was chosen', () => {
    const { context } = testContext();
    const id = preference(context);
    const result = submit(context, id, { outcome: 'card_rejected', reason: 'FUND' });

    expect(result.redirect).toContain('https://shop.test/no?');
    expect(result.redirect).toContain('collection_status=rejected');

    const created = payment(context, 1_000_000_001);
    expect(created['status']).toBe('rejected');
    expect(created['status_detail']).toBe('cc_rejected_insufficient_amount');

    const order = orderForPreference(context, id);
    expect(order?.doc['order_status']).toBe('payment_required');
  });

  test('falls back to a general rejection for an unknown reason', () => {
    const { context } = testContext();
    submit(context, preference(context), { outcome: 'card_rejected', reason: 'NOPE' });
    expect(payment(context, 1_000_000_001)['status_detail']).toBe('cc_rejected_other_reason');
  });

  test('leaves a ticket payment pending', () => {
    const { context } = testContext();
    const result = submit(context, preference(context), { outcome: 'pending' });
    expect(result.redirect).toContain('payment_type=ticket');
    expect(payment(context, 1_000_000_001)['status']).toBe('pending');
  });

  test('passes the preference metadata, reference and notification URL to the payment', () => {
    const { context } = testContext();
    const id = preference(context, {
      external_reference: 'cart-7',
      notification_url: 'https://hooks.test/mp',
      metadata: { seat: '4B' },
    });
    submit(context, id, { outcome: 'pix' });

    const created = payment(context, 1_000_000_001);
    expect(created['external_reference']).toBe('cart-7');
    expect(created['notification_url']).toBe('https://hooks.test/mp');
    expect(created['metadata']).toEqual({ seat: '4B' });
  });

  test('uses the submitted payer email, or the preference one when it is not an address', () => {
    const { context } = testContext();
    const id = preference(context, { payer: { email: 'buyer@example.com' } });
    submit(context, id, { outcome: 'pix', payer_email: 'other@example.com' });
    expect((payment(context, 1_000_000_001)['payer'] as JsonObject)['email']).toBe('other@example.com');

    submit(context, id, { outcome: 'pix', payer_email: 'not-an-email' });
    expect((payment(context, 1_000_000_002)['payer'] as JsonObject)['email']).toBe('buyer@example.com');
  });

  test('preserves query parameters already present on the back_url', () => {
    const { context } = testContext();
    const id = preference(context, {
      back_urls: { ...BACK_URLS, pending: 'https://shop.test/wait?cart=9' },
    });
    const result = submit(context, id, { outcome: 'pix' });
    expect(new URL(result.redirect ?? '').searchParams.get('cart')).toBe('9');
  });

  test('sends the literal string null when the preference has no external reference', () => {
    const { context } = testContext();
    const result = submit(context, preference(context), { outcome: 'pix' });
    expect(result.redirect).toContain('external_reference=null');
  });

  test('offers a manual link instead of redirecting when auto_return is approved-only', () => {
    const { context } = testContext();
    const id = preference(context, { auto_return: 'approved' });
    const pending = submit(context, id, { outcome: 'pix' });
    expect(pending.redirect).toBeNull();
    expect(pending.html).toContain('https://shop.test/wait?');
    expect(pending.html).not.toContain('http-equiv="refresh"');

    const approved = submit(context, id, { outcome: 'card_approved' });
    expect(approved.redirect).toContain('https://shop.test/ok?');
    expect(approved.html).toContain('http-equiv="refresh"');
  });

  test('redirects for every status when auto_return is all', () => {
    const { context } = testContext();
    const id = preference(context, { auto_return: 'all' });
    expect(submit(context, id, { outcome: 'pix' }).redirect).toContain('https://shop.test/wait?');
  });

  test('has no redirect when the matching back_url is missing', () => {
    const { context } = testContext();
    const id = preference(context, { back_urls: { success: 'https://shop.test/ok' } });
    const result = submit(context, id, { outcome: 'pix' });
    expect(result.redirect).toBeNull();
    expect(result.html).toContain('no matching back_url');
  });

  test('escapes the back_url it echoes into the result page', () => {
    const { context } = testContext();
    const id = preference(context, {
      back_urls: { ...BACK_URLS, pending: 'https://shop.test/wait?q="><b>' },
    });
    const result = submit(context, id, { outcome: 'pix' });

    expect(result.html).not.toContain('"><b>');
    // The URL parser percent-encodes the quote; the ampersand separators still need escaping.
    expect(result.html).toContain('q=%22%3E%3Cb%3E&amp;collection_id=');
    expect(result.html).not.toContain('&collection_id=');
  });

  test('rejects a missing, unknown or excluded outcome', () => {
    const { context } = testContext();
    const id = preference(context, {
      payment_methods: { excluded_payment_types: [{ id: 'credit_card' }] },
    });
    expect(checkoutSubmit(context, id, new URLSearchParams()).ok).toBe(false);
    expect(checkoutSubmit(context, id, new URLSearchParams('outcome=cash')).ok).toBe(false);

    const excluded = checkoutSubmit(context, id, new URLSearchParams('outcome=card_approved'));
    expect(!excluded.ok && excluded.error.cause[0]?.code).toBe(2022);
  });

  test('rejects an unknown or expired preference', () => {
    const { context, clock } = testContext();
    expect(checkoutSubmit(context, 'missing', new URLSearchParams('outcome=pix')).ok).toBe(false);

    const id = preference(context, {
      expires: true,
      expiration_date_to: new Date(1_700_000_600_000).toISOString(),
    });
    clock.advance(600_000);
    const result = checkoutSubmit(context, id, new URLSearchParams('outcome=pix'));
    expect(!result.ok && result.error.cause[0]?.code).toBe(2021);
  });

  test('reuses the merchant order across attempts on the same preference', () => {
    const { context } = testContext();
    const id = preference(context);
    submit(context, id, { outcome: 'card_rejected', reason: 'FUND' });
    submit(context, id, { outcome: 'card_approved' });

    const order = orderForPreference(context, id);
    expect((order?.doc['payments'] as JsonObject[]).length).toBe(2);
    expect(order?.doc['order_status']).toBe('paid');
  });
});

describe('returnParams', () => {
  test('sends the literal string null for the values Checkout Pro has none for', () => {
    expect(
      returnParams({
        paymentId: 7,
        status: 'approved',
        paymentType: 'credit_card',
        merchantOrderId: null,
        preferenceId: 'pref-1',
        externalReference: null,
      }),
    ).toEqual({
      collection_id: '7',
      collection_status: 'approved',
      payment_id: '7',
      status: 'approved',
      external_reference: 'null',
      payment_type: 'credit_card',
      merchant_order_id: 'null',
      preference_id: 'pref-1',
      site_id: 'MLB',
      processing_mode: 'aggregator',
      merchant_account_id: 'null',
    });
  });
});
