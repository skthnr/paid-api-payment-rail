/**
 * Base64 JSON codecs for the x402 v2 `PAYMENT-*` headers.
 *
 * The transport carries JSON in base64; a header that is not canonical base64
 * is rejected instead of being silently repaired, so two different header
 * strings can never decode to the same signed delegate.
 */

import { decodeHeaderJson as decodeSdkHeaderJson, encodeHeaderJson, messageOf } from '@portico/sdk';

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

export { encodeHeaderJson };
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
  let parsed: unknown;
  try {
    parsed = decodeSdkHeaderJson<unknown>(header, headerName);
  } catch (error) {
    throw new PaymentHeaderError(messageOf(error), headerName);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PaymentHeaderError(`${headerName} must contain a JSON object`, headerName);
  }
  return parsed;
}
