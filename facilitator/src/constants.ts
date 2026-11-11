/**
 * x402 v2 constants shared by the facilitator routes.
 *
 * The HTTP transport uses base64-encoded JSON in the PAYMENT-* headers. These
 * headers are not CORS-safelisted, so the server must expose/allow them
 * explicitly (see `server.ts`).
 */

export const X402_VERSION = 2;
export const X402_SCHEME = 'exact';

export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

export const EXPOSED_PAYMENT_HEADERS = [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER];
export const ALLOWED_PAYMENT_HEADERS = ['Content-Type', PAYMENT_SIGNATURE_HEADER];

/** Service prices are quoted with 6 decimal places of display precision. */
export const PRICE_DECIMALS = 6;
/** The payment FT is pinned to 18 decimals; all amounts are raw units. */
export const TOKEN_DECIMALS = 18;
export const RAW_PER_PRICE_UNIT = 10n ** BigInt(TOKEN_DECIMALS - PRICE_DECIMALS);

export const MAX_TIMEOUT_SECONDS = 3600;
export const MAX_QUOTE_QUANTITY = 1000;
export const MAX_SERVICE_NAME_LENGTH = 64;
