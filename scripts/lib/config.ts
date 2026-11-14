/**
 * Shared environment validators for the repo scripts.
 *
 * `demo.ts` and `bench.ts` run from the same operator surface, so the account,
 * key, integer and URL rules live here instead of being copied into both.
 * Error text is preserved verbatim because operators see these messages.
 */

import { isAccountId, isSecretKey, normalizeHttpUrl } from '../../packages/sdk/src/guards.js';

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function accountId(value: string, name: string): string {
  if (!isAccountId(value)) {
    throw new Error(`${name} is not a valid NEAR account id: ${value}`);
  }
  return value;
}

export function secretKey(value: string, name: string): string {
  if (!isSecretKey(value)) {
    throw new Error(`${name} must be an ed25519 or secp256k1 secret key`);
  }
  return value;
}

export function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw.length === 0 ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

export function httpUrl(value: string, name: string): string {
  const normalized = normalizeHttpUrl(value);
  if (normalized === null) {
    throw new Error(`${name} must be a valid http or https URL: ${value}`);
  }
  return normalized;
}
