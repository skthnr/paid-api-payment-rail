/**
 * NEP-366 meta-transaction builders for x402 v2 NEAR payments.
 *
 * The split path signs exactly one `ft_transfer_call` against the payment FT
 * with the split contract as the on-chain receiver and the tool request in the
 * NEP-141 `msg`. The official single-transfer path signs one `ft_transfer`
 * paying the quoted `payTo` wallet. Both attach the NEP-141 1-yocto deposit
 * (prepaid by the relayer) and cap the delegate at the quoted
 * `maxTimeoutSeconds`; the scheme maps one block to one second.
 */

import {
  actions,
  decodeSignedDelegate,
  encodeSignedDelegate,
  teraToGas,
  type Action,
  type SignedDelegate,
} from 'near-api-js';
import { DELEGATED_GAS_TGAS, EXACT_TRANSFER_TGAS, ONE_YOCTO } from '../constants.js';
import { DelegateEncodingError, DelegateOptionsError } from '../errors.js';

const U128_MAX = (1n << 128n) - 1n;

/** Result of signing a delegate action; shaped like near-api-js' return value. */
export interface SignedDelegateResult {
  delegateHash: Uint8Array;
  signedDelegate: SignedDelegate;
}

/**
 * The subset of `near-api-js` `Account` the builders need. Keeping the
 * interface structural lets callers inject a signer-backed account and lets
 * unit tests supply a deterministic fake without a network.
 */
export interface MetaTransactionAccount {
  readonly accountId?: string;
  createSignedMetaTransaction(args: {
    receiverId: string;
    actions: Action[];
    blockHeightTtl?: number;
    signer?: unknown;
  }): Promise<SignedDelegateResult>;
}

export interface SplitDelegateParams {
  account: MetaTransactionAccount;
  /** NEP-141 contract that executes the delegated transfer. */
  tokenContract: string;
  /** Split contract that receives the FT transfer and dispatches `msg`. */
  splitContract: string;
  /** Positive integer of raw FT units. */
  amount: string | bigint;
  /** Tool name resolved by the split contract's `msg` dispatcher. */
  tool?: string;
  /** Split action; defaults to `pay_tool`. */
  action?: string;
  /** Delegate lifetime in seconds; near-api-js maps it to `blockHeightTtl`. */
  maxTimeoutSeconds: number;
}

export interface ExactDelegateParams {
  account: MetaTransactionAccount;
  /** NEP-141 contract that executes the delegated transfer. */
  tokenContract: string;
  /** FT payee for the official single-transfer path. */
  payTo: string;
  /** Positive integer of raw FT units. */
  amount: string | bigint;
  /** Delegate lifetime in seconds; near-api-js maps it to `blockHeightTtl`. */
  maxTimeoutSeconds: number;
}

function requireContract(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 64) {
    throw new DelegateOptionsError(`${field} must be a non-empty NEAR account id`);
  }
  return value;
}

function requireTimeout(maxTimeoutSeconds: number): number {
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 1) {
    throw new DelegateOptionsError('maxTimeoutSeconds must be a positive integer');
  }
  return maxTimeoutSeconds;
}

/**
 * Normalize a raw NEP-141 amount to its canonical decimal string. Amounts are
 * never scaled: the payment FT uses 18 decimals and every API surface here
 * speaks raw units.
 */
export function normalizeAmount(amount: string | bigint): string {
  const value = typeof amount === 'bigint' ? amount.toString() : amount.trim();
  if (!/^\d+$/.test(value)) {
    throw new DelegateOptionsError('amount must be a positive u128 integer of raw FT units');
  }
  const raw = BigInt(value);
  if (raw <= 0n || raw > U128_MAX) {
    throw new DelegateOptionsError('amount must be a positive u128 integer of raw FT units');
  }
  return raw.toString();
}

/**
 * Sign the split payment: one `ft_transfer_call` to the FT contract with the
 * split contract as `receiver_id`, 100 Tgas (the delegated cap) and a
 * 1-yocto deposit.
 */
export async function createSplitDelegate(
  params: SplitDelegateParams
): Promise<SignedDelegateResult> {
  const tokenContract = requireContract(params.tokenContract, 'tokenContract');
  const splitContract = requireContract(params.splitContract, 'splitContract');
  const amount = normalizeAmount(params.amount);
  const maxTimeoutSeconds = requireTimeout(params.maxTimeoutSeconds);
  const action = params.action ?? 'pay_tool';
  if (action.trim().length === 0) {
    throw new DelegateOptionsError('action must be a non-empty split action name');
  }

  const delegateAction = actions.functionCall(
    'ft_transfer_call',
    {
      receiver_id: splitContract,
      amount,
      msg: JSON.stringify({ action, tool: params.tool }),
    },
    teraToGas(DELEGATED_GAS_TGAS),
    ONE_YOCTO
  );

  return params.account.createSignedMetaTransaction({
    receiverId: tokenContract,
    actions: [delegateAction],
    blockHeightTtl: maxTimeoutSeconds,
  });
}

/**
 * Sign the official x402 v2 NEAR exact payment: one `ft_transfer` of
 * `amount` to `payTo` with 30 Tgas and a 1-yocto deposit.
 */
export async function createExactDelegate(
  params: ExactDelegateParams
): Promise<SignedDelegateResult> {
  const tokenContract = requireContract(params.tokenContract, 'tokenContract');
  const payTo = requireContract(params.payTo, 'payTo');
  const amount = normalizeAmount(params.amount);
  const maxTimeoutSeconds = requireTimeout(params.maxTimeoutSeconds);

  const delegateAction = actions.functionCall(
    'ft_transfer',
    {
      receiver_id: payTo,
      amount,
    },
    teraToGas(EXACT_TRANSFER_TGAS),
    ONE_YOCTO
  );

  return params.account.createSignedMetaTransaction({
    receiverId: tokenContract,
    actions: [delegateAction],
    blockHeightTtl: maxTimeoutSeconds,
  });
}

/**
 * Base64 borsh bytes of a `SignedDelegate` for the `PAYMENT-SIGNATURE`
 * payload. Borsh encoding uses `encodeSignedDelegate`; a `SignedDelegate`
 * instance's own `encode()` covers structurally-typed delegates.
 */
export function encodeSignedDelegateBase64(signedDelegate: SignedDelegate): string {
  const bytes = encodeDelegateBytes(signedDelegate);
  return Buffer.from(bytes).toString('base64');
}

function encodeDelegateBytes(signedDelegate: SignedDelegate): Uint8Array {
  try {
    return encodeSignedDelegate(signedDelegate);
  } catch {
    try {
      return signedDelegate.encode();
    } catch (cause) {
      throw new DelegateEncodingError('failed to encode the signed delegate', { cause });
    }
  }
}

/**
 * Decode `payload.signedDelegateAction` back to a `SignedDelegate`.
 *
 * This is a parser only: it rejects non-canonical base64 and non-canonical
 * borsh, but it does not verify the signature, key permissions, nonce or
 * chain validity. Those gates belong to the facilitator relayer.
 */
export function decodeSignedDelegateBase64(signedDelegateAction: string): SignedDelegate {
  const trimmed = signedDelegateAction.trim();
  if (trimmed.length === 0) {
    throw new DelegateEncodingError('signedDelegateAction is empty');
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== trimmed) {
    throw new DelegateEncodingError('signedDelegateAction is not canonical base64');
  }
  try {
    return decodeSignedDelegate(bytes);
  } catch (cause) {
    throw new DelegateEncodingError(
      'signedDelegateAction is not a canonical NEP-366 SignedDelegate',
      { cause }
    );
  }
}
