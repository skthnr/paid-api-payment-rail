/**
 * x402 v2 wire constants for the NEAR exact scheme.
 *
 * Amounts are raw NEP-141 units (the payment FT is pinned to 18 decimals).
 * Timeout mapping treats one NEAR block as one second, so
 * `blockHeightTtl = maxTimeoutSeconds` and `timeoutBlocks = max(1, ceil(s / 1))`.
 */

export const X402_VERSION = 2;
export const X402_SCHEME = 'exact';
export const DEFAULT_NETWORK = 'near:testnet';

export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

export const EXPOSED_PAYMENT_HEADERS = [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER];
export const ALLOWED_PAYMENT_HEADERS = ['Content-Type', PAYMENT_SIGNATURE_HEADER];

/** The payment FT decimals asserted by the facilitator at boot. */
export const FT_DECIMALS = 18;
/** Split contract fee bounds. */
export const MAX_FEE_BPS = 5000;
export const BPS_DENOMINATOR = 10_000n;
/** NEP-141 transfers require a 1-yocto attached deposit. */
export const ONE_YOCTO = 1n;
/** Delegated gas budget for the split `ft_transfer_call` path (whole cap). */
export const DELEGATED_GAS_TGAS = 100;
/** Per-leg gas: FT transfer + resolver callback. */
export const FT_TRANSFER_TGAS = 10;
export const FT_RESOLVE_TGAS = 5;
/** Official scheme's fixed block cadence for timeout mapping. */
export const ESTIMATED_BLOCK_SECONDS = 1;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
/** Ledger pagination bound enforced by the contract view. */
export const LEDGER_LIMIT_MAX = 100;
