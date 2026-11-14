/**
 * x402 v2 paywall example.
 *
 * A merchant route answers an unpaid request with HTTP 402 and a base64
 * `PAYMENT-REQUIRED` requirement. A retry carrying `PAYMENT-SIGNATURE` is
 * checked against that requirement locally, verified and settled through the
 * portico facilitator, and only then answered with the paid resource plus a
 * `PAYMENT-RESPONSE` header.
 *
 * Settlement success means the facilitator observed the inner NEP-141
 * transfer as `SuccessValue` at finality final. A failure is propagated with
 * the facilitator status and never includes the paid resource.
 *
 * CORS exposes `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`, allows
 * `PAYMENT-SIGNATURE` and `Content-Type`, sends `Vary: Origin` and answers
 * preflight without payment.
 */

try {
  process.loadEnvFile();
} catch {
  /* .env optional */
}
import { pathToFileURL } from 'node:url';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express';
import cors from 'cors';
import helmet from 'helmet';
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_SCHEME,
  X402_VERSION,
  encodeHeaderJson,
  isAccountId,
  isRecord,
  isU128,
  messageOf,
  normalizeHttpUrl,
  parsePaymentSignature,
  parseSettlementResponse,
  type AcceptsEntry,
  type PaymentPayload,
  type PaymentRequired,
  type ResourceInfo,
  type SettlementResponse,
} from '@portico/sdk';

/** Validated paywall configuration. */
export interface PaywallConfig {
  nodeEnv: string;
  port: number;
  host: string;
  facilitatorUrl: string;
  network: string;
  tokenContract: string;
  splitContract: string;
  /** Price in raw 18-decimal FT units. */
  amount: string;
  /** Tool name dispatched by the split contract. */
  tool: string;
  /** Absolute URL advertised as `resource.url`. */
  resourceUrl: string;
  description: string;
  maxTimeoutSeconds: number;
  allowedOrigins: string[];
}

/** A configuration value is missing or malformed. */
export class PaywallConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PaywallConfigError';
  }
}

/** Minimal fetch surface used for facilitator calls; `globalThis.fetch` satisfies it. */
export type PaywallFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<Response>;

export interface PaywallDependencies {
  fetch?: PaywallFetch;
}

const defaultFetch: PaywallFetch = (url, init) => globalThis.fetch(url, init);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new PaywallConfigError(`${name} is required`);
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
  const value = raw === undefined || raw.length === 0 ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PaywallConfigError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function accountId(value: string, name: string): string {
  if (!isAccountId(value)) {
    throw new PaywallConfigError(`${name} is not a valid NEAR account id`);
  }
  return value;
}

function rawAmount(value: string, name: string): string {
  if (!isU128(value) || BigInt(value) <= 0n) {
    throw new PaywallConfigError(`${name} must be a positive integer of raw FT units`);
  }
  return value;
}

function httpUrl(value: string, name: string): string {
  const normalized = normalizeHttpUrl(value);
  if (normalized === null) {
    throw new PaywallConfigError(`${name} must be a valid http or https URL: ${value}`);
  }
  return normalized;
}

function networkId(value: string): string {
  if (!value.startsWith('near:')) {
    throw new PaywallConfigError('PORTICO_NETWORK must be a NEAR CAIP-2 id such as near:testnet');
  }
  return value;
}

function toolName(value: string): string {
  const tool = value.trim();
  if (tool.length === 0 || tool.length > 64) {
    throw new PaywallConfigError('PAYWALL_TOOL must be 1..64 characters');
  }
  return tool;
}

