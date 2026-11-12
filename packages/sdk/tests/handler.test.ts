import { describe, expect, it } from 'vitest';
import {
  PaymentHeaderError,
  buildPaymentSignature,
  parsePaymentRequired,
  readPaymentRequired,
} from '../src/http/handler.js';
import type { AcceptsEntry, PaymentPayload, PaymentRequired } from '../src/types.js';

const NETWORK = 'near:testnet';
const TOKEN = 'token.portico.testnet';
const SPLIT = 'split.portico.testnet';

const ACCEPT: AcceptsEntry = {
  scheme: 'exact',
  network: NETWORK,
  amount: '100000000000000',
  asset: TOKEN,
  payTo: SPLIT,
  maxTimeoutSeconds: 60,
};

function requirement(overrides: Partial<PaymentRequired> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://api.portico.testnet/tools/web-search' },
    accepts: [ACCEPT],
    ...overrides,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function headers(value: string): { get(name: string): string | null } {
  return { get: name => (name === 'PAYMENT-REQUIRED' ? value : null) };
}

describe('PAYMENT-REQUIRED', () => {
  it('decodes the base64 JSON requirement and keeps accepts[0]', () => {
    const parsed = readPaymentRequired({
      status: 402,
      headers: headers(encode(requirement())),
    });

    expect(parsed).toEqual(requirement());
    expect(parsed?.accepts[0]?.amount).toBe('100000000000000');
  });

  it('falls back to a JSON body when the header is stripped', () => {
    const parsed = readPaymentRequired({ status: 402, headers: {}, body: requirement() });
    expect(parsed).toEqual(requirement());
  });

  it('returns null for a non-402 response', () => {
    expect(
      readPaymentRequired({ status: 200, headers: headers(encode(requirement())) })
    ).toBeNull();
  });

  it('rejects a wrong x402Version', () => {
    expect(() => parsePaymentRequired({ ...requirement(), x402Version: -1 })).toThrowError(
      PaymentHeaderError
    );
  });

  it('rejects an empty accepts array', () => {
    expect(() => parsePaymentRequired(requirement({ accepts: [] }))).toThrowError(/non-empty/);
  });

  it('rejects a non-numeric amount', () => {
    expect(() =>
      parsePaymentRequired(requirement({ accepts: [{ ...ACCEPT, amount: '1.5' }] }))
    ).toThrowError(/positive integer/);
  });

  it('rejects a non-positive maxTimeoutSeconds', () => {
    expect(() =>
      parsePaymentRequired(requirement({ accepts: [{ ...ACCEPT, maxTimeoutSeconds: 0 }] }))
    ).toThrowError(/maxTimeoutSeconds/);
  });
});

describe('PAYMENT-SIGNATURE', () => {
  it('encodes the v2 payload shape into a single header', () => {
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: requirement().resource,
      accepted: ACCEPT,
      payload: { signedDelegateAction: Buffer.from([1, 2, 3]).toString('base64') },
    };

    const built = buildPaymentSignature(payload);
    const encoded = built['PAYMENT-SIGNATURE'];
    expect(Object.keys(built)).toEqual(['PAYMENT-SIGNATURE']);
    expect(encoded).toBeDefined();

    const decoded = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8')) as PaymentPayload;
    expect(decoded).toEqual(payload);
  });

  it('rejects a non-canonical signedDelegateAction', () => {
    expect(() =>
      buildPaymentSignature({
        x402Version: 2,
        resource: requirement().resource,
        accepted: ACCEPT,
        payload: { signedDelegateAction: 'not base64!!' },
      })
    ).toThrowError(PaymentHeaderError);
  });
});
