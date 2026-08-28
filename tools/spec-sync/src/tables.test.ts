import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  emitTables,
  loadTables,
  parseStatusDetails,
  parseTable,
  parseTestCardholders,
  parseTestCards,
} from './tables.ts';

const ROOT = join(import.meta.dir, '../../..');
const tables = await loadTables(join(ROOT, 'spec/tables'));

// Slices of the served Markdown: backslash-escaped punctuation, whole table on one line.
const PAYMENTS = String.raw`\# Get payment status | Status | \`status\_detail\` | Description | | --- | --- | --- | | approved | \`accredited\` | Done! Your payment was credited. Your statement will show the \`amount\` charge as \`statement\_descriptor\`. | | authorized | \`pending\_capture\` | The payment has been authorized and is waiting for \[capture\](https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/payment-management/capture-authorized-payment). | | in\_process | \`pending\_contingency\` | We are processing your payment.

Don't worry! You will be notified via e-mail if the payment was credited in less than 2 business days. | | rejected | \`cc\_rejected\_bad\_filled\_card\_number\` | Check card number. |`;

const ORDERS = String.raw`\# Transaction status Check the list of the \`status\` and \`status\_detail\`. | \`status\` | \`status\_detail\` | Description | |:---:|:---:|:---:| | \`created\` | \`created\` | The transaction was created successfully. | | \`action\_required\` | \`pending\_challenge\` | The 3DS \_Challenge\_ was initiated. | | \`failed\` | \`3ds\_challenge\_expired\` | The 3DS challenge expired. |`;

// Not String.raw: Bun escapes non-ASCII in template literals, which the raw tag would
// then surface verbatim. The header below keeps the page's curly apostrophe.
const CARDS = `\\# Test cards Below are the \\*\\*test cards\\*\\*. | Card type | Flag | Number | Security code | Expiration date | | :--- | :---: | :---: | :---: | :---: | | Credit card | Mastercard | 5480 8328 0103 3311 | 123 | 11/30 | | Credit card | American Express | 3753 651535 56885 | 1234 | 11/30 | Next, choose which payment scenario to test and fill in the \\*\\*cardholder's information\\*\\* as indicated in the table below. | Payment Status | Cardholder’s first and last name | Identity document | | --- | --- | --- | | Approved payment | \\\`APRO\\\` | (CPF) 12345678909 | | Rejected for missing card\\_number | \\\`CARD\\\` | - |`;

const ESCAPED_PIPE = String.raw`| A | B | | --- | --- | | one \| two | three |`;

const CODES = [
  'APRO',
  'OTHE',
  'CONT',
  'CALL',
  'FUND',
  'SECU',
  'EXPI',
  'FORM',
  'CARD',
  'INST',
  'DUPL',
  'LOCK',
  'CTNA',
  'ATTE',
  'BLAC',
  'UNSU',
  'TEST',
];

const digits = (card: string): string => card.replace(/ /g, '');

