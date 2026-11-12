/**
 * x402 v2 NEAR exact delegate gate.
 *
 * `decodeSignedDelegate` is a parser, not a verifier: every rule below is
 * re-checked here, and every read is pinned to one final block so the preflight
 * cannot mix heights. The split path deliberately relaxes scheme §6 from
 * `ft_transfer` to `ft_transfer_call` (documented extension): `accepted.payTo`
 * remains the split contract and `args.receiver_id == accepted.payTo` still
 * holds, while the action receiver stays the NEP-141 token.
 */

import { createHash } from 'node:crypto';
import {
  KeyType,
  decodeSignedDelegate,
  encodeDelegateAction,
  type SignedDelegate,
} from 'near-api-js';
import {
  FINALITY_LAG_BLOCKS,
  FT_TRANSFER_CALL_GAS,
  FT_TRANSFER_GAS,
  MICRO_BLOCKS_PER_BLOCK,
  ONE_YOCTO,
  U128_MAX,
} from '../constants.js';
import { isRecord } from '../guards.js';
import { isAccountId, type FacilitatorConfig } from '../config.js';
import type {
  GateErrorReason,
  GateFailure,
  GateSuccess,
  PaymentPayload,
  StorageBalanceView,
} from '../types.js';
import { SettlementCache } from './cache.js';
import { decodeCanonicalBase64, PaymentHeaderError } from './headers.js';
import { describeError, type AccessKeyQuery, type BlockHeight, type NearReader } from './near.js';

const KNOWN_MSG_ACTIONS: Record<string, true> = {
  pay_developers: true,
  pay_developers_batch: true,
  credit_developer: true,
  pay_tool: true,
  pay_tools: true,
  open_stream: true,
  fund_stream: true,
};

function extractSignatureBytes(signature: unknown): Uint8Array | null {
  if (signature === null || typeof signature !== 'object') {
    return null;
  }
  if ('data' in signature && signature.data instanceof Uint8Array) {
    return signature.data;
  }
  if ('signature' in signature) {
    const inner = signature.signature;
    if (inner instanceof Uint8Array) {
      return inner;
    }
    if (inner !== null && typeof inner === 'object' && 'data' in inner) {
      return inner.data instanceof Uint8Array ? inner.data : null;
    }
  }
  return null;
}

function extractSignatureCurve(signature: unknown): number | null {
  if (signature === null || typeof signature !== 'object') {
    return null;
  }
  if ('keyType' in signature && typeof signature.keyType === 'number') {
    return signature.keyType;
  }
  if ('signatureType' in signature && typeof signature.signatureType === 'number') {
    return signature.signatureType;
  }
  if ('publicKey' in signature) {
    const key = signature.publicKey;
    if (
      key !== null &&
      typeof key === 'object' &&
      'keyType' in key &&
      typeof key.keyType === 'number'
    ) {
      return key.keyType;
    }
  }
  if ('signature' in signature) {
    const inner = signature.signature;
    if (
      inner !== null &&
      typeof inner === 'object' &&
      'keyType' in inner &&
      typeof inner.keyType === 'number'
    ) {
      return inner.keyType;
    }
  }
  return null;
}

export interface VerifiedPayment extends GateSuccess {
  signedDelegate: SignedDelegate;
}

export type GateResult =
  | { ok: true; payment: VerifiedPayment }
  | { ok: false; failure: GateFailure };

class GateReject extends Error {
  public constructor(
    public readonly reason: GateErrorReason,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
    this.name = 'GateReject';
  }
}


function canonicalU128(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const amount = BigInt(value);
  return amount <= U128_MAX ? amount : null;
}

function argumentAmount(value: unknown): bigint | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return BigInt(value);
  }
  return canonicalU128(value);
}

function isFullAccessPermission(permission: unknown): boolean {
  if (permission === 'FullAccess') {
    return true;
  }
  return isRecord(permission) && ('FullAccess' in permission || 'fullAccess' in permission);
}

function isMissingAccountError(error: unknown): boolean {
  return /does not exist|AccountDoesNotExist|UNKNOWN_ACCOUNT|not registered/i.test(
    describeError(error)
  );
}

