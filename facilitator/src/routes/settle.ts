/**
 * POST /settle — gate, claim the duplicate lock, relay, then verify FINAL.
 *
 * Success is reported only when the inner `ft_transfer(_call)` receipt is
 * `SuccessValue`. If the broadcast or the status lookup times out after the
 * outer transaction hash is known, the response is non-terminal
 * (`settlement_pending`) with that hash so the caller reconciles instead of
 * paying twice.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { SignedDelegate, TxExecutionStatus } from 'near-api-js';
import { PAYMENT_RESPONSE_HEADER } from '../constants.js';
import type { FacilitatorConfig } from '../config.js';
import { SettlementCache } from '../services/cache.js';
import type { DelegateGate } from '../services/delegateGate.js';
import {
  decodeCanonicalBase64,
  encodeHeaderJson,
  PaymentHeaderError,
} from '../services/headers.js';
import { isRecord } from '@portico/sdk';
import {
  isNonceError,
  isTimeoutError,
  type NearReader,
  type RelayResult,
  type TransactionResponse,
} from '../services/near.js';
import { inspectInnerTransfer } from '../services/receipts.js';
import type { SettlementResponse } from '../types.js';
import { readPaymentPayload } from './payment.js';

export interface SettlementChain extends NearReader {
  relay(signedDelegate: SignedDelegate, onSigned?: (txHash: string) => void): Promise<RelayResult>;
  txStatus(
    txHash: string,
    sender: string,
    waitUntil?: TxExecutionStatus
  ): Promise<TransactionResponse>;
}

export interface SettleRouterOptions {
  gate: DelegateGate;
  chain: SettlementChain;
  cache: SettlementCache;
  config: FacilitatorConfig;
}

function payloadHashOf(payload: unknown): string | null {
  if (
    !isRecord(payload) ||
    !isRecord(payload.payload) ||
    typeof payload.payload.signedDelegateAction !== 'string'
  ) {
    return null;
  }
  try {
    return SettlementCache.hashBytes(
      decodeCanonicalBase64(payload.payload.signedDelegateAction, 'payload.signedDelegateAction')
    );
  } catch {
    return null;
  }
}

function sendSettlement(res: Response, status: number, body: SettlementResponse): void {
  res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeaderJson(body));
  res.status(status).json(body);
}

function isUnknownTransactionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /UNKNOWN_TRANSACTION|UnknownTransaction|does not exist|not found/i.test(text);
}

export function createSettleRouter(options: SettleRouterOptions): Router {
  const router = Router();
  const { network, relayerId, tokenContract } = options.config;

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    let payload: unknown;
    try {
      payload = readPaymentPayload(req);
    } catch (error) {
      if (error instanceof PaymentHeaderError) {
        sendSettlement(res, error.httpStatus, {
          success: false,
          errorReason:
            error.code === 'MISSING_PAYMENT_SIGNATURE'
              ? 'missing_payment_signature'
              : 'invalid_signature_encoding',
          network,
        });
        return;
      }
      next(error);
      return;
    }

    try {
      const result = await options.gate.verify(payload);
      if (!result.ok) {
        if (result.failure.errorReason === 'nonce_reused') {
          const hash = payloadHashOf(payload);
          const known = hash === null ? undefined : options.cache.get(hash);
          if (known?.state === 'settled' && known.txHash !== null) {
            sendSettlement(res, 200, {
              success: true,
              payer: known.payer ?? undefined,
              transaction: known.txHash,
              network,
              settlement: 'settled',
            });
            return;
          }
          if (known !== undefined) {
            sendSettlement(res, 202, {
              success: false,
              errorReason: known.errorReason ?? 'delegate_action_invalid_nonce',
              payer: known.payer ?? undefined,
              transaction: known.txHash ?? undefined,
              network,
              settlement: 'pending',
            });
            return;
          }
        }
        sendSettlement(res, result.failure.httpStatus, {
          success: false,
          errorReason: result.failure.errorReason,
          network,
        });
        return;
      }
      const payment = result.payment;
      options.cache.evictExpired(payment.blockHeight);
      const claim = options.cache.beginSettlement(payment.payloadHash, payment.maxBlockHeight, {
        payer: payment.payer,
        amount: payment.amount,
        methodName: payment.methodName,
        tool: payment.tool,
      });
      if (claim.duplicate) {
        if (claim.record.state === 'settled' && claim.record.txHash !== null) {
          sendSettlement(res, 200, {
            success: true,
            payer: claim.record.payer ?? undefined,
            transaction: claim.record.txHash,
            network,
            settlement: 'settled',
          });
          return;
        }
        if (claim.record.state === 'failed') {
          sendSettlement(res, 200, {
            success: false,
            errorReason: claim.record.errorReason ?? 'settlement_failed',
            payer: claim.record.payer ?? undefined,
            transaction: claim.record.txHash ?? undefined,
            network,
          });
          return;
        }
        const settlement: SettlementResponse = {
          success: false,
          errorReason: 'duplicate_settlement',
          network,
          settlement: 'pending',
        };
        if (claim.record.txHash !== null) {
          settlement.transaction = claim.record.txHash;
        }
        sendSettlement(res, 409, settlement);
        return;
      }

      let relay: RelayResult;
      try {
        relay = await options.chain.relay(payment.signedDelegate, txHash => {
          options.cache.attachTransaction(payment.payloadHash, txHash);
        });
      } catch {
        options.cache.markFailed(payment.payloadHash, 'relay_failed');
        sendSettlement(res, 502, {
          success: false,
          errorReason: 'relay_failed',
          payer: payment.payer,
          network,
        });
        return;
      }

      let final: TransactionResponse | null = null;
      let lookupError: unknown = null;
      try {
        final = await options.chain.txStatus(relay.txHash, relayerId, 'FINAL');
      } catch (error) {
        lookupError = error;
      }
      if (final === null && relay.response !== null) {
        if (relay.response.final_execution_status === 'FINAL') {
          final = relay.response;
        }
      }

      if (final === null) {
        if (relay.error !== undefined && isNonceError(relay.error)) {
          const known = options.cache.get(payment.payloadHash);
          if (known?.state === 'settled' && known.txHash !== null) {
            sendSettlement(res, 200, {
              success: true,
              payer: known.payer ?? undefined,
              transaction: known.txHash,
              network,
              settlement: 'settled',
            });
            return;
          }
          sendSettlement(res, 202, {
            success: false,
            errorReason: 'delegate_action_invalid_nonce',
            payer: payment.payer,
            transaction: known?.txHash ?? relay.txHash,
            network,
            settlement: 'pending',
          });
          return;
        }
        if (
          isTimeoutError(relay.error) ||
          isTimeoutError(lookupError) ||
          isUnknownTransactionError(lookupError)
        ) {
          sendSettlement(res, 202, {
            success: false,
            errorReason: 'settlement_pending',
            transaction: relay.txHash,
            network,
            settlement: 'pending',
          });
          return;
        }
        options.cache.markFailed(payment.payloadHash, 'settlement_failed');
        sendSettlement(res, 502, {
          success: false,
          errorReason: 'settlement_failed',
          payer: payment.payer,
          transaction: relay.txHash,
          network,
        });
        return;
      }

      if (final.final_execution_status !== 'FINAL') {
        sendSettlement(res, 202, {
          success: false,
          errorReason: 'settlement_pending',
          transaction: relay.txHash,
          network,
          settlement: 'pending',
        });
        return;
      }

      const inner = inspectInnerTransfer(final, tokenContract);
      if (!inner.ok) {
        const reason = inner.errorReason ?? 'settlement_failed';
        options.cache.markFailed(payment.payloadHash, reason, false);
        sendSettlement(res, 200, {
          success: false,
          errorReason: reason,
          payer: payment.payer,
          transaction: relay.txHash,
          network,
        });
        return;
      }

      options.cache.markSettled(payment.payloadHash, relay.txHash);
      sendSettlement(res, 200, {
        success: true,
        payer: payment.payer,
        transaction: relay.txHash,
        network,
        settlement: 'settled',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
