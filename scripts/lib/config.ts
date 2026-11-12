/**
 * Shared environment validators for the repo scripts.
 *
 * `demo.ts` and `bench.ts` run from the same operator surface, so the account,
 * key, integer and URL rules live here instead of being copied into both.
 * Error text is preserved verbatim because operators see these messages.
 */

const ACCOUNT_ID_PATTERN = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;
const SECRET_KEY_PATTERN = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/;

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function accountId(value: string, name: string): string {
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error(`${name} is not a valid NEAR account id: ${value}`);
  }
  return value;
}

export function secretKey(value: string, name: string): string {
  if (!SECRET_KEY_PATTERN.test(value)) {
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
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString().replace(/\/+$/, '');
}
