import {
  type Minor,
  type Payment,
  type PaymentCommand,
  type PaymentMethod,
  type Sandbox,
  type SandboxStore,
  apply,
  create,
  paymentId,
  refundId,
  refundable,
  sandboxId,
} from '@payground/core';
import { SeededIdGenerator, SeededRandom } from '@payground/core/testing.ts';
import { decide } from '@payground/mercadopago/api/decision.ts';
import { TEST_CARDS } from '@payground/mercadopago/generated/tables.ts';
import type { Storage } from '@payground/storage';
import { FAILURE, OK, USAGE_ERROR, flag, integer, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';

export const SEED_USAGE = `Usage: payground seed [options]

Writes a deterministic spread of payments into the first sandbox, creating one if the
database is empty. The same --seed and the same clock always produce the same data.

  --db <path>       SQLite file, or :memory: (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --sandbox <id>    Sandbox to write into (default: the oldest one)
  --payments <n>    How many payments to write (default 12, max 500)
  --seed <n>        Seed for ids and amounts (default 1)
  -h, --help        Show this help`;

/** Provider-facing ids start here, exactly as the Mercado Pago adapter mints them. */
const SEQUENCE_BASE = 1_000_000_000;
const SPACING_MS = 15 * 60 * 1000;
const SHORT_TTL_MS = 5 * 60 * 1000;

type Step = 'settle' | 'capture' | 'expire' | 'cancel' | 'dispute' | 'chargeback' | 'refund-full' | 'refund-half';

interface Recipe {
  readonly code: string;
  /** Test cardholder name, which is what decides a card payment's outcome. */
  readonly holder?: string;
  readonly capture?: boolean;
  readonly steps?: readonly Step[];
}

/** Ordered so that a small --payments still covers the interesting states. */
const RECIPES: readonly Recipe[] = [
  { code: 'pix', steps: ['settle'] },
  { code: 'pix' },
  { code: 'master', holder: 'APRO' },
  { code: 'visa', holder: 'FUND' },
  { code: 'pix', steps: ['expire'] },
  { code: 'master', holder: 'APRO', steps: ['refund-full'] },
  { code: 'bolbradesco' },
  { code: 'visa', holder: 'CONT' },
  { code: 'master', holder: 'APRO', capture: false },
  { code: 'account_money' },
  { code: 'visa', holder: 'APRO', steps: ['refund-half'] },
  { code: 'pix', steps: ['cancel'] },
  { code: 'amex', holder: 'SECU' },
  { code: 'master', holder: 'APRO', capture: false, steps: ['capture'] },
  { code: 'visa', holder: 'APRO', steps: ['dispute'] },
  { code: 'master', holder: 'APRO', steps: ['dispute', 'chargeback'] },
  { code: 'debelo', holder: 'OTHE' },
  { code: 'bolbradesco', steps: ['expire'] },
];

const CARD_BY_CODE: Record<string, (typeof TEST_CARDS)[number] | undefined> = {
  master: TEST_CARDS[0],
  visa: TEST_CARDS[1],
  amex: TEST_CARDS[2],
  debelo: TEST_CARDS[3],
};

const PAYERS = ['ana.souza', 'bruno.lima', 'carla.dias', 'diego.rocha', 'elisa.matos'] as const;

function cardSnapshot(code: string, holder: string): PaymentMethod['card'] {
  const card = CARD_BY_CODE[code];
  if (card === undefined) return null;
  const digits = card.number.replaceAll(' ', '');
  const [month, year] = card.expiration.split('/');
  return {
    bin: digits.slice(0, 6),
    lastFour: digits.slice(-4),
    expiryMonth: Number(month),
    expiryYear: 2000 + Number(year),
    holderName: holder,
    brand: code,
  };
}

function methodFor(recipe: Recipe): PaymentMethod {
  const holder = recipe.holder;
  if (holder === undefined) {
    const kind = recipe.code === 'pix' ? 'bank_transfer' : recipe.code === 'account_money' ? 'wallet' : 'voucher';
    return { kind, code: recipe.code, card: null };
  }
  return { kind: 'card', code: recipe.code, card: cardSnapshot(recipe.code, holder) };
}

function commandFor(step: Step, payment: Payment): PaymentCommand {
  switch (step) {
    case 'settle':
      return { type: 'settle' };
    case 'capture':
      return { type: 'capture', amount: null };
    case 'expire':
      return { type: 'expire' };
    case 'cancel':
      return { type: 'cancel', by: 'collector' };
    case 'dispute':
      return { type: 'dispute' };
    case 'chargeback':
      return { type: 'resolve', outcome: 'chargeback' };
    case 'refund-full':
      return { type: 'refund', amount: refundable(payment) };
    case 'refund-half':
      return { type: 'refund', amount: Math.max(1, Math.floor(refundable(payment) / 2)) as Minor };
  }
}

function ensureSandbox(storage: Storage, ids: SeededIdGenerator, now: number): Sandbox {
  const existing = storage.sandboxes.list()[0];
  if (existing !== undefined) return existing;
  const created: Sandbox = {
    id: sandboxId(ids.uuid()),
    name: 'default',
    accessToken: `TEST-${ids.uuid()}`,
    publicKey: `TEST-${ids.uuid()}`,
    webhookSecret: ids.uuid(),
    liveMode: false,
    createdAt: now,
  };
  storage.sandboxes.create(created);
  return created;
}

/** The same seed mints the same ids, so seeding twice over the same data would collide. */
class AlreadySeeded extends Error {}

function write(store: SandboxStore, sandbox: Sandbox, recipe: Recipe, at: number, amount: Minor, index: number, ids: SeededIdGenerator, random: SeededRandom): Payment | null {
  const method = methodFor(recipe);
  const capture = recipe.capture ?? true;
  const wantsExpiry = (recipe.steps ?? []).includes('expire');
  const expiresAt = method.kind === 'bank_transfer' || method.kind === 'voucher' ? at + (wantsExpiry ? SHORT_TTL_MS : 24 * 60 * 60 * 1000) : null;
  const payer = PAYERS[random.int(PAYERS.length)] as string;

  const id = paymentId(ids.uuid());
  if (store.payments.get(id) !== null) throw new AlreadySeeded();

  const created = create(
    {
      id,
      sandbox: sandbox.id,
      method,
      payer: {
        email: `${payer}@example.com`,
        firstName: null,
        lastName: null,
        documentType: 'CPF',
        documentNumber: '12345678909',
      },
      amount,
      currency: 'BRL',
      installments: method.kind === 'card' ? 1 + random.int(3) : 1,
      binaryMode: false,
      captureOnCreate: capture,
      description: `Seeded order ${1000 + index}`,
      externalReference: `order-${1000 + index}`,
      notificationUrl: null,
      metadata: { source: 'payground-seed' },
      expiresAt,
    },
    decide({ method, capture, binaryMode: false }),
    at,
  );
  if (!created.ok) return null;

  let payment = created.value;
  store.payments.insert(payment, SEQUENCE_BASE + store.nextSequence('payment'));

  let step = 0;
  for (const name of recipe.steps ?? []) {
    step += 1;
    const command = commandFor(name, payment);
    const when = name === 'expire' ? (payment.expiresAt ?? at) + 60_000 : at + step * 60_000;
    const transition = apply(payment, command, when);
    if (!transition.ok) break;
    payment = transition.value.payment;
    store.payments.update(payment);
    store.payments.record(transition.value);
    if (command.type === 'refund') {
      store.refunds.insert(
        {
          id: refundId(ids.uuid()),
          sandbox: sandbox.id,
          paymentId: payment.id,
          amount: command.amount,
          status: 'approved',
          partial: name === 'refund-half',
          createdAt: when,
        },
        SEQUENCE_BASE + store.nextSequence('refund'),
      );
    }
  }
  return payment;
}

export function runSeed(argv: readonly string[], env: Env): number {
  const parsed = parseOptions(argv, {
    db: { type: 'string' },
    sandbox: { type: 'string' },
    payments: { type: 'string' },
    seed: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(SEED_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(SEED_USAGE);
    return OK;
  }

  const count = integer(text(parsed.values, 'payments') ?? '12', 'payments', 1, 500);
  if (!count.ok) {
    env.io.err(count.message);
    return USAGE_ERROR;
  }
  const seed = integer(text(parsed.values, 'seed') ?? '1', 'seed', 0, Number.MAX_SAFE_INTEGER);
  if (!seed.ok) {
    env.io.err(seed.message);
    return USAGE_ERROR;
  }

  const db = text(parsed.values, 'db') ?? env.variables['PAYGROUND_DB'] ?? DEFAULT_DB;
  let storage: Storage;
  try {
    storage = env.openStorage(db);
  } catch (error) {
    env.io.err(`cannot open the database at ${db}: ${error instanceof Error ? error.message : String(error)}`);
    return FAILURE;
  }

  try {
    const ids = new SeededIdGenerator(seed.value);
    const random = new SeededRandom(seed.value + 1);
    const now = env.now();
    const only = text(parsed.values, 'sandbox');
    const target = only === undefined ? null : storage.sandboxes.get(sandboxId(only));
    if (only !== undefined && target === null) {
      env.io.err(`sandbox not found: ${only}`);
      return FAILURE;
    }
    const sandbox = target ?? ensureSandbox(storage, ids, now - count.value * SPACING_MS);
    const store = storage.forSandbox(sandbox.id);

    const counts = new Map<string, number>();
    let written = 0;
    try {
      storage.transaction(() => {
        for (let index = 0; index < count.value; index += 1) {
          const recipe = RECIPES[index % RECIPES.length] as Recipe;
          const at = now - (count.value - index) * SPACING_MS;
          const amount = (1000 + random.int(50_000)) as Minor;
          const payment = write(store, sandbox, recipe, at, amount, index, ids, random);
          if (payment === null) continue;
          written += 1;
          counts.set(payment.status.state, (counts.get(payment.status.state) ?? 0) + 1);
        }
      });
    } catch (error) {
      if (!(error instanceof AlreadySeeded)) throw error;
      env.io.err(`${sandbox.id} already holds the payments of --seed ${seed.value}; run \`payground reset\` first`);
      return FAILURE;
    }

    env.io.out(`seeded ${written} payments into ${sandbox.id} (${sandbox.name})`);
    env.io.out(`  access token   ${sandbox.accessToken}`);
    for (const [state, total] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      env.io.out(`  ${state.padEnd(14)} ${total}`);
    }
    env.io.out(`  ${'total'.padEnd(14)} ${store.payments.search({ limit: 1 }).total}`);
    return OK;
  } finally {
    storage.close();
  }
}
