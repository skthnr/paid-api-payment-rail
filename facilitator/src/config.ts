/**
 * Facilitator configuration.
 *
 * All values come from the environment described in `.env.example`. Validation
 * happens once at boot and fails closed: a malformed account id, fee bound or
 * decimals setting stops the process instead of degrading the payment path.
 */

import 'dotenv/config';

export type PorticoNetwork = `near:${string}`;

export interface FacilitatorConfig {
  nodeEnv: string;
  logLevel: string;
  network: PorticoNetwork;
  rpcUrl: string;
  splitContract: string;
  tokenContract: string;
  expectedDecimals: number;
  relayerId: string;
  relayerSecretKeys: string[];
  platformWallet: string;
  feeBps: number;
  port: number;
  host: string;
  facilitatorUrl: string;
  maxTimeoutSeconds: number;
  settlementCacheTtlMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rpcRetries: number;
  rpcRetryWaitMs: number;
  corsOrigins: string[];
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ACCOUNT_ID_PATTERN =
  /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;
const SECRET_KEY_PATTERN = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/;

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value);
}

export function assertAccountId(value: string, name: string): string {
  if (!isAccountId(value)) {
    throw new ConfigError(`${name} is not a valid NEAR account id`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function parseSecretKeys(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('PORTICO_RELAYER_SECRET_KEYS must be a JSON array of secret keys');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError('PORTICO_RELAYER_SECRET_KEYS must be a non-empty JSON array');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'string' || !SECRET_KEY_PATTERN.test(entry)) {
      throw new ConfigError(`PORTICO_RELAYER_SECRET_KEYS[${index}] is not a secret key`);
    }
    return entry;
  });
}

function parseNetwork(raw: string): PorticoNetwork {
  if (raw !== 'near:testnet' && raw !== 'near:mainnet') {
    throw new ConfigError('PORTICO_NETWORK must be near:testnet or near:mainnet');
  }
  return raw;
}

function parseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`FACILITATOR_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('FACILITATOR_URL must use http or https');
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Load and validate the facilitator configuration. Throws ConfigError on any
 * invalid or missing value; callers should let the process exit.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const feeBps = integer(env, 'PORTICO_FEE_BPS', 2000, 0, 5000);
  const expectedDecimals = integer(env, 'PORTICO_EXPECTED_DECIMALS', 18, 0, 24);
  if (expectedDecimals !== 18) {
    throw new ConfigError(
      'PORTICO_EXPECTED_DECIMALS must be 18; the scheme and demo amounts are raw 18-decimal FT units'
    );
  }

  const corsOrigins = (env.PORTICO_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    logLevel: env.LOG_LEVEL ?? 'info',
    network: parseNetwork(env.PORTICO_NETWORK ?? 'near:testnet'),
    rpcUrl: env.PORTICO_RPC_URL ?? 'https://test.rpc.fastnear.com',
    splitContract: assertAccountId(required(env, 'PORTICO_SPLIT_CONTRACT'), 'PORTICO_SPLIT_CONTRACT'),
    tokenContract: assertAccountId(required(env, 'PORTICO_TOKEN_CONTRACT'), 'PORTICO_TOKEN_CONTRACT'),
    expectedDecimals,
    relayerId: assertAccountId(required(env, 'PORTICO_RELAYER_ID'), 'PORTICO_RELAYER_ID'),
    relayerSecretKeys: parseSecretKeys(required(env, 'PORTICO_RELAYER_SECRET_KEYS')),
    platformWallet: assertAccountId(required(env, 'PORTICO_PLATFORM_WALLET'), 'PORTICO_PLATFORM_WALLET'),
    feeBps,
    port: integer(env, 'PORTICO_FACILITATOR_PORT', 3002, 1, 65_535),
    host: env.HOST ?? '0.0.0.0',
    facilitatorUrl: parseUrl(env.FACILITATOR_URL ?? 'http://localhost:3002'),
    maxTimeoutSeconds: integer(env, 'PORTICO_MAX_TIMEOUT_SECONDS', 60, 1, 3600),
    settlementCacheTtlMs: integer(env, 'PORTICO_SETTLEMENT_CACHE_TTL_MS', 120_000, 1_000, 86_400_000),
    rateLimitWindowMs: integer(env, 'RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 3_600_000),
    rateLimitMax: integer(
      env,
      'RATE_LIMIT_MAX',
      env.RATE_LIMIT_MAX_REQUESTS ? Number(env.RATE_LIMIT_MAX_REQUESTS) : 100,
      1,
      100_000
    ),
    rpcRetries: integer(env, 'PORTICO_RPC_RETRIES', 4, 1, 20),
    rpcRetryWaitMs: integer(env, 'PORTICO_RPC_RETRY_WAIT_MS', 250, 10, 10_000),
    corsOrigins,
  };
}
