import { describe, expect, it } from 'vitest';
import type { JsonRpcProvider } from 'near-api-js';
import { RevenueSplitClient } from '../src/contracts/revenueSplit.js';
import { ClientConfigError, ContractViewError } from '../src/errors.js';

describe('RevenueSplitClient views', () => {
  it('calls the provider at finality final and returns an Option null', async () => {
    const calls: unknown[] = [];
    const provider = {
      callFunction: async (params: unknown) => {
        calls.push(params);
        return null;
      },
    } as unknown as JsonRpcProvider;
    const client = new RevenueSplitClient({
      contractId: 'split.portico.testnet',
      provider,
    });

    await expect(client.get_tool_info('web-search')).resolves.toBeNull();
    expect(calls).toEqual([
      {
        contractId: 'split.portico.testnet',
        method: 'get_tool_info',
        args: { name: 'web-search' },
        blockQuery: { finality: 'final' },
      },
    ]);
  });

  it('wraps provider failures in ContractViewError', async () => {
    const provider = {
      callFunction: async () => {
        throw new Error('rpc down');
      },
    } as unknown as JsonRpcProvider;
    const client = new RevenueSplitClient({
      contractId: 'split.portico.testnet',
      provider,
    });

    await expect(client.get_totals()).rejects.toThrowError(ContractViewError);
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
