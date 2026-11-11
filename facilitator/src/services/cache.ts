/**
 * Duplicate-settlement cache.
 *
 * x402 v2 §10 is a RECOMMENDED (SHOULD) mitigation, implemented here as a
 * fail-closed guard: the first request for a payload hash wins, concurrent or
 * repeated submissions of the same signed delegate are rejected until the entry
 * is evicted at the delegate's `max_block_height` or the process TTL expires.
 */

import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';

export type SettlementState = 'pending' | 'settled' | 'failed';

export interface SettlementRecord {
  payloadHash: string;
  state: SettlementState;
  txHash: string | null;
  maxBlockHeight: number;
  errorReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BeginSettlementResult {
  record: SettlementRecord;
  duplicate: boolean;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export class SettlementCache {
  private readonly records: LRUCache<string, SettlementRecord>;

  public constructor(ttlMs: number, maxEntries = 10_000) {
    this.records = new LRUCache<string, SettlementRecord>({
      max: maxEntries,
      ttl: ttlMs,
      updateAgeOnGet: false,
    });
  }

  public static hashPayload(payload: unknown): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  public get size(): number {
    return this.records.size;
  }

  public get(hash: string): SettlementRecord | undefined {
    return this.records.get(hash);
  }

  /**
   * Claim a payload for settlement. Returns `duplicate: true` when the same
   * payload is already pending or settled; a previously failed payload may be
   * retried.
   */
  public begin(payload: unknown, maxBlockHeight: number): BeginSettlementResult {
    const payloadHash = SettlementCache.hashPayload(payload);
    const existing = this.records.get(payloadHash);
    if (existing && existing.state !== 'failed') {
      return { record: existing, duplicate: true };
    }
    const now = Date.now();
    const record: SettlementRecord = {
      payloadHash,
      state: 'pending',
      txHash: null,
      maxBlockHeight,
      errorReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(payloadHash, record);
    return { record, duplicate: false };
  }

  public markSettled(hash: string, txHash: string): boolean {
    return this.update(hash, record => ({
      ...record,
      state: 'settled',
      txHash,
      errorReason: null,
    }));
  }

  public markFailed(hash: string, reason: string): boolean {
    return this.update(hash, record => ({
      ...record,
      state: 'failed',
      errorReason: reason,
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
    this.records.purgeStale();
    return removed;
  }

  public list(): SettlementRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
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
