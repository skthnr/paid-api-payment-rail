/**
 * Request logging middleware.
 *
 * Derived from the origin Apache-2.0 facilitator middleware (see NOTICE);
 * adapted for the portico relayer (service name, request ids from node:crypto).
 */

import { randomUUID } from 'node:crypto';
import winston from 'winston';
import type { Request, Response, NextFunction } from 'express';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'portico-facilitator' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => {
          const { level, message, timestamp, ...meta } = info;
          const stamp = typeof timestamp === 'string' ? timestamp : '';
          const metaStr = Object.keys(meta).length > 1 ? ` ${JSON.stringify(meta, null, 0)}` : '';
          return `[${stamp}] ${level}: ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

if (process.env.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    })
  );
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const requestId = randomUUID();
  req.headers['x-request-id'] = requestId;

  logger.info('Incoming request', {
    requestId,
    method: req.method,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    ip: req.ip ?? req.socket.remoteAddress,
    userAgent: req.get('User-Agent'),
  });

  const originalSend = res.send.bind(res);
  res.send = function send(body: unknown) {
    logger.info('Request completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${Date.now() - startTime}ms`,
    });
    return originalSend(body);
  };

  next();
}

export function errorLogger(err: Error, req: Request, _res: Response, next: NextFunction): void {
  logger.error('Request error', {
    requestId: req.headers['x-request-id'],
    method: req.method,
    path: req.path,
    error: err.message,
    stack: err.stack,
  });
  next(err);
}
