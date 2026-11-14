/**
 * x402 v2 payment client for the NEAR exact scheme.
 *
 * `pay()` performs the buyer loop end to end: request the resource, read the
 * HTTP 402 `PAYMENT-REQUIRED` requirement, sign one NEP-366 delegate for the
 * split `ft_transfer_call`, retry with `PAYMENT-SIGNATURE`, then require a
 * successful `PAYMENT-RESPONSE`. There is no unpaid fallback: any deviation
 * from the quoted requirement throws a typed error instead of degrading.
 */

import {
  DEFAULT_NETWORK,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
} from './constants.js';
import {
  ClientConfigError,
  PaymentAcceptError,
  PaymentOptionsError,
  PaymentRejectedError,
  PaymentRequestError,
  PaymentRequirementError,
  PaymentSettlementError,
  PaymentSettlementMissingError,
  QuoteRequestError,
  SupportedRequestError,
} from './errors.js';
import { isRecord } from './guards.js';
import {
  buildPaymentSignature,
  decodeHeaderJson,
  getHeader,
  parsePaymentRequired,
  readPaymentRequired,
  readSettlementResponse,
  type HeaderReader,
} from './http/handler.js';
import {
  createSplitDelegate,
  encodeSignedDelegateBase64,
  normalizeAmount,
  type MetaTransactionAccount,
} from './payments/metaTx.js';
import type { AcceptsEntry, PaymentPayload, PaymentRequired, SettlementResponse } from './types.js';

/** Minimal response surface consumed by the client; `Response` satisfies it. */
export interface PaymentResponseLike {
  status: number;
  headers: HeaderReader;
  text(): Promise<string>;
}

/** Injectable fetch used by the client; `globalThis.fetch` satisfies it. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<PaymentResponseLike>;

export type PayMethod = 'GET' | 'POST';

export interface PorticoClientOptions {
  /** Facilitator base URL, e.g. `http://localhost:3002`. */
  facilitatorUrl: string;
  /** NEP-141 contract the delegate spends. */
  tokenContract: string;
  /** Split contract used as `payTo` and as the FT `receiver_id`. */
  splitContract: string;
  /** CAIP-2 network id; defaults to `near:testnet`. */
  network?: string;
  /** Fetch implementation; defaults to the runtime `fetch`. */
  fetch?: FetchLike;
}

export interface PayOptions {
  /** Signing account; any `near-api-js` `Account` satisfies this shape. */
  account: MetaTransactionAccount;
  /** Paid resource URL. */
  resourceUrl: string;
  /** Expected price in raw FT units; must equal `accepts[0].amount`. */
  amount: string | bigint;
  /** Tool name dispatched by the split contract. */
  tool: string;
  /** Split action; defaults to `pay_tool`. */
  action?: string;
  /** Delegate lifetime; may only shorten `accepts[0].maxTimeoutSeconds`. */
  maxTimeoutSeconds?: number;
  /** Extra request headers kept on both the unpaid and paid requests. */
  headers?: Record<string, string>;
  /** HTTP method for the resource; defaults to `GET`. */
  method?: PayMethod;
  /** Request body sent on both attempts when the resource is a POST endpoint. */
  body?: string;
}

export interface PaymentResult {
  /** The paid response; its body is unread. */
  response: PaymentResponseLike;
  settlement: SettlementResponse;
}

export interface AcceptExpectation {
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

export interface SupportedKind {
  x402Version: 2;
  scheme: 'exact';
  network: string;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function configString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ClientConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PaymentOptionsError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) {
      result[key] = value;
    }
  }
  return result;
}

function mergeHeaders(
  base: Record<string, string>,
  override: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {};
  const overridden = new Set(Object.keys(override).map(name => name.toLowerCase()));
  for (const [name, value] of Object.entries(base)) {
    if (!overridden.has(name.toLowerCase())) {
      merged[name] = value;
    }
  }
  for (const [name, value] of Object.entries(override)) {
    merged[name] = value;
  }
  return merged;
}