function luhn(card: string): boolean {
  const value = digits(card);
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) {
    const digit = Number(value[value.length - 1 - i]);
    const doubled = i % 2 === 1 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

describe('parser', () => {
  test('unescapes and collapses payment status rows', () => {
    const rows = parseStatusDetails(PAYMENTS);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      status: 'approved',
      detail: 'accredited',
      description:
        'Done! Your payment was credited. Your statement will show the amount charge as statement_descriptor.',
    });
    expect(rows[1]?.description).toBe(
      'The payment has been authorized and is waiting for capture.',
    );
    expect(rows[2]?.description).toBe(
      "We are processing your payment. Don't worry! You will be notified via e-mail if the payment was credited in less than 2 business days.",
    );
    expect(rows[3]?.detail).toBe('cc_rejected_bad_filled_card_number');
  });

  test('reads the Orders vocabulary from a centred table', () => {
    expect(parseStatusDetails(ORDERS)).toEqual([
      {
        status: 'created',
        detail: 'created',
        description: 'The transaction was created successfully.',
      },
      {
        status: 'action_required',
        detail: 'pending_challenge',
        description: 'The 3DS _Challenge_ was initiated.',
      },
      {
        status: 'failed',
        detail: '3ds_challenge_expired',
        description: 'The 3DS challenge expired.',
      },
    ]);
  });

  test('stops each table at the prose that follows it', () => {
    expect(parseTestCards(CARDS)).toEqual([
      {
        type: 'Credit card',
        brand: 'Mastercard',
        number: '5480 8328 0103 3311',
        securityCode: '123',
        expiration: '11/30',
      },
      {
        type: 'Credit card',
        brand: 'American Express',
        number: '3753 651535 56885',
        securityCode: '1234',
        expiration: '11/30',
      },
    ]);
    expect(parseTestCardholders(CARDS)).toEqual([
      { code: 'APRO', scenario: 'Approved payment' },
      { code: 'CARD', scenario: 'Rejected for missing card_number' },
    ]);
  });

  test('treats an escaped pipe as cell content', () => {
    expect(parseTable(ESCAPED_PIPE, ['A', 'B'])).toEqual([['one | two', 'three']]);
  });

  test('rejects a table it cannot find', () => {
    expect(() => parseTable(CARDS, ['Nope', 'Missing'])).toThrow('table not found');
  });

  test('rejects a status that is not an identifier', () => {
    expect(() => parseStatusDetails(String.raw`| Status | status_detail | Description | | --- | --- | --- | | Approved! | ok | fine |`)).toThrow(
      'unexpected status',
    );
  });
});

describe('committed output', () => {
  test('packages/mercadopago/src/generated/tables.ts is up to date', async () => {
    const path = join(ROOT, 'packages/mercadopago/src/generated/tables.ts');
    expect(await Bun.file(path).text()).toBe(emitTables(tables));
  });
});

describe('committed data', () => {
  test('records every documented cardholder code', () => {
    // The live page lists 17 scenarios, not the 18 the brief expected.
    expect(tables.testCardholders.map((holder) => holder.code)).toEqual(CODES);
  });

  test('has no duplicate (status, detail) pair', () => {
    for (const rows of [tables.paymentStatusDetails, tables.orderTransactionStatuses]) {
      const pairs = rows.map((row) => `${row.status}/${row.detail}`);
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });

  test('maps every status_detail to a known status', () => {
    const statuses = new Set(tables.paymentStatusDetails.map((row) => row.status));
    expect(statuses.size).toBe(9);
    for (const row of tables.paymentStatusDetails) {
      expect(statuses.has(row.status)).toBe(true);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  test('keeps the Orders vocabulary separate from the Payments one', () => {
    const payments = new Set(tables.paymentStatusDetails.map((row) => row.status));
    for (const status of ['created', 'processed', 'processing', 'action_required', 'failed']) {
      expect(payments.has(status)).toBe(false);
      expect(tables.orderTransactionStatuses.some((row) => row.status === status)).toBe(true);
    }
  });

  test('carries card numbers that are digits and spaces and pass Luhn', () => {
    expect(tables.testCards).toHaveLength(4);
    for (const card of tables.testCards) {
      expect(card.number).toMatch(/^[0-9 ]+$/);
      // All four pass, including the 15-digit American Express 3753 651535 56885.
      expect(luhn(card.number)).toBe(true);
      expect(card.securityCode).toMatch(/^[0-9]{3,4}$/);
    }
  });
});

describe('scraped files', () => {
  test('each records its source and fetch date', async () => {
    const files = [
      'payment-status-details.json',
      'order-transaction-statuses.json',
      'test-cards.json',
      'test-cardholders.json',
    ];
    for (const file of files) {
      const scraped = (await Bun.file(join(ROOT, 'spec/tables', file)).json()) as {
        source: string;
        fetchedAt: string;
        rows: unknown[];
      };
      expect(scraped.source).toStartWith('https://www.mercadopago.com.br/developers/');
      expect(scraped.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(scraped.rows.length).toBeGreaterThan(0);
    }
  });
});
