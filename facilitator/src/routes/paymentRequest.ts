/**
 * Read the x402 v2 payment payload from `PAYMENT-SIGNATURE` or the JSON body.
 *
 * The header is authoritative when present. Body fallback exists for clients
 * and proxies that cannot set custom headers; `paymentPayload` is accepted as a
 * wrapper for spec-style verify/settle bodies.
 */

import type { Request } from 'express';
import { PAYMENT_SIGNATURE_HEADER } from '../constants.js';
import { isRecord } from '../guards.js';
import { PaymentHeaderError, decodePaymentSignature } from '../services/headers.js';

export function readPaymentPayload(req: Request): unknown {
  const header = req.get(PAYMENT_SIGNATURE_HEADER);
  if (typeof header === 'string' && header.trim().length > 0) {
    return decodePaymentSignature(header);
  }

  const body: unknown = req.body;
  if (!isRecord(body)) {
    throw new PaymentHeaderError(
      'Request body must contain a payment payload',
      'MISSING_PAYMENT_SIGNATURE'
    );
  }
  if (isRecord(body.paymentPayload)) {
    return body.paymentPayload;
  }
  if ('accepted' in body && 'payload' in body) {
    return body;
  }
  throw new PaymentHeaderError(
    'Request body must contain a payment payload',
    'MISSING_PAYMENT_SIGNATURE'
  );
}
