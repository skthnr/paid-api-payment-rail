/**
 * POST /verify — read-only delegate preflight.
 *
 * Runs the same gate as settlement but never writes the settlement cache and
 * never broadcasts an outer transaction. A successful response echoes the
 * verified payer and the pinned block so a caller can reconcile what was
 * checked.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DelegateGate, VerifiedPayment } from '../services/delegateGate.js';
import { PaymentHeaderError } from '../services/headers.js';
import type { VerificationResponse } from '../types.js';
import { readPaymentPayload } from './payment.js';

export interface VerifyRouterOptions {
  gate: DelegateGate;
  network: string;
}

export function verificationSuccess(
  payment: VerifiedPayment,
  network: string
): VerificationResponse {
  return {
    success: true,
    network,
    payer: payment.payer,
    publicKey: payment.publicKey,
    amount: payment.amount,
    asset: payment.asset,
    payTo: payment.payTo,
    payee: payment.payee,
    methodName: payment.methodName,
    tool: payment.tool,
    payloadHash: payment.payloadHash,
    nonce: payment.nonce,
    maxBlockHeight: payment.maxBlockHeight,
    blockHeight: payment.blockHeight,
    blockHash: payment.blockHash,
    timeoutBlocks: payment.timeoutBlocks,
  };
}

export function createVerifyRouter(options: VerifyRouterOptions): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await options.gate.verify(readPaymentPayload(req));
      if (!result.ok) {
        res.status(result.failure.httpStatus).json({
          success: false,
          errorReason: result.failure.errorReason,
          error: result.failure.message,
          network: options.network,
        });
        return;
      }
      res.status(200).json(verificationSuccess(result.payment, options.network));
    } catch (error) {
      if (error instanceof PaymentHeaderError) {
        res.status(error.httpStatus).json({
          success: false,
          errorReason:
            error.code === 'MISSING_PAYMENT_SIGNATURE'
              ? 'missing_payment_signature'
              : 'invalid_signature_encoding',
          error: error.message,
          network: options.network,
        });
        return;
      }
      next(error);
    }
  });

  return router;
}
