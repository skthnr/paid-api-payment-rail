/**
 * MCP tool surface for x402 v2 payments on NEAR.
 *
 * Five tools are exposed to agents: quote a service, pay a resource through
 * the NEP-366 delegate flow, read a wallet balance, verify a settled
 * transaction, and estimate the developer/platform split of a quote. Every
 * handler reuses `@portico/sdk`; the facilitator HTTP surface is the only
 * settlement path, so a tool never reports success the chain did not produce.
 *
 * Tool arguments cross a JSON-RPC boundary, so each handler validates its own
 * shape and rejects malformed input with a typed error before any network
 * call. The stdio server turns those errors into MCP `isError` content and
 * keeps the transport alive.
 */

import {
  PorticoClient,
  RevenueSplitClient,
  normalizeAmount,
  type AcceptsEntry,
  type FetchLike,
  type PaymentRequired,
} from '@portico/sdk';
import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { isRecord, messageOf } from './guards.js';

/** Environment-backed configuration for the tool host. */
export interface PorticoToolsConfig {
  /** Facilitator base URL, e.g. `http://localhost:3002`. */
  facilitatorUrl: string;
  /** NEAR JSON-RPC endpoint used for views and balances. */
  rpcUrl: string;
  /** CAIP-2 network id, e.g. `near:testnet`. */
  network: string;
  /** NEP-141 payment contract. */
  tokenContract: string;
  /** Revenue-split contract used as `payTo`. */
  splitContract: string;
  /** Buyer account that signs delegates; required by `x402_pay`. */
  buyerAccount?: string;
  /** Full-access secret key of the buyer account. */
  buyerSecretKey?: string;
  /** Injectable fetch used by tests and embedding hosts. */
  fetch?: FetchLike;
}

/** One MCP tool definition. `inputSchema` is JSON Schema. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

/** Handler contract consumed by the stdio server. */
export interface ToolHost {
  readonly definitions: readonly ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** A tool argument was malformed. */
export class ToolInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** The tool host is missing configuration it needs for the call. */
export class ToolConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ToolConfigError';
  }
}

/** A network read or facilitator call failed. */
export class ToolExecutionError extends Error {
  public constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolExecutionError';
  }
}

const ACCOUNT_ID_PATTERN =
  /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;
const SECRET_KEY_PATTERN = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/;
const TX_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const U128_PATTERN = /^\d+$/;

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new ToolConfigError(`${name} is required`);
  }
  return value;
}

function requireString(
  args: Record<string, unknown>,
  field: string,
  maxLength: number
): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ToolInputError(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function optionalString(
  args: Record<string, unknown>,
  field: string,
  maxLength: number
): string | undefined {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`${field} must be a non-empty string when provided`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ToolInputError(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function optionalPositiveInteger(
  args: Record<string, unknown>,
  field: string,
  max: number
): number | undefined {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ToolInputError(`${field} must be an integer in [1, ${max}]`);
  }
  return value;
}

function requireAmount(value: unknown, field: string): string {
  if (typeof value !== 'string' && typeof value !== 'bigint') {
    throw new ToolInputError(`${field} must be a decimal string of raw FT units`);
  }
  try {
    return normalizeAmount(value);
  } catch {
    throw new ToolInputError(`${field} must be a positive u128 integer of raw FT units`);
  }
}

function requireHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`${field} must be an absolute http(s) URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ToolInputError(`${field} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolInputError(`${field} must use http or https`);
  }
  return parsed.toString();
}

function assertAccountId(value: string, field: string): string {
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    throw new ToolInputError(`${field} is not a valid NEAR account id`);
  }
  return value;
}

function optionalParams(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.params;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ToolInputError('params must be a JSON object');
  }
  return value;
}