async function readResponseBody(
  response: PaymentResponseLike
): Promise<{ text: string | null; json: unknown }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { text: null, json: undefined };
  }
  if (text.trim().length === 0) {
    return { text, json: undefined };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

/**
 * Select the requirement the client will pay. x402 v2 places the requirement
 * in `accepts[0]`; entries after the first are not a downgrade path, so a
 * mismatch on the first entry throws instead of silently picking another.
 */
export function selectAccept(
  requirement: PaymentRequired,
  expectation: AcceptExpectation
): AcceptsEntry {
  const accept = requirement.accepts[0];
  if (accept === undefined) {
    throw new PaymentAcceptError('accepts', 'PAYMENT-REQUIRED carries no accepts entry');
  }
  if (accept.scheme !== 'exact') {
    throw new PaymentAcceptError(
      'scheme',
      `accepts[0].scheme is "${accept.scheme}", expected "exact"`
    );
  }
  if (accept.network !== expectation.network) {
    throw new PaymentAcceptError(
      'network',
      `accepts[0].network is "${accept.network}", expected "${expectation.network}"`
    );
  }
  if (accept.asset !== expectation.asset) {
    throw new PaymentAcceptError(
      'asset',
      `accepts[0].asset is "${accept.asset}", expected "${expectation.asset}"`
    );
  }
  if (accept.payTo !== expectation.payTo) {
    throw new PaymentAcceptError(
      'payTo',
      `accepts[0].payTo is "${accept.payTo}", expected "${expectation.payTo}"`
    );
  }
  if (accept.amount !== expectation.amount) {
    throw new PaymentAcceptError(
      'amount',
      `accepts[0].amount is "${accept.amount}", expected "${expectation.amount}"`
    );
  }
  return accept;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
    throw new SupportedRequestError(`/supported: ${field} must be an array of strings`);
  }
  return value as string[];
}

/** Strict parser for the facilitator's `GET /supported` document. */
export function parseSupportedResponse(value: unknown): SupportedResponse {
  if (!isRecord(value)) {
    throw new SupportedRequestError('/supported must be a JSON object');
  }
  const kindsValue = value.kinds;
  if (!Array.isArray(kindsValue)) {
    throw new SupportedRequestError('/supported: kinds must be an array');
  }
  const kinds = kindsValue.map((kind, index): SupportedKind => {
    if (!isRecord(kind)) {
      throw new SupportedRequestError(`/supported: kinds[${index}] must be an object`);
    }
    if (kind.x402Version !== X402_VERSION) {
      throw new SupportedRequestError(`/supported: kinds[${index}].x402Version must be 2`);
    }
    if (kind.scheme !== 'exact') {
      throw new SupportedRequestError(`/supported: kinds[${index}].scheme must be "exact"`);
    }
    const network = kind.network;
    if (typeof network !== 'string' || !network.startsWith('near:')) {
      throw new SupportedRequestError(
        `/supported: kinds[${index}].network must be a NEAR CAIP-2 id`
      );
    }
    return { x402Version: X402_VERSION, scheme: 'exact', network };
  });
  const extensions = requireStringArray(value.extensions, 'extensions');
  const signersValue = value.signers;
  if (!isRecord(signersValue)) {
    throw new SupportedRequestError('/supported: signers must be an object');
  }
  const signers: Record<string, string[]> = {};
  for (const [network, accounts] of Object.entries(signersValue)) {
    signers[network] = requireStringArray(accounts, `signers.${network}`);
  }
  return { kinds, extensions, signers };
}

export class PorticoClient {
  public readonly facilitatorUrl: string;
  public readonly tokenContract: string;
  public readonly splitContract: string;
  public readonly network: string;
  private readonly fetchImpl: FetchLike;

