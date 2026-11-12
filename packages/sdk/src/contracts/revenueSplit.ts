/**
 * Read-only client for the portico revenue-split contract.
 * Views are executed through `JsonRpcProvider.callFunction` pinned to
 * `finality:"final"`, so a view never reports state from a fork or an
 * unexecuted optimistic block. The provider JSON-encodes the arguments and
 * decodes the returned JSON payload.
 */

import { JsonRpcProvider, type SerializedReturnValue } from 'near-api-js';
import { LEDGER_LIMIT_MAX } from '../constants.js';
import { ClientConfigError, ContractViewError } from '../errors.js';
import type { LedgerEntry, SplitView, StreamView, ToolInfo, TotalsView } from '../types.js';

export const DEFAULT_NEAR_RPC_URL = 'https://rpc.testnet.near.org';

export interface RevenueSplitClientOptions {
  /** Deployed split contract account id. */
  contractId: string;
  /** RPC endpoint used when no provider is injected. */
  rpcUrl?: string;
  /** Pre-built provider; wins over `rpcUrl`. */
  provider?: JsonRpcProvider;
}

function requireU64(value: number, field: string, method: string): number {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new ContractViewError(method, `${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireU128(amount: string | bigint, field: string, method: string): string {
  const value = typeof amount === 'bigint' ? amount.toString() : amount.trim();
  if (!/^\d+$/.test(value) || BigInt(value) > (1n << 128n) - 1n) {
    throw new ContractViewError(method, `${field} must be a u128 integer`);
  }
  return value;
}

function requireLedgerLimit(limit: number, method: string): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_LIMIT_MAX) {
    throw new ContractViewError(method, `limit must be an integer in 1..=${LEDGER_LIMIT_MAX}`);
  }
  return limit;
}

export class RevenueSplitClient {
  public readonly contractId: string;
  private readonly provider: JsonRpcProvider;

  public constructor(options: RevenueSplitClientOptions) {
    if (
      typeof options.contractId !== 'string' ||
      options.contractId.trim().length === 0 ||
      options.contractId.length > 64
    ) {
      throw new ClientConfigError('contractId must be a non-empty NEAR account id');
    }
    this.contractId = options.contractId.trim();
    if (options.provider !== undefined) {
      this.provider = options.provider;
      return;
    }
    const rpcUrl = options.rpcUrl ?? DEFAULT_NEAR_RPC_URL;
    try {
      new URL(rpcUrl);
    } catch (cause) {
      throw new ClientConfigError(`rpcUrl is not a valid URL: ${rpcUrl}`, { cause });
    }
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  /** Call a view method through the provider at finality final. */
  public async callView<T extends SerializedReturnValue | null>(
    method: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    if (typeof method !== 'string' || method.trim().length === 0) {
      throw new ContractViewError(method, 'method must be a non-empty view name');
    }
    let result: T | undefined;
    try {
      result = (await this.provider.callFunction<SerializedReturnValue>({
        contractId: this.contractId,
        method,
        args,
        blockQuery: { finality: 'final' },
      })) as T | undefined;
    } catch (cause) {
      throw new ContractViewError(method, `view ${method} failed`, { cause });
    }
    if (result === undefined) {
      throw new ContractViewError(method, `view ${method} returned an empty result`);
    }
    return result;
  }

  /** `calculate_split(amount: U128)` — developer/platform legs at the current fee. */
  public async calculate_split(amount: string | bigint): Promise<SplitView> {
    const method = 'calculate_split';
    return this.callView<SplitView>(method, {
      amount: requireU128(amount, 'amount', method),
    });
  }

  /** `get_tool_info(name)` — `null` when the tool is not registered. */
  public async get_tool_info(name: string): Promise<ToolInfo | null> {
    return this.callView<ToolInfo | null>('get_tool_info', { name });
  }

  /** `get_ledger(after_id, limit)` — newest page of public ledger entries. */
  public async get_ledger(
    afterId: number | null = null,
    limit: number = LEDGER_LIMIT_MAX
  ): Promise<LedgerEntry[]> {
    const method = 'get_ledger';
    const after = afterId === null ? null : requireU64(afterId, 'afterId', method);
    return this.callView<LedgerEntry[]>(method, {
      after_id: after,
      limit: requireLedgerLimit(limit, method),
    });
  }

  /** `get_totals()` — registry, stream and volume counters. */
  public async get_totals(): Promise<TotalsView> {
    return this.callView<TotalsView>('get_totals', {});
  }

  /** `get_stream_view(stream_id)` — accrual state of one stream. */
  public async get_stream_view(streamId: number): Promise<StreamView> {
    const method = 'get_stream_view';
    return this.callView<StreamView>(method, {
      stream_id: requireU64(streamId, 'streamId', method),
    });
  }
}