function parsePaymentPayload(payload: unknown): PaymentPayload {
  if (!isRecord(payload)) {
    throw new GateReject('invalid_payload', 'payment payload must be a JSON object');
  }
  if (payload.x402Version !== 2) {
    throw new GateReject('unsupported_x402_version', 'x402Version must be 2');
  }
  if (!isRecord(payload.accepted)) {
    throw new GateReject('invalid_payload', 'accepted must be an object');
  }
  const accepted = payload.accepted;
  if (accepted.scheme !== 'exact') {
    throw new GateReject('unsupported_scheme', 'accepted.scheme must be "exact"');
  }
  if (typeof accepted.network !== 'string') {
    throw new GateReject('invalid_payload', 'accepted.network must be a string');
  }
  if (typeof accepted.asset !== 'string') {
    throw new GateReject('invalid_payload', 'accepted.asset must be a string');
  }
  if (typeof accepted.payTo !== 'string' || !isAccountId(accepted.payTo)) {
    throw new GateReject('invalid_payload', 'accepted.payTo must be a valid account id');
  }
  const amount = accepted.amount;
  if (typeof amount !== 'string' || canonicalU128(amount) === null) {
    throw new GateReject('invalid_amount', 'accepted.amount must be a canonical u128 string');
  }
  const maxTimeoutSeconds = accepted.maxTimeoutSeconds;
  if (
    typeof maxTimeoutSeconds !== 'number' ||
    !Number.isInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds <= 0
  ) {
    throw new GateReject('invalid_timeout', 'accepted.maxTimeoutSeconds must be a positive integer');
  }
  const extra = accepted.extra;
  if (extra !== undefined && !isRecord(extra)) {
    throw new GateReject('invalid_payload', 'accepted.extra must be an object');
  }
  if (!isRecord(payload.payload)) {
    throw new GateReject('invalid_payload', 'payload must be an object');
  }
  if (typeof payload.payload.signedDelegateAction !== 'string') {
    throw new GateReject('missing_payment_signature', 'payload.signedDelegateAction is required');
  }
  return {
    x402Version: 2,
    resource: isRecord(payload.resource)
      ? {
          url: typeof payload.resource.url === 'string' ? payload.resource.url : '',
          description:
            typeof payload.resource.description === 'string'
              ? payload.resource.description
              : undefined,
          mimeType:
            typeof payload.resource.mimeType === 'string' ? payload.resource.mimeType : undefined,
        }
      : undefined,
    accepted: {
      scheme: 'exact',
      network: accepted.network,
      amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
      maxTimeoutSeconds,
      extra: isRecord(extra) ? extra : undefined,
    },
    payload: { signedDelegateAction: payload.payload.signedDelegateAction },
  };
}

export class DelegateGate {
  public constructor(
    private readonly near: NearReader,
    private readonly config: FacilitatorConfig
  ) {}

  public async verify(payload: unknown): Promise<GateResult> {
    try {
      return { ok: true, payment: await this.verifyOrThrow(payload) };
    } catch (error) {
      if (error instanceof PaymentHeaderError) {
        return {
          ok: false,
          failure: {
            success: false,
            errorReason: 'invalid_signature_encoding',
            message: error.message,
            httpStatus: 400,
          },
        };
      }
      if (error instanceof GateReject) {
        return {
          ok: false,
          failure: {
            success: false,
            errorReason: error.reason,
            message: error.message,
            httpStatus: error.httpStatus,
          },
        };
      }
      return {
        ok: false,
        failure: {
          success: false,
          errorReason: 'chain_unavailable',
          message: 'NEAR RPC preflight failed',
          httpStatus: 503,
        },
      };
    }
  }