  public constructor(options: PorticoClientOptions) {
    const facilitatorUrl = configString(options.facilitatorUrl, 'facilitatorUrl');
    try {
      new URL(facilitatorUrl);
    } catch (cause) {
      throw new ClientConfigError(`facilitatorUrl is not a valid URL: ${facilitatorUrl}`, {
        cause,
      });
    }
    this.facilitatorUrl = facilitatorUrl.replace(/\/+$/, '');
    this.tokenContract = configString(options.tokenContract, 'tokenContract');
    this.splitContract = configString(options.splitContract, 'splitContract');
    this.network = options.network ?? DEFAULT_NETWORK;
    if (!this.network.startsWith('near:')) {
      throw new ClientConfigError('network must be a NEAR CAIP-2 id such as near:testnet');
    }
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  /**
   * Quote a service through the facilitator and return the 402 requirement.
   * Any non-402 answer is an error: a facilitator that cannot quote must not
   * cause the caller to pay an unvalidated amount.
   */
  public async quote(service: string, params?: Record<string, unknown>): Promise<PaymentRequired> {
    const name = optionString(service, 'service');
    if (params !== undefined && !isRecord(params)) {
      throw new QuoteRequestError('params must be a plain object');
    }
    const body = JSON.stringify(
      params === undefined ? { service: name } : { service: name, params }
    );
    const response = await this.request(
      'POST',
      `${this.facilitatorUrl}/quote`,
      {
        'Content-Type': 'application/json',
      },
      body
    );
    const { text, json } = await readResponseBody(response);
    if (response.status !== 402) {
      throw new QuoteRequestError(`facilitator quote failed with HTTP ${response.status}`, {
        status: response.status,
        body: text,
      });
    }
    const requirement = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: json,
    });
    if (requirement === null) {
      throw new QuoteRequestError('facilitator quote did not include PAYMENT-REQUIRED', {
        status: response.status,
        body: text,
      });
    }
    return requirement;
  }

  /** Read and validate the facilitator's advertised kinds and signers. */
  public async supported(): Promise<SupportedResponse> {
    const response = await this.request('GET', `${this.facilitatorUrl}/supported`, {});
    const { text, json } = await readResponseBody(response);
    if (!isSuccessStatus(response.status)) {
      throw new SupportedRequestError(
        `facilitator /supported failed with HTTP ${response.status}`,
        { status: response.status, body: text }
      );
    }
    if (json === undefined) {
      throw new SupportedRequestError('facilitator /supported returned a non-JSON body', {
        status: response.status,
        body: text,
      });
    }
    return parseSupportedResponse(json);
  }

  /**
   * Pay a resource with one delegated `ft_transfer_call`.
   *
   * The first request must answer 402 with a valid `PAYMENT-REQUIRED`; the
   * delegate spends exactly `accepts[0].amount`, the delegate TTL defaults to
   * `accepts[0].maxTimeoutSeconds`, and the paid retry must carry a successful
   * `PAYMENT-RESPONSE`.
   */
  public async pay(options: PayOptions): Promise<PaymentResult> {
    if (typeof options.account?.createSignedMetaTransaction !== 'function') {
      throw new PaymentOptionsError('account must provide createSignedMetaTransaction');
    }
    const resourceUrl = optionString(options.resourceUrl, 'resourceUrl');
    const tool = optionString(options.tool, 'tool');
    let expectedAmount: string;
    try {
      expectedAmount = normalizeAmount(options.amount);
    } catch (cause) {
      throw new PaymentOptionsError('amount must be a positive u128 integer of raw FT units', {
        cause,
      });
    }
    const method = options.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') {
      throw new PaymentOptionsError('method must be GET or POST');
    }
    const headers = withoutHeader({ ...(options.headers ?? {}) }, PAYMENT_SIGNATURE_HEADER);

    const initial = await this.request(method, resourceUrl, headers, options.body);
    if (initial.status !== 402) {
      throw new PaymentRequirementError(
        `expected HTTP 402 from ${resourceUrl}, received ${initial.status}`,
        initial.status
      );
    }
    const requirement = await this.readRequirement(initial);

    const accepted = selectAccept(requirement, {
      network: this.network,
      asset: this.tokenContract,
      payTo: this.splitContract,
      amount: expectedAmount,
    });

    let timeoutSeconds = accepted.maxTimeoutSeconds;
    if (options.maxTimeoutSeconds !== undefined) {
      if (!Number.isInteger(options.maxTimeoutSeconds) || options.maxTimeoutSeconds < 1) {
        throw new PaymentOptionsError('maxTimeoutSeconds must be a positive integer');
      }
      if (options.maxTimeoutSeconds > accepted.maxTimeoutSeconds) {
        throw new PaymentOptionsError(
          `maxTimeoutSeconds ${options.maxTimeoutSeconds} exceeds the quoted ` +
            `${accepted.maxTimeoutSeconds}`
        );
      }
      timeoutSeconds = options.maxTimeoutSeconds;
    }

    const { signedDelegate } = await createSplitDelegate({
      account: options.account,
      tokenContract: this.tokenContract,
      splitContract: this.splitContract,
      amount: accepted.amount,
      tool,
      action: options.action,
      maxTimeoutSeconds: timeoutSeconds,
    });

    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: requirement.resource,
      accepted,
      payload: { signedDelegateAction: encodeSignedDelegateBase64(signedDelegate) },
    };
    const retryHeaders = mergeHeaders(headers, buildPaymentSignature(payload));

    const paid = await this.request(method, resourceUrl, retryHeaders, options.body);
    return this.readSettlement(paid);
  }

  private async request(
    method: PayMethod,
    url: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<PaymentResponseLike> {
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (body !== undefined) {
      init.body = body;
    }
    try {
      return await this.fetchImpl(url, init);
    } catch (cause) {
      throw new PaymentRequestError(`${method} ${url} failed`, { cause });
    }
  }

  private async readRequirement(response: PaymentResponseLike): Promise<PaymentRequired> {
    const header = getHeader(response.headers, PAYMENT_REQUIRED_HEADER);
    if (header) {
      return parsePaymentRequired(decodeHeaderJson<unknown>(header, PAYMENT_REQUIRED_HEADER));
    }
    const { json } = await readResponseBody(response);
    const requirement = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: json,
    });
    if (requirement === null) {
      throw new PaymentRequirementError(
        '402 response did not include a PAYMENT-REQUIRED requirement',
        response.status
      );
    }
    return requirement;
  }

  private async readSettlement(response: PaymentResponseLike): Promise<PaymentResult> {
    const headerSettlement = readSettlementResponse({
      status: response.status,
      headers: response.headers,
    });
    if (headerSettlement !== null) {
      return this.assertSettled(response, headerSettlement, null);
    }

    const { text, json } = await readResponseBody(response);
    const settlement = readSettlementResponse({
      status: response.status,
      headers: response.headers,
      body: json,
    });
    if (settlement !== null) {
      return this.assertSettled(response, settlement, text);
    }
    if (!isSuccessStatus(response.status)) {
      throw new PaymentRejectedError(`paid request failed with HTTP ${response.status}`, {
        status: response.status,
        settlement: null,
        body: text,
      });
    }
    throw new PaymentSettlementMissingError(
      `HTTP ${response.status} response did not include PAYMENT-RESPONSE`,
      { status: response.status, body: text }
    );
  }

  private assertSettled(
    response: PaymentResponseLike,
    settlement: SettlementResponse,
    body: string | null
  ): PaymentResult {
    if (!isSuccessStatus(response.status)) {
      throw new PaymentRejectedError(`paid request failed with HTTP ${response.status}`, {
        status: response.status,
        settlement,
        body,
      });
    }
    if (!settlement.success) {
      throw new PaymentSettlementError(
        settlement.errorReason ?? 'payment settlement failed',
        settlement
      );
    }
    if (settlement.network !== this.network) {
      throw new PaymentSettlementError(
        `PAYMENT-RESPONSE network "${settlement.network}" does not match "${this.network}"`,
        settlement
      );
    }
    return { response, settlement };
  }
}
