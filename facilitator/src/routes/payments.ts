/**
 * GET /payments and GET /payments/:txHash.
 *
 * The list comes from the settlement cache (live lock + short-lived history).
 * A hash that is no longer cached is resolved with `tx_status FINAL`, still
 * requiring the inner FT receipt to be `SuccessValue`. The outer transaction's
 * signer is the relayer, never the payer: for an uncached hash the response
 * reports the delegate action's `sender_id` only when the transaction shape
 * exposes it safely, and otherwise omits `payer` entirely.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { isAccountId } from '../config.js';
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

/**
 * Reads the NEP-366 delegate sender from one `SignedDelegate` action.
 *
 * RPC clients serialize the action as `signedDelegate.delegateAction`,
 * `signedDelegateAction` or the snake_case equivalents; every access is
 * shape-guarded so an unexpected encoding yields `null` instead of a guess.
 */
function delegateSender(action: Record<string, unknown>): string | null {
  const directSender = action.senderId ?? action.sender_id;
  if (typeof directSender === 'string') {
    return directSender;
  }
  const directDelegate = action.delegateAction ?? action.delegate_action;
  if (isRecord(directDelegate)) {
    const senderId = directDelegate.senderId ?? directDelegate.sender_id;
    if (typeof senderId === 'string') {
      return senderId;
    }
  }
  const candidates = [
    action.signedDelegate,
    action.signed_delegate,
    action.signedDelegateAction,
    action.signed_delegate_action,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const nested = candidate.delegateAction ?? candidate.delegate_action;
    if (isRecord(nested)) {
      const senderId = nested.senderId ?? nested.sender_id;
      if (typeof senderId === 'string') {
        return senderId;
      }
      continue;
    }
    const direct = candidate.senderId ?? candidate.sender_id;
    if (typeof direct === 'string') {
      return direct;
    }
  }
  return null;
}

/**
 * Payer of a relayed settlement, or `null` when it cannot be read safely.
 *
 * The outer transaction signer is the relayer and is never returned as the
 * payer; a delegate whose sender equals the relayer is also rejected by the
 * gate, and this helper keeps that invariant for old/foreign transactions.
 */
function delegatedPayer(response: TransactionResponse, relayerId: string): string | null {
  const transaction: unknown = response.transaction;
  if (!isRecord(transaction)) {
    return null;
  }
  const actions: unknown = transaction.actions;
  if (!Array.isArray(actions)) {
    return null;
  }
  for (const entry of actions) {
    if (!isRecord(entry)) {
      continue;
    }
    const kind = typeof entry.action === 'string' ? entry.action.toLowerCase() : '';
    if (kind !== 'signeddelegate' && kind !== 'signed_delegate') {
      continue;
    }
    const senderId = delegateSender(entry);
    if (senderId !== null && isAccountId(senderId) && senderId !== relayerId) {
      return senderId;
    }
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
      const payer = delegatedPayer(final, options.relayerId);
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