/** Load and validate the paywall configuration; throws on any invalid value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PaywallConfig {
  const port = integer(env, 'PAYWALL_PORT', 3003, 1, 65_535);
  const host = env.HOST?.trim() || '0.0.0.0';
  const facilitatorUrl = httpUrl(
    env.FACILITATOR_URL?.trim() || 'http://localhost:3002',
    'FACILITATOR_URL'
  );
  const resourceUrl = httpUrl(
    env.PAYWALL_RESOURCE_URL?.trim() || `http://localhost:${port}/premium`,
    'PAYWALL_RESOURCE_URL'
  );
  const allowedOrigins = (env.PAYWALL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
  return {
    nodeEnv: env.NODE_ENV?.trim() || 'development',
    port,
    host,
    facilitatorUrl,
    network: networkId(env.PORTICO_NETWORK?.trim() || 'near:testnet'),
    tokenContract: accountId(required(env, 'PORTICO_TOKEN_CONTRACT'), 'PORTICO_TOKEN_CONTRACT'),
    splitContract: accountId(required(env, 'PORTICO_SPLIT_CONTRACT'), 'PORTICO_SPLIT_CONTRACT'),
    amount: rawAmount(env.PAYWALL_PRICE?.trim() || '1000000', 'PAYWALL_PRICE'),
    tool: toolName(env.PAYWALL_TOOL ?? 'web-search'),
    resourceUrl,
    description: env.PAYWALL_DESCRIPTION?.trim() || 'portico paywall premium resource',
    maxTimeoutSeconds: integer(
      env,
      'PAYWALL_MAX_TIMEOUT_SECONDS',
      Number(env.PORTICO_MAX_TIMEOUT_SECONDS ?? '60'),
      1,
      3_600
    ),
    allowedOrigins,
  };
}

function buildRequirement(config: PaywallConfig): PaymentRequired {
  const accepted: AcceptsEntry = {
    scheme: X402_SCHEME,
    network: config.network,
    amount: config.amount,
    asset: config.tokenContract,
    payTo: config.splitContract,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: { tool: config.tool },
  };
  const resource: ResourceInfo = {
    url: config.resourceUrl,
    description: config.description,
    mimeType: 'application/json',
  };
  return { x402Version: X402_VERSION, resource, accepts: [accepted] };
}

/**
 * The payload must pay this merchant's exact requirement. A client may shorten
 * the timeout, never the amount, asset, network or payee.
 */
function matchesRequirement(payload: PaymentPayload, requirement: PaymentRequired): boolean {
  const required = requirement.accepts[0];
  if (required === undefined) {
    return false;
  }
  return (
    payload.resource.url === requirement.resource.url &&
    payload.accepted.scheme === required.scheme &&
    payload.accepted.network === required.network &&
    payload.accepted.amount === required.amount &&
    payload.accepted.asset === required.asset &&
    payload.accepted.payTo === required.payTo &&
    payload.accepted.maxTimeoutSeconds >= 1 &&
    payload.accepted.maxTimeoutSeconds <= required.maxTimeoutSeconds
  );
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function failureStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 402;
}

