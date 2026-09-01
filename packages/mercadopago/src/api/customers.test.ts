import { describe, expect, test } from 'bun:test';
import { unwrap } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { Address, Card, Customer, CustomerSearchResult } from '../generated/types.ts';
import { validateAddress, validateCard, validateCustomer } from '../generated/validate.ts';
import { createCardToken, getCardToken } from './card-tokens.ts';
import type { ServiceContext } from './context.ts';
import {
  createCustomer,
  createCustomerAddress,
  deleteCard,
  deleteCustomer,
  deleteCustomerAddress,
  getCard,
  getCustomer,
  getCustomerAddress,
  listCards,
  listCustomerAddresses,
  saveCard,
  searchCustomers,
  updateCard,
  updateCustomer,
  updateCustomerAddress,
} from './customers.ts';
import { cardTokenBody, harness } from './fixture.ts';

const customerBody = (overrides: Record<string, unknown> = {}) => ({
  email: 'buyer@example.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: { area_code: '11', number: '999999999' },
  identification: { type: 'CPF', number: '12345678909' },
  description: 'frequent buyer',
  ...overrides,
});

const newCustomer = (context: ServiceContext, overrides: Record<string, unknown> = {}): Customer =>
  unwrap(createCustomer(context, customerBody(overrides))).body as Customer;

const tokenFor = (context: ServiceContext, overrides: Record<string, unknown> = {}): string =>
  (unwrap(createCardToken(context, cardTokenBody(overrides))).body as { id: string }).id;

const failure = (result: { ok: boolean; error?: unknown }): ErrorBody => {
  if (result.ok) throw new Error('expected a failure');
  return result.error as ErrorBody;
};

describe('createCustomer', () => {
  test('returns a valid Customer', () => {
    const { context } = harness();
    const created = unwrap(createCustomer(context, customerBody()));

    expect(created.status).toBe(201);
    const customer = created.body as Customer;
    expect(validateCustomer(customer).ok).toBe(true);
    expect(customer).toMatchObject({
      email: 'buyer@example.com',
      first_name: 'Ada',
      phone: { area_code: '11', number: '999999999' },
      identification: { type: 'CPF', number: '12345678909' },
      cards: [],
    });
    expect(customer.id).toMatch(/^\d+-[0-9a-f]{14}$/);
    expect(customer.default_card).toBeUndefined();
  });

  test('rejects a body without a usable email', () => {
    const { context } = harness();
    expect(failure(createCustomer(context, { first_name: 'Ada' })).status).toBe(400);
    expect(failure(createCustomer(context, { email: 'nope' })).status).toBe(400);
  });

  test('an email is unique per sandbox, case-insensitively', () => {
    const { context } = harness();
    const first = newCustomer(context);
    const error = failure(createCustomer(context, customerBody({ email: 'BUYER@example.com' })));

    expect(error).toMatchObject({
      status: 400,
      error: 'bad_request',
      cause: [{ code: 101, description: 'customer already exist', data: first.id }],
    });
  });
});

describe('searchCustomers', () => {
  test('filters by email and pages', () => {
    const { context } = harness();
    newCustomer(context);
    newCustomer(context, { email: 'other@example.com' });

    const all = unwrap(searchCustomers(context, new URLSearchParams())).body as CustomerSearchResult;
    expect(all.paging).toEqual({ total: 2, limit: 30, offset: 0 });

    const found = unwrap(searchCustomers(context, new URLSearchParams({ email: 'Other@example.com' })))
      .body as CustomerSearchResult;
    expect(found.results?.map((customer) => customer.email)).toEqual(['other@example.com']);

    const paged = unwrap(searchCustomers(context, new URLSearchParams({ limit: '1', offset: '1' })))
      .body as CustomerSearchResult;
    expect(paged.paging).toEqual({ total: 2, limit: 1, offset: 1 });
    expect(paged.results).toHaveLength(1);
  });
});

describe('updateCustomer', () => {
  test('merges the given fields and keeps the rest', () => {
    const { context, clock } = harness();
    const created = newCustomer(context);
    clock.advance(1000);

    const updated = unwrap(updateCustomer(context, created.id as string, { first_name: 'Grace' })).body as Customer;
    expect(updated).toMatchObject({ first_name: 'Grace', last_name: 'Lovelace', email: 'buyer@example.com' });
    expect(updated.date_last_updated).not.toBe(created.date_last_updated);
  });

  test('moving to an email another customer owns is rejected', () => {
    const { context } = harness();
    newCustomer(context);
    const second = newCustomer(context, { email: 'other@example.com' });

    expect(failure(updateCustomer(context, second.id as string, { email: 'buyer@example.com' })).status).toBe(400);
    // Its own email is not a clash.
    expect(updateCustomer(context, second.id as string, { email: 'other@example.com' }).ok).toBe(true);
  });

  test('an unknown customer is a 404', () => {
    const { context } = harness();
    expect(failure(updateCustomer(context, 'missing', {})).status).toBe(404);
    expect(failure(getCustomer(context, 'missing')).status).toBe(404);
  });
});

