/**
 * Facilitator wire types (x402 v2 + portico ledger views).
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

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network: string;
  settlement?: 'settled' | 'pending';
}
