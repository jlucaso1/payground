import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { deliveryHeaders, notification, signatureHeader } from '@payground/mercadopago/webhook/index.ts';
import {
  InvalidWebhookSignatureError,
  SignatureFailureReason,
  WebhookSignatureValidator,
} from 'mercadopago/dist/utils/webhook';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function text(rng: SeededRandom, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[rng.int(ALPHABET.length)] as string;
  return out;
}

function digits(rng: SeededRandom, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(rng.int(10));
  return out;
}

function uuid(rng: SeededRandom): string {
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[rng.int(16)] as string).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

function reasonOf(run: () => void): SignatureFailureReason {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidWebhookSignatureError);
    return (error as InvalidWebhookSignatureError).reason;
  }
  throw new Error('expected the validator to reject');
}

describe('official SDK validator accepts payground signatures', () => {
  test('a delivery built by payground validates unchanged', () => {
    const secret = 'a-sandbox-secret';
    const requestId = '8e4c1f5a-1111-4000-8000-aaaaaaaaaaaa';
    const dataId = '1234567890';
    const ts = 1704067200;
    const headers = deliveryHeaders({ requestId, ts, dataId, secret });
    const body = notification({
      id: 12345,
      type: 'payment',
      action: 'payment.updated',
      dataId,
      userId: 44444,
      liveMode: false,
      createdAt: ts * 1000,
    });

    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: headers['x-signature'] as string,
        xRequestId: headers['x-request-id'] as string,
        dataId: body.data.id,
        secret,
      }),
    ).not.toThrow();
  });

  test('randomised deliveries all validate', () => {
    const rng = new SeededRandom(4242);
    for (let i = 0; i < 1000; i++) {
      const secret = text(rng, 8 + rng.int(56));
      const requestId = uuid(rng);
      const dataId = rng.int(2) === 0 ? digits(rng, 8 + rng.int(12)) : uuid(rng);
      const ts = 1 + rng.int(2_000_000_000);
      const headers = deliveryHeaders({ requestId, ts, dataId, secret });

      expect(() =>
        WebhookSignatureValidator.validate({
          xSignature: headers['x-signature'] as string,
          xRequestId: requestId,
          dataId,
          secret,
        }),
      ).not.toThrow();
    }
  });

  test('validates when the framework hands the values as arrays', () => {
    const secret = 'array-secret';
    const requestId = 'req-array';
    const dataId = '777';
    const ts = 1700000000;
    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: [signatureHeader({ dataId, requestId, ts, secret })],
        xRequestId: [requestId],
        dataId: [dataId],
        secret,
      }),
    ).not.toThrow();
  });

  test('validates inside a tolerance window against the delivery clock', () => {
    const secret = 'tolerance-secret';
    const requestId = 'req-tolerance';
    const dataId = '999';
    const now = 1_700_000_000_000;
    const ts = Math.floor(now / 1000);
    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: signatureHeader({ dataId, requestId, ts, secret }),
        xRequestId: requestId,
        dataId,
        secret,
        toleranceSeconds: 300,
        now: () => now + 10_000,
      }),
    ).not.toThrow();
  });

  test('validates deliveries whose data id or request id is absent', () => {
    const secret = 'partial-secret';
    const ts = 1699999999;
    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: signatureHeader({ dataId: null, requestId: 'req-only', ts, secret }),
        xRequestId: 'req-only',
        dataId: undefined,
        secret,
      }),
    ).not.toThrow();
    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: signatureHeader({ dataId: '555', requestId: null, ts, secret }),
        xRequestId: null,
        dataId: '555',
        secret,
      }),
    ).not.toThrow();
    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: signatureHeader({ dataId: null, requestId: null, ts, secret }),
        xRequestId: undefined,
        dataId: undefined,
        secret,
      }),
    ).not.toThrow();
  });
});

describe('official SDK validator rejects tampering', () => {
  const secret = 'tamper-secret';
  const requestId = 'c0ffee00-2222-4000-8000-bbbbbbbbbbbb';
  const dataId = '1234567890';
  const ts = 1704067200;
  const header = signatureHeader({ dataId, requestId, ts, secret });
  const valid = { xSignature: header, xRequestId: requestId, dataId, secret };

  test('a flipped hash byte is rejected', () => {
    const hash = header.slice(header.indexOf('v1=') + 3);
    const flipped = `${hash.slice(0, -1)}${hash.endsWith('a') ? 'b' : 'a'}`;
    expect(reasonOf(() => WebhookSignatureValidator.validate({ ...valid, xSignature: `ts=${ts},v1=${flipped}` }))).toBe(
      SignatureFailureReason.SignatureMismatch,
    );
  });

  test('a swapped data id is rejected', () => {
    expect(reasonOf(() => WebhookSignatureValidator.validate({ ...valid, dataId: '1234567891' }))).toBe(
      SignatureFailureReason.SignatureMismatch,
    );
  });

  test('a swapped request id is rejected', () => {
    expect(reasonOf(() => WebhookSignatureValidator.validate({ ...valid, xRequestId: `${requestId}0` }))).toBe(
      SignatureFailureReason.SignatureMismatch,
    );
  });

  test('a replayed hash under a different timestamp is rejected', () => {
    expect(reasonOf(() => WebhookSignatureValidator.validate({ ...valid, xSignature: header.replace(String(ts), String(ts + 1)) }))).toBe(
      SignatureFailureReason.SignatureMismatch,
    );
  });

  test('the wrong secret is rejected', () => {
    expect(reasonOf(() => WebhookSignatureValidator.validate({ ...valid, secret: `${secret}!` }))).toBe(
      SignatureFailureReason.SignatureMismatch,
    );
  });

  test('every randomised delivery rejects a foreign secret', () => {
    const rng = new SeededRandom(31337);
    for (let i = 0; i < 200; i++) {
      const trueSecret = text(rng, 16);
      const otherSecret = text(rng, 16);
      const id = digits(rng, 10);
      const req = uuid(rng);
      const stamp = 1 + rng.int(2_000_000_000);
      expect(
        reasonOf(() =>
          WebhookSignatureValidator.validate({
            xSignature: signatureHeader({ dataId: id, requestId: req, ts: stamp, secret: trueSecret }),
            xRequestId: req,
            dataId: id,
            secret: otherSecret,
          }),
        ),
      ).toBe(SignatureFailureReason.SignatureMismatch);
    }
  });
});

describe('documented divergence', () => {
  // The docs tell integrators to lowercase data.id before templating, and we follow them:
  // https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks
  // The SDK validator does not lowercase, so a mixed-case resource id would disagree. Every id
  // payground mints is already lowercase, which keeps the two implementations in agreement.
  test('a mixed-case data id is where the SDK and the docs part ways', () => {
    const secret = 'case-secret';
    const requestId = 'req-case';
    const ts = 1704067200;
    const mixed = 'ABC-Def';
    expect(
      reasonOf(() =>
        WebhookSignatureValidator.validate({
          xSignature: signatureHeader({ dataId: mixed, requestId, ts, secret }),
          xRequestId: requestId,
          dataId: mixed,
          secret,
        }),
      ),
    ).toBe(SignatureFailureReason.SignatureMismatch);
    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: signatureHeader({ dataId: mixed, requestId, ts, secret }),
        xRequestId: requestId,
        dataId: mixed.toLowerCase(),
        secret,
      }),
    ).not.toThrow();
  });
});
