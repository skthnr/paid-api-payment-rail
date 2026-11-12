import { describe, expect, it } from 'vitest';
import { teraToGas, type Action, type SignedDelegate } from 'near-api-js';
import {
  PorticoClient,
  parseSupportedResponse,
  selectAccept,
  type FetchLike,
  type PaymentResponseLike,
} from '../src/client.js';
import type {
  AcceptsEntry,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
} from '../src/types.js';

const NETWORK = 'near:testnet';
const TOKEN = 'token.portico.testnet';
const SPLIT = 'split.portico.testnet';
const RESOURCE = 'https://api.portico.testnet/tools/web-search';
const AMOUNT = '100000000000000';

interface CapturedMetaTransaction {
  receiverId: string;
  actions: Action[];
  blockHeightTtl?: number;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeSignedDelegate(): SignedDelegate {
  return {
    get delegateAction(): never {
      throw new Error('fake delegate has no borsh payload');
    },
    get signature(): never {
      throw new Error('fake delegate has no borsh payload');
    },
    encode: () => Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
  } as unknown as SignedDelegate;
}

function captureAccount(): {
  account: MetaTransactionAccount;
  calls: CapturedMetaTransaction[];
} {
  const calls: CapturedMetaTransaction[] = [];
  const account: MetaTransactionAccount = {
    createSignedMetaTransaction: async args => {
      calls.push(args);
      return { delegateHash: new Uint8Array(32), signedDelegate: fakeSignedDelegate() };
    },
  };
  return { account, calls };
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function response(
  status: number,
  headers: Record<string, string> = {},
  body: unknown = undefined
): PaymentResponseLike {
  const entries = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    status,
    headers: { get: (name: string) => entries.get(name.toLowerCase()) ?? null },
    text: async () => {
      if (body === undefined) {
        return '';
      }
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function scriptedFetch(responses: PaymentResponseLike[]): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error('no scripted response left');
    }
    return next;
  };
  return { fetch: fetchImpl, requests };
}

function requirement(overrides: Partial<AcceptsEntry> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: RESOURCE, description: 'web search', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        amount: AMOUNT,
        asset: TOKEN,
        payTo: SPLIT,
        maxTimeoutSeconds: 60,
        extra: { service: 'web-search' },
        ...overrides,
      },
    ],
  };
}

function settlement(overrides: Partial<SettlementResponse> = {}): SettlementResponse {
  return {
    success: true,
    network: NETWORK,
    payer: 'buyer1.portico.testnet',
    transaction: '4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f',
    settlement: 'settled',
    ...overrides,
  };
}

function buildClient(fetchImpl: FetchLike): PorticoClient {
  return new PorticoClient({
    facilitatorUrl: 'http://localhost:3002/',
    tokenContract: TOKEN,
    splitContract: SPLIT,
    network: NETWORK,
    fetch: fetchImpl,
  });
}

function getFunctionCall(action: Action): NonNullable<Action['functionCall']> {
  const call = action.functionCall;
  if (call === undefined) {
    throw new Error('expected a FunctionCall action');
  }
  return call;
}

