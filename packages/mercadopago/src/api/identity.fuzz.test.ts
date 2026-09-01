import { expect, test } from 'bun:test';
import { unwrap } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { harness } from './fixture.ts';
import { type PayerCost, getInstallments } from './identity.ts';

const METHODS = ['visa', 'master', 'amex', 'elo', 'hipercard', 'debvisa', 'pix', 'bolbradesco'];

test('an instalment plan is always consistent with its amount', () => {
  const random = new SeededRandom(20_240_917);
  const { context } = harness();

  for (let round = 0; round < 500; round += 1) {
    // Above every catalogue minimum, so a plan is always offered.
    const cents = random.int(9_999_899) + 101;
    const amount = cents / 100;
    const method = METHODS[random.int(METHODS.length)] ?? 'visa';
    const entry = unwrap(
      getInstallments(context, new URLSearchParams({ payment_method_id: method, amount: String(amount) })),
    ).body as { payer_costs: PayerCost[] }[];

    const costs = entry[0]?.payer_costs ?? [];
    expect(costs.length).toBeGreaterThan(0);

    let previousRate = -1;
    for (const cost of costs) {
      const each = Math.round(cost.installment_amount * 100);
      expect(each * cost.installments).toBe(Math.round(cost.total_amount * 100));
      expect(cost.installment_rate).toBeGreaterThanOrEqual(previousRate);
      previousRate = cost.installment_rate;

      // The total only drifts from the advertised rate by the instalment rounding plus the
      // half hundredth of a percent the rate itself is rounded to.
      const drift = Math.abs(each * cost.installments - cents * (1 + cost.installment_rate / 100));
      expect(drift).toBeLessThanOrEqual(cost.installments + cents * 0.00005);
      expect(cost.recommended_message).toContain(`${cost.installments} parcela`);
    }
  }
});
