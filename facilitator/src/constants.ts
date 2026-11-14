/**
 * x402 v2 constants shared by the facilitator routes.
 *
 * The HTTP transport uses base64-encoded JSON in the PAYMENT-* headers. These
 * headers are not CORS-safelisted, so the server must expose/allow them
 * explicitly (see `server.ts`).
 */

export {
  ALLOWED_PAYMENT_HEADERS,
  EXPOSED_PAYMENT_HEADERS,
  ONE_YOCTO,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_SCHEME,
  X402_VERSION,
} from '@portico/sdk';

/** Service prices are quoted with 6 decimal places of display precision. */
export const PRICE_DECIMALS = 6;
/** The payment FT is pinned to 18 decimals; all amounts are raw units. */
export const TOKEN_DECIMALS = 18;
export const RAW_PER_PRICE_UNIT = 10n ** BigInt(TOKEN_DECIMALS - PRICE_DECIMALS);

export const MAX_TIMEOUT_SECONDS = 3600;
export const MAX_QUOTE_QUANTITY = 1000;

export const U128_MAX = (1n << 128n) - 1n;
/** NEP-366 nonce bound: `nonce < block_height * 1_000_000`. */
export const MICRO_BLOCKS = 1_000_000n;
export const FT_TRANSFER_GAS = 30_000_000_000_000n;
export const FT_TRANSFER_CALL_GAS = 100_000_000_000_000n;
/**
 * Default allowance for the optimistic-vs-final block lag in the delegate TTL
 * gate. The active value comes from `PORTICO_FINALITY_LAG_BLOCKS`
 * (`FacilitatorConfig.finalityLagBlocks`, range `0..=60`).
 */
export const FINALITY_LAG_BLOCKS = 3;
export const MAX_SERVICE_LEN = 64;
