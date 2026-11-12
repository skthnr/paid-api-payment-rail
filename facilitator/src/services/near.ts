/**
 * NEAR JSON-RPC access for the facilitator.
 *
 * Every read used by the delegate gate accepts an optional `blockId` (a block
 * hash returned by `blockHeight`) so one preflight observes a single final
 * block. Pinned reads use the raw `query` request with `block_id`; near-api-js
 * 7.5.3's convenience wrappers only accept finality for access keys.
 *
 * Relaying builds the outer signed transaction first: the transaction hash is
 * therefore known before broadcast, which is what lets `/settle` return a
 * non-terminal `settlement_pending` response after an RPC timeout instead of
 * double-submitting the delegate.
 */

import { createHash } from 'node:crypto';
import {
  Account,
  JsonRpcProvider,
  MultiKeySigner,
  actions,
  baseEncode,
  encodeTransaction,
  type FinalExecutionOutcome,
  type KeyPairString,
  type SignedDelegate,
  type SignedTransaction,
  type TxExecutionStatus,
} from 'near-api-js';
import type { FacilitatorConfig } from '../config.js';
import { isRecord } from '@portico/sdk';
import type { FtMetadataView, StorageBalanceView, ToolInfoView } from '../types.js';

export type TransactionResponse = FinalExecutionOutcome;

export interface BlockHeight {
  height: number;
  hash: string;
}

export interface AccountInfo {
  code_hash: string;
  storage_usage: number;
}

export interface ContractCodeInfo {
  code: Uint8Array;
  hash: string;
}

export interface AccessKeyQuery {
  nonce: bigint;
  permission: unknown;
  block_hash: string;
  block_height: number;
}

function finalityBlock(blockId?: string): { blockId: string } | { finality: 'final' } {
  return blockId === undefined ? { finality: 'final' } : { blockId };
}

interface RawCallResult {
  result: number[];
  logs?: string[];
}

function isRawCallResult(value: unknown): value is RawCallResult {
  return isRecord(value) && Array.isArray(value.result);
}

export interface RelayResult {
  txHash: string;
  response: TransactionResponse | null;
  error?: unknown;
}

/** Chain reads used by the gate. Tests provide an in-memory implementation. */
export interface NearReader {
  blockHeight(final: boolean): Promise<BlockHeight>;
  viewAccessKey(accountId: string, publicKey: string, blockId?: string): Promise<AccessKeyQuery>;
  viewAccount(accountId: string, blockId?: string): Promise<AccountInfo>;
  viewContractCode(accountId: string, blockId?: string): Promise<ContractCodeInfo>;
  callFunction<T>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    blockId?: string
  ): Promise<T | undefined>;
  ftBalanceOf(accountId: string, blockId?: string): Promise<bigint>;
  ftMetadata(blockId?: string): Promise<FtMetadataView>;
  storageBalanceOf(accountId: string, blockId?: string): Promise<StorageBalanceView | null>;
  viewToolInfo(tool: string, blockId?: string): Promise<ToolInfoView | null>;
}

export class NearClientError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'NearClientError';
    this.code = code;
  }
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function argsBase64(args: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
}

export class NearClient implements NearReader {
  public readonly provider: JsonRpcProvider;
  private readonly relayer: Account;

  public constructor(private readonly config: FacilitatorConfig) {
    this.provider = new JsonRpcProvider(
      { url: config.rpcUrl },
      { retries: config.rpcRetries, wait: config.rpcRetryWaitMs }
    );
    const signer = MultiKeySigner.fromSecretKeys(config.relayerSecretKeys as KeyPairString[]);
    this.relayer = new Account(config.relayerId, this.provider, signer);
  }

  public async blockHeight(final: boolean): Promise<BlockHeight> {
    const block = await this.provider.viewBlock({ finality: final ? 'final' : 'optimistic' });
    return { height: block.header.height, hash: block.header.hash };
  }

  public async viewAccessKey(
    accountId: string,
    publicKey: string,
    blockId?: string
  ): Promise<AccessKeyQuery> {
    if (blockId === undefined) {
      const result = await this.provider.viewAccessKey({
        accountId,
        publicKey,
        finalityQuery: { finality: 'final' },
      });
      return {
        nonce: result.nonce,
        permission: result.permission,
        block_hash: result.block_hash,
        block_height: result.block_height,
      };
    }
    const result = await this.provider.query({
      request_type: 'view_access_key',
      account_id: accountId,
      public_key: publicKey,
      block_id: blockId,
    });
    if (
      !isRecord(result) ||
      !('nonce' in result) ||
      !('permission' in result) ||
      !('block_hash' in result) ||
      !('block_height' in result)
    ) {
      throw new NearClientError('access_key_unavailable', 'view_access_key returned no key');
    }
    if (
      (typeof result.nonce !== 'string' && typeof result.nonce !== 'number') ||
      typeof result.block_hash !== 'string' ||
      typeof result.block_height !== 'number'
    ) {
      throw new NearClientError('access_key_unavailable', 'view_access_key returned a bad shape');
    }
    return {
      nonce: BigInt(result.nonce),
      permission: result.permission,
      block_hash: result.block_hash,
      block_height: result.block_height,
    };
  }

