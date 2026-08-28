import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  emitTables,
  FILES,
  parseStatusDetails,
  parseTestCardholders,
  parseTestCards,
  type Scraped,
  SOURCES,
} from './tables.ts';

const ROOT = join(import.meta.dir, '../../..');
const TABLES = join(ROOT, 'spec/tables');
const OUT = join(ROOT, 'packages/mercadopago/src/generated');

async function markdown(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return await res.text();
}

async function record<T>(file: string, source: string, rows: T[]): Promise<void> {
  const scraped: Scraped<T> = { source, fetchedAt: new Date().toISOString().slice(0, 10), rows };
  await writeFile(join(TABLES, file), `${JSON.stringify(scraped, null, 2)}\n`);
  console.log(`${file} ${rows.length} rows`);
}

async function main(): Promise<void> {
  const [payments, orders, cards] = await Promise.all([
    markdown(SOURCES.paymentStatusDetails),
    markdown(SOURCES.orderTransactionStatuses),
    markdown(SOURCES.testCards),
  ]);

  const tables = {
    paymentStatusDetails: parseStatusDetails(payments),
    orderTransactionStatuses: parseStatusDetails(orders),
    testCards: parseTestCards(cards),
    testCardholders: parseTestCardholders(cards),
  };

  await mkdir(TABLES, { recursive: true });
  await record(FILES.paymentStatusDetails, SOURCES.paymentStatusDetails, tables.paymentStatusDetails);
  await record(
    FILES.orderTransactionStatuses,
    SOURCES.orderTransactionStatuses,
    tables.orderTransactionStatuses,
  );
  await record(FILES.testCards, SOURCES.testCards, tables.testCards);
  await record(FILES.testCardholders, SOURCES.testCards, tables.testCardholders);

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'tables.ts'), emitTables(tables));
}

if (import.meta.main) await main();
