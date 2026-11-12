/**
 * Duplicate-settlement cache.
 *
 * x402 v2 §10 is a RECOMMENDED (SHOULD) mitigation, implemented here as a
 * fail-closed guard: the first request for a payload hash wins, concurrent or
 * repeated submissions of the same signed delegate are rejected until the entry
 * is evicted at the delegate's `max_block_height` or the process TTL expires.
 *
 * Entries move to a short-lived history once the inner transfer receipt is
 * final. The live map is the duplicate lock; the history map backs
 * `GET /payments` without keeping a settled payload in the lock forever.
 */

import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';

export type SettlementState = 'pending' | 'settled' | 'failed';

export interface SettlementMetadata {
  payer?: string | null;
  amount?: string | null;
  methodName?: string | null;
  tool?: string | null;
}

export interface SettlementRecord {
  payloadHash: string;
  state: SettlementState;
  txHash: string | null;
  maxBlockHeight: number;
  payer: string | null;
  amount: string | null;
  methodName: string | null;
  tool: string | null;
  /** A failed record may be retried only when this is true. */
  retryable: boolean;
  errorReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BeginSettlementResult {
  record: SettlementRecord;
  duplicate: boolean;
}

export class SettlementCache {
  private readonly records: LRUCache<string, SettlementRecord>;
  private readonly history: LRUCache<string, SettlementRecord>;

  public constructor(ttlMs: number, maxEntries = 10_000) {
    const options = { max: maxEntries, ttl: ttlMs, updateAgeOnGet: false } as const;
    this.records = new LRUCache<string, SettlementRecord>(options);
    this.history = new LRUCache<string, SettlementRecord>(options);
  }

  /** Hash raw bytes without re-encoding them first. */
  public static hashBytes(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  public get size(): number {
    return this.records.size + this.history.size;
  }

  public get(hash: string): SettlementRecord | undefined {
    return this.records.get(hash) ?? this.history.get(hash);
  }

  /** Claim a payload by its precomputed hash (the signed-delegate digest). */
  public beginSettlement(
    payloadHash: string,
    maxBlockHeight: number,
    metadata: SettlementMetadata = {}
  ): BeginSettlementResult {
    const existing = this.records.get(payloadHash) ?? this.history.get(payloadHash);
    if (existing && (existing.state !== 'failed' || !existing.retryable)) {
      return { record: existing, duplicate: true };
    }
    const now = Date.now();
    const record: SettlementRecord = {
      payloadHash,
      state: 'pending',
      txHash: null,
      maxBlockHeight,
      payer: metadata.payer ?? null,
      amount: metadata.amount ?? null,
      methodName: metadata.methodName ?? null,
      tool: metadata.tool ?? null,
      errorReason: null,
      retryable: false,
      createdAt: now,
      updatedAt: now,
    };
    this.history.delete(payloadHash);
    this.records.set(payloadHash, record);
    return { record, duplicate: false };
  }

  /** Record the broadcast hash before/while the outer transaction is submitted. */
  public attachTransaction(hash: string, txHash: string): boolean {
    return this.update(hash, record => ({ ...record, txHash }));
  }

  /**
   * Mark a payload settled and release the duplicate lock: once the inner
   * receipt is final the delegate nonce can never land again. The record moves
   * to the history map for `GET /payments`.
   */
  public markSettled(hash: string, txHash: string): boolean {
    const record = this.records.get(hash);
    if (!record) {
      return false;
    }
    const settled: SettlementRecord = {
      ...record,
      state: 'settled',
      txHash,
      errorReason: null,
      retryable: false,
      updatedAt: Date.now(),
    };
    this.records.delete(hash);
    this.history.set(hash, settled);
    return true;
  }

  public markFailed(hash: string, reason: string, retryable = true): boolean {
    return this.update(hash, record => ({
      ...record,
      state: 'failed',
      errorReason: reason,
      retryable,
    }));
  }

  /**
   * Evict entries whose delegate can no longer land: `max_block_height` has
   * passed, so the protocol rejects the inner transaction anyway.
   */
  public evictExpired(blockHeight: number): number {
    let removed = 0;
    for (const [hash, record] of this.records.entries()) {
      if (record.maxBlockHeight <= blockHeight) {
        this.records.delete(hash);
        removed += 1;
      }
    }
    for (const [hash, record] of this.history.entries()) {
      if (record.maxBlockHeight <= blockHeight) {
        this.history.delete(hash);
        removed += 1;
      }
    }
    this.records.purgeStale();
    this.history.purgeStale();
    return removed;
  }

  public list(): SettlementRecord[] {
    return [...this.records.values(), ...this.history.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
  }

  public findByTxHash(txHash: string): SettlementRecord | undefined {
    return this.list().find(record => record.txHash === txHash);
  }

  private update(
    hash: string,
    change: (record: SettlementRecord) => SettlementRecord
  ): boolean {
    const record = this.records.get(hash);
    if (!record) {
      return false;
    }
    this.records.set(hash, { ...change(record), updatedAt: Date.now() });
    return true;
  }
}