function postPayment(
  fetchImpl: PaywallFetch,
  config: PaywallConfig,
  path: '/verify' | '/settle',
  signature: string
): Promise<Response> {
  return fetchImpl(`${config.facilitatorUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [PAYMENT_SIGNATURE_HEADER]: signature,
    },
    body: '{}',
  });
}

/** Build the express application. `fetch` is injectable for tests. */
export function createPaywallApp(
  config: PaywallConfig,
  dependencies: PaywallDependencies = {}
): { app: Express } {
  const fetchImpl = dependencies.fetch ?? defaultFetch;
  const requirement = buildRequirement(config);
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use((_req: Request, res: ExpressResponse, next: NextFunction) => {
    res.setHeader('Vary', 'Origin');
    next();
  });
  app.use(
    cors({
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', PAYMENT_SIGNATURE_HEADER],
      exposedHeaders: [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER],
      credentials: false,
      maxAge: 600,
      optionsSuccessStatus: 204,
    })
  );
  app.use(express.json({ limit: '16kb' }));

  function sendRequirement(res: ExpressResponse, error?: string): void {
    const body: PaymentRequired = error === undefined ? requirement : { ...requirement, error };
    res.setHeader(PAYMENT_REQUIRED_HEADER, encodeHeaderJson(body));
    res.status(402).json(body);
  }

  function sendFailure(
    res: ExpressResponse,
    status: number,
    body: Record<string, unknown> | null,
    paymentResponse: string | null
  ): void {
    if (paymentResponse !== null) {
      res.setHeader(PAYMENT_RESPONSE_HEADER, paymentResponse);
    }
    const payload: Record<string, unknown> =
      body === null
        ? { success: false, error: 'payment_failed', network: config.network }
        : { ...body };
    delete payload.resource;
    if (payload.success !== true) {
      payload.success = false;
    }
    res.status(status).json(payload);
  }

  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({
      status: 'ok',
      service: 'portico-paywall',
      nodeEnv: config.nodeEnv,
      network: config.network,
      facilitator: config.facilitatorUrl,
      resource: config.resourceUrl,
      amount: config.amount,
      tool: config.tool,
      tokenContract: config.tokenContract,
      splitContract: config.splitContract,
    });
  });

  const paid = async (req: Request, res: ExpressResponse): Promise<void> => {
    const signatureHeader = req.get(PAYMENT_SIGNATURE_HEADER);
    const signature = typeof signatureHeader === 'string' ? signatureHeader.trim() : '';
    if (signature.length === 0) {
      sendRequirement(res);
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = parsePaymentSignature(signature);
    } catch {
      res.status(400).json({
        error: 'invalid_payment_signature',
        code: 'INVALID_PAYMENT_SIGNATURE',
      });
      return;
    }
    if (!matchesRequirement(payload, requirement)) {
      sendRequirement(res, 'payment_requirement_mismatch');
      return;
    }

    let verifyResponse: Response;
    try {
      verifyResponse = await postPayment(fetchImpl, config, '/verify', signature);
    } catch (error) {
      process.stderr.write(`paywall verify call failed: ${messageOf(error)}\n`);
      res.status(502).json({
        error: 'facilitator_unavailable',
        code: 'FACILITATOR_UNAVAILABLE',
        network: config.network,
      });
      return;
    }
    const verifyBody = await readJson(verifyResponse);
    if (!verifyResponse.ok || verifyBody === null || verifyBody.success !== true) {
      sendFailure(
        res,
        failureStatus(verifyResponse.status),
        verifyBody,
        verifyResponse.headers.get(PAYMENT_RESPONSE_HEADER)
      );
      return;
    }

    let settleResponse: Response;
    try {
      settleResponse = await postPayment(fetchImpl, config, '/settle', signature);
    } catch (error) {
      process.stderr.write(`paywall settle call failed: ${messageOf(error)}\n`);
      res.status(502).json({
        error: 'facilitator_unavailable',
        code: 'FACILITATOR_UNAVAILABLE',
        network: config.network,
      });
      return;
    }
    const paymentResponseHeader = settleResponse.headers.get(PAYMENT_RESPONSE_HEADER);
    const settleBody = await readJson(settleResponse);
    if (settleBody === null) {
      sendFailure(res, 502, null, paymentResponseHeader);
      return;
    }

    let settlement: SettlementResponse;
    try {
      settlement = parseSettlementResponse(settleBody);
    } catch {
      sendFailure(
        res,
        502,
        {
          success: false,
          errorReason: 'invalid_facilitator_response',
          network: config.network,
        },
        paymentResponseHeader
      );
      return;
    }

    if (!settlement.success || settlement.settlement !== 'settled') {
      sendFailure(res, failureStatus(settleResponse.status), settleBody, paymentResponseHeader);
      return;
    }

    res.setHeader(PAYMENT_RESPONSE_HEADER, paymentResponseHeader ?? encodeHeaderJson(settlement));
    res.status(200).json({
      ok: true,
      paid: true,
      resource: {
        url: config.resourceUrl,
        description: config.description,
        mimeType: 'application/json',
      },
      settlement,
    });
  };

  app.get('/premium', paid);
  app.post('/premium', paid);

  app.use((_req: Request, res: ExpressResponse) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  app.use((error: Error, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    process.stderr.write(`paywall request failed: ${error.message}\n`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  return { app };
}

/** Start the paywall using environment configuration. */
export function start(): void {
  let config: PaywallConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof PaywallConfigError) {
      process.stderr.write(`paywall config error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { app } = createPaywallApp(config);
  const server = app.listen(config.port, config.host, () => {
    process.stdout.write(`portico paywall listening on http://${config.host}:${config.port}\n`);
    process.stdout.write(
      `resource ${config.resourceUrl}; facilitator ${config.facilitatorUrl}; ` +
        `network ${config.network}; amount ${config.amount}; tool ${config.tool}\n`
    );
  });

  const shutdown = (signal: string): void => {
    process.stdout.write(`paywall shutting down (${signal})\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  start();
}