describe('PorticoClient.pay', () => {
  it('decodes PAYMENT-REQUIRED, signs accepts[0] and retries with PAYMENT-SIGNATURE', async () => {
    const requirementObject = requirement();
    const settlementObject = settlement();
    const { fetch, requests } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
      response(200, { 'PAYMENT-RESPONSE': encodeHeader(settlementObject) }, { ok: true }),
    ]);
    const { account, calls } = captureAccount();

    const result = await buildClient(fetch).pay({
      account,
      resourceUrl: RESOURCE,
      amount: AMOUNT,
      tool: 'web-search',
      headers: { 'X-Request-Id': 'req-1', 'payment-signature': 'stale-value' },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers['X-Request-Id']).toBe('req-1');
    expect(requests[0]!.headers['payment-signature']).toBeUndefined();
    expect(requests[0]!.headers['PAYMENT-SIGNATURE']).toBeUndefined();

    const signatureHeader = requests[1]!.headers['PAYMENT-SIGNATURE'];
    expect(signatureHeader).toBeDefined();
    const payload = JSON.parse(
      Buffer.from(signatureHeader!, 'base64').toString('utf8')
    ) as PaymentPayload;
    expect(payload.x402Version).toBe(2);
    expect(payload.resource).toEqual(requirementObject.resource);
    expect(payload.accepted).toEqual(requirementObject.accepts[0]);
    expect(payload.payload.signedDelegateAction).toBe(
      Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64')
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.receiverId).toBe(TOKEN);
    expect(calls[0]!.blockHeightTtl).toBe(60);
    expect(calls[0]!.actions).toHaveLength(1);
    const functionCall = getFunctionCall(calls[0]!.actions[0]!);
    expect(functionCall.methodName).toBe('ft_transfer_call');
    expect(functionCall.gas).toBe(teraToGas(100));
    expect(functionCall.deposit).toBe(1n);
    expect(JSON.parse(Buffer.from(functionCall.args).toString('utf8'))).toEqual({
      receiver_id: SPLIT,
      amount: AMOUNT,
      msg: JSON.stringify({ action: 'pay_tool', tool: 'web-search' }),
    });

    expect(result.settlement).toEqual(settlementObject);
    expect(result.response.status).toBe(200);
  });

  it('refuses a non-402 resource without signing', async () => {
    const { fetch } = scriptedFetch([response(200, {}, { paid: false })]);
    const { account, calls } = captureAccount();

    await expect(
      buildClient(fetch).pay({
        account,
        resourceUrl: RESOURCE,
        amount: AMOUNT,
        tool: 'web-search',
      })
    ).rejects.toMatchObject({ code: 'payment_required_missing', status: 200 });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['network', { network: 'near:mainnet' }],
    ['asset', { asset: 'other-token.testnet' }],
    ['payTo', { payTo: 'someone-else.testnet' }],
    ['amount', { amount: '999' }],
  ])('refuses accepts[0] when %s does not match', async (field, override) => {
    const requirementObject = requirement(override as Partial<AcceptsEntry>);
    const { fetch, requests } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
    ]);
    const { account, calls } = captureAccount();

    await expect(
      buildClient(fetch).pay({
        account,
        resourceUrl: RESOURCE,
        amount: AMOUNT,
        tool: 'web-search',
      })
    ).rejects.toMatchObject({ code: 'payment_accept_mismatch', field });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it('only reads the requirement from accepts[0]', () => {
    const first = requirement().accepts[0]!;
    const second = requirement({ asset: 'other-token.testnet' }).accepts[0]!;

    expect(
      selectAccept(
        { x402Version: 2, resource: { url: RESOURCE }, accepts: [first, second] },
        { network: NETWORK, asset: TOKEN, payTo: SPLIT, amount: AMOUNT }
      )
    ).toEqual(first);
  });

  it('shortens but never extends the quoted delegate lifetime', async () => {
    const requirementObject = requirement();
    const settlementObject = settlement();
    const { fetch } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
      response(200, { 'PAYMENT-RESPONSE': encodeHeader(settlementObject) }),
    ]);
    const { account, calls } = captureAccount();

    await buildClient(fetch).pay({
      account,
      resourceUrl: RESOURCE,
      amount: AMOUNT,
      tool: 'web-search',
      maxTimeoutSeconds: 15,
    });
    expect(calls[0]!.blockHeightTtl).toBe(15);

    const tooLong = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
    ]);
    const second = captureAccount();
    await expect(
      buildClient(tooLong.fetch).pay({
        account: second.account,
        resourceUrl: RESOURCE,
        amount: AMOUNT,
        tool: 'web-search',
        maxTimeoutSeconds: 61,
      })
    ).rejects.toMatchObject({ code: 'invalid_payment_options' });
    expect(second.calls).toHaveLength(0);
  });

  it('forwards the POST method and body on both attempts', async () => {
    const requirementObject = requirement();
    const { fetch, requests } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
      response(200, { 'PAYMENT-RESPONSE': encodeHeader(settlement()) }),
    ]);
    const { account } = captureAccount();

    await buildClient(fetch).pay({
      account,
      resourceUrl: RESOURCE,
      amount: AMOUNT,
      tool: 'web-search',
      method: 'POST',
      body: JSON.stringify({ query: 'near' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(requests.map(request => request.method)).toEqual(['POST', 'POST']);
    expect(requests.map(request => request.body)).toEqual([
      JSON.stringify({ query: 'near' }),
      JSON.stringify({ query: 'near' }),
    ]);
    expect(requests[1]!.headers['Content-Type']).toBe('application/json');
  });

  it('throws when the paid response omits PAYMENT-RESPONSE', async () => {
    const requirementObject = requirement();
    const { fetch } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
      response(200, {}, { ok: true }),
    ]);
    const { account } = captureAccount();

    await expect(
      buildClient(fetch).pay({
        account,
        resourceUrl: RESOURCE,
        amount: AMOUNT,
        tool: 'web-search',
      })
    ).rejects.toMatchObject({ code: 'payment_settlement_missing', status: 200 });
  });

  it('throws when the facilitator reports success:false', async () => {
    const requirementObject = requirement();
    const failed = settlement({ success: false, errorReason: 'duplicate_settlement' });
    const { fetch } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
      response(200, { 'PAYMENT-RESPONSE': encodeHeader(failed) }),
    ]);
    const { account } = captureAccount();

    await expect(
      buildClient(fetch).pay({
        account,
        resourceUrl: RESOURCE,
        amount: AMOUNT,
        tool: 'web-search',
      })
    ).rejects.toMatchObject({
      code: 'payment_settlement_failed',
      settlement: { success: false, errorReason: 'duplicate_settlement' },
    });
  });

  it('never downgrades: a second 402 is a rejection', async () => {
    const requirementObject = requirement();
    const { fetch } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(requirementObject) }, requirementObject),
      response(402, {}, { error: 'invalid delegate' }),
    ]);
    const { account } = captureAccount();

    await expect(
      buildClient(fetch).pay({
        account,
        resourceUrl: RESOURCE,
        amount: AMOUNT,
        tool: 'web-search',
      })
    ).rejects.toMatchObject({ code: 'payment_rejected', status: 402 });
  });
});

