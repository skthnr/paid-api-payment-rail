/**
 * Facilitator wire types (x402 v2 + portico ledger views).
 *
 * The protocol wire shapes are shared with the SDK as type-only re-exports;
 * the facilitator still validates every field at runtime before it reaches
 * `near-api-js`.
 */

export type {
  AcceptsEntry,
  PaymentPayload,
  PaymentRequired,
  ResourceInfo,
  SettlementResponse,
  SignedDelegateActionEnvelope,
} from '@portico/sdk';

export interface QuoteRequest {
  service: string;
  params?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: Array<{ x402Version: 2; scheme: 'exact'; network: string }>;
  extensions: string[];
  signers: Record<string, string[]>;
}

export interface HealthResponse {
  status: 'ok';
  service: 'portico-facilitator';
  version: string;
  network: string;
  uptimeSeconds: number;
  paymentsProcessed: number;
  timestamp: number;
}

export interface ErrorResponse {
  error: string;
  code: string;
}

/** Reasons emitted by the delegate gate. Stable snake_case strings. */
export type GateErrorReason =
  | 'invalid_payload'
  | 'missing_payment_signature'
  | 'unsupported_x402_version'
  | 'unsupported_scheme'
  | 'network_mismatch'
  | 'asset_mismatch'
  | 'payto_mismatch'
  | 'invalid_timeout'
  | 'invalid_amount'
  | 'invalid_signature_encoding'
  | 'invalid_signed_delegate'
  | 'invalid_action_count'
  | 'unsupported_action'
  | 'receiver_mismatch'
  | 'unsupported_method'
  | 'invalid_gas'
  | 'invalid_deposit'
  | 'invalid_args'
  | 'amount_mismatch'
  | 'invalid_msg'
  | 'unknown_tool'
  | 'inactive_tool'
  | 'underpriced_tool'
  | 'unknown_developer'
  | 'signature_key_curve_mismatch'
  | 'unsupported_key_type'
  | 'signature_mismatch'
  | 'missing_access_key'
  | 'full_access_key_required'
  | 'nonce_reused'
  | 'nonce_too_large'
  | 'delegate_expired'
  | 'unknown_sender'
  | 'token_not_deployed'
  | 'insufficient_balance'
  | 'payee_not_registered'
  | 'relayer_is_sender'
  | 'chain_unavailable';

/** Success shape shared by `/verify` and `/settle`. */
export interface GateSuccess {
  success: true;
  payer: string;
  publicKey: string;
  amount: string;
  asset: string;
  payTo: string;
  payee: string;
  methodName: 'ft_transfer' | 'ft_transfer_call';
  tool: string | null;
  payloadHash: string;
  nonce: string;
  maxBlockHeight: number;
  blockHeight: number;
  blockHash: string;
  timeoutBlocks: number;
}

export interface GateFailure {
  success: false;
  errorReason: GateErrorReason;
  message: string;
  httpStatus: number;
}

export type VerificationResponse =
  | ({ success: true; network: string } & Omit<GateSuccess, 'success'>)
  | {
      success: false;
      errorReason: GateErrorReason | string;
      error: string;
      network: string;
    };

/** NEP-141 `ft_metadata` view. */
export interface FtMetadataView {
  name?: string;
  symbol?: string;
  decimals: number;
  icon?: string | null;
  reference?: string | null;
  reference_hash?: string | null;
}

/** NEP-145 `storage_balance_of` view. */
export interface StorageBalanceView {
  total: string;
  available: string;
}

/** `get_tool_info` view from the revenue-split contract. */
export interface ToolInfoView {
  developer: string;
  price_per_call: string;
  total_calls: number;
  total_revenue: string;
  active: boolean;
  created_at_block: number;
}

export type SettlementStateView = 'pending' | 'settled' | 'failed';

/** One duplicate-settlement cache entry as exposed by `GET /payments`. */
export interface PaymentRecordView {
  payloadHash: string;
  state: SettlementStateView;
  txHash: string | null;
  maxBlockHeight: number;
  payer: string | null;
  amount: string | null;
  methodName: string | null;
  tool: string | null;
  errorReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentsListResponse {
  payments: PaymentRecordView[];
  count: number;
  network: string;
}
