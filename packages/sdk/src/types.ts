/**
 * x402 v2 wire types and portico contract view shapes.
 *
 * U128 values cross the wire as decimal strings; bigint is only used inside the
 * SDK when arithmetic is needed.
 */

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface AcceptsEntry {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: AcceptsEntry[];
  extensions?: Record<string, unknown>;
}

/** Base64 borsh bytes of a NEP-366 SignedDelegateAction. */
export interface SignedDelegateActionEnvelope {
  signedDelegateAction: string;
}

export interface PaymentPayload {
  x402Version: 2;
  resource: ResourceInfo;
  accepted: AcceptsEntry;
  payload: SignedDelegateActionEnvelope;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network: string;
  settlement?: 'settled' | 'pending';
}

export type LedgerAction =
  | 'payment'
  | 'tool_call'
  | 'developer_payout'
  | 'stream_claim'
  | 'stream_fund'
  | 'stream_withdraw'
  | 'stream_close';

export interface LedgerEntry {
  id: number;
  payer: string;
  payee: string;
  amount: string;
  action: LedgerAction;
  tool: string | null;
  memo: string | null;
  block_height: number;
}

export interface ToolInfo {
  developer: string;
  price_per_call: string;
  total_calls: number;
  total_revenue: string;
  active: boolean;
  created_at_block: number;
}

export interface SplitView {
  developer: string;
  platform: string;
}

export interface TotalsView {
  tools_count: number;
  open_streams: number;
  active_streams: number;
  settled_volume: string;
  total_developer_balance: string;
}

export type StreamStatus = 'open' | 'paused' | 'closed';

export interface StreamView {
  accrued: string;
  claimable: string;
  escrow_remaining: string;
  status: StreamStatus;
}

export interface FtMetadata {
  name: string;
  symbol: string;
  decimals: number;
  icon?: string | null;
  reference?: string | null;
  reference_hash?: string | null;
}
