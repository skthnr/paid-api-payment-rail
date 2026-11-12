import { describe, expect, it } from 'vitest';
import {
  DelegateAction,
  KeyPair,
  KeyType,
  Signature,
  SignedDelegate,
  actions,
  teraToGas,
  type Action,
} from 'near-api-js';
import {
  createExactDelegate,
  createSplitDelegate,
  decodeSignedDelegateBase64,
  encodeSignedDelegateBase64,
  normalizeAmount,
  type MetaTransactionAccount,
} from '../src/payments/metaTx.js';

interface CapturedMetaTransaction {
  receiverId: string;
  actions: Action[];
  blockHeightTtl?: number;
}

const TOKEN = 'token.portico.testnet';
const SPLIT = 'split.portico.testnet';

/**
 * A delegate-shaped object whose borsh fields are unreadable, so encoding must
 * fall back to the instance `encode()` method.
 */
function fakeSignedDelegate(): SignedDelegate {
  return {
    get delegateAction(): never {
      throw new Error('fake delegate has no borsh payload');
    },
    get signature(): never {
      throw new Error('fake delegate has no borsh payload');
    },
    encode: () => Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
  } as unknown as SignedDelegate;
}

function captureAccount(): {
  account: MetaTransactionAccount;
  calls: CapturedMetaTransaction[];
  signedDelegate: SignedDelegate;
} {
  const calls: CapturedMetaTransaction[] = [];
  const signedDelegate = fakeSignedDelegate();
  const account: MetaTransactionAccount = {
    accountId: 'buyer1.portico.testnet',
    createSignedMetaTransaction: async args => {
      calls.push(args);
      return { delegateHash: new Uint8Array(32), signedDelegate };
    },
  };
  return { account, calls, signedDelegate };
}

function functionCallOf(action: Action): NonNullable<Action['functionCall']> {
  const call = action.functionCall;
  if (call === undefined) {
    throw new Error('expected a FunctionCall action');
  }
  return call;
}

function decodeActionArgs(args: Uint8Array): unknown {
  return JSON.parse(Buffer.from(args).toString('utf8'));
}

