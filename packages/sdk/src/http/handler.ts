/**
 * x402 v2 HTTP header handling.
 *
 * The transport carries base64-encoded JSON in PAYMENT-REQUIRED,
 * PAYMENT-SIGNATURE and PAYMENT-RESPONSE. Decoding is strict: invalid base64,
 * non-JSON payloads, wrong versions and malformed accepts entries throw a
 * PaymentHeaderError instead of being coerced.
 */

import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
} from '../constants.js';
import { isRecord } from '../guards.js';
import type {
  AcceptsEntry,
  PaymentPayload,
  PaymentRequired,
  ResourceInfo,
  SettlementResponse,
} from '../types.js';

export class PaymentHeaderError extends Error {
  public readonly header: string | null;

  public constructor(message: string, header: string | null = null) {
    super(message);
    this.name = 'PaymentHeaderError';
    this.header = header;
  }
}

export interface HeaderReader {
  get(name: string): string | null;
}

export type HeaderSource = HeaderReader | Record<string, string | string[] | undefined>;

function isHeaderReader(source: HeaderSource): source is HeaderReader {
  return 'get' in source && typeof source.get === 'function';
}

function pickHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function readFromRecord(
  source: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const lower = name.toLowerCase();
  const direct = source[name] ?? source[lower];
  if (direct !== undefined) {
    return pickHeaderValue(direct);
  }
  for (const key in source) {
    if (key.toLowerCase() === lower) {
      return pickHeaderValue(source[key]);
    }
  }
  return null;
}

export function getHeader(source: HeaderSource, name: string): string | null {
  return isHeaderReader(source) ? source.get(name) : readFromRecord(source, name);
}

export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeCanonicalBase64(value: string, label: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new PaymentHeaderError(`${label} is empty`, label);
  }
  if ((trimmed.length & 3) !== 0) {
    throw new PaymentHeaderError(`${label} is not canonical base64`, label);
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== trimmed) {
    throw new PaymentHeaderError(`${label} is not canonical base64`, label);
  }
  return bytes;
}

export function decodeHeaderJson<T>(value: string, headerName: string): T {
  const bytes = decodeCanonicalBase64(value, headerName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PaymentHeaderError(`${headerName} does not contain JSON`, headerName);
  }
  return parsed as T;
}

function requireString(value: unknown, field: string, headerName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PaymentHeaderError(`${headerName}: ${field} must be a non-empty string`, headerName);
  }
  return value;
}

function validateAcceptsEntry(entry: unknown, index: number, headerName: string): AcceptsEntry {
  if (!isRecord(entry)) {
    throw new PaymentHeaderError(`${headerName}: accepts[${index}] must be an object`, headerName);
  }
  if (entry.scheme !== 'exact') {
    throw new PaymentHeaderError(
      `${headerName}: accepts[${index}].scheme must be "exact"`,
      headerName
    );
  }
  const network = requireString(entry.network, `accepts[${index}].network`, headerName);
  if (!network.startsWith('near:')) {
    throw new PaymentHeaderError(
      `${headerName}: accepts[${index}].network must be a NEAR CAIP-2 id`,
      headerName
    );
  }
  const amount = requireString(entry.amount, `accepts[${index}].amount`, headerName);
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new PaymentHeaderError(
      `${headerName}: accepts[${index}].amount must be a positive integer`,
      headerName
    );
  }
  const asset = requireString(entry.asset, `accepts[${index}].asset`, headerName);
  const payTo = requireString(entry.payTo, `accepts[${index}].payTo`, headerName);
  const maxTimeoutSeconds = entry.maxTimeoutSeconds;
  if (
    typeof maxTimeoutSeconds !== 'number' ||
    !Number.isInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < 1
  ) {
    throw new PaymentHeaderError(
      `${headerName}: accepts[${index}].maxTimeoutSeconds must be a positive integer`,
      headerName
    );
  }
  let extra: Record<string, unknown> | undefined;
  if (entry.extra !== undefined) {
    if (!isRecord(entry.extra)) {
      throw new PaymentHeaderError(
        `${headerName}: accepts[${index}].extra must be an object`,
        headerName
      );
    }
    extra = entry.extra;
  }
  const accept: AcceptsEntry = {
    scheme: 'exact',
    network,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds,
  };
  if (extra !== undefined) {
    accept.extra = extra;
  }
  return accept;
}

