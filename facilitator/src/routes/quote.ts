/**
 * Quote route — POST /quote and GET /quote/pricing.
 *
 * A paid resource answers an unpaid request with HTTP 402 and a base64
 * `PAYMENT-REQUIRED` header carrying a v2 `PaymentRequired` object. The
 * requirement lives in `accepts[0]`; `resource.url` identifies the quoted
 * resource and `extra` carries the split parameters for observability.
 */

import { Router, type Request, type Response } from 'express';
import {
  MAX_QUOTE_QUANTITY,
  MAX_SERVICE_NAME_LENGTH,
  MAX_TIMEOUT_SECONDS,
  PAYMENT_REQUIRED_HEADER,
  PRICE_DECIMALS,
  RAW_PER_PRICE_UNIT,
  TOKEN_DECIMALS,
  X402_SCHEME,
  X402_VERSION,
} from '../constants.js';
import type {
  ErrorResponse,
  PaymentRequired,
  QuoteRequest,
} from '../types.js';

/** Service pricing in display units with PRICE_DECIMALS precision. */
export const SERVICE_PRICING: Readonly<Record<string, string>> = Object.freeze({
  'gpt-4': '0.001',
  'gpt-4-turbo': '0.0008',
  'gpt-3.5-turbo': '0.0002',
  'claude-3-opus': '0.0015',
  'claude-3-sonnet': '0.0008',
  'claude-3-haiku': '0.0002',
  'gemini-pro': '0.0005',
  'llama-3': '0.0003',
  'dall-e-3': '0.004',
  'dall-e-2': '0.002',
  'stable-diffusion': '0.001',
  midjourney: '0.005',
  'code-interpreter': '0.0005',
  'web-search': '0.0001',
  'file-analysis': '0.0003',
  default: '0.0001',
});

export interface QuoteRouterOptions {
  facilitatorUrl: string;
  tokenContract: string;
  splitContract: string;
  network: string;
  maxTimeoutSeconds: number;
  feeBps: number;
}

const U128_MAX = (1n << 128n) - 1n;

function decimalToPriceUnits(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`invalid price: ${value}`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(PRICE_DECIMALS, '0').slice(0, PRICE_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(PRICE_DECIMALS) + BigInt(fraction === '' ? '0' : fraction);
}

/**
 * Convert a display price to raw 18-decimal FT units. Kept integer-only so a
 * quote never drifts by a floating-point ulp.
 */
export function priceToRawAmount(price: string, multiplier = 1n): string {
  const raw = decimalToPriceUnits(price) * multiplier * RAW_PER_PRICE_UNIT;
  if (raw <= 0n || raw > U128_MAX) {
    throw new Error('quoted amount is outside the u128 range');
  }
  return raw.toString();
}

function multiplierFor(params: Record<string, unknown>): bigint {
  let multiplier = 1n;

  if (typeof params.maxTokens === 'number' && Number.isFinite(params.maxTokens)) {
    if (params.maxTokens > 1_000_000) {
      throw new Error('params.maxTokens exceeds the quote limit');
    }
    if (params.maxTokens > 1000) {
      multiplier *= BigInt(Math.ceil(params.maxTokens / 1000));
    }
  }

  if (typeof params.size === 'string') {
    if (params.size === '1024x1024') {
      multiplier *= 2n;
    } else if (params.size === '1792x1024' || params.size === '1024x1792') {
      multiplier *= 3n;
    }
  }

  if (typeof params.quantity === 'number' && Number.isFinite(params.quantity)) {
    if (!Number.isInteger(params.quantity) || params.quantity < 1) {
      throw new Error('params.quantity must be a positive integer');
    }
    if (params.quantity > MAX_QUOTE_QUANTITY) {
      throw new Error('params.quantity exceeds the quote limit');
    }
    if (params.quantity > 1) {
      multiplier *= BigInt(params.quantity);
    }
  }

  return multiplier;
}

export function encodePaymentRequired(requirement: PaymentRequired): string {
  return Buffer.from(JSON.stringify(requirement), 'utf8').toString('base64');
}

function badRequest(res: Response, message: string, code: string): Response {
  return res.status(400).json({ error: message, code } satisfies ErrorResponse);
}

export function createQuoteRouter(options: QuoteRouterOptions): Router {
  const router = Router();

  router.post('/', (req: Request, res: Response) => {
    const body = req.body as Partial<QuoteRequest> | undefined;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(res, 'Request body must be a JSON object', 'INVALID_BODY');
    }
    if (typeof body.service !== 'string' || body.service.length === 0) {
      return badRequest(res, 'Missing required field: service', 'MISSING_SERVICE');
    }
    if (body.service.length > MAX_SERVICE_NAME_LENGTH) {
      return badRequest(res, 'service is too long', 'INVALID_SERVICE');
    }
    const params = body.params ?? {};
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return badRequest(res, 'params must be a JSON object', 'INVALID_PARAMS');
    }

    const service = body.service.toLowerCase();
    const price = SERVICE_PRICING[service] ?? SERVICE_PRICING.default ?? '0.0001';

    let amount: string;
    try {
      amount = priceToRawAmount(price, multiplierFor(params as Record<string, unknown>));
    } catch (error) {
      return badRequest(res, (error as Error).message, 'INVALID_QUOTE_PARAMS');
    }

    const maxTimeoutSeconds = Math.min(options.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    const requirement: PaymentRequired = {
      x402Version: X402_VERSION,
      resource: {
        url: `${options.facilitatorUrl}/quote/${encodeURIComponent(service)}`,
        description: `${service} API call`,
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: X402_SCHEME,
          network: options.network,
          amount,
          asset: options.tokenContract,
          payTo: options.splitContract,
          maxTimeoutSeconds,
          extra: {
            service,
            feeBps: options.feeBps,
            priceDecimals: PRICE_DECIMALS,
            tokenDecimals: TOKEN_DECIMALS,
          },
        },
      ],
    };

    res.setHeader(PAYMENT_REQUIRED_HEADER, encodePaymentRequired(requirement));
    return res.status(402).json(requirement);
  });

  router.get('/pricing', (_req: Request, res: Response) => {
    res.json({
      pricing: SERVICE_PRICING,
      defaultToken: options.tokenContract,
      defaultNetwork: options.network,
      splitContract: options.splitContract,
      maxTimeoutSeconds: options.maxTimeoutSeconds,
      priceDecimals: PRICE_DECIMALS,
      tokenDecimals: TOKEN_DECIMALS,
      feeBps: options.feeBps,
    });
  });

  return router;
}
