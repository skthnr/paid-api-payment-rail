/**
 * Base64 JSON codecs for the x402 v2 `PAYMENT-*` headers.
 *
 * The transport carries JSON in base64; a header that is not canonical base64
 * is rejected instead of being silently repaired, so two different header
 * strings can never decode to the same signed delegate.
 */

import {
  decodeCanonicalBase64 as decodeSdkBase64,
  decodeHeaderJson as decodeSdkHeaderJson,
  encodeHeaderJson,
  messageOf,
  PaymentHeaderError as SdkPaymentHeaderError,
} from '@portico/sdk';
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
  try {
    return decodeSdkBase64(value, label);
  } catch (error) {
    if (error instanceof SdkPaymentHeaderError) {
      throw new PaymentHeaderError(`${label} must be canonical base64`);
    }
    throw error;
  }
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
