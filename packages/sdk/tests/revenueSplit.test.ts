import { describe, expect, it } from 'vitest';
import { RevenueSplitClient, decodeViewResult } from '../src/contracts/revenueSplit.js';
import { ClientConfigError, ContractViewError } from '../src/errors.js';

function byteArray(value: unknown): number[] {
  return Array.from(Buffer.from(JSON.stringify(value), 'utf8'));
}

describe('decodeViewResult', () => {
  it('decodes the RPC byte array into JSON', () => {
    expect(
      decodeViewResult('calculate_split', byteArray({ developer: '80', platform: '20' }))
    ).toEqual({ developer: '80', platform: '20' });
  });

  it('decodes a base64 string payload into JSON', () => {
    const encoded = Buffer.from(JSON.stringify({ tools_count: 1 }), 'utf8').toString('base64');
    expect(decodeViewResult('get_totals', encoded)).toEqual({ tools_count: 1 });
  });

  it('accepts a JSON null for Option views', () => {
    expect(decodeViewResult('get_tool_info', byteArray(null))).toBeNull();
  });

  it('throws ContractViewError on invalid JSON', () => {
    const bytes = Array.from(Buffer.from('not json', 'utf8'));
    expect(() => decodeViewResult('get_ledger', bytes)).toThrowError(ContractViewError);
    expect(() => decodeViewResult('get_ledger', bytes)).toThrowError(/invalid JSON/);
  });

  it('throws ContractViewError on an unexpected payload', () => {
    expect(() => decodeViewResult('get_ledger', 42)).toThrowError(/unexpected result payload/);
  });
});

describe('RevenueSplitClient configuration', () => {
  it('rejects an empty contract id without touching the network', () => {
    expect(() => new RevenueSplitClient({ contractId: '' })).toThrowError(ClientConfigError);
  });

  it('rejects an invalid RPC URL without touching the network', () => {
    expect(
      () => new RevenueSplitClient({ contractId: 'split.portico.testnet', rpcUrl: 'not a url' })
    ).toThrowError(ClientConfigError);
  });
});
