import { expect, test } from 'bun:test';
import { unwrap } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import type { Card, Customer } from '../generated/types.ts';
import { validateCustomer } from '../generated/validate.ts';
import { createCardToken } from './card-tokens.ts';
import type { ServiceContext } from './context.ts';
import {
  createCustomer,
  createCustomerAddress,
  deleteCard,
  deleteCustomer,
  deleteCustomerAddress,
  getCustomer,
  saveCard,
} from './customers.ts';
import { cardTokenBody, harness } from './fixture.ts';

const read = (context: ServiceContext, id: string): Customer =>
  unwrap(getCustomer(context, id)).body as Customer;

/** Every mutation must leave the customer consistent with its own cards and addresses. */
test('customers hold their invariants across a seeded sweep', () => {
  const random = new SeededRandom(20_240_602);
  const { context, clock } = harness();
  const ids: string[] = [];

  for (let round = 0; round < 300; round++) {
    clock.advance(1000);
    const action = random.int(5);

    if (action === 0 || ids.length === 0) {
      const email = `buyer-${random.int(40)}@example.com`;
      const created = createCustomer(context, { email });
      if (created.ok) {
        const customer = created.value.body as Customer;
        expect(validateCustomer(customer).ok).toBe(true);
        ids.push(customer.id as string);
      } else {
        expect(created.error.status).toBe(400);
      }
      continue;
    }

    const id = ids[random.int(ids.length)] as string;
    const customer = read(context, id);
    const cards = customer.cards ?? [];

    if (action === 1) {
      const token = (unwrap(createCardToken(context, cardTokenBody())).body as { id: string }).id;
      const card = unwrap(saveCard(context, id, { token })).body as Card;
      expect(card.customer_id).toBe(id);
    } else if (action === 2 && cards.length > 0) {
      const card = cards[random.int(cards.length)] as Card;
      unwrap(deleteCard(context, id, card.id as string));
    } else if (action === 3) {
      unwrap(createCustomerAddress(context, id, { zip_code: `0131010${random.int(10)}` }));
    } else if (action === 4) {
      const removed = unwrap(deleteCustomer(context, id)).body as Customer;
      ids.splice(ids.indexOf(id), 1);
      // Nothing survives the customer it belonged to.
      for (const card of removed.cards ?? []) {
        expect(context.store.documents.get('customer_card', card.id as string)).toBeNull();
      }
      expect(getCustomer(context, id).ok).toBe(false);
      continue;
    }

    const after = read(context, id);
    const owned = (after.cards ?? []).map((card) => card.id);
    expect(owned).toEqual([...new Set(owned)]);
    if (after.default_card === undefined) {
      expect(owned).toEqual([]);
    } else {
      expect(owned).toContain(after.default_card);
    }
  }

  // Emails stay unique: every surviving customer owns a distinct one.
  const emails = ids.map((id) => read(context, id).email);
  expect(new Set(emails).size).toBe(emails.length);
});

test('deleting an address only removes that address', () => {
  const random = new SeededRandom(7);
  const { context } = harness();
  const id = (unwrap(createCustomer(context, { email: 'buyer@example.com' })).body as Customer).id as string;

  const created = Array.from({ length: 8 }, () => {
    const address = unwrap(createCustomerAddress(context, id, { zip_code: `0131010${random.int(10)}` })).body as {
      id: string;
    };
    return address.id;
  });

  const kept = [...created];
  while (kept.length > 0) {
    const index = random.int(kept.length);
    const [gone] = kept.splice(index, 1);
    unwrap(deleteCustomerAddress(context, id, gone as string));
    for (const remaining of kept) {
      expect(context.store.documents.get('customer_address', remaining)).not.toBeNull();
    }
  }
});
