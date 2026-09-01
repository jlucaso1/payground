import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import type { JsonValue } from '@payground/core';
import { redactBody } from './control-history.ts';

const SECRET_KEYS = ['client_secret', 'webhook_secret', 'access_token', 'token', 'password', 'security_code'];
const PLAIN_KEYS = ['id', 'status', 'amount', 'payer', 'items', 'metadata', 'description'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const pick = <T>(random: SeededRandom, items: readonly T[]): T => items[random.int(items.length)] as T;

const word = (random: SeededRandom, length: number): string => {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[random.int(ALPHABET.length)];
  return out;
};

/** A Luhn-valid number of the length real card brands use. */
function cardNumber(random: SeededRandom): string {
  const length = 13 + random.int(7);
  let digits = '';
  for (let i = 0; i < length - 1; i++) digits += String(random.int(10));
  for (let check = 0; check < 10; check++) {
    const candidate = `${digits}${check}`;
    let sum = 0;
    let double = true;
    for (let i = candidate.length - 2; i >= 0; i--) {
      let value = candidate.charCodeAt(i) - 48;
      if (double) {
        value *= 2;
        if (value > 9) value -= 9;
      }
      sum += value;
      double = !double;
    }
    if ((sum + check) % 10 === 0) return candidate;
  }
  throw new Error('unreachable');
}

interface Planted {
  cards: string[];
  secrets: string[];
}

function build(random: SeededRandom, depth: number, planted: Planted): JsonValue {
  const shape = random.int(depth <= 0 ? 3 : 6);
  switch (shape) {
    case 0:
      return word(random, random.int(12));
    case 1:
      return random.int(1_000_000);
    case 2:
      return random.int(2) === 0 ? null : random.int(2) === 0;
    case 3: {
      const items: JsonValue[] = [];
      for (let i = random.int(4); i > 0; i--) items.push(build(random, depth - 1, planted));
      return items;
    }
    default: {
      const out: { [key: string]: JsonValue } = {};
      for (let i = random.int(5); i > 0; i--) {
        const roll = random.int(10);
        if (roll < 2) {
          const secret = `sec-${word(random, 16)}`;
          planted.secrets.push(secret);
          out[pick(random, SECRET_KEYS)] = secret;
        } else if (roll < 4) {
          const card = cardNumber(random);
          planted.cards.push(card);
          // Anywhere, under any key, alone or embedded in text.
          out[pick(random, PLAIN_KEYS)] = random.int(2) === 0 ? card : `paid with ${card}, thanks`;
        } else {
          out[pick(random, PLAIN_KEYS)] = build(random, depth - 1, planted);
        }
      }
      return out;
    }
  }
}

describe('history redaction fuzz', () => {
  test('no card number and no secret survives redaction, over randomly shaped bodies', () => {
    const random = new SeededRandom(20260901);
    let checkedCards = 0;
    let checkedSecrets = 0;

    for (let iteration = 0; iteration < 400; iteration++) {
      const planted: Planted = { cards: [], secrets: [] };
      const body = JSON.stringify(build(random, 4, planted));
      const redacted = redactBody(body) ?? '';

      for (const card of planted.cards) expect(redacted).not.toInclude(card);
      for (const secret of planted.secrets) expect(redacted).not.toInclude(secret);
      checkedCards += planted.cards.length;
      checkedSecrets += planted.secrets.length;
    }

    expect(checkedCards).toBeGreaterThan(50);
    expect(checkedSecrets).toBeGreaterThan(50);
  });

  test('a body that is not Json is scrubbed as text', () => {
    const random = new SeededRandom(7);
    for (let iteration = 0; iteration < 50; iteration++) {
      const card = cardNumber(random);
      expect(redactBody(`<html>${card}</html>`)).not.toInclude(card);
    }
  });
});