  public async viewAccount(accountId: string, blockId?: string): Promise<AccountInfo> {
    const account = await this.provider.viewAccount({
      accountId,
      blockQuery: finalityBlock(blockId),
    });
    return { code_hash: account.code_hash, storage_usage: account.storage_usage };
  }

  public async viewContractCode(accountId: string, blockId?: string): Promise<ContractCodeInfo> {
    const contract = await this.provider.viewContractCode({
      contractId: accountId,
      blockQuery: finalityBlock(blockId),
    });
    return { code: contract.code, hash: contract.hash };
  }

  public async callFunction<T = unknown>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    blockId?: string
  ): Promise<T | undefined> {
    if (blockId === undefined) {
      const result = await this.provider.callFunction({
        contractId,
        method,
        args,
        blockQuery: { finality: 'final' },
      });
      return result as T | undefined;
    }
    const response = await this.provider.query({
      request_type: 'call_function',
      account_id: contractId,
      method_name: method,
      args_base64: argsBase64(args),
      block_id: blockId,
    });
    if (!isRawCallResult(response)) {
      throw new NearClientError('call_function_unavailable', 'call_function returned a bad shape');
    }
    if (response.result.length === 0) {
      return undefined;
    }
    const text = Buffer.from(response.result).toString('utf8');
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  public async ftBalanceOf(accountId: string, blockId?: string): Promise<bigint> {
    const result = await this.callFunction<string>(
      this.config.tokenContract,
      'ft_balance_of',
      { account_id: accountId },
      blockId
    );
    if (result === undefined) {
      throw new NearClientError('ft_balance_unavailable', 'ft_balance_of returned no value');
    }
    return BigInt(result);
  }

  public async ftMetadata(blockId?: string): Promise<FtMetadataView> {
    const metadata = await this.callFunction<FtMetadataView>(
      this.config.tokenContract,
      'ft_metadata',
      {},
      blockId
    );
    if (metadata === undefined || typeof metadata.decimals !== 'number') {
      throw new NearClientError('ft_metadata_unavailable', 'ft_metadata returned no decimals');
    }
    return metadata;
  }

  /** Boot assertion: the configured FT must use the scheme's 18 decimals. */
  public async assertTokenDecimals(): Promise<FtMetadataView> {
    const metadata = await this.ftMetadata();
    if (
      !Number.isInteger(metadata.decimals) ||
      metadata.decimals !== this.config.expectedDecimals
    ) {
      throw new NearClientError(
        'token_decimals_mismatch',
        `ft_metadata().decimals is ${metadata.decimals}; expected ${this.config.expectedDecimals}`
      );
    }
    return metadata;
  }

  public async storageBalanceOf(
    accountId: string,
    blockId?: string
  ): Promise<StorageBalanceView | null> {
    const result = await this.callFunction<StorageBalanceView | null>(
      this.config.tokenContract,
      'storage_balance_of',
      { account_id: accountId },
      blockId
    );
    return result ?? null;
  }

  public async viewToolInfo(tool: string, blockId?: string): Promise<ToolInfoView | null> {
    const result = await this.callFunction<ToolInfoView | null>(
      this.config.splitContract,
      'get_tool_info',
      { name: tool },
      blockId
    );
    return result ?? null;
  }

  public async txStatus(
    txHash: string,
    sender: string,
    waitUntil: TxExecutionStatus = 'FINAL'
  ): Promise<TransactionResponse> {
    const result = await this.provider.viewTransactionStatus({
      txHash,
      accountId: sender,
      waitUntil,
    });
    return result as unknown as TransactionResponse;
  }

  /**
   * Sign the outer NEP-366 transaction, report its hash, then broadcast it and
   * wait for FINAL. `onSigned` runs after the hash is known and before
   * `send_tx`, so the settlement cache is armed before anything can land.
   */
  public async relay(
    signedDelegate: SignedDelegate,
    onSigned?: (txHash: string) => void
  ): Promise<RelayResult> {
    const signedTransaction: SignedTransaction = await this.relayer.createSignedTransaction({
      receiverId: signedDelegate.delegateAction.senderId,
      actions: [actions.signedDelegate(signedDelegate)],
    });
    const txHash = baseEncode(sha256(encodeTransaction(signedTransaction.transaction)));
    onSigned?.(txHash);
    try {
      const response = await this.provider.sendTransactionUntil(signedTransaction, 'FINAL');
      return { txHash, response: response as unknown as TransactionResponse };
    } catch (error) {
      return { txHash, response: null, error };
    }
  }
}

/** Stable, non-secret error text for classification and logging. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}

/** `DelegateActionInvalidNonce` / outer nonce failures. */
export function isNonceError(error: unknown): boolean {
  return /DelegateActionInvalidNonce|DelegateActionNonceTooLarge/i.test(describeError(error));
}

/** Transport or RPC wait timeout after (or around) broadcast. */
export function isTimeoutError(error: unknown): boolean {
  return /timeout|timed out|TimeoutError|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network error/i.test(
    describeError(error)
  );
}
