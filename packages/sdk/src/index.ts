/**
 * @portico/sdk — x402 v2 NEAR exact-scheme payment client.
 *
 * W1 surface: wire constants, types and strict PAYMENT-* header handling.
 * The meta-transaction client (`payments/metaTx.ts`), client (`client.ts`) and
 * contract views (`contracts/revenueSplit.ts`) land in the primitive wave.
 */

export * from './constants.js';
export * from './types.js';
export * from './http/handler.js';