describe('createSplitDelegate', () => {
  it('signs one 100 Tgas ft_transfer_call to the split contract with a 1-yocto deposit', async () => {
    const { account, calls } = captureAccount();

    await createSplitDelegate({
      account,
      tokenContract: TOKEN,
      splitContract: SPLIT,
      amount: 1_000_000n,
      tool: 'web-search',
      action: 'pay_tool',
      maxTimeoutSeconds: 60,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.receiverId).toBe(TOKEN);
    expect(call.blockHeightTtl).toBe(60);
    expect(call.actions).toHaveLength(1);

    const functionCall = functionCallOf(call.actions[0]!);
    expect(functionCall.methodName).toBe('ft_transfer_call');
    expect(functionCall.gas).toBe(teraToGas(100));
    expect(functionCall.gas).toBe(100_000_000_000_000n);
    expect(functionCall.deposit).toBe(1n);
    expect(decodeActionArgs(functionCall.args)).toEqual({
      receiver_id: SPLIT,
      amount: '1000000',
      msg: JSON.stringify({ action: 'pay_tool', tool: 'web-search' }),
    });
  });

  it('defaults the action to pay_tool and omits an undefined tool from msg', async () => {
    const { account, calls } = captureAccount();

    await createSplitDelegate({
      account,
      tokenContract: TOKEN,
      splitContract: SPLIT,
      amount: '250000',
      maxTimeoutSeconds: 30,
    });

    const functionCall = functionCallOf(calls[0]!.actions[0]!);
    expect(decodeActionArgs(functionCall.args)).toEqual({
      receiver_id: SPLIT,
      amount: '250000',
      msg: JSON.stringify({ action: 'pay_tool' }),
    });
  });

  it('rejects a zero amount before asking the account to sign', async () => {
    const { account, calls } = captureAccount();

    await expect(
      createSplitDelegate({
        account,
        tokenContract: TOKEN,
        splitContract: SPLIT,
        amount: 0n,
        maxTimeoutSeconds: 60,
      })
    ).rejects.toMatchObject({ code: 'invalid_delegate_options' });
    expect(calls).toHaveLength(0);
  });
});

describe('createExactDelegate', () => {
  it('signs one 30 Tgas ft_transfer to payTo with a 1-yocto deposit', async () => {
    const { account, calls } = captureAccount();

    await createExactDelegate({
      account,
      tokenContract: TOKEN,
      payTo: 'buyer1.portico.testnet',
      amount: '42',
      maxTimeoutSeconds: 30,
    });

    const call = calls[0]!;
    expect(call.receiverId).toBe(TOKEN);
    expect(call.blockHeightTtl).toBe(30);
    const functionCall = functionCallOf(call.actions[0]!);
    expect(functionCall.methodName).toBe('ft_transfer');
    expect(functionCall.gas).toBe(teraToGas(30));
    expect(functionCall.gas).toBe(30_000_000_000_000n);
    expect(functionCall.deposit).toBe(1n);
    expect(decodeActionArgs(functionCall.args)).toEqual({
      receiver_id: 'buyer1.portico.testnet',
      amount: '42',
    });
  });
});

describe('normalizeAmount', () => {
  it('canonicalizes bigint and string inputs to raw decimal strings', () => {
    expect(normalizeAmount('000100')).toBe('100');
    expect(normalizeAmount(1_000_000n)).toBe('1000000');
    expect(normalizeAmount(' 1000000 ')).toBe('1000000');
  });

  it('rejects non-numeric, zero, negative and u128-overflowing amounts', () => {
    for (const amount of ['', '1.5', '-1', '0', '1e3']) {
      expect(() => normalizeAmount(amount)).toThrowError(/positive u128 integer/);
    }
    expect(() => normalizeAmount(0n)).toThrowError(/positive u128 integer/);
    expect(() => normalizeAmount(1n << 128n)).toThrowError(/positive u128 integer/);
  });
});

describe('signed delegate encoding', () => {
  it('base64-encodes the fallback encode() bytes', () => {
    expect(encodeSignedDelegateBase64(fakeSignedDelegate())).toBe(
      Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64')
    );
  });

  it('round-trips a real SignedDelegate through canonical borsh', () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const signedDelegate = new SignedDelegate({
      delegateAction: new DelegateAction({
        senderId: 'buyer1.portico.testnet',
        receiverId: TOKEN,
        actions: [
          actions.functionCall(
            'ft_transfer_call',
            { receiver_id: SPLIT, amount: '1', msg: '{}' },
            teraToGas(100),
            1n
          ),
        ],
        nonce: 7n,
        maxBlockHeight: 1000n,
        publicKey: keyPair.getPublicKey(),
      }),
      signature: new Signature({ keyType: KeyType.ED25519, data: new Uint8Array(64) }),
    });

    const encoded = encodeSignedDelegateBase64(signedDelegate);
    const decoded = decodeSignedDelegateBase64(encoded);

    expect(decoded.delegateAction.senderId).toBe('buyer1.portico.testnet');
    expect(decoded.delegateAction.receiverId).toBe(TOKEN);
    expect(decoded.delegateAction.nonce).toBe(7n);
    expect(decoded.delegateAction.maxBlockHeight).toBe(1000n);
    expect(decoded.delegateAction.actions).toHaveLength(1);
  });

  it('rejects empty and non-canonical base64', () => {
    expect(() => decodeSignedDelegateBase64('')).toThrowError(/empty/);
    expect(() => decodeSignedDelegateBase64('not base64!!')).toThrowError(/canonical base64/);
  });

  it('rejects canonical base64 that is not a SignedDelegate', () => {
    const encoded = Buffer.from([1, 2, 3]).toString('base64');
    expect(() => decodeSignedDelegateBase64(encoded)).toThrowError(
      /not a canonical NEP-366 SignedDelegate/
    );
  });
});
