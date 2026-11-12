import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parsePaymentRequired,
  parseSettlementResponse,
} from '@portico/sdk';
import { createPaywallApp, type PaywallConfig, type PaywallFetch } from './index.js';

const TOKEN = 'token.portico.testnet';
const SPLIT = 'split.portico.testnet';
const NETWORK = 'near:testnet';
const RESOURCE = 'http://paywall.test/premium';
const TX_HASH = '4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f';

interface FakeCall {
  url: string;
  signature: string | null;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function config(overrides: Partial<PaywallConfig> = {}): PaywallConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    facilitatorUrl: 'http://facilitator.test',
    network: NETWORK,
    tokenContract: TOKEN,
    splitContract: SPLIT,
    amount: '1000000',
    tool: 'web-search',
    resourceUrl: RESOURCE,
    description: 'premium data',
    maxTimeoutSeconds: 60,
    allowedOrigins: ['http://localhost:3000'],
    ...overrides,
  };
}

function fakeFacilitator(
  verify: () => Response,
  settle: () => Response
): { fetch: PaywallFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl: PaywallFetch = async (url, init) => {
    calls.push({ url, signature: init.headers[PAYMENT_SIGNATURE_HEADER] ?? null });
    if (url.endsWith('/verify')) {
      return verify();
    }
    if (url.endsWith('/settle')) {
      return settle();
    }
    return json(404, { error: 'Not found' });
  };
  return { fetch: fetchImpl, calls };
}

function paymentSignature(overrides: { amount?: string } = {}): string {
  return encode({
    x402Version: 2,
    resource: {
      url: RESOURCE,
      description: 'premium data',
      mimeType: 'application/json',
    },
    accepted: {
      scheme: 'exact',
      network: NETWORK,
      amount: overrides.amount ?? '1000000',
      asset: TOKEN,
      payTo: SPLIT,
      maxTimeoutSeconds: 60,
      extra: { tool: 'web-search' },
    },
    payload: { signedDelegateAction: Buffer.from('signed-delegate').toString('base64') },
  });
}

function settledBody(): Record<string, unknown> {
  return {
    success: true,
    network: NETWORK,
    payer: 'buyer1.portico.testnet',
    transaction: TX_HASH,
    settlement: 'settled',
  };
}

async function withApp(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('test server did not expose a TCP address');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeIdleConnections();
    await closed;
  }
}

describe('paywall 402 loop', () => {
  it('answers an unpaid request with the v2 PAYMENT-REQUIRED requirement', async () => {
    const facilitator = fakeFacilitator(
      () => json(200, { success: true }),
      () => json(200, settledBody())
    );
    const { app } = createPaywallApp(config(), { fetch: facilitator.fetch });
    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/premium`);
      expect(response.status).toBe(402);
      const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
      expect(header).not.toBeNull();
      const requirement = parsePaymentRequired(
        JSON.parse(Buffer.from(header ?? '', 'base64').toString('utf8'))
      );
      expect(requirement.x402Version).toBe(2);
      expect(requirement.resource.url).toBe(RESOURCE);
      expect(requirement.accepts[0]).toMatchObject({
        scheme: 'exact',
        network: NETWORK,
        amount: '1000000',
        asset: TOKEN,
        payTo: SPLIT,
        maxTimeoutSeconds: 60,
      });
      expect(await response.json()).toEqual(requirement);
      expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    });
    expect(facilitator.calls).toEqual([]);
  });

  it('does not touch the facilitator without PAYMENT-SIGNATURE', async () => {
    const facilitator = fakeFacilitator(
      () => json(200, { success: true }),
      () => json(200, settledBody())
    );
    const { app } = createPaywallApp(config(), { fetch: facilitator.fetch });
    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/premium`);
      expect(response.status).toBe(402);
      expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    });
    expect(facilitator.calls).toEqual([]);
  });

  it('returns the resource and PAYMENT-RESPONSE after verify and settled settlement', async () => {
    const settlement = settledBody();
    const facilitator = fakeFacilitator(
      () => json(200, { success: true, payer: 'buyer1.portico.testnet' }),
      () =>
        json(200, settlement, {
          [PAYMENT_RESPONSE_HEADER]: encode(settlement),
        })
    );
    const signature = paymentSignature();
    const { app } = createPaywallApp(config(), { fetch: facilitator.fetch });
    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/premium`, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: signature },
      });
      expect(response.status).toBe(200);
      const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
      expect(header).not.toBeNull();
      expect(
        parseSettlementResponse(JSON.parse(Buffer.from(header ?? '', 'base64').toString('utf8')))
      ).toMatchObject({ success: true, settlement: 'settled', transaction: TX_HASH });
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, paid: true });
      expect(body.resource).toMatchObject({ url: RESOURCE });
      expect(body.settlement).toMatchObject({ success: true, transaction: TX_HASH });
    });
    expect(facilitator.calls).toEqual([
      { url: 'http://facilitator.test/verify', signature },
      { url: 'http://facilitator.test/settle', signature },
    ]);
  });

  it('propagates a failed settlement without the resource or a success header', async () => {
    const failure = {
      success: false,
      errorReason: 'settlement_failed',
      network: NETWORK,
    };
    const facilitator = fakeFacilitator(
      () => json(200, { success: true }),
      () =>
        json(200, failure, {
          [PAYMENT_RESPONSE_HEADER]: encode(failure),
        })
    );
    const { app } = createPaywallApp(config(), { fetch: facilitator.fetch });
    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/premium`, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentSignature() },
      });
      expect(response.status).toBe(402);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ success: false, errorReason: 'settlement_failed' });
      const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
      expect(header).not.toBeNull();
      expect(
        parseSettlementResponse(JSON.parse(Buffer.from(header ?? '', 'base64').toString('utf8')))
      ).toMatchObject({ success: false, errorReason: 'settlement_failed' });
    });
  });

  it('rejects a signature that undercuts the quoted requirement before any facilitator call', async () => {
    const facilitator = fakeFacilitator(
      () => json(200, { success: true }),
      () => json(200, settledBody())
    );
    const { app } = createPaywallApp(config(), { fetch: facilitator.fetch });
    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/premium`, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentSignature({ amount: '1' }) },
      });
      expect(response.status).toBe(402);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ error: 'payment_requirement_mismatch' });
    });
    expect(facilitator.calls).toEqual([]);
  });

  it('propagates a verification failure status without the resource', async () => {
    const facilitator = fakeFacilitator(
      () => json(400, { success: false, errorReason: 'invalid_signature_encoding' }),
      () => json(200, settledBody())
    );
    const { app } = createPaywallApp(config(), { fetch: facilitator.fetch });
    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/premium`, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentSignature() },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        success: false,
        errorReason: 'invalid_signature_encoding',
      });
    });
    expect(facilitator.calls.map(call => call.url)).toEqual(['http://facilitator.test/verify']);
  });

  it('answers CORS preflight unpaid and exposes the payment headers', async () => {
    const facilitator = fakeFacilitator(
      () => json(200, { success: true }),
      () => json(200, settledBody())
    );
    const { app } = createPaywallApp(config(), { fetch: facilitator.fetch });
    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/premium`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'PAYMENT-SIGNATURE,content-type',
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      expect(allowed).toContain('payment-signature');
      expect(allowed).toContain('content-type');
      const exposed = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase();
      expect(exposed).toContain('payment-required');
      expect(exposed).toContain('payment-response');
      expect((response.headers.get('vary') ?? '').toLowerCase()).toContain('origin');
      expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
    });
    expect(facilitator.calls).toEqual([]);
  });
});
