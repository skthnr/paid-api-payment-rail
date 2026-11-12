/**
 * Facilitator HTTP server.
 *
 * x402 v2 surface: quote/pricing, read-only /verify, /settle with a
 * `PAYMENT-RESPONSE`, ledger-backed /payments views, /supported with required
 * signers, and /health. The chain client is constructed once and its FT
 * decimals are asserted at boot; a mismatch stops the process.
 */

import { pathToFileURL } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ConfigError, loadConfig, type FacilitatorConfig } from './config.js';
import {
  ALLOWED_PAYMENT_HEADERS,
  EXPOSED_PAYMENT_HEADERS,
  X402_SCHEME,
  X402_VERSION,
} from './constants.js';
import { errorLogger, logger, requestLogger } from './middleware/logger.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { createPaymentsRouter } from './routes/payments.js';
import { createQuoteRouter } from './routes/quote.js';
import { createSettleRouter } from './routes/settle.js';
import { createVerifyRouter } from './routes/verify.js';
import { SettlementCache } from './services/cache.js';
import { DelegateGate } from './services/delegateGate.js';
import { NearClient, describeError } from './services/near.js';
import type { ErrorResponse, HealthResponse, SupportedResponse } from './types.js';

const VERSION = '0.1.0';

export interface AppDependencies {
  near?: NearClient;
}

export interface PorticoApp {
  app: Express;
  cache: SettlementCache;
  near: NearClient;
  gate: DelegateGate;
}

export function createApp(
  config: FacilitatorConfig,
  dependencies: AppDependencies = {}
): PorticoApp {
  const app = express();
  const cache = new SettlementCache(config.settlementCacheTtlMs);
  const near = dependencies.near ?? new NearClient(config);
  const gate = new DelegateGate(near, config);

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(
    cors({
      origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: [...ALLOWED_PAYMENT_HEADERS],
      exposedHeaders: [...EXPOSED_PAYMENT_HEADERS],
      credentials: false,
      maxAge: 600,
      optionsSuccessStatus: 204,
    })
  );
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Vary', 'Origin');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use(requestLogger);
  app.use(
    createRateLimiter({
      windowMs: config.rateLimitWindowMs,
      maxRequests: config.rateLimitMax,
    })
  );

  app.get('/health', (_req: Request, res: Response) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'portico-facilitator',
      version: VERSION,
      network: config.network,
      uptimeSeconds: Math.floor(process.uptime()),
      paymentsProcessed: cache.size,
      timestamp: Date.now(),
    };
    res.json(body);
  });

  app.get('/supported', (_req: Request, res: Response) => {
    const body: SupportedResponse = {
      kinds: [{ x402Version: X402_VERSION, scheme: X402_SCHEME, network: config.network }],
      extensions: [],
      signers: { 'near:*': [config.relayerId] },
    };
    res.json(body);
  });

  app.use(
    '/quote',
    createQuoteRouter({
      facilitatorUrl: config.facilitatorUrl,
      tokenContract: config.tokenContract,
      splitContract: config.splitContract,
      network: config.network,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      feeBps: config.feeBps,
    })
  );
  app.use('/verify', createVerifyRouter({ gate, network: config.network }));
  app.use('/settle', createSettleRouter({ gate, chain: near, cache, config }));
  app.use(
    '/payments',
    createPaymentsRouter({
      chain: near,
      cache,
      network: config.network,
      relayerId: config.relayerId,
      tokenContract: config.tokenContract,
    })
  );

  app.use((_req: Request, res: Response) => {
    const body: ErrorResponse = { error: 'Not found', code: 'NOT_FOUND' };
    res.status(404).json(body);
  });

  app.use(errorLogger);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const body: ErrorResponse = { error: 'Internal server error', code: 'INTERNAL_ERROR' };
    if (!res.headersSent) {
      res.status(500).json(body);
    }
    logger.error('Unhandled request error', { error: err.message });
  });

  return { app, cache, near, gate };
}

export async function start(): Promise<void> {
  let config: FacilitatorConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error('Invalid configuration', { error: error.message });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const near = new NearClient(config);
  try {
    await near.assertTokenDecimals();
  } catch (error) {
    logger.error('FT metadata check failed; refusing to start', {
      error: describeError(error),
      tokenContract: config.tokenContract,
      expectedDecimals: config.expectedDecimals,
    });
    process.exitCode = 1;
    return;
  }

  const { app } = createApp(config, { near });
  const server = app.listen(config.port, config.host, () => {
    logger.info('portico facilitator listening', {
      host: config.host,
      port: config.port,
      network: config.network,
      splitContract: config.splitContract,
      tokenContract: config.tokenContract,
      relayerId: config.relayerId,
      feeBps: config.feeBps,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('Shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void start();
}
