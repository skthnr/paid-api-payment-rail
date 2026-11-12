/**
 * GET /payments and GET /payments/:txHash.
 *
 * The list comes from the settlement cache (live lock + short-lived history).
 * A hash that is no longer cached is resolved with `tx_status FINAL`, still
 * requiring the inner FT receipt to be `SuccessValue`.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { SettlementCache, SettlementRecord } from '../services/cache.js';
import { isRecord } from '../guards.js';
import type { TransactionResponse } from '../services/near.js';
import { inspectInnerTransfer } from '../services/receipts.js';
import type { PaymentRecordView, PaymentsListResponse, SettlementResponse } from '../types.js';
import type { SettlementChain } from './settle.js';

const TX_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export interface PaymentsRouterOptions {
  chain: SettlementChain;
  cache: SettlementCache;
  network: string;
  relayerId: string;
  tokenContract: string;
}

function toRecordView(record: SettlementRecord): PaymentRecordView {
  return {
    payloadHash: record.payloadHash,
    state: record.state,
    txHash: record.txHash,
    maxBlockHeight: record.maxBlockHeight,
    payer: record.payer,
    amount: record.amount,
    methodName: record.methodName,
    tool: record.tool,
    errorReason: record.errorReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function responseSigner(response: TransactionResponse): string | null {
  const transaction: unknown = response.transaction;
  if (isRecord(transaction) && typeof transaction.signer_id === 'string') {
    return transaction.signer_id;
  }
  return null;
}

function isUnknownTransaction(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /UNKNOWN_TRANSACTION|UnknownTransaction|does not exist|not found/i.test(text);
}

export function createPaymentsRouter(options: PaymentsRouterOptions): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const rawLimit = req.query.limit;
    let limit = 50;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
        res.status(400).json({ error: 'limit must be an integer', code: 'INVALID_LIMIT' });
        return;
      }
      limit = Math.min(Math.max(Number(rawLimit), 1), 200);
    }
    const payments = options.cache.list().slice(0, limit).map(toRecordView);
    const body: PaymentsListResponse = {
      payments,
      count: payments.length,
      network: options.network,
    };
    res.json(body);
  });

  router.get('/:txHash', async (req: Request, res: Response, next: NextFunction) => {
    const txHash = req.params.txHash ?? '';
    if (!TX_HASH_PATTERN.test(txHash)) {
      res.status(400).json({ error: 'Invalid transaction hash', code: 'INVALID_TX_HASH' });
      return;
    }
    const cached = options.cache.findByTxHash(txHash);
    if (cached !== undefined) {
      res.json({
        ...toRecordView(cached),
        network: options.network,
        success: cached.state === 'settled',
      });
      return;
    }

    try {
      const final = await options.chain.txStatus(txHash, options.relayerId, 'FINAL');
      const inner = inspectInnerTransfer(final, options.tokenContract);
      const settlement: SettlementResponse = {
        success: inner.ok,
        transaction: txHash,
        network: options.network,
      };
      if (inner.ok) {
        settlement.settlement = 'settled';
      } else {
        settlement.errorReason = inner.errorReason ?? 'settlement_failed';
      }
      const payer = responseSigner(final);
      if (payer !== null) {
        settlement.payer = payer;
      }
      res.json(settlement);
    } catch (error) {
      if (isUnknownTransaction(error)) {
        res.status(404).json({ error: 'Payment not found', code: 'NOT_FOUND' });
        return;
      }
      next(error);
    }
  });

  return router;
}
