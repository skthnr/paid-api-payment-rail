/**
 * Step 14 zero-funds demo.
 *
 * Runs the complete sell-side loop against a deployed portico stack:
 *
 *   quote -> NEP-366 delegate -> facilitator /verify -> /settle -> ledger sale
 *   -> stream open -> fast-forward/wait -> claim
 *
 * The buyer account holds zero liquid NEAR for the whole run: it signs one
 * delegate and the facilitator relayer pays gas plus the 1-yocto attached
 * deposit. A stream is funded from a separate subscriber account because
 * opening one is a direct transaction; claims are permissionless.
 *
 * Every value printed or asserted is read from the chain or the facilitator.
 * When the environment cannot satisfy a step (missing account, missing
 * contract view, no sandbox fast-forward within the budget), the script throws
 * with an explicit message instead of reporting a simulated success.
 *
 * Usage (from the repo root):
 *   pnpm demo
 *
 * Required environment:
 *   FACILITATOR_URL, PORTICO_TOKEN_CONTRACT, PORTICO_SPLIT_CONTRACT,
 *   PORTICO_BUYER_ACCOUNT, PORTICO_BUYER_SECRET_KEY,
 *   PORTICO_STREAM_SUBSCRIBER_ACCOUNT, PORTICO_STREAM_SUBSCRIBER_SECRET_KEY,
 *   PORTICO_STREAM_RECIPIENT (defaults to PORTICO_DEV_ACCOUNT)
 *
 * Optional environment:
 *   PORTICO_RPC_URL, PORTICO_NETWORK, PORTICO_DEMO_TOOL,
 *   PORTICO_DEMO_EXPECTED_AMOUNT, PORTICO_DEMO_CLIFF_BLOCKS,
 *   PORTICO_DEMO_STREAM_DEPOSIT, PORTICO_DEMO_STREAM_RATE,
 *   PORTICO_DEMO_MAX_MS, PORTICO_MAX_TIMEOUT_SECONDS,
 *   PORTICO_SANDBOX_RPC_URL
 */

try {
  process.loadEnvFile();
} catch {
  /* .env optional */
}
import { setTimeout as delay } from 'node:timers/promises';
import {
  PorticoClient,
  RevenueSplitClient,
  X402_VERSION,
  buildPaymentSignature,
  createSplitDelegate,
  encodeSignedDelegateBase64,
  normalizeAmount,
  selectAccept,
  type PaymentPayload,
  type PaymentRequired,
} from '../packages/sdk/src/index.js';
import { isRecord } from '../packages/sdk/src/guards.js';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  actions,
  teraToGas,
  type KeyPairString,
  type FinalExecutionOutcome,
} from 'near-api-js';
import { accountId, httpUrl, integer, required, secretKey } from './lib/config.js';
import { tokenBalance } from './lib/near.js';

/** On-chain ledger capacity used to bound the id lookup. */
const LEDGER_CAPACITY = 100_000;
/** Contract cliff bounds, in blocks from the open block. */
const MIN_CLIFF_BLOCKS = 3_600;
const MAX_CLIFF_BLOCKS = 31_536_000;

interface DemoConfig {
  facilitatorUrl: string;
  rpcUrl: string;
  sandboxRpcUrl?: string;
  network: string;
  tokenContract: string;
  splitContract: string;
  buyerAccount: string;
  buyerSecretKey: string;
  streamSubscriberAccount: string;
  streamSubscriberSecretKey: string;
  streamRecipient: string;
  tool: string;
  expectedAmount?: string;
  streamDeposit: string;
  streamRate: string;
  cliffBlocks: number;
  maxTimeoutSeconds: number;
  maxDurationMs: number;
}

interface Timing {
  label: string;
  ms: number;
}

interface FacilitatorResponse {
  status: number;
  ok: boolean;
  body: unknown;
  text: string;
}

interface StreamOpened {
  streamId: number;
  cliffEndBlock: number;
}

