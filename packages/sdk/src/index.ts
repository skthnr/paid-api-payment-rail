/**
 * @portico/sdk — x402 v2 NEAR exact-scheme payment client.
 *
 * Public surface: wire constants and types, strict PAYMENT-* header handling,
 * the NEP-366 delegate builders, the buyer client (`pay`/`quote`/`supported`)
 * and the revenue-split contract views.
 */

export * from './constants.js';
export * from './errors.js';
export * from './types.js';
export * from './http/handler.js';
export * from './payments/metaTx.js';
export * from './client.js';
export * from './contracts/revenueSplit.js';