describe('saveCard', () => {
  test('stores only the masked card and consumes the token', () => {
    const { context } = harness();
    const customer = newCustomer(context);
    const token = tokenFor(context);

    const saved = unwrap(saveCard(context, customer.id as string, { token }));
    expect(saved.status).toBe(201);
    const card = saved.body as Card;

    expect(validateCard(card).ok).toBe(true);
    expect(card).toMatchObject({
      customer_id: customer.id,
      first_six_digits: '423564',
      last_four_digits: '5682',
      expiration_month: 11,
      expiration_year: 2030,
      cardholder: { name: 'APRO', identification: { type: 'CPF', number: '12345678909' } },
      payment_method: { id: 'visa', name: 'Visa', payment_type_id: 'credit_card' },
      security_code: { mode: 'mandatory', length: 3 },
    });
    expect(JSON.stringify(card)).not.toContain('4235647728025682');

    expect((unwrap(getCardToken(context, token)).body as { status: string }).status).toBe('used');
    expect(failure(saveCard(context, customer.id as string, { token })).status).toBe(400);
  });

  test('the first card becomes the default and deleting it promotes the next', () => {
    const { context } = harness();
    const customer = newCustomer(context);
    const id = customer.id as string;

    const first = unwrap(saveCard(context, id, { token: tokenFor(context) })).body as Card;
    const second = unwrap(saveCard(context, id, { token: tokenFor(context) })).body as Card;
    expect((unwrap(getCustomer(context, id)).body as Customer).default_card).toBe(first.id as string);

    unwrap(deleteCard(context, id, first.id as string));
    expect((unwrap(getCustomer(context, id)).body as Customer).default_card).toBe(second.id as string);

    unwrap(deleteCard(context, id, second.id as string));
    const emptied = unwrap(getCustomer(context, id)).body as Customer;
    expect(emptied.default_card).toBeUndefined();
    expect(emptied.cards).toEqual([]);
  });

  test('cards belong to their customer', () => {
    const { context } = harness();
    const owner = newCustomer(context);
    const other = newCustomer(context, { email: 'other@example.com' });
    const card = unwrap(saveCard(context, owner.id as string, { token: tokenFor(context) })).body as Card;

    expect(unwrap(getCard(context, owner.id as string, card.id as string)).status).toBe(200);
    expect(failure(getCard(context, other.id as string, card.id as string)).status).toBe(404);
    expect(unwrap(listCards(context, other.id as string)).body).toEqual([]);
    expect(failure(saveCard(context, 'missing', { token: tokenFor(context) })).status).toBe(404);
  });

  test('updateCard rewrites the expiry and the holder', () => {
    const { context } = harness();
    const customer = newCustomer(context);
    const card = unwrap(saveCard(context, customer.id as string, { token: tokenFor(context) })).body as Card;

    const updated = unwrap(
      updateCard(context, customer.id as string, card.id as string, {
        expiration_month: 3,
        expiration_year: 2031,
        cardholder: { name: 'GRACE HOPPER' },
      }),
    ).body as Card;

    expect(updated).toMatchObject({
      expiration_month: 3,
      expiration_year: 2031,
      cardholder: { name: 'GRACE HOPPER', identification: { type: 'CPF', number: '12345678909' } },
    });
    expect(
      failure(updateCard(context, customer.id as string, card.id as string, { expiration_month: 13 })).status,
    ).toBe(400);
  });
});

describe('addresses', () => {
  const addressBody = {
    zip_code: '01310100',
    street_name: 'Avenida Paulista',
    street_number: '1000',
    city: 'São Paulo',
    state: 'SP',
    country: 'BR',
    neighborhood: 'Bela Vista',
  };

  test('are created, listed, updated and deleted per customer', () => {
    const { context } = harness();
    const id = newCustomer(context).id as string;

    const created = unwrap(createCustomerAddress(context, id, addressBody));
    expect(created.status).toBe(201);
    const address = created.body as Address;
    expect(validateAddress(address).ok).toBe(true);
    expect(address).toMatchObject({ zip_code: '01310100', neighborhood: 'Bela Vista' });
    expect(address.id).toMatch(/^\d+$/);

    expect(unwrap(listCustomerAddresses(context, id)).body).toHaveLength(1);
    expect((unwrap(getCustomerAddress(context, id, address.id as string)).body as Address).id).toBe(
      address.id as string,
    );

    const updated = unwrap(updateCustomerAddress(context, id, address.id as string, { street_number: '1500' }))
      .body as Address;
    expect(updated).toMatchObject({ street_number: '1500', street_name: 'Avenida Paulista' });

    unwrap(deleteCustomerAddress(context, id, address.id as string));
    expect(unwrap(listCustomerAddresses(context, id)).body).toEqual([]);
    expect(failure(getCustomerAddress(context, id, address.id as string)).status).toBe(404);
  });

  test('a zip code is required', () => {
    const { context } = harness();
    const id = newCustomer(context).id as string;
    expect(failure(createCustomerAddress(context, id, { street_name: 'Avenida Paulista' })).status).toBe(400);
  });
});

describe('deleteCustomer', () => {
  test('cascades to the saved cards and addresses', () => {
    const { context } = harness();
    const customer = newCustomer(context);
    const id = customer.id as string;
    const card = unwrap(saveCard(context, id, { token: tokenFor(context) })).body as Card;
    const address = unwrap(createCustomerAddress(context, id, { zip_code: '01310100' })).body as Address;

    const removed = unwrap(deleteCustomer(context, id));
    expect(removed.status).toBe(200);
    expect((removed.body as Customer).id).toBe(id);

    expect(failure(getCustomer(context, id)).status).toBe(404);
    expect(context.store.documents.get('customer_card', card.id as string)).toBeNull();
    expect(context.store.documents.get('customer_address', address.id as string)).toBeNull();
  });

  test('the email is free again afterwards', () => {
    const { context } = harness();
    unwrap(deleteCustomer(context, newCustomer(context).id as string));
    expect(createCustomer(context, customerBody()).ok).toBe(true);
  });
});