interface AccessKeyState {
  permission: unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rawAmount(value: string, name: string): string {
  try {
    return normalizeAmount(value.trim());
  } catch {
    throw new Error(`${name} must be a positive u128 integer of raw FT units`);
  }
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const streamDeposit = rawAmount(
    env.PORTICO_DEMO_STREAM_DEPOSIT?.trim() || '1000000',
    'PORTICO_DEMO_STREAM_DEPOSIT'
  );
  const network = env.PORTICO_NETWORK?.trim() || 'near:testnet';
  if (!network.startsWith('near:')) {
    throw new Error('PORTICO_NETWORK must be a NEAR CAIP-2 id such as near:testnet');
  }
  const expectedAmount = env.PORTICO_DEMO_EXPECTED_AMOUNT?.trim();
  const sandboxRpcUrl = env.PORTICO_SANDBOX_RPC_URL?.trim();
  const tool = env.PORTICO_DEMO_TOOL?.trim() || 'web-search';
  if (tool.length === 0 || tool.length > 64) {
    throw new Error('PORTICO_DEMO_TOOL must be 1..64 characters');
  }
  const streamRecipient = accountId(
    env.PORTICO_STREAM_RECIPIENT?.trim() || required(env, 'PORTICO_DEV_ACCOUNT'),
    'PORTICO_STREAM_RECIPIENT'
  );
  return {
    facilitatorUrl: httpUrl(
      env.FACILITATOR_URL?.trim() || 'http://localhost:3002',
      'FACILITATOR_URL'
    ),
    rpcUrl: httpUrl(
      env.PORTICO_RPC_URL?.trim() || 'https://test.rpc.fastnear.com',
      'PORTICO_RPC_URL'
    ),
    ...(sandboxRpcUrl === undefined || sandboxRpcUrl.length === 0
      ? {}
      : { sandboxRpcUrl: httpUrl(sandboxRpcUrl, 'PORTICO_SANDBOX_RPC_URL') }),
    network,
    tokenContract: accountId(required(env, 'PORTICO_TOKEN_CONTRACT'), 'PORTICO_TOKEN_CONTRACT'),
    splitContract: accountId(required(env, 'PORTICO_SPLIT_CONTRACT'), 'PORTICO_SPLIT_CONTRACT'),
    buyerAccount: accountId(required(env, 'PORTICO_BUYER_ACCOUNT'), 'PORTICO_BUYER_ACCOUNT'),
    buyerSecretKey: secretKey(
      required(env, 'PORTICO_BUYER_SECRET_KEY'),
      'PORTICO_BUYER_SECRET_KEY'
    ),
    streamSubscriberAccount: accountId(
      required(env, 'PORTICO_STREAM_SUBSCRIBER_ACCOUNT'),
      'PORTICO_STREAM_SUBSCRIBER_ACCOUNT'
    ),
    streamSubscriberSecretKey: secretKey(
      required(env, 'PORTICO_STREAM_SUBSCRIBER_SECRET_KEY'),
      'PORTICO_STREAM_SUBSCRIBER_SECRET_KEY'
    ),
    streamRecipient,
    tool,
    ...(expectedAmount === undefined || expectedAmount.length === 0
      ? {}
      : { expectedAmount: rawAmount(expectedAmount, 'PORTICO_DEMO_EXPECTED_AMOUNT') }),
    streamDeposit,
    streamRate: rawAmount(
      env.PORTICO_DEMO_STREAM_RATE?.trim() || streamDeposit,
      'PORTICO_DEMO_STREAM_RATE'
    ),
    cliffBlocks: integer(
      env,
      'PORTICO_DEMO_CLIFF_BLOCKS',
      MIN_CLIFF_BLOCKS,
      MIN_CLIFF_BLOCKS,
      MAX_CLIFF_BLOCKS
    ),
    maxTimeoutSeconds: integer(env, 'PORTICO_MAX_TIMEOUT_SECONDS', 60, 1, 3_600),
    maxDurationMs: integer(env, 'PORTICO_DEMO_MAX_MS', 120_000, 1_000, 3_600_000),
  };
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await read();
      if (value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError === null ? '' : `: ${messageOf(lastError)}`;
      throw new Error(`${label} did not settle within ${timeoutMs} ms${suffix}`);
    }
    await delay(500);
  }
}

async function assertBuyerReady(provider: JsonRpcProvider, config: DemoConfig): Promise<void> {
  const view = await provider.viewAccount({
    accountId: config.buyerAccount,
    blockQuery: { finality: 'final' },
  });
  if (view.amount !== 0n) {
    throw new Error(
      `buyer ${config.buyerAccount} must hold zero liquid NEAR, found ${view.amount} yocto`
    );
  }
  const keyPair = KeyPair.fromString(config.buyerSecretKey as KeyPairString);
  const publicKey = keyPair.getPublicKey().toString();
  let accessKey: AccessKeyState;
  try {
    accessKey = await provider.viewAccessKey({
      accountId: config.buyerAccount,
      publicKey,
      finalityQuery: { finality: 'final' },
    });
  } catch (cause) {
    throw new Error(`buyer key ${publicKey} is not present on ${config.buyerAccount}`, { cause });
  }
  if (accessKey.permission !== 'FullAccess') {
    throw new Error(`buyer key ${publicKey} must be a full-access key for the exact scheme`);
  }
}