describe('PorticoClient.quote', () => {
  it('posts the service and params and returns the exact quoted amount', async () => {
    const quoted = requirement({
      amount: '200000000000000',
      extra: { service: 'web-search', quantity: 2 },
    });
    const { fetch, requests } = scriptedFetch([
      response(402, { 'PAYMENT-REQUIRED': encodeHeader(quoted) }, quoted),
    ]);

    const result = await buildClient(fetch).quote('web-search', { quantity: 2 });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://localhost:3002/quote');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(requests[0]!.body ?? '')).toEqual({
      service: 'web-search',
      params: { quantity: 2 },
    });
    expect(result.accepts[0]!.amount).toBe('200000000000000');
    expect(result.resource.url).toBe(RESOURCE);
  });

  it('rejects a non-402 quote', async () => {
    const { fetch } = scriptedFetch([response(500, {}, { error: 'boom' })]);

    await expect(buildClient(fetch).quote('web-search')).rejects.toMatchObject({
      code: 'quote_request_failed',
      status: 500,
    });
  });
});

describe('PorticoClient.supported', () => {
  it('parses kinds, extensions and relayer signers', async () => {
    const document = {
      kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
      extensions: [],
      signers: { [NETWORK]: ['relayer.portico.testnet'] },
    };
    const { fetch, requests } = scriptedFetch([response(200, {}, document)]);

    const supported = await buildClient(fetch).supported();

    expect(requests[0]!.url).toBe('http://localhost:3002/supported');
    expect(supported).toEqual(document);
  });

  it('rejects a document without signers', () => {
    expect(() =>
      parseSupportedResponse({
        kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
        extensions: [],
      })
    ).toThrowError(/signers/);
  });

  it('rejects a non-exact kind', () => {
    expect(() =>
      parseSupportedResponse({
        kinds: [{ x402Version: 2, scheme: 'other', network: NETWORK }],
        extensions: [],
        signers: {},
      })
    ).toThrowError(/scheme/);
  });
});
