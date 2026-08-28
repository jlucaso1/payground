import { join } from 'node:path';

export const SOURCES = {
  paymentStatusDetails:
    'https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/response-handling/query-results.md',
  orderTransactionStatuses:
    'https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/payment-management/status/transaction-status.md',
  testCards: 'https://www.mercadopago.com.br/developers/en/docs/your-integrations/test/cards.md',
} as const;

export const FILES = {
  paymentStatusDetails: 'payment-status-details.json',
  orderTransactionStatuses: 'order-transaction-statuses.json',
  testCards: 'test-cards.json',
  testCardholders: 'test-cardholders.json',
} as const;

export interface StatusDetailRow {
  status: string;
  detail: string;
  description: string;
}

export interface TestCardRow {
  type: string;
  brand: string;
  number: string;
  securityCode: string;
  expiration: string;
}

export interface TestCardholderRow {
  code: string;
  scenario: string;
}

export interface Scraped<T> {
  source: string;
  fetchedAt: string;
  rows: T[];
}

export interface Tables {
  paymentStatusDetails: readonly StatusDetailRow[];
  orderTransactionStatuses: readonly StatusDetailRow[];
  testCards: readonly TestCardRow[];
  testCardholders: readonly TestCardholderRow[];
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SEPARATOR = /^:?-{3,}:?$/;
const IDENTIFIER = /^[a-z0-9_]+$/;

function splitCells(md: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < md.length; i += 1) {
    const ch = md[i] as string;
    if (ch === '\\') {
      const next = md[i + 1];
      if (next !== undefined && PUNCTUATION.test(next)) {
        cell += next;
        i += 1;
        continue;
      }
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  return cells;
}

function clean(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseTable(md: string, header: readonly string[]): string[][] {
  const cells = splitCells(md).map(clean);
  const width = header.length;

  let i = -1;
  for (let at = 0; at + width <= cells.length; at += 1) {
    if (header.every((name, k) => slug(cells[at + k] as string) === slug(name))) {
      i = at + width;
      break;
    }
  }
  if (i < 0) throw new Error(`table not found: ${header.join(' | ')}`);

  while (i < cells.length) {
    const cell = cells[i] as string;
    if (cell !== '' && !SEPARATOR.test(cell)) break;
    i += 1;
  }

  const rows: string[][] = [];
  while (i + width <= cells.length) {
    const row = cells.slice(i, i + width);
    if (row.some((cell) => cell === '')) break;
    rows.push(row);
    i += width;
    if (cells[i] !== '') break;
    i += 1;
  }
  if (rows.length === 0) throw new Error(`empty table: ${header.join(' | ')}`);
  return rows;
}

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`unexpected ${what}: ${value}`);
  return value;
}

export function parseStatusDetails(md: string): StatusDetailRow[] {
  return parseTable(md, ['Status', 'status_detail', 'Description']).map((row) => ({
    status: identifier(row[0] as string, 'status'),
    detail: identifier(row[1] as string, 'status_detail'),
    description: row[2] as string,
  }));
}

export function parseTestCards(md: string): TestCardRow[] {
  return parseTable(md, ['Card type', 'Flag', 'Number', 'Security code', 'Expiration date']).map(
    (row) => {
      const number = row[2] as string;
      if (!/^[0-9 ]+$/.test(number)) throw new Error(`unexpected card number: ${number}`);
      return {
        type: row[0] as string,
        brand: row[1] as string,
        number,
        securityCode: row[3] as string,
        expiration: row[4] as string,
      };
    },
  );
}

export function parseTestCardholders(md: string): TestCardholderRow[] {
  return parseTable(md, [
    'Payment Status',
    'Cardholder’s first and last name',
    'Identity document',
  ]).map((row) => {
    const code = row[1] as string;
    if (!/^[A-Z]{4}$/.test(code)) throw new Error(`unexpected cardholder code: ${code}`);
    return { code, scenario: row[0] as string };
  });
}

const str = (value: string): string =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

const record = (fields: readonly (readonly [string, string])[]): string =>
  `{ ${fields.map(([name, value]) => `${name}: ${str(value)}`).join(', ')} }`;

function block(name: string, type: string, entries: readonly string[]): string {
  return [
    `export const ${name} = [`,
    ...entries.map((entry) => `  ${entry},`),
    `] as const satisfies readonly ${type}[];`,
    '',
  ].join('\n');
}

export function emitTables(tables: Tables): string {
  const statuses = [...new Set(tables.paymentStatusDetails.map((row) => row.status))];
  const byStatus = statuses.map((status) => [
    status,
    tables.paymentStatusDetails.filter((row) => row.status === status).map((row) => row.detail),
  ] as const);

  const out: string[] = [
    '// Generated by tools/spec-sync. Do not edit.',
    '',
    'export interface StatusDetail { status: string; detail: string; description: string }',
    'export interface TransactionStatus { status: string; detail: string; description: string }',
    'export interface TestCard { type: string; brand: string; number: string; securityCode: string; expiration: string }',
    'export interface TestCardholder { code: string; scenario: string }',
    '',
    block(
      'PAYMENT_STATUS_DETAILS',
      'StatusDetail',
      tables.paymentStatusDetails.map((row) =>
        record([
          ['status', row.status],
          ['detail', row.detail],
          ['description', row.description],
        ]),
      ),
    ),
    block(
      'ORDER_TRANSACTION_STATUSES',
      'TransactionStatus',
      tables.orderTransactionStatuses.map((row) =>
        record([
          ['status', row.status],
          ['detail', row.detail],
          ['description', row.description],
        ]),
      ),
    ),
    block(
      'TEST_CARDS',
      'TestCard',
      tables.testCards.map((row) =>
        record([
          ['type', row.type],
          ['brand', row.brand],
          ['number', row.number],
          ['securityCode', row.securityCode],
          ['expiration', row.expiration],
        ]),
      ),
    ),
    block(
      'TEST_CARDHOLDERS',
      'TestCardholder',
      tables.testCardholders.map((row) =>
        record([
          ['code', row.code],
          ['scenario', row.scenario],
        ]),
      ),
    ),
    '/** Payment statuses, derived from the scraped table. */',
    block('PAYMENT_STATUSES', 'string', statuses.map(str)),
    'export const STATUS_DETAILS_BY_STATUS: ReadonlyMap<string, readonly string[]> = new Map([',
    ...byStatus.map(
      ([status, details]) => `  [${str(status)}, [${details.map(str).join(', ')}]],`,
    ),
    ']);',
    '',
    'export const TEST_CARDHOLDER_CODES: ReadonlyMap<string, TestCardholder> = new Map(',
    '  TEST_CARDHOLDERS.map((holder) => [holder.code, holder] as const),',
    ');',
    '',
  ];
  return out.join('\n');
}

export async function loadTables(dir: string): Promise<Tables> {
  const read = async <T>(file: string): Promise<T[]> =>
    ((await Bun.file(join(dir, file)).json()) as Scraped<T>).rows;

  return {
    paymentStatusDetails: await read<StatusDetailRow>(FILES.paymentStatusDetails),
    orderTransactionStatuses: await read<StatusDetailRow>(FILES.orderTransactionStatuses),
    testCards: await read<TestCardRow>(FILES.testCards),
    testCardholders: await read<TestCardholderRow>(FILES.testCardholders),
  };
}