async function assertBuyerStillZero(provider: JsonRpcProvider, config: DemoConfig): Promise<void> {
  const view = await provider.viewAccount({
    accountId: config.buyerAccount,
    blockQuery: { finality: 'final' },
  });
  if (view.amount !== 0n) {
    throw new Error(
      `buyer ${config.buyerAccount} paid NEAR: balance moved to ${view.amount} yocto`
    );
  }
}

async function postFacilitator(
  baseUrl: string,
  path: '/verify' | '/settle',
  headers: Record<string, string>
): Promise<FacilitatorResponse> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });
  } catch (cause) {
    throw new Error(`facilitator ${path} request failed`, { cause });
  }
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, ok: response.ok, body, text };
}

/** Highest stored ledger id, found by bisection over the contiguous id space. */
async function lastLedgerId(client: RevenueSplitClient): Promise<number> {
  let low = 0;
  let high = LEDGER_CAPACITY;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const page = await client.get_ledger(mid - 1, 1);
    if (page.length > 0) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function assertTxSuccess(tx: unknown, label: string): void {
  const outcome = tx as FinalExecutionOutcome;
  if (outcome.final_execution_status !== 'FINAL') {
    throw new Error(`${label} did not reach FINAL: ${outcome.final_execution_status}`);
  }
  const status: unknown = outcome.status;
  if (typeof status === 'object' && status !== null && 'SuccessValue' in status) {
    return;
  }
  throw new Error(`${label} failed: ${JSON.stringify(status)}`);
}

function readStreamOpened(tx: unknown, subscriber: string): StreamOpened {
  const outcome = tx as FinalExecutionOutcome;
  for (const receipt of outcome.receipts_outcome) {
    for (const log of receipt.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(log.slice('EVENT_JSON:'.length));
      } catch {
        continue;
      }
      if (!isRecord(parsed) || parsed.standard !== 'portico' || !isRecord(parsed.data)) {
        continue;
      }
      const data = parsed.data;
      if (data.subscriber !== subscriber) {
        continue;
      }
      if (typeof data.stream_id !== 'number' || typeof data.cliff_end_block !== 'number') {
        continue;
      }
      return { streamId: data.stream_id, cliffEndBlock: data.cliff_end_block };
    }
  }
  throw new Error(
    `transaction ${outcome.transaction.hash} did not emit a portico StreamOpened event; ` +
      'the stream was not opened (check the cliff, rate and deposit)'
  );
}