function readU128Value(value: unknown, label: string): string {
  if (typeof value === 'string' && U128_PATTERN.test(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (isRecord(value)) {
    const first = value['0'];
    if (typeof first === 'string' && U128_PATTERN.test(first)) {
      return first;
    }
  }
  throw new ToolExecutionError(`${label} returned an unexpected u128 payload`);
}

function firstAccept(requirement: PaymentRequired): AcceptsEntry {
  const accepted = requirement.accepts[0];
  if (accepted === undefined) {
    throw new ToolExecutionError('quote did not include accepts[0]');
  }
  return accepted;
}

/** Tool definitions advertised by `tools/list`. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'x402_quote',
    description:
      'Fetch the x402 v2 PAYMENT-REQUIRED requirement for a priced service from the portico facilitator.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service or tool name, e.g. "web-search"',
        },
        params: {
          type: 'object',
          description: 'Optional quote modifiers such as maxTokens, size or quantity',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'x402_pay',
    description:
      'Pay a resource through the SDK: request the 402 requirement, sign one NEP-366 delegate and retry with PAYMENT-SIGNATURE. Returns the settled PAYMENT-RESPONSE.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceUrl: {
          type: 'string',
          description: 'Absolute URL of the paid resource',
        },
        tool: {
          type: 'string',
          description: 'Registered tool name dispatched by the split contract',
        },
        amount: {
          type: 'string',
          description: 'Expected price in raw FT units (decimal string or bigint)',
        },
        method: {
          type: 'string',
          description: 'HTTP method used for both attempts; GET or POST',
        },
        body: {
          type: 'string',
          description: 'Optional request body sent on both attempts',
        },
        maxTimeoutSeconds: {
          type: 'number',
          description: 'Optional delegate lifetime, capped by the quoted requirement',
        },
      },
      required: ['resourceUrl', 'tool', 'amount'],
    },
  },
  {
    name: 'x402_balance',
    description:
      'Read the liquid NEAR balance and the raw payment-token balance of an account at finality final.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'NEAR account id; defaults to the configured buyer account',
        },
      },
    },
  },
  {
    name: 'x402_verify_payment',
    description:
      'Look up a settled transaction through the facilitator and report whether the inner FT transfer succeeded.',
    inputSchema: {
      type: 'object',
      properties: {
        transactionHash: {
          type: 'string',
          description: 'Base58 transaction hash returned by x402_pay',
        },
      },
      required: ['transactionHash'],
    },
  },
  {
    name: 'x402_estimate_cost',
    description:
      'Quote a service and read the contract split view to estimate the developer and platform legs of the payment.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service or tool name, e.g. "web-search"',
        },
        params: {
          type: 'object',
          description: 'Optional quote modifiers such as maxTokens, size or quantity',
        },
      },
      required: ['service'],
    },
  },
];

/**
 * Tool host backed by the portico SDK and the facilitator HTTP API.
 *
 * Construction validates the static configuration; buyer key material is only
 * required by the paths that sign a delegate, so read-only tools work without
 * it.
 */
export class PorticoTools implements ToolHost {
  public readonly definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS;
  private readonly config: PorticoToolsConfig;
  private readonly client: PorticoClient;
  private readonly revenueSplit: RevenueSplitClient;
  private readonly fetchImpl: FetchLike;
  private provider: JsonRpcProvider | null = null;
  private account: Account | null = null;

  public constructor(config: PorticoToolsConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.client = new PorticoClient({
      facilitatorUrl: config.facilitatorUrl,
      tokenContract: config.tokenContract,
      splitContract: config.splitContract,
      network: config.network,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
    this.revenueSplit = new RevenueSplitClient({
      contractId: config.splitContract,
      rpcUrl: config.rpcUrl,
    });
    if (config.buyerAccount !== undefined) {
      assertAccountId(config.buyerAccount, 'buyerAccount');
    }
    if (config.buyerSecretKey !== undefined && !SECRET_KEY_PATTERN.test(config.buyerSecretKey)) {
      throw new ToolConfigError('buyerSecretKey must be an ed25519 or secp256k1 secret key');
    }
  }

  /** Dispatch one tool call; unknown names are rejected before any I/O. */
  public async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'x402_quote':
        return this.quoteTool(args);
      case 'x402_pay':
        return this.payTool(args);
      case 'x402_balance':
        return this.balanceTool(args);
      case 'x402_verify_payment':
        return this.verifyPaymentTool(args);
      case 'x402_estimate_cost':
        return this.estimateCostTool(args);
      default:
        throw new ToolInputError(`Unknown tool: ${name}`);
    }
  }

  private async quoteTool(args: Record<string, unknown>): Promise<PaymentRequired> {
    const service = requireString(args, 'service', 64);
    return this.client.quote(service, optionalParams(args));
  }

  private async payTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resourceUrl = requireHttpUrl(args.resourceUrl, 'resourceUrl');
    const tool = requireString(args, 'tool', 64);
    const amount = requireAmount(args.amount, 'amount');
    const method = optionalString(args, 'method', 4);
    if (method !== undefined && method !== 'GET' && method !== 'POST') {
      throw new ToolInputError('method must be GET or POST');
    }
    const body = optionalString(args, 'body', 65_536);
    const maxTimeoutSeconds = optionalPositiveInteger(args, 'maxTimeoutSeconds', 3_600);

    const result = await this.client.pay({
      account: this.buyerAccountOrThrow(),
      resourceUrl,
      tool,
      amount,
      ...(method === undefined ? {} : { method }),
      ...(body === undefined ? {} : { body }),
      ...(maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds }),
    });

    return {
      status: result.response.status,
      resourceUrl,
      tool,
      amount,
      settlement: result.settlement,
    };
  }

  private async balanceTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = optionalString(args, 'account', 64);
    const accountId = requested ?? this.config.buyerAccount;
    if (accountId === undefined) {
      throw new ToolInputError(
        'account is required when PORTICO_BUYER_ACCOUNT is not configured'
      );
    }
    assertAccountId(accountId, 'account');
    const provider = this.getProvider();
    const view = await provider.viewAccount({
      accountId,
      blockQuery: { finality: 'final' },
    });
    return {
      account: accountId,
      near: {
        liquid: view.amount.toString(),
        staked: view.locked.toString(),
        blockHeight: view.block_height,
      },
      token: {
        contract: this.config.tokenContract,
        raw: (await this.tokenBalance(accountId)).toString(),
      },
    };
  }

  private async verifyPaymentTool(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const transactionHash = requireString(args, 'transactionHash', 128);
    if (!TX_HASH_PATTERN.test(transactionHash)) {
      throw new ToolInputError('transactionHash must be a base58 NEAR transaction hash');
    }
    const url = `${this.client.facilitatorUrl}/payments/${encodeURIComponent(transactionHash)}`;
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    if (response.status === 404) {
      throw new ToolExecutionError(`payment ${transactionHash} was not found`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ToolExecutionError(`facilitator /payments returned HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ToolExecutionError('facilitator /payments returned a non-JSON body');
    }
    if (!isRecord(parsed)) {
      throw new ToolExecutionError('facilitator /payments returned a non-object body');
    }
    return { verified: parsed.success === true, payment: parsed };
  }

  private async estimateCostTool(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const service = requireString(args, 'service', 64);
    const requirement = await this.client.quote(service, optionalParams(args));
    const accepted = firstAccept(requirement);
    const split = await this.revenueSplit.calculate_split(accepted.amount);
    const tool = await this.revenueSplit.get_tool_info(service);
    return {
      service,
      network: accepted.network,
      amount: accepted.amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      split,
      tool,
    };
  }

  private getProvider(): JsonRpcProvider {
    if (this.provider === null) {
      this.provider = new JsonRpcProvider({ url: this.config.rpcUrl });
    }
    return this.provider;
  }

  private buyerAccountOrThrow(): Account {
    if (this.account !== null) {
      return this.account;
    }
    const accountId = this.config.buyerAccount;
    const secretKey = this.config.buyerSecretKey;
    if (accountId === undefined || secretKey === undefined) {
      throw new ToolConfigError(
        'x402_pay requires PORTICO_BUYER_ACCOUNT and PORTICO_BUYER_SECRET_KEY'
      );
    }
    this.account = new Account(accountId, this.getProvider(), secretKey as KeyPairString);
    return this.account;
  }

  private async tokenBalance(accountId: string): Promise<bigint> {
    let result: string | undefined;
    try {
      result = await this.getProvider().callFunction<string>({
        contractId: this.config.tokenContract,
        method: 'ft_balance_of',
        args: { account_id: accountId },
        blockQuery: { finality: 'final' },
      });
    } catch (cause) {
      throw new ToolExecutionError(`ft_balance_of(${accountId}) failed`, { cause });
    }
    if (result === undefined) {
      throw new ToolExecutionError(`ft_balance_of(${accountId}) returned no value`);
    }
    return BigInt(readU128Value(result, 'ft_balance_of'));
  }
}

/** Build the tool host from the process environment used by every binary. */
export function createToolsFromEnv(env: NodeJS.ProcessEnv = process.env): PorticoTools {
  const buyerAccount = env.PORTICO_BUYER_ACCOUNT?.trim();
  const buyerSecretKey = env.PORTICO_BUYER_SECRET_KEY?.trim();
  return new PorticoTools({
    facilitatorUrl: env.FACILITATOR_URL?.trim() || 'http://localhost:3002',
    rpcUrl: env.PORTICO_RPC_URL?.trim() || 'https://test.rpc.fastnear.com',
    network: env.PORTICO_NETWORK?.trim() || 'near:testnet',
    tokenContract: requiredEnv(env, 'PORTICO_TOKEN_CONTRACT'),
    splitContract: requiredEnv(env, 'PORTICO_SPLIT_CONTRACT'),
    ...(buyerAccount === undefined || buyerAccount.length === 0 ? {} : { buyerAccount }),
    ...(buyerSecretKey === undefined || buyerSecretKey.length === 0
      ? {}
      : { buyerSecretKey }),
  });
}