  private async verifyOrThrow(payload: unknown): Promise<VerifiedPayment> {
    const parsed = parsePaymentPayload(payload);
    const accepted = parsed.accepted;
    const acceptedAmount = canonicalU128(accepted.amount);
    if (acceptedAmount === null || acceptedAmount === 0n) {
      throw new GateReject('invalid_amount', 'accepted.amount must be a positive u128');
    }
    if (accepted.network !== this.config.network) {
      throw new GateReject(
        'network_mismatch',
        `accepted.network must be ${this.config.network}`
      );
    }
    if (accepted.asset !== this.config.tokenContract) {
      throw new GateReject('asset_mismatch', 'accepted.asset must be the configured FT');
    }
    if (accepted.maxTimeoutSeconds > this.config.maxTimeoutSeconds) {
      throw new GateReject(
        'invalid_timeout',
        `accepted.maxTimeoutSeconds exceeds ${this.config.maxTimeoutSeconds}`
      );
    }
    const timeoutBlocks = Math.max(1, Math.ceil(accepted.maxTimeoutSeconds / 1));

    const delegateBytes = decodeCanonicalBase64(
      parsed.payload.signedDelegateAction,
      'payload.signedDelegateAction'
    );
    let signedDelegate: SignedDelegate;
    try {
      signedDelegate = decodeSignedDelegate(delegateBytes);
    } catch {
      throw new GateReject('invalid_signed_delegate', 'signedDelegateAction is not a valid NEP-366 delegate');
    }
    const { delegateAction, signature } = signedDelegate;

    const senderId = delegateAction.senderId;
    if (!isAccountId(senderId)) {
      throw new GateReject('invalid_signed_delegate', 'delegate senderId is not a valid account id');
    }
    if (delegateAction.receiverId !== accepted.asset) {
      throw new GateReject('receiver_mismatch', 'delegate receiverId must equal accepted.asset');
    }
    if (delegateAction.actions.length !== 1) {
      throw new GateReject('invalid_action_count', 'delegate must contain exactly one action');
    }
    const action = delegateAction.actions[0];
    if (action === undefined || action.enum !== 'functionCall' || action.functionCall === undefined) {
      throw new GateReject('unsupported_action', 'delegate action must be a FunctionCall');
    }
    const functionCall = action.functionCall;
    const methodName = functionCall.methodName;
    if (methodName !== 'ft_transfer' && methodName !== 'ft_transfer_call') {
      throw new GateReject(
        'unsupported_method',
        'methodName must be ft_transfer or ft_transfer_call'
      );
    }
    const requiredGas = methodName === 'ft_transfer' ? FT_TRANSFER_GAS : FT_TRANSFER_CALL_GAS;
    if (functionCall.gas !== requiredGas) {
      throw new GateReject(
        'invalid_gas',
        methodName === 'ft_transfer'
          ? 'ft_transfer must attach exactly 30 Tgas'
          : 'ft_transfer_call must attach exactly 100 Tgas'
      );
    }
    if (functionCall.deposit !== ONE_YOCTO) {
      throw new GateReject('invalid_deposit', 'delegate deposit must be exactly 1 yoctoNEAR');
    }

    let args: Record<string, unknown>;
    try {
      const decoded = JSON.parse(Buffer.from(functionCall.args).toString('utf8')) as unknown;
      if (!isRecord(decoded)) {
        throw new Error('args must be an object');
      }
      args = decoded;
    } catch {
      throw new GateReject('invalid_args', 'functionCall args must be a JSON object');
    }

    if (args.receiver_id !== accepted.payTo) {
      throw new GateReject('receiver_mismatch', 'args.receiver_id must equal accepted.payTo');
    }
    const argsAmount = argumentAmount(args.amount);
    if (argsAmount === null || argsAmount !== acceptedAmount) {
      throw new GateReject('amount_mismatch', 'args.amount must equal accepted.amount exactly');
    }

    if (methodName === 'ft_transfer_call') {
      if (accepted.payTo !== this.config.splitContract) {
        throw new GateReject('payto_mismatch', 'ft_transfer_call payTo must be the split contract');
      }
    } else if (accepted.payTo === this.config.splitContract) {
      throw new GateReject('payto_mismatch', 'ft_transfer payTo must be a payee wallet');
    }
    if (accepted.extra !== undefined && 'splitContract' in accepted.extra) {
      if (accepted.extra.splitContract !== this.config.splitContract) {
        throw new GateReject('payto_mismatch', 'extra.splitContract must match the configured contract');
      }
    }

    let tool: string | null = null;
    if (methodName === 'ft_transfer_call') {
      tool = parsePayToolMsg(args.msg);
    }

    if (delegateAction.publicKey.keyType !== KeyType.ED25519 &&
        delegateAction.publicKey.keyType !== KeyType.SECP256K1) {
      throw new GateReject('unsupported_key_type', 'delegate public key must be ed25519 or secp256k1');
    }
    const signatureCurve = extractSignatureCurve(signature);
    const signatureBytes = extractSignatureBytes(signature);
    if (signatureCurve === null || signatureBytes === null) {
      throw new GateReject('signature_mismatch', 'delegate signature shape is not recognized');
    }
    if (signatureCurve !== delegateAction.publicKey.keyType) {
      throw new GateReject(
        'signature_key_curve_mismatch',
        'delegate signature curve must match the public key curve'
      );
    }
    const delegateHash = createHash('sha256')
      .update(encodeDelegateAction(delegateAction))
      .digest();
    let signatureValid = false;
    try {
      signatureValid = delegateAction.publicKey.verify(
        new Uint8Array(delegateHash),
        signatureBytes
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new GateReject('signature_mismatch', 'delegate signature does not verify');
    }

    if (this.config.relayerId === senderId) {
      throw new GateReject('relayer_is_sender', 'relayer and payer must be different accounts');
    }

    const block = await this.finalBlock();
    const blockHeight = block.height;
    const blockHash = block.hash;

    await this.requireAccount(senderId, blockHash, 'unknown_sender', 'payer account does not exist');
    await this.requireContract(this.config.tokenContract, blockHash, 'token_not_deployed');
    if (methodName === 'ft_transfer_call') {
      await this.requireContract(this.config.splitContract, blockHash, 'token_not_deployed');
    }

    let accessKey: AccessKeyQuery;
    try {
      accessKey = await this.near.viewAccessKey(
        senderId,
        delegateAction.publicKey.toString(),
        blockHash
      );
    } catch (error) {
      if (isMissingAccountError(error)) {
        throw new GateReject('missing_access_key', 'payer key is not registered on the account');
      }
      throw new GateReject('chain_unavailable', 'view_access_key failed', 503);
    }
    if (!isFullAccessPermission(accessKey.permission)) {
      throw new GateReject(
        'full_access_key_required',
        'payer key must be FullAccess; function-call and gas keys are rejected'
      );
    }

    const keyNonce = accessKey.nonce;
    if (delegateAction.nonce <= keyNonce) {
      throw new GateReject('nonce_reused', 'delegate nonce is not greater than the access-key nonce');
    }
    if (delegateAction.nonce >= BigInt(blockHeight) * MICRO_BLOCKS_PER_BLOCK) {
      throw new GateReject('nonce_too_large', 'delegate nonce exceeds the NEP-366 micro-block bound');
    }
    const remainingBlocks = delegateAction.maxBlockHeight - BigInt(blockHeight);
    if (remainingBlocks <= 0n) {
      throw new GateReject('delegate_expired', 'delegate max_block_height has passed');
    }
    if (remainingBlocks > BigInt(timeoutBlocks) + FINALITY_LAG_BLOCKS) {
      throw new GateReject(
        'delegate_expired',
        'delegate max_block_height exceeds accepted.maxTimeoutSeconds'
      );
    }

    let balance: bigint;
    try {
      balance = await this.near.ftBalanceOf(senderId, blockHash);
    } catch (error) {
      if (isMissingAccountError(error)) {
        balance = 0n;
      } else {
        throw new GateReject('chain_unavailable', 'ft_balance_of failed', 503);
      }
    }
    if (balance < acceptedAmount) {
      throw new GateReject('insufficient_balance', 'payer FT balance is below accepted.amount');
    }

    let payee: string;
    if (methodName === 'ft_transfer_call') {
      const toolInfo = await this.fetchToolInfo(tool === null ? '' : tool, blockHash);
      if (toolInfo === null) {
        throw new GateReject('unknown_tool', 'msg.tool is not registered');
      }
      if (!toolInfo.active) {
        throw new GateReject('inactive_tool', 'msg.tool is not active');
      }
      if (acceptedAmount < BigInt(toolInfo.price_per_call)) {
        throw new GateReject(
          'underpriced_tool',
          'accepted.amount is below the registered tool price'
        );
      }
      if (!isAccountId(toolInfo.developer)) {
        throw new GateReject('unknown_developer', 'tool developer is not a valid account id');
      }
      await this.requireAccount(
        toolInfo.developer,
        blockHash,
        'unknown_developer',
        'tool developer account does not exist'
      );
      payee = toolInfo.developer;
    } else {
      await this.requireAccount(
        accepted.payTo,
        blockHash,
        'payee_not_registered',
        'payTo account does not exist'
      );
      payee = accepted.payTo;
    }

    let storage: StorageBalanceView | null;
    try {
      storage = await this.near.storageBalanceOf(accepted.payTo, blockHash);
    } catch {
      throw new GateReject('chain_unavailable', 'storage_balance_of failed', 503);
    }
    if (storage === null) {
      throw new GateReject('payee_not_registered', 'payTo is not registered with the FT');
    }

    return {
      success: true,
      payer: senderId,
      publicKey: delegateAction.publicKey.toString(),
      amount: accepted.amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
      payee,
      methodName,
      tool,
      payloadHash: SettlementCache.hashBytes(delegateBytes),
      nonce: delegateAction.nonce.toString(),
      maxBlockHeight: Number(delegateAction.maxBlockHeight),
      blockHeight,
      blockHash,
      timeoutBlocks,
      signedDelegate,
    };
  }

  private async finalBlock(): Promise<BlockHeight> {
    try {
      return await this.near.blockHeight(true);
    } catch {
      throw new GateReject('chain_unavailable', 'final block lookup failed', 503);
    }
  }

  private async requireAccount(
    accountId: string,
    blockHash: string,
    reason: GateErrorReason,
    message: string
  ): Promise<void> {
    try {
      await this.near.viewAccount(accountId, blockHash);
    } catch (error) {
      if (isMissingAccountError(error)) {
        throw new GateReject(reason, message);
      }
      throw new GateReject('chain_unavailable', `view_account failed for ${accountId}`, 503);
    }
  }

  private async requireContract(
    accountId: string,
    blockHash: string,
    reason: GateErrorReason
  ): Promise<void> {
    try {
      const code = await this.near.viewContractCode(accountId, blockHash);
      if (code.code.length === 0) {
        throw new GateReject(reason, `${accountId} has no deployed code`);
      }
    } catch (error) {
      if (error instanceof GateReject) {
        throw error;
      }
      if (isMissingAccountError(error)) {
        throw new GateReject(reason, `${accountId} has no deployed code`);
      }
      throw new GateReject('chain_unavailable', `view_code failed for ${accountId}`, 503);
    }
  }

  private async fetchToolInfo(tool: string, blockHash: string) {
    try {
      return await this.near.viewToolInfo(tool, blockHash);
    } catch {
      throw new GateReject('chain_unavailable', 'get_tool_info failed', 503);
    }
  }
}

function parsePayToolMsg(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GateReject('invalid_msg', 'ft_transfer_call requires a JSON msg');
  }
  let msg: unknown;
  try {
    msg = JSON.parse(value);
  } catch {
    throw new GateReject('invalid_msg', 'msg is not valid JSON');
  }
  if (!isRecord(msg) || typeof msg.action !== 'string') {
    throw new GateReject('invalid_msg', 'msg must be an object with an action');
  }
  if (KNOWN_MSG_ACTIONS[msg.action] !== true) {
    throw new GateReject('invalid_msg', 'msg.action is not a registered payment action');
  }
  if (msg.action !== 'pay_tool') {
    throw new GateReject('invalid_msg', 'x402 payments must use msg.action = "pay_tool"');
  }
  if (typeof msg.tool !== 'string' || msg.tool.trim().length === 0) {
    throw new GateReject('invalid_msg', 'msg.tool is required');
  }
  return msg.tool;
}