export function parsePaymentRequired(value: unknown): PaymentRequired {
  if (!isRecord(value)) {
    throw new PaymentHeaderError('PAYMENT-REQUIRED must be a JSON object', PAYMENT_REQUIRED_HEADER);
  }
  if (value.x402Version !== X402_VERSION) {
    throw new PaymentHeaderError(
      'PAYMENT-REQUIRED: x402Version must be 2',
      PAYMENT_REQUIRED_HEADER
    );
  }
  if (!isRecord(value.resource)) {
    throw new PaymentHeaderError(
      'PAYMENT-REQUIRED: resource must be an object',
      PAYMENT_REQUIRED_HEADER
    );
  }
  const url = requireString(value.resource.url, 'resource.url', PAYMENT_REQUIRED_HEADER);
  if (!Array.isArray(value.accepts) || value.accepts.length === 0) {
    throw new PaymentHeaderError(
      'PAYMENT-REQUIRED: accepts must be a non-empty array',
      PAYMENT_REQUIRED_HEADER
    );
  }
  const accepts = value.accepts.map((entry, index) =>
    validateAcceptsEntry(entry, index, PAYMENT_REQUIRED_HEADER)
  );
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new PaymentHeaderError(
      'PAYMENT-REQUIRED: error must be a string',
      PAYMENT_REQUIRED_HEADER
    );
  }
  if (value.extensions !== undefined && !isRecord(value.extensions)) {
    throw new PaymentHeaderError(
      'PAYMENT-REQUIRED: extensions must be an object',
      PAYMENT_REQUIRED_HEADER
    );
  }

  const requirement: PaymentRequired = {
    x402Version: X402_VERSION,
    resource: { url },
    accepts,
  };
  if (typeof value.error === 'string') {
    requirement.error = value.error;
  }
  const description = value.resource.description;
  if (typeof description === 'string') {
    requirement.resource.description = description;
  }
  const mimeType = value.resource.mimeType;
  if (typeof mimeType === 'string') {
    requirement.resource.mimeType = mimeType;
  }
  if (isRecord(value.extensions)) {
    requirement.extensions = value.extensions;
  }
  return requirement;
}

export interface HeaderResponse {
  status: number;
  headers: HeaderSource;
  body?: unknown;
}

export function isPaymentRequiredResponse(response: HeaderResponse): boolean {
  return response.status === 402;
}

/**
 * Read the payment requirement from a 402 response. Prefers the header, falls
 * back to a JSON body for proxies that strip unknown headers.
 */
export function readPaymentRequired(response: HeaderResponse): PaymentRequired | null {
  if (!isPaymentRequiredResponse(response)) {
    return null;
  }
  const header = getHeader(response.headers, PAYMENT_REQUIRED_HEADER);
  if (header) {
    return parsePaymentRequired(decodeHeaderJson<unknown>(header, PAYMENT_REQUIRED_HEADER));
  }
  if (isRecord(response.body)) {
    return parsePaymentRequired(response.body);
  }
  return null;
}

function checkDelegateEnv(value: unknown): string {
  if (!isRecord(value)) {
    throw new PaymentHeaderError(
      'PAYMENT-SIGNATURE payload must be an object',
      PAYMENT_SIGNATURE_HEADER
    );
  }
  const encoded = requireString(
    value.signedDelegateAction,
    'payload.signedDelegateAction',
    PAYMENT_SIGNATURE_HEADER
  );
  if (encoded.trim() !== encoded) {
    throw new PaymentHeaderError(
      'PAYMENT-SIGNATURE: signedDelegateAction must be canonical base64',
      PAYMENT_SIGNATURE_HEADER
    );
  }
  decodeCanonicalBase64(encoded, PAYMENT_SIGNATURE_HEADER);
  return encoded;
}

