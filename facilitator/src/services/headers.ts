/**
 * Base64 JSON codecs for the x402 v2 `PAYMENT-*` headers.
 *
 * The transport carries JSON in base64; a header that is not canonical base64
 * is rejected instead of being silently repaired, so two different header
 * strings can never decode to the same signed delegate.
 */

import {
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from '../constants.js';
import type { SettlementResponse } from '../types.js';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class PaymentHeaderError extends Error {
  public readonly code: string;
  public readonly httpStatus = 400;

  public constructor(message: string, code = 'INVALID_PAYMENT_HEADER') {
    super(message);
    this.name = 'PaymentHeaderError';
    this.code = code;
  }
}

export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}
export function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !BASE64_PATTERN.test(trimmed)) {
    throw new PaymentHeaderError(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== trimmed) {
    throw new PaymentHeaderError(`${label} must be canonical base64`);
  }
  return new Uint8Array(bytes);
}

export function decodeHeaderJson(header: string, headerName: string): unknown {
  const bytes = decodeCanonicalBase64(header, headerName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new PaymentHeaderError(`${headerName} must contain JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PaymentHeaderError(`${headerName} must contain a JSON object`);
  }
  return parsed;
}

export function encodePaymentSignature(payload: unknown): string {
  return encodeHeaderJson(payload);
}

export function decodePaymentSignature(header: string): unknown {
  return decodeHeaderJson(header, PAYMENT_SIGNATURE_HEADER);
}

export function encodeSettlementResponse(response: SettlementResponse): string {
  return encodeHeaderJson(response);
}

export function decodeSettlementResponse(header: string): SettlementResponse {
  const value = decodeHeaderJson(header, PAYMENT_RESPONSE_HEADER);
  if (typeof value !== 'object' || value === null) {
    throw new PaymentHeaderError(`${PAYMENT_RESPONSE_HEADER} must contain an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.success !== 'boolean') {
    throw new PaymentHeaderError(`${PAYMENT_RESPONSE_HEADER}.success must be a boolean`);
  }
  if (typeof record.network !== 'string' || record.network.length === 0) {
    throw new PaymentHeaderError(`${PAYMENT_RESPONSE_HEADER}.network is required`);
  }
  if (!record.success && (typeof record.errorReason !== 'string' || record.errorReason.length === 0)) {
    throw new PaymentHeaderError(`${PAYMENT_RESPONSE_HEADER}.errorReason is required on failure`);
  }
  if (
    record.settlement !== undefined &&
    record.settlement !== 'settled' &&
    record.settlement !== 'pending'
  ) {
    throw new PaymentHeaderError(
      `${PAYMENT_RESPONSE_HEADER}.settlement must be "settled" or "pending"`
    );
  }
  for (const field of ['payer', 'transaction', 'errorReason'] as const) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      throw new PaymentHeaderError(`${PAYMENT_RESPONSE_HEADER}.${field} must be a string`);
    }
  }

  const response: SettlementResponse = {
    success: record.success,
    network: record.network,
  };
  if (typeof record.errorReason === 'string') {
    response.errorReason = record.errorReason;
  }
  if (typeof record.payer === 'string') {
    response.payer = record.payer;
  }
  if (typeof record.transaction === 'string') {
    response.transaction = record.transaction;
  }
  if (record.settlement === 'settled' || record.settlement === 'pending') {
    response.settlement = record.settlement;
  }
  return response;
}
