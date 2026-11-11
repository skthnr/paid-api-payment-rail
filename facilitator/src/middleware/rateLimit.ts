/**
 * Rate limiting middleware.
 *
 * Derived from the origin Apache-2.0 facilitator middleware (see NOTICE); the
 * limits are configured by the portico environment instead of hardcoded envs.
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { logger } from './logger.js';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 100,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
};

export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  return rateLimit({
    windowMs: finalConfig.windowMs,
    max: finalConfig.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: finalConfig.skipSuccessfulRequests,
    skipFailedRequests: finalConfig.skipFailedRequests,
    keyGenerator: (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown',
    handler: (req: Request, res: Response) => {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        path: req.path,
        method: req.method,
      });
      res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil(finalConfig.windowMs / 1000),
        message: `Rate limit exceeded. Please retry after ${Math.ceil(finalConfig.windowMs / 1000)} seconds.`,
      });
    },
    skip: (req: Request): boolean => req.path === '/health',
  });
}

export function createSettlementRateLimiter() {
  return createRateLimiter({ windowMs: 60 * 1000, maxRequests: 20 });
}

export function createVerificationRateLimiter() {
  return createRateLimiter({ windowMs: 60 * 1000, maxRequests: 200 });
}

export function createQuoteRateLimiter() {
  return createRateLimiter({ windowMs: 60 * 1000, maxRequests: 500 });
}