/** Decode and validate one `PAYMENT-SIGNATURE` header into the v2 payload. */
export function parsePaymentSignature(header: string): PaymentPayload {
  const value = decodeHeaderJson<unknown>(header, PAYMENT_SIGNATURE_HEADER);
  if (!isRecord(value)) {
    throw new PaymentHeaderError(
      'PAYMENT-SIGNATURE must contain a JSON object',
      PAYMENT_SIGNATURE_HEADER
    );
  }
  if (value.x402Version !== X402_VERSION) {
    throw new PaymentHeaderError(
      'PAYMENT-SIGNATURE must use x402 version 2',
      PAYMENT_SIGNATURE_HEADER
    );
  }
  if (
    !isRecord(value.resource) ||
    typeof value.resource.url !== 'string' ||
    value.resource.url.length === 0
  ) {
    throw new PaymentHeaderError(
      'PAYMENT-SIGNATURE.resource.url is required',
      PAYMENT_SIGNATURE_HEADER
    );
  }
  const signedDelegateAction = checkDelegateEnv(value.payload);
  const accepted = validateAcceptsEntry(value.accepted, 0, PAYMENT_SIGNATURE_HEADER);
  const resource: ResourceInfo = { url: value.resource.url };
  if (typeof value.resource.description === 'string') {
    resource.description = value.resource.description;
  }
  if (typeof value.resource.mimeType === 'string') {
    resource.mimeType = value.resource.mimeType;
  }
  return {
    x402Version: X402_VERSION,
    resource,
    accepted,
    payload: { signedDelegateAction },
  };
}

export function buildPaymentSignature(payload: PaymentPayload): Record<string, string> {
  if (payload.x402Version !== X402_VERSION) {
    throw new PaymentHeaderError('PaymentPayload.x402Version must be 2', PAYMENT_SIGNATURE_HEADER);
  }
  if (!isRecord(payload.resource) || typeof payload.resource.url !== 'string') {
    throw new PaymentHeaderError(
      'PaymentPayload.resource.url is required',
      PAYMENT_SIGNATURE_HEADER
    );
  }
  validateAcceptsEntry(payload.accepted, 0, PAYMENT_SIGNATURE_HEADER);
  checkDelegateEnv(payload.payload);
  return { [PAYMENT_SIGNATURE_HEADER]: encodeHeaderJson(payload) };
}

export function parseSettlementResponse(value: unknown): SettlementResponse {
  if (!isRecord(value)) {
    throw new PaymentHeaderError('PAYMENT-RESPONSE must be a JSON object', PAYMENT_RESPONSE_HEADER);
  }
  if (typeof value.success !== 'boolean') {
    throw new PaymentHeaderError(
      'PAYMENT-RESPONSE: success must be a boolean',
      PAYMENT_RESPONSE_HEADER
    );
  }
  const network = requireString(value.network, 'network', PAYMENT_RESPONSE_HEADER);
  if (!value.success && (typeof value.errorReason !== 'string' || value.errorReason.length === 0)) {
    throw new PaymentHeaderError(
      'PAYMENT-RESPONSE: errorReason is required on failure',
      PAYMENT_RESPONSE_HEADER
    );
  }
  if (
    value.settlement !== undefined &&
    value.settlement !== 'settled' &&
    value.settlement !== 'pending'
  ) {
    throw new PaymentHeaderError(
      'PAYMENT-RESPONSE: settlement must be "settled" or "pending"',
      PAYMENT_RESPONSE_HEADER
    );
  }
  for (const field of ['payer', 'transaction', 'errorReason'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new PaymentHeaderError(
        `PAYMENT-RESPONSE: ${field} must be a string`,
        PAYMENT_RESPONSE_HEADER
      );
    }
  }

  const response: SettlementResponse = { success: value.success, network };
  if (typeof value.errorReason === 'string') {
    response.errorReason = value.errorReason;
  }
  if (typeof value.payer === 'string') {
    response.payer = value.payer;
  }
  if (typeof value.transaction === 'string') {
    response.transaction = value.transaction;
  }
  if (value.settlement === 'settled' || value.settlement === 'pending') {
    response.settlement = value.settlement;
  }
  return response;
}

export function readSettlementResponse(response: HeaderResponse): SettlementResponse | null {
  const header = getHeader(response.headers, PAYMENT_RESPONSE_HEADER);
  if (header) {
    return parseSettlementResponse(decodeHeaderJson<unknown>(header, PAYMENT_RESPONSE_HEADER));
  }
  if (isRecord(response.body) && typeof response.body.success === 'boolean') {
    return parseSettlementResponse(response.body);
  }
  return null;
}
