/**
 * Shared read-only NEAR helpers for the repo scripts.
 *
 * Both scripts read raw `U128` views through `near-api-js`'s provider and must
 * accept the JSON string or `{ "0": string }` shape returned by the RPC.
 */

import { JsonRpcProvider } from 'near-api-js';
import { isRecord } from '../../packages/sdk/src/guards.js';

const U128_PATTERN = /^\d+$/;

async function readU128View(
  provider: JsonRpcProvider,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
  label: string
): Promise<bigint> {
  const result = await provider.callFunction<string>({
    contractId,
    method,
    args,
    blockQuery: { finality: 'final' },
  });
  if (result === undefined) {
    throw new Error(`${label} returned no value`);
  }
  let text: string;
  if (typeof result === 'string' && U128_PATTERN.test(result)) {
    text = result;
  } else if (isRecord(result) && typeof result['0'] === 'string') {
    text = result['0'];
  } else {
    throw new Error(`${label} returned an unexpected u128 payload`);
  }
  return BigInt(text);
}

/** Raw FT balance through `ft_balance_of`. */
export function tokenBalance(
  provider: JsonRpcProvider,
  tokenContract: string,
  account: string
): Promise<bigint> {
  return readU128View(
    provider,
    tokenContract,
    'ft_balance_of',
    { account_id: account },
    `ft_balance_of(${account})`
  );
}
