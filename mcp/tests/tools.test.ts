import { describe, expect, it } from 'vitest';
import type {
  FetchLike,
  PaymentResponseLike,
} from '@portico/sdk';
import {
  PorticoTools,
  ToolConfigError,
  ToolInputError,
  type PorticoToolsConfig,
} from '../src/tools.js';

const TOKEN = 'token.portico.testnet';
const SPLIT = 'split.portico.testnet';
const NETWORK = 'near:testnet';
const TX_HASH = '4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f';

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): PaymentResponseLike {
  const entries = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    status,
    headers: { get: (name: string) => entries.get(name.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  };
}

function scriptedFetch(responses: PaymentResponseLike[]): {
  fetch: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(`${init?.method ?? 'GET'} ${url}`);
    const next = responses.shift();
    if (next === undefined) {
      throw new Error('no scripted response left');
    }
    return next;
  };
  return { fetch: fetchImpl, urls };
}

function tools(
  fetchImpl?: FetchLike,
  overrides: Partial<PorticoToolsConfig> = {}
): PorticoTools {
  return new PorticoTools({
    facilitatorUrl: 'http://facilitator.test',
    rpcUrl: 'http://127.0.0.1:1',
    network: NETWORK,
    tokenContract: TOKEN,
    splitContract: SPLIT,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...overrides,
  });
}

function requirement(): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: {
      url: 'http://facilitator.test/quote/web-search',
      description: 'web-search API call',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        amount: '1000000',
        asset: TOKEN,
        payTo: SPLIT,
        maxTimeoutSeconds: 60,
      },
    ],
  };
}

describe('MCP tools', () => {
  it('quotes a service through the facilitator', async () => {
    const document = requirement();
    const scripted = scriptedFetch([
      jsonResponse(402, document, { 'PAYMENT-REQUIRED': encodeHeader(document) }),
    ]);
    const result = await tools(scripted.fetch).execute('x402_quote', {
      service: 'web-search',
    });
    expect(result).toEqual(document);
    expect(scripted.urls).toEqual(['POST http://facilitator.test/quote']);
  });

  it('verifies a payment through the facilitator ledger route', async () => {
    const payment = {
      success: true,
      network: NETWORK,
      transaction: TX_HASH,
      settlement: 'settled',
    };
    const scripted = scriptedFetch([jsonResponse(200, payment)]);
    const result = await tools(scripted.fetch).execute('x402_verify_payment', {
      transactionHash: TX_HASH,
    });
    expect(result).toEqual({ verified: true, payment });
    expect(scripted.urls).toEqual([`GET http://facilitator.test/payments/${TX_HASH}`]);
  });

  it('requires buyer key material before signing a payment', async () => {
    await expect(
      tools().execute('x402_pay', {
        resourceUrl: 'http://paywall.test/premium',
        tool: 'web-search',
        amount: '1000000',
      })
    ).rejects.toBeInstanceOf(ToolConfigError);
  });

  it('validates amounts, accounts and tool names before network access', async () => {
    await expect(
      tools().execute('x402_pay', {
        resourceUrl: 'http://paywall.test/premium',
        tool: 'web-search',
        amount: '0',
      })
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      tools().execute('x402_balance', { account: 'Not An Account' })
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      tools().execute('x402_quote', { service: '' })
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(tools().execute('x402_unknown', {})).rejects.toBeInstanceOf(ToolInputError);
  });

  it('rejects non-object quote params without calling the facilitator', async () => {
    await expect(
      tools().execute('x402_quote', { service: 'web-search', params: ['bad'] })
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
