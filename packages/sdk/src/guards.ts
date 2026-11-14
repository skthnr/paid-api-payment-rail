/**
 * Canonical runtime guard for untrusted JSON shapes in the SDK.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Human-readable message for an unknown rejection value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ACCOUNT_ID_PATTERN =
  /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;
export const SECRET_KEY_PATTERN = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/;
export const U128_PATTERN = /^\d+$/;
export const TX_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value);
}

export function isSecretKey(value: string): boolean {
  return SECRET_KEY_PATTERN.test(value);
}

export function isU128(value: string): boolean {
  return U128_PATTERN.test(value);
}

export function normalizeHttpUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  return parsed.toString().replace(/\/+$/, '');
}
