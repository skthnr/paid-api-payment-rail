/**
 * Inner-receipt verification for NEP-366 settlement.
 *
 * The outer transaction can succeed while the delegated FT call fails or is
 * refunded. `ft_transfer` reports `SuccessValue` directly; `ft_transfer_call`
 * reports `SuccessReceiptId` pointing at the FT's `ft_resolve_transfer`
 * receipt, whose `SuccessValue` is the used (non-refunded) amount. Settlement
 * succeeds only when that chain ends in a positive used amount.
 */

import type { FinalExecutionOutcome } from 'near-api-js';

export interface InnerReceiptResult {
  ok: boolean;
  used?: string;
  errorReason?: string;
  receiptId?: string;
}

interface ReceiptEntry {
  id: string;
  outcome: FinalExecutionOutcome['receipts_outcome'][number]['outcome'];
}

function statusRecord(status: unknown): Record<string, unknown> | null {
  return status !== null && typeof status === 'object' ? (status as Record<string, unknown>) : null;
}

function successValueText(status: unknown): string | null {
  const record = statusRecord(status);
  if (record === null || !('SuccessValue' in record)) {
    return null;
  }
  const raw = record.SuccessValue;
  return typeof raw === 'string' ? Buffer.from(raw, 'base64').toString('utf8') : '';
}

function usedAmount(text: string): bigint | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string' && /^\d+$/.test(parsed)) {
      return BigInt(parsed);
    }
    if (typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0) {
      return BigInt(parsed);
    }
  } catch {
    return null;
  }
  return null;
}

export function inspectInnerTransfer(
  response: FinalExecutionOutcome,
  tokenContract: string
): InnerReceiptResult {
  const byId = new Map<string, ReceiptEntry>(
    response.receipts_outcome.map(entry => [entry.id, entry])
  );
  const tokenOutcomes = response.receipts_outcome.filter(
    entry => entry.outcome.executor_id === tokenContract
  );
  if (tokenOutcomes.length === 0) {
    return { ok: false, errorReason: 'inner_receipt_missing' };
  }

  for (const entry of tokenOutcomes) {
    let current: ReceiptEntry | undefined = entry;
    for (let hops = 0; hops < 4 && current !== undefined; hops += 1) {
      const status = current.outcome.status;
      const record = statusRecord(status);
      if (record !== null && 'Failure' in record) {
        return {
          ok: false,
          errorReason: 'inner_receipt_failed',
          receiptId: current.id,
        };
      }
      const text = successValueText(status);
      if (text !== null) {
        if (text.length === 0) {
          // `ft_transfer` has no return value; the transfer itself settled.
          return { ok: true, receiptId: current.id };
        }
        const used = usedAmount(text);
        if (used === null) {
          return {
            ok: false,
            errorReason: 'inner_receipt_invalid',
            receiptId: current.id,
          };
        }
        if (used <= 0n) {
          return {
            ok: false,
            errorReason: 'payment_refunded',
            receiptId: current.id,
          };
        }
        return { ok: true, used: used.toString(), receiptId: current.id };
      }
      const nextId =
        record !== null && typeof record.SuccessReceiptId === 'string'
          ? record.SuccessReceiptId
          : null;
      if (nextId === null) {
        return {
          ok: false,
          errorReason: 'inner_receipt_pending',
          receiptId: current.id,
        };
      }
      current = byId.get(nextId);
    }
  }
  return { ok: false, errorReason: 'inner_receipt_pending' };
}