async function sandboxFastForward(sandboxRpcUrl: string, delta: number): Promise<void> {
  let response: Response;
  try {
    response = await fetch(sandboxRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'portico-demo',
        method: 'sandbox_fast_forward',
        params: { delta_height: delta },
      }),
    });
  } catch (cause) {
    throw new Error(`sandbox_fast_forward request failed against ${sandboxRpcUrl}`, {
      cause,
    });
  }
  if (!response.ok) {
    throw new Error(`sandbox_fast_forward returned HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (isRecord(body) && body.error !== undefined) {
    throw new Error(`sandbox_fast_forward failed: ${JSON.stringify(body.error)}`);
  }
}

async function waitForHeight(
  provider: JsonRpcProvider,
  target: number,
  deadline: number
): Promise<number> {
  let lastNotice = 0;
  for (;;) {
    const block = await provider.viewBlock({ finality: 'final' });
    if (block.header.height >= target) {
      return block.header.height;
    }
    const now = Date.now();
    if (now >= deadline) {
      throw new Error(
        `final block height ${target} was not reached before the demo budget elapsed ` +
          `(current ${block.header.height}); set PORTICO_SANDBOX_RPC_URL to a ` +
          'near-sandbox node to fast-forward the stream cliff'
      );
    }
    if (now - lastNotice >= 10_000) {
      process.stdout.write(
        `  waiting for final block ${target} (current ${block.header.height})\n`
      );
      lastNotice = now;
    }
    await delay(1_000);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = performance.now();
  const timings: Timing[] = [];

  async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await run();
    } finally {
      timings.push({ label, ms: performance.now() - start });
    }
  }

  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const client = new PorticoClient({
    facilitatorUrl: config.facilitatorUrl,
    tokenContract: config.tokenContract,
    splitContract: config.splitContract,
    network: config.network,
  });
  const revenue = new RevenueSplitClient({
    contractId: config.splitContract,
    rpcUrl: config.rpcUrl,
  });
  const buyer = new Account(config.buyerAccount, provider, config.buyerSecretKey as KeyPairString);
  const subscriber = new Account(
    config.streamSubscriberAccount,
    provider,
    config.streamSubscriberSecretKey as KeyPairString
  );

  process.stdout.write(`portico zero-funds demo (${config.network})\n`);
  process.stdout.write(`  facilitator: ${config.facilitatorUrl}\n`);
  process.stdout.write(`  split: ${config.splitContract}  token: ${config.tokenContract}\n`);
  process.stdout.write(`  buyer: ${config.buyerAccount} (0 NEAR required)\n`);
  process.stdout.write(`  tool: ${config.tool}\n`);

  await step('buyer credentials', () => assertBuyerReady(provider, config));

  const supported = await step('facilitator /supported', () => client.supported());
  const signers = supported.signers['near:*'] ?? [];
  if (signers.length === 0) {
    throw new Error('facilitator /supported advertised no near:* relayer signer');
  }
  const relayerId = signers[0];
  if (relayerId === undefined) {
    throw new Error('facilitator /supported returned an empty relayer list');
  }
  const relayerView = await step('relayer balance', () =>
    provider.viewAccount({ accountId: relayerId, blockQuery: { finality: 'final' } })
  );
  if (relayerView.amount === 0n) {
    throw new Error(
      `relayer ${relayerId} has no liquid NEAR to prepay gas and the 1-yocto deposit`
    );
  }
  process.stdout.write(`  relayer: ${relayerId} (${relayerView.amount} yocto liquid)\n`);

  const totalsBefore = await revenue.get_totals();
  const toolBefore = await revenue.get_tool_info(config.tool);
  if (toolBefore === null) {
    throw new Error(
      `tool "${config.tool}" is not registered on ${config.splitContract}; ` +
        'register it before running the demo'
    );
  }
  const lastLedgerBefore = await lastLedgerId(revenue);
  process.stdout.write(
    `  tool price: ${toolBefore.price_per_call} raw units -> ${toolBefore.developer}\n`
  );

  const requirement: PaymentRequired = await step('quote', () => client.quote(config.tool));
  const firstAccept = requirement.accepts[0];
  if (firstAccept === undefined) {
    throw new Error('quote did not include accepts[0]');
  }
  if (config.expectedAmount !== undefined && firstAccept.amount !== config.expectedAmount) {
    throw new Error(
      `quoted amount ${firstAccept.amount} does not match PORTICO_DEMO_EXPECTED_AMOUNT ` +
        config.expectedAmount
    );
  }
  const accepted = selectAccept(requirement, {
    network: config.network,
    asset: config.tokenContract,
    payTo: config.splitContract,
    amount: firstAccept.amount,
  });

  const buyerFtBefore = await tokenBalance(provider, config.tokenContract, config.buyerAccount);
  if (buyerFtBefore < BigInt(accepted.amount)) {
    throw new Error(
      `buyer ${config.buyerAccount} holds ${buyerFtBefore} raw FT units, ` +
        `the quote requires ${accepted.amount}`
    );
  }

  const { signedDelegate } = await step('sign delegate', () =>
    createSplitDelegate({
      account: buyer,
      tokenContract: config.tokenContract,
      splitContract: config.splitContract,
      amount: accepted.amount,
      tool: config.tool,
      maxTimeoutSeconds: Math.min(config.maxTimeoutSeconds, accepted.maxTimeoutSeconds),
    })
  );
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: requirement.resource,
    accepted,
    payload: { signedDelegateAction: encodeSignedDelegateBase64(signedDelegate) },
  };
  const paymentHeaders = buildPaymentSignature(payload);

  const verify = await step('facilitator /verify', () =>
    postFacilitator(config.facilitatorUrl, '/verify', paymentHeaders)
  );
  if (!verify.ok || !isRecord(verify.body) || verify.body.success !== true) {
    throw new Error(
      `facilitator /verify rejected the delegate: HTTP ${verify.status} ${verify.text}`
    );
  }

  const settle = await step('facilitator /settle', () =>
    postFacilitator(config.facilitatorUrl, '/settle', paymentHeaders)
  );
  const settleBody = settle.body;
  if (!isRecord(settleBody) || settleBody.success !== true || settleBody.settlement !== 'settled') {
    throw new Error(`facilitator /settle did not settle: HTTP ${settle.status} ${settle.text}`);
  }
  const transactionHash = settleBody.transaction;
  if (typeof transactionHash !== 'string' || transactionHash.length === 0) {
    throw new Error('settled response did not include a transaction hash');
  }
  process.stdout.write(`  settled: ${transactionHash}\n`);
  await step('buyer still zero NEAR', () => assertBuyerStillZero(provider, config));

  const sale = await step('ledger sale', () =>
    waitFor(
      async () => {
        const totals = await revenue.get_totals();
        if (BigInt(totals.settled_volume) <= BigInt(totalsBefore.settled_volume)) {
          return null;
        }
        const tool = await revenue.get_tool_info(config.tool);
        if (tool === null || tool.total_calls <= toolBefore.total_calls) {
          return null;
        }
        const page = await revenue.get_ledger(lastLedgerBefore, 50);
        const entry = page.find(
          item =>
            item.action === 'tool_call' &&
            item.tool === config.tool &&
            item.payer === config.buyerAccount
        );
        return entry === undefined ? null : { entry, tool };
      },
      60_000,
      'ledger sale entry'
    )
  );
  if (sale.entry.payee !== sale.tool.developer) {
    throw new Error(
      `ledger payee ${sale.entry.payee} does not match developer ${sale.tool.developer}`
    );
  }
  if (BigInt(sale.entry.amount) !== BigInt(sale.tool.price_per_call)) {
    throw new Error(
      `ledger amount ${sale.entry.amount} does not match tool price ` + sale.tool.price_per_call
    );
  }
  const splitView = await revenue.calculate_split(sale.entry.amount);
  if (BigInt(splitView.developer) + BigInt(splitView.platform) !== BigInt(sale.entry.amount)) {
    throw new Error(
      `split view does not add up: ${splitView.developer} + ${splitView.platform} != ` +
        sale.entry.amount
    );
  }
  const expectedBuyerFt = buyerFtBefore - BigInt(sale.tool.price_per_call);
  await step('buyer refund exact', () =>
    waitFor(
      async () => {
        const balance = await tokenBalance(provider, config.tokenContract, config.buyerAccount);
        return balance === expectedBuyerFt ? balance : null;
      },
      60_000,
      'buyer token balance after the sale'
    )
  );
  process.stdout.write(
    `  sale ledger id=${sale.entry.id} payer=${sale.entry.payer} ` +
      `payee=${sale.entry.payee} amount=${sale.entry.amount}\n`
  );
  process.stdout.write(
    `  split: developer=${splitView.developer} platform=${splitView.platform}\n`
  );

  const subscriberFtBefore = await tokenBalance(
    provider,
    config.tokenContract,
    config.streamSubscriberAccount
  );
  if (subscriberFtBefore < BigInt(config.streamDeposit)) {
    throw new Error(
      `stream subscriber ${config.streamSubscriberAccount} holds ${subscriberFtBefore} ` +
        `raw FT units, the stream deposit is ${config.streamDeposit}`
    );
  }

  const openTx = await step('open stream', () =>
    subscriber.signAndSendTransaction({
      receiverId: config.tokenContract,
      actions: [
        actions.functionCall(
          'ft_transfer_call',
          {
            receiver_id: config.splitContract,
            amount: config.streamDeposit,
            msg: JSON.stringify({
              action: 'open_stream',
              recipient: config.streamRecipient,
              rate_per_block: config.streamRate,
              cliff_blocks: config.cliffBlocks,
            }),
          },
          teraToGas(100),
          1n
        ),
      ],
      waitUntil: 'FINAL',
      throwOnFailure: true,
    })
  );
  assertTxSuccess(openTx, 'open stream');
  const opened = readStreamOpened(openTx, config.streamSubscriberAccount);
  const openedView = await revenue.get_stream_view(opened.streamId);
  if (openedView.status !== 'open') {
    throw new Error(`stream ${opened.streamId} is not open`);
  }
  if (BigInt(openedView.escrow_remaining) !== BigInt(config.streamDeposit)) {
    throw new Error(
      `stream ${opened.streamId} escrow ${openedView.escrow_remaining} does not match ` +
        `the deposit ${config.streamDeposit}`
    );
  }
  if (BigInt(openedView.claimable) !== 0n) {
    throw new Error(`stream ${opened.streamId} is claimable before its cliff`);
  }
  const lastLedgerAfterOpen = await lastLedgerId(revenue);
  process.stdout.write(
    `  stream ${opened.streamId}: deposit=${config.streamDeposit} ` +
      `rate=${config.streamRate}/block cliff_end=${opened.cliffEndBlock}\n`
  );

  await step('advance blocks', async () => {
    const target = opened.cliffEndBlock + 1;
    const latest = await provider.viewBlock({ finality: 'final' });
    if (latest.header.height >= target) {
      return;
    }
    const remainingMs = config.maxDurationMs - (performance.now() - startedAt);
    const remainingBlocks = target - latest.header.height;
    if (config.sandboxRpcUrl !== undefined) {
      await sandboxFastForward(config.sandboxRpcUrl, remainingBlocks + 1);
    } else if (remainingBlocks * 1_000 > remainingMs) {
      throw new Error(
        `the stream cliff needs ${remainingBlocks} more blocks, which cannot fit in ` +
          `the ${config.maxDurationMs} ms budget on a live network; set ` +
          'PORTICO_SANDBOX_RPC_URL to a near-sandbox node that supports ' +
          'sandbox_fast_forward'
      );
    } else {
      process.stdout.write(`  no PORTICO_SANDBOX_RPC_URL: waiting for ${remainingBlocks} blocks\n`);
    }
    await waitForHeight(provider, target, Date.now() + config.maxDurationMs);
  });

  const accrual = await step('stream accrual', () =>
    waitFor(
      async () => {
        const view = await revenue.get_stream_view(opened.streamId);
        return BigInt(view.claimable) > 0n ? view : null;
      },
      60_000,
      'stream accrual'
    )
  );
  const claimable = BigInt(accrual.claimable);
  const recipientBefore = await tokenBalance(
    provider,
    config.tokenContract,
    config.streamRecipient
  );

  const claimTx = await step('claim stream', () =>
    subscriber.signAndSendTransaction({
      receiverId: config.splitContract,
      actions: [actions.functionCall('claim', { stream_id: opened.streamId }, teraToGas(50), 0n)],
      waitUntil: 'FINAL',
      throwOnFailure: true,
    })
  );
  assertTxSuccess(claimTx, 'claim stream');
  await waitFor(
    async () => {
      const balance = await tokenBalance(provider, config.tokenContract, config.streamRecipient);
      return balance - recipientBefore >= claimable ? balance : null;
    },
    60_000,
    'stream claim transfer'
  );
  const claimEntry = await waitFor(
    async () => {
      const page = await revenue.get_ledger(lastLedgerAfterOpen, 50);
      const entry = page.find(
        item =>
          item.action === 'stream_claim' &&
          item.payee === config.streamRecipient &&
          BigInt(item.amount) >= claimable
      );
      return entry === undefined ? null : entry;
    },
    60_000,
    'stream claim ledger entry'
  );
  process.stdout.write(
    `  claimed ${claimEntry.amount} raw units to ${config.streamRecipient} ` +
      `(ledger id=${claimEntry.id}, tx=${claimTx.transaction.hash})\n`
  );

  const totalMs = performance.now() - startedAt;
  process.stdout.write('\ntimings (ms):\n');
  for (const timing of timings) {
    process.stdout.write(`  ${timing.label}: ${timing.ms.toFixed(0)}\n`);
  }
  process.stdout.write(`  total: ${totalMs.toFixed(0)}\n`);
  if (totalMs > config.maxDurationMs) {
    throw new Error(
      `demo took ${totalMs.toFixed(0)} ms, exceeding the ${config.maxDurationMs} ms budget`
    );
  }
  process.stdout.write(
    `OK: quote -> verify -> settle -> ledger sale -> stream -> claim in ` +
      `${totalMs.toFixed(0)} ms (< ${config.maxDurationMs} ms)\n`
  );
}

main().catch(error => {
  process.stderr.write(`portico demo failed: ${messageOf(error)}\n`);
  process.exitCode = 1;
});
