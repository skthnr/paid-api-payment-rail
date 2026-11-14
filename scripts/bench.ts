/**
 * Step 15 numbers: N gasless sale -> split -> payout loops.
 *
 * Each loop runs the same path as the zero-funds demo, without the stream:
 *
 *   POST /quote (402 PAYMENT-REQUIRED) -> buyer signs one NEP-366 delegate
 *   -> POST /verify -> POST /settle -> relayer broadcasts -> tx_status FINAL
 *
 * The buyer pays no NEAR: the relayer pays gas and the 1-yocto attached
 * deposit. One loop is one `pay_tool` call on the split contract: the tool
 * price is split 80/20, the developer leg leaves as an FT transfer and the
 * platform leg is credited to the platform wallet's balance.
 *
 * Measured per loop, from the FINAL `tx_status` outcome:
 *   TGas = sum(receipts_outcome[].outcome.gas_burnt) / 1e12
 *   NEAR = sum(receipts_outcome[].outcome.tokens_burnt) / 1e24
 *   latency = performance.now() at the quote request -> FINAL tx_status return
 *
 * The inner NEP-141 receipt must be `SuccessValue`; an outer transaction
 * success alone is not accepted. This script uses the facilitator's own
 * `inspectInnerTransfer` so the benchmark and the settlement route share one
 * definition of inner success, then additionally requires the terminal
 * receipt to be executed by the FT contract with `SuccessValue`.
 *
 * Sanity band (asserted per loop, never inferred):
 *   - 7 <= TGas <= 102
 * Latency has no invented floor: the run reports the measured p50 and p95 of
 * the wall-clock quote -> FINAL path, together with the exact command, so the
 * number is reproducible instead of matched to a block-cadence guess.
 * If the stack is unavailable or a measured loop leaves the gas band, the
 * script writes a blocker transcript and exits non-zero. It never reports a
 * synthetic or estimated median.
 *
 * Usage (from the repo root):
 *   pnpm bench
 *   pnpm bench --json
 *
 * Required environment (same deployment surface as scripts/demo.ts):
 *   PORTICO_TOKEN_CONTRACT, PORTICO_SPLIT_CONTRACT,
 *   PORTICO_BUYER_ACCOUNT, PORTICO_BUYER_SECRET_KEY
 *
 * Optional environment:
 *   PORTICO_BENCH_BASE_URL   facilitator base URL (overrides FACILITATOR_URL)
 *   FACILITATOR_URL          default http://localhost:3002
 *   PORTICO_RPC_URL          default https://test.rpc.fastnear.com
 *   PORTICO_NETWORK          default near:testnet
 *   PORTICO_DEMO_TOOL        default web-search
 *   PORTICO_MAX_TIMEOUT_SECONDS  delegate TTL cap, default 60
 *   PORTICO_BENCH_LOOPS      default 20
 *   PORTICO_BENCH_LOOP_TIMEOUT_MS  per-loop FINAL deadline, default 120000
 *   PORTICO_BENCH_TRANSCRIPT transcript path, default W4-NUMBERS.txt under
 *                            D:/near/portico on Windows and the repo parent on
 *                            other platforms
 *
 * The transcript is written on every run, including configuration errors,
 * unavailable-stack blockers and band failures.
 */

try { process.loadEnvFile(); } catch { /* .env optional */ }
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  type FinalExecutionOutcome,
  type KeyPairString,
} from 'near-api-js';
import {
  PorticoClient,
  RevenueSplitClient,
  X402_VERSION,
  buildPaymentSignature,
  createSplitDelegate,
  encodeSignedDelegateBase64,
  selectAccept,
  type AcceptsEntry,
  type FetchLike,
  type PaymentPayload,
  type SplitView,
  type SupportedResponse,
  type ToolInfo,
  type TotalsView,
} from '../packages/sdk/src/index.js';
import { isRecord } from '../packages/sdk/src/guards.js';
import { accountId, httpUrl, integer, required, secretKey } from './lib/config.js';
import { tokenBalance } from './lib/near.js';
import { inspectInnerTransfer } from '../facilitator/src/services/receipts.js';

/** Step 15 defaults fixed by p0-business.md. */
const DEFAULT_LOOP_COUNT = 20;
const MIN_TGAS = 7;
const MAX_TGAS = 102;
const TGAS_DIVISOR = 1e12;
const YOCTO_PER_NEAR = 10n ** 24n;
/** Deployment defaults matching scripts/demo.ts and facilitator/src/config.ts. */
const DEFAULT_FACILITATOR_URL = 'http://localhost:3002';
const DEFAULT_RPC_URL = 'https://test.rpc.fastnear.com';
const DEFAULT_NETWORK = 'near:testnet';
const DEFAULT_TOOL = 'web-search';
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_LOOP_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 30_000;
const TX_POLL_MS = 500;
const U128_PATTERN = /^\d+$/;

interface BenchConfig {
  facilitatorUrl: string;
  rpcUrl: string;
  network: string;
  tokenContract: string;
  splitContract: string;
  buyerAccount: string;
  buyerSecretKey: string;
  tool: string;
  loops: number;
  maxTimeoutSeconds: number;
  loopTimeoutMs: number;
  transcriptPath: string;
  json: boolean;
}

interface FacilitatorResponse {
  status: number;
  ok: boolean;
  body: unknown;
  text: string;
}

interface ToolCalledEvent {
  payer: string;
  tool: string;
  developer: string;
  amount: string;
}

interface LoopRecord {
  index: number;
  txHash: string;
  amount: string;
  price: string;
  gasBurnt: string;
  gasTgas: number;
  tokensBurntYocto: string;
  tokensBurntNear: string;
  latencyMs: number;
  receiptCount: number;
  innerReceiptId: string | null;
  innerUsed: string | null;
  paymentsConfirmed: boolean | null;
}

interface Summary {
  n: number;
  p50Tgas: number;
  p95Tgas: number;
  minTgas: number;
  maxTgas: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  minReceipts: number;
  maxReceipts: number;
  totalTokensBurntYocto: string;
  totalTokensBurntNear: string;
}

interface BandCheck {
  ok: boolean;
  minTgas: number;
  maxTgas: number;
  violations: string[];
}

interface TotalsDelta {
  before: TotalsView;
  after: TotalsView;
  callsDelta: number;
  settledVolumeDelta: string;
  platformBalanceDelta: string;
}

interface BenchReport {
  ok: boolean;
  blocker?: string;
  startedAt: string;
  finishedAt?: string;
  network?: string;
  facilitator?: string;
  rpc?: string;
  splitContract?: string;
  tokenContract?: string;
  buyer?: string;
  relayer?: string;
  tool?: string;
  pricePerCall?: string;
  developer?: string;
  split?: SplitView;
  quoteAmount?: string;
  loops: LoopRecord[];
  summary?: Summary;
  band?: BandCheck;
  totals?: TotalsDelta;
  headline?: string;
  transcript?: string;
}

interface Preflight {
  client: PorticoClient;
  revenue: RevenueSplitClient;
  provider: JsonRpcProvider;
  buyer: Account;
  relayerId: string;
  tool: ToolInfo;
  split: SplitView;
  accepted: AcceptsEntry;
  totalsBefore: TotalsView;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default transcript location: the workspace root, not the repo subdirectory. */
function defaultTranscriptPath(): string {
  if (process.platform === 'win32') {
    return 'D:/near/portico/W4-NUMBERS.txt';
  }
  return resolve(process.cwd(), '..', 'W4-NUMBERS.txt');
}

function loadConfig(env: NodeJS.ProcessEnv, args: readonly string[]): BenchConfig {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else {
      throw new Error(`unknown argument: ${arg} (supported: --json)`);
    }
  }
  const baseUrl =
    env.PORTICO_BENCH_BASE_URL?.trim() || env.FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL;
  const network = env.PORTICO_NETWORK?.trim() || DEFAULT_NETWORK;
  if (!network.startsWith('near:')) {
    throw new Error('PORTICO_NETWORK must be a NEAR CAIP-2 id such as near:testnet');
  }
  const tool = env.PORTICO_DEMO_TOOL?.trim() || DEFAULT_TOOL;
  if (tool.length === 0 || tool.length > 64) {
    throw new Error('PORTICO_DEMO_TOOL must be 1..64 characters');
  }
  const transcriptPath = env.PORTICO_BENCH_TRANSCRIPT?.trim();
  return {
    facilitatorUrl: httpUrl(baseUrl, 'PORTICO_BENCH_BASE_URL/FACILITATOR_URL'),
    rpcUrl: httpUrl(env.PORTICO_RPC_URL?.trim() || DEFAULT_RPC_URL, 'PORTICO_RPC_URL'),
    network,
    tokenContract: accountId(required(env, 'PORTICO_TOKEN_CONTRACT'), 'PORTICO_TOKEN_CONTRACT'),
    splitContract: accountId(required(env, 'PORTICO_SPLIT_CONTRACT'), 'PORTICO_SPLIT_CONTRACT'),
    buyerAccount: accountId(required(env, 'PORTICO_BUYER_ACCOUNT'), 'PORTICO_BUYER_ACCOUNT'),
    buyerSecretKey: secretKey(
      required(env, 'PORTICO_BUYER_SECRET_KEY'),
      'PORTICO_BUYER_SECRET_KEY'
    ),
    tool,
    loops: integer(env, 'PORTICO_BENCH_LOOPS', DEFAULT_LOOP_COUNT, 1, 200),
    maxTimeoutSeconds: integer(
      env,
      'PORTICO_MAX_TIMEOUT_SECONDS',
      DEFAULT_MAX_TIMEOUT_SECONDS,
      1,
      3_600
    ),
    loopTimeoutMs: integer(
      env,
      'PORTICO_BENCH_LOOP_TIMEOUT_MS',
      DEFAULT_LOOP_TIMEOUT_MS,
      10_000,
      600_000
    ),
    transcriptPath:
      transcriptPath === undefined || transcriptPath.length === 0
        ? defaultTranscriptPath()
        : resolve(transcriptPath),
    json,
  };
}

/** Wrap global fetch so every SDK request observes the HTTP deadline. */
const fetchWithTimeout: FetchLike = (input, init) =>
  globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });

async function getJson(url: string, label: string): Promise<FacilitatorResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`${label} request failed against ${url}`, { cause });
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

async function postJson(
  baseUrl: string,
  path: '/verify' | '/settle',
  headers: Record<string, string>,
  timeoutMs: number = HTTP_TIMEOUT_MS
): Promise<FacilitatorResponse> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
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

/** Emit the transcript on every run; the caller decides the exit code. */
async function persistTranscript(path: string, lines: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = yocto % YOCTO_PER_NEAR;
  if (fraction === 0n) {
    return whole.toString();
  }
  const digits = fraction.toString().padStart(24, '0').slice(0, 12).replace(/0+$/, '');
  return digits.length === 0 ? whole.toString() : `${whole}.${digits}`;
}

function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error(`${label} must be non-negative`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && U128_PATTERN.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${label} is not a non-negative integer: ${JSON.stringify(value)}`);
}

function statusRecord(status: unknown): Record<string, unknown> | null {
  return status !== null && typeof status === 'object' ? (status as Record<string, unknown>) : null;
}

function hasSuccessValue(status: unknown): boolean {
  const record = statusRecord(status);
  return record !== null && 'SuccessValue' in record;
}

function failureText(status: unknown): string | null {
  const record = statusRecord(status);
  if (record === null || !('Failure' in record)) {
    return null;
  }
  return JSON.stringify(record.Failure);
}

/** Sum the Step 15 gas/token fields over the whole receipt tree. */
function sumReceiptCost(outcome: FinalExecutionOutcome): {
  gasBurnt: bigint;
  tokensBurnt: bigint;
} {
  let gasBurnt = 0n;
  let tokensBurnt = 0n;
  for (const entry of outcome.receipts_outcome) {
    gasBurnt += toBigInt(entry.outcome.gas_burnt, 'receipts_outcome[].outcome.gas_burnt');
    tokensBurnt += toBigInt(entry.outcome.tokens_burnt, 'receipts_outcome[].outcome.tokens_burnt');
  }
  return { gasBurnt, tokensBurnt };
}

function readToolCalledEvents(outcome: FinalExecutionOutcome): ToolCalledEvent[] {
  const events: ToolCalledEvent[] = [];
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
      if (!isRecord(parsed) || parsed.standard !== 'portico') {
        continue;
      }
      if (parsed.event !== 'tool_called' || !isRecord(parsed.data)) {
        continue;
      }
      const data = parsed.data;
      if (
        typeof data.payer !== 'string' ||
        typeof data.tool !== 'string' ||
        typeof data.developer !== 'string' ||
        typeof data.amount !== 'string'
      ) {
        continue;
      }
      events.push({
        payer: data.payer,
        tool: data.tool,
        developer: data.developer,
        amount: data.amount,
      });
    }
  }
  return events;
}

function median(sample: readonly number[]): number {
  if (sample.length === 0) {
    throw new Error('median requires at least one sample');
  }
  const sorted = [...sample].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const value = sorted[mid];
    if (value === undefined) {
      throw new Error('median index out of range');
    }
    return value;
  }
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) {
    throw new Error('median indices out of range');
  }
  return (lower + upper) / 2;
}

function percentile(sample: readonly number[], fraction: number): number {
  if (sample.length === 0) {
    throw new Error('percentile requires at least one sample');
  }
  const sorted = [...sample].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error('percentile index out of range');
  }
  return value;
}

function minOf(sample: readonly number[]): number {
  let value = Number.POSITIVE_INFINITY;
  for (const item of sample) {
    value = Math.min(value, item);
  }
  return value;
}

function maxOf(sample: readonly number[]): number {
  let value = Number.NEGATIVE_INFINITY;
  for (const item of sample) {
    value = Math.max(value, item);
  }
  return value;
}

function summarize(loops: readonly LoopRecord[]): Summary {
  const gas = loops.map(loop => loop.gasTgas);
  const latency = loops.map(loop => loop.latencyMs);
  const receipts = loops.map(loop => loop.receiptCount);
  let totalTokensBurnt = 0n;
  for (const loop of loops) {
    totalTokensBurnt += BigInt(loop.tokensBurntYocto);
  }
  return {
    n: loops.length,
    p50Tgas: median(gas),
    p95Tgas: percentile(gas, 0.95),
    minTgas: minOf(gas),
    maxTgas: maxOf(gas),
    p50LatencyMs: median(latency),
    p95LatencyMs: percentile(latency, 0.95),
    minLatencyMs: minOf(latency),
    maxLatencyMs: maxOf(latency),
    minReceipts: minOf(receipts),
    maxReceipts: maxOf(receipts),
    totalTokensBurntYocto: totalTokensBurnt.toString(),
    totalTokensBurntNear: formatNear(totalTokensBurnt),
  };
}

function checkBand(loops: readonly LoopRecord[], expectedLoops: number): BandCheck {
  const violations: string[] = [];
  if (loops.length !== expectedLoops) {
    violations.push(`completed ${loops.length} loops, expected ${expectedLoops}`);
  }
  for (const loop of loops) {
    if (loop.gasTgas < MIN_TGAS || loop.gasTgas > MAX_TGAS) {
      violations.push(
        `loop ${loop.index} gas ${loop.gasTgas.toFixed(3)} TGas is outside ` +
          `${MIN_TGAS}–${MAX_TGAS}`
      );
    }
  }
  return {
    ok: violations.length === 0,
    minTgas: MIN_TGAS,
    maxTgas: MAX_TGAS,
    violations,
  };
}

function isRetryableTxError(error: unknown): boolean {
  const message = messageOf(error);
  return /UNKNOWN_TRANSACTION|UnknownTransaction|does not exist|not found|TIMEOUT|timeout|timed out|fetch failed|ECONN|EAI_AGAIN|502|503|504/i.test(
    message
  );
}

async function waitForFinal(
  provider: JsonRpcProvider,
  txHash: string,
  relayerId: string,
  deadline: number,
  label: string
): Promise<FinalExecutionOutcome> {
  let lastError: unknown = null;
  for (;;) {
    try {
      const outcome = await provider.viewTransactionStatus({
        txHash,
        accountId: relayerId,
        waitUntil: 'FINAL',
      });
      return outcome as unknown as FinalExecutionOutcome;
    } catch (error) {
      lastError = error;
      if (!isRetryableTxError(error)) {
        throw new Error(`${label}: tx_status failed: ${messageOf(error)}`, { cause: error });
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: tx_status did not reach FINAL within the loop budget: ` + messageOf(lastError)
      );
    }
    await delay(TX_POLL_MS);
  }
}

/**
 * Verify that the delegate actually settled an FT movement:
 * - the outer transaction and every receipt are successful;
 * - the facilitator's inner-receipt walk finds a `SuccessValue`;
 * - the terminal receipt is the FT contract itself with `SuccessValue`;
 * - the split emitted exactly one matching `ToolCalled` event;
 * - at least two FT receipts succeeded (the payout transfer and the resolver).
 */
function assertLoopOutcome(
  outcome: FinalExecutionOutcome,
  config: BenchConfig,
  tool: ToolInfo,
  index: number
): { innerReceiptId: string | null; innerUsed: string | null } {
  if (outcome.final_execution_status !== 'FINAL') {
    throw new Error(
      `loop ${index}: outcome is ${String(outcome.final_execution_status)}, not FINAL`
    );
  }
  if (!hasSuccessValue(outcome.status)) {
    throw new Error(`loop ${index}: outer transaction failed: ${JSON.stringify(outcome.status)}`);
  }
  for (const entry of outcome.receipts_outcome) {
    const failure = failureText(entry.outcome.status);
    if (failure !== null) {
      throw new Error(`loop ${index}: receipt ${entry.id} failed: ${failure}`);
    }
  }

  const inner = inspectInnerTransfer(outcome, config.tokenContract);
  if (!inner.ok) {
    throw new Error(
      `loop ${index}: inner FT receipt is not SuccessValue: ` +
        `${inner.errorReason ?? 'unknown reason'}`
    );
  }
  if (inner.receiptId === undefined) {
    throw new Error(`loop ${index}: inner FT receipt id is missing`);
  }
  const terminal = outcome.receipts_outcome.find(entry => entry.id === inner.receiptId);
  if (terminal === undefined) {
    throw new Error(`loop ${index}: inner receipt ${inner.receiptId} is absent from the outcome`);
  }
  if (terminal.outcome.executor_id !== config.tokenContract) {
    throw new Error(
      `loop ${index}: terminal inner receipt ${inner.receiptId} ran on ` +
        `${terminal.outcome.executor_id}, not the FT ${config.tokenContract}`
    );
  }
  if (!hasSuccessValue(terminal.outcome.status)) {
    throw new Error(
      `loop ${index}: terminal FT receipt ${inner.receiptId} is not SuccessValue: ` +
        JSON.stringify(terminal.outcome.status)
    );
  }

  const events = readToolCalledEvents(outcome);
  if (events.length !== 1) {
    throw new Error(`loop ${index}: expected one ToolCalled event, found ${events.length}`);
  }
  const event = events[0];
  if (event === undefined) {
    throw new Error(`loop ${index}: missing ToolCalled event`);
  }
  if (event.payer !== config.buyerAccount) {
    throw new Error(
      `loop ${index}: ToolCalled payer ${event.payer} is not the buyer ${config.buyerAccount}`
    );
  }
  if (event.tool !== config.tool) {
    throw new Error(`loop ${index}: ToolCalled tool ${event.tool} is not ${config.tool}`);
  }
  if (event.developer !== tool.developer) {
    throw new Error(
      `loop ${index}: ToolCalled developer ${event.developer} is not ${tool.developer}`
    );
  }
  if (event.amount !== tool.price_per_call) {
    throw new Error(
      `loop ${index}: ToolCalled amount ${event.amount} is not the registered price ` +
        tool.price_per_call
    );
  }

  const tokenSuccesses = outcome.receipts_outcome.filter(
    entry =>
      entry.outcome.executor_id === config.tokenContract && hasSuccessValue(entry.outcome.status)
  );
  if (tokenSuccesses.length < 2) {
    throw new Error(
      `loop ${index}: expected the FT payout transfer and resolver to succeed, ` +
        `found ${tokenSuccesses.length} successful FT receipt(s)`
    );
  }

  return {
    innerReceiptId: inner.receiptId ?? null,
    innerUsed: inner.used ?? null,
  };
}

async function assertBuyerReady(provider: JsonRpcProvider, config: BenchConfig): Promise<bigint> {
  const view = await provider.viewAccount({
    accountId: config.buyerAccount,
    blockQuery: { finality: 'final' },
  });
  const keyPair = KeyPair.fromString(config.buyerSecretKey as KeyPairString);
  const publicKey = keyPair.getPublicKey().toString();
  let permission: unknown;
  try {
    const accessKey = await provider.viewAccessKey({
      accountId: config.buyerAccount,
      publicKey,
      finalityQuery: { finality: 'final' },
    });
    permission = accessKey.permission;
  } catch (cause) {
    throw new Error(`buyer key ${publicKey} is not present on ${config.buyerAccount}`, { cause });
  }
  if (permission !== 'FullAccess') {
    throw new Error(`buyer key ${publicKey} must be a full-access key for the exact scheme`);
  }
  return view.amount;
}

async function preflight(config: BenchConfig, note: (line: string) => void): Promise<Preflight> {
  const health = await getJson(`${config.facilitatorUrl}/health`, 'facilitator /health');
  if (health.status !== 200 || !isRecord(health.body) || health.body.status !== 'ok') {
    throw new Error(
      `portico facilitator is unavailable at ${config.facilitatorUrl}: ` +
        `GET /health returned HTTP ${health.status} ${health.text}`
    );
  }
  if (health.body.network !== config.network) {
    throw new Error(
      `facilitator reports network ${String(health.body.network)}, expected ${config.network}`
    );
  }

  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const client = new PorticoClient({
    facilitatorUrl: config.facilitatorUrl,
    tokenContract: config.tokenContract,
    splitContract: config.splitContract,
    network: config.network,
    fetch: fetchWithTimeout,
  });
  const revenue = new RevenueSplitClient({
    contractId: config.splitContract,
    provider,
  });

  let supported: SupportedResponse;
  try {
    supported = await client.supported();
  } catch (error) {
    throw new Error(`facilitator ${config.facilitatorUrl} /supported failed: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const signers = supported.signers['near:*'] ?? [];
  const relayerId = signers[0];
  if (relayerId === undefined) {
    throw new Error('facilitator /supported advertised no near:* relayer signer');
  }
  if (relayerId === config.buyerAccount) {
    throw new Error(
      `buyer ${config.buyerAccount} is also the relayer; the exact scheme requires distinct accounts`
    );
  }
  const relayerView = await provider.viewAccount({
    accountId: relayerId,
    blockQuery: { finality: 'final' },
  });
  if (relayerView.amount === 0n) {
    throw new Error(
      `relayer ${relayerId} has no liquid NEAR to prepay gas and the 1-yocto deposit`
    );
  }
  note(`relayer: ${relayerId} (${relayerView.amount} yocto liquid)`);

  const buyerNearYocto = await assertBuyerReady(provider, config);
  note(`buyer: ${config.buyerAccount} (${buyerNearYocto} yocto liquid NEAR)`);

  const tool = await revenue.get_tool_info(config.tool);
  if (tool === null) {
    throw new Error(
      `tool "${config.tool}" is not registered on ${config.splitContract}; ` +
        'register it before running the bench'
    );
  }
  if (!tool.active) {
    throw new Error(`tool "${config.tool}" is not active on ${config.splitContract}`);
  }
  const split = await revenue.calculate_split(tool.price_per_call);
  if (BigInt(split.developer) + BigInt(split.platform) !== BigInt(tool.price_per_call)) {
    throw new Error(
      `calculate_split(${tool.price_per_call}) does not add up: ` +
        `${split.developer} + ${split.platform} != ${tool.price_per_call}`
    );
  }
  const expectedPlatform = (BigInt(tool.price_per_call) * 2_000n) / 10_000n;
  const expectedDeveloper = BigInt(tool.price_per_call) - expectedPlatform;
  if (
    split.platform !== expectedPlatform.toString() ||
    split.developer !== expectedDeveloper.toString()
  ) {
    throw new Error(
      `the Step 15 headline requires the 80/20 split (2000 bps); observed ` +
        `developer=${split.developer} platform=${split.platform} of ${tool.price_per_call}`
    );
  }
  note(`tool: ${config.tool}  price: ${tool.price_per_call}  developer: ${tool.developer}`);
  note(
    `split: developer=${split.developer} platform=${split.platform} ` +
      `(of ${tool.price_per_call})`
  );

  const requirement = await client.quote(config.tool);
  const firstAccept = requirement.accepts[0];
  if (firstAccept === undefined) {
    throw new Error('quote did not include accepts[0]');
  }
  const accepted = selectAccept(requirement, {
    network: config.network,
    asset: config.tokenContract,
    payTo: config.splitContract,
    amount: firstAccept.amount,
  });
  if (BigInt(accepted.amount) < BigInt(tool.price_per_call)) {
    throw new Error(
      `quoted amount ${accepted.amount} is below the registered tool price ` +
        `${tool.price_per_call}; the delegate gate would reject every loop`
    );
  }
  note(
    `quote: amount=${accepted.amount} (settled price ${tool.price_per_call}; ` +
      `excess ${BigInt(accepted.amount) - BigInt(tool.price_per_call)} refunded per loop)`
  );

  const buyerFtBefore = await tokenBalance(provider, config.tokenContract, config.buyerAccount);
  const requiredFt = BigInt(accepted.amount) * BigInt(config.loops);
  if (buyerFtBefore < requiredFt) {
    throw new Error(
      `buyer ${config.buyerAccount} holds ${buyerFtBefore} raw FT units, ` +
        `${config.loops} loops need ${requiredFt}`
    );
  }
  note(`buyer FT balance: ${buyerFtBefore} raw units (needs ${requiredFt})`);

  const totalsBefore = await revenue.get_totals();
  return {
    client,
    revenue,
    provider,
    buyer: new Account(config.buyerAccount, provider, config.buyerSecretKey as KeyPairString),
    relayerId,
    tool,
    split,
    accepted,
    totalsBefore,
  };
}

async function runLoop(config: BenchConfig, pre: Preflight, index: number): Promise<LoopRecord> {
  const loopStart = performance.now();
  const deadline = Date.now() + config.loopTimeoutMs;
  const label = `loop ${index}`;
  const requirement = await pre.client.quote(config.tool);
  const firstAccept = requirement.accepts[0];
  if (firstAccept === undefined) {
    throw new Error(`${label}: quote did not include accepts[0]`);
  }
  if (firstAccept.amount !== pre.accepted.amount) {
    throw new Error(
      `${label}: quote amount changed mid-run from ${pre.accepted.amount} to ` +
        `${firstAccept.amount}`
    );
  }
  const accepted = selectAccept(requirement, {
    network: config.network,
    asset: config.tokenContract,
    payTo: config.splitContract,
    amount: firstAccept.amount,
  });
  const { signedDelegate } = await createSplitDelegate({
    account: pre.buyer,
    tokenContract: config.tokenContract,
    splitContract: config.splitContract,
    amount: accepted.amount,
    tool: config.tool,
    maxTimeoutSeconds: Math.min(config.maxTimeoutSeconds, accepted.maxTimeoutSeconds),
  });
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: requirement.resource,
    accepted,
    payload: { signedDelegateAction: encodeSignedDelegateBase64(signedDelegate) },
  };
  const paymentHeaders = buildPaymentSignature(payload);

  const verify = await postJson(config.facilitatorUrl, '/verify', paymentHeaders);
  if (!verify.ok || !isRecord(verify.body) || verify.body.success !== true) {
    throw new Error(
      `${label}: facilitator /verify rejected the delegate: HTTP ${verify.status} ${verify.text}`
    );
  }

  const settle = await postJson(
    config.facilitatorUrl,
    '/settle',
    paymentHeaders,
    config.loopTimeoutMs
  );
  const settleBody = settle.body;
  if (!isRecord(settleBody)) {
    throw new Error(`${label}: facilitator /settle returned a non-JSON body: ${settle.text}`);
  }
  const txHash = settleBody.transaction;
  if (typeof txHash !== 'string' || txHash.length === 0) {
    throw new Error(
      `${label}: facilitator /settle returned no transaction hash: HTTP ${settle.status} ` +
        settle.text
    );
  }
  const settledByFacilitator = settleBody.success === true && settleBody.settlement === 'settled';
  if (!settledByFacilitator && settleBody.settlement !== 'pending') {
    throw new Error(
      `${label}: facilitator /settle did not settle the payment: ` +
        `${String(settleBody.errorReason ?? 'unknown')} (HTTP ${settle.status}) ${settle.text}`
    );
  }

  const outcome = await waitForFinal(pre.provider, txHash, pre.relayerId, deadline, label);
  const latencyMs = performance.now() - loopStart;

  const payment = await getJson(
    `${config.facilitatorUrl}/payments/${encodeURIComponent(txHash)}`,
    `${label} /payments/:txHash`
  );
  const paymentsConfirmed =
    payment.status === 200 && isRecord(payment.body) && payment.body.success === true;
  if (settledByFacilitator && !paymentsConfirmed) {
    throw new Error(
      `${label}: /settle reported success but GET /payments/${txHash} does not: ` +
        `HTTP ${payment.status} ${payment.text}`
    );
  }

  const inner = assertLoopOutcome(outcome, config, pre.tool, index);
  const { gasBurnt, tokensBurnt } = sumReceiptCost(outcome);
  if (gasBurnt === 0n) {
    throw new Error(`${label}: FINAL outcome reported zero gas_burnt`);
  }
  const gasTgas = Number(gasBurnt) / TGAS_DIVISOR;
  return {
    index,
    txHash,
    amount: accepted.amount,
    price: pre.tool.price_per_call,
    gasBurnt: gasBurnt.toString(),
    gasTgas,
    tokensBurntYocto: tokensBurnt.toString(),
    tokensBurntNear: formatNear(tokensBurnt),
    latencyMs: Math.round(latencyMs),
    receiptCount: outcome.receipts_outcome.length,
    innerReceiptId: inner.innerReceiptId,
    innerUsed: inner.innerUsed,
    paymentsConfirmed,
  };
}

async function assertTotals(
  revenue: RevenueSplitClient,
  config: BenchConfig,
  pre: Preflight
): Promise<TotalsDelta> {
  const totalsAfter = await revenue.get_totals();
  const toolAfter = await revenue.get_tool_info(config.tool);
  if (toolAfter === null) {
    throw new Error(`tool "${config.tool}" disappeared during the run`);
  }
  const callsDelta = toolAfter.total_calls - pre.tool.total_calls;
  if (callsDelta !== config.loops) {
    throw new Error(`tool "${config.tool}" recorded ${callsDelta} calls, expected ${config.loops}`);
  }
  const settledVolumeDelta =
    BigInt(totalsAfter.settled_volume) - BigInt(pre.totalsBefore.settled_volume);
  const expectedVolume = BigInt(pre.tool.price_per_call) * BigInt(config.loops);
  if (settledVolumeDelta !== expectedVolume) {
    throw new Error(`settled_volume moved by ${settledVolumeDelta}, expected ${expectedVolume}`);
  }
  const platformBalanceDelta =
    BigInt(totalsAfter.total_developer_balance) - BigInt(pre.totalsBefore.total_developer_balance);
  const expectedPlatform = BigInt(pre.split.platform) * BigInt(config.loops);
  if (platformBalanceDelta !== expectedPlatform) {
    throw new Error(
      `platform balance moved by ${platformBalanceDelta}, expected ${expectedPlatform} ` +
        `(${config.loops} x ${pre.split.platform})`
    );
  }
  return {
    before: pre.totalsBefore,
    after: totalsAfter,
    callsDelta,
    settledVolumeDelta: settledVolumeDelta.toString(),
    platformBalanceDelta: platformBalanceDelta.toString(),
  };
}

async function runBench(
  config: BenchConfig,
  report: BenchReport,
  note: (line: string) => void
): Promise<void> {
  note(`portico bench — N=${config.loops} gasless sale→split→payout loops`);
  note(`started: ${report.startedAt}`);
  note(`network: ${config.network}`);
  note(`facilitator: ${config.facilitatorUrl}`);
  note(`rpc: ${config.rpcUrl}`);
  note(`split: ${config.splitContract}  token: ${config.tokenContract}`);
  const pre = await preflight(config, note);
  note(`buyer: ${config.buyerAccount}  tool: ${config.tool}`);
  report.relayer = pre.relayerId;
  report.tool = config.tool;
  report.pricePerCall = pre.tool.price_per_call;
  report.developer = pre.tool.developer;
  report.split = pre.split;
  report.quoteAmount = pre.accepted.amount;

  for (let index = 1; index <= config.loops; index += 1) {
    const record = await runLoop(config, pre, index);
    report.loops.push(record);
    note(
      `loop ${String(index).padStart(2, '0')} tx=${record.txHash} ` +
        `gas_tgas=${record.gasTgas.toFixed(3)} ` +
        `tokens_burnt_near=${record.tokensBurntNear} ` +
        `latency_ms=${record.latencyMs} inner=SuccessValue`
    );
  }

  report.summary = summarize(report.loops);
  const summary = report.summary;
  note('summary:');
  note(`  p50 TGas: ${summary.p50Tgas.toFixed(3)}`);
  note(`  p95 TGas: ${summary.p95Tgas.toFixed(3)}`);
  note(`  min TGas: ${summary.minTgas.toFixed(3)}`);
  note(`  max TGas: ${summary.maxTgas.toFixed(3)}`);
  note(`  p50 latency ms: ${summary.p50LatencyMs}`);
  note(`  p95 latency ms: ${summary.p95LatencyMs}`);
  note(`  min latency ms: ${summary.minLatencyMs}`);
  note(`  max latency ms: ${summary.maxLatencyMs}`);
  note(`  receipts per loop: ${summary.minReceipts}–${summary.maxReceipts}`);
  note(`  tokens burnt: ${summary.totalTokensBurntNear} NEAR total`);
  note(`  N: ${summary.n}`);

  const totals = await assertTotals(pre.revenue, config, pre);
  report.totals = totals;
  note(
    `totals: calls +${totals.callsDelta}, settled_volume +${totals.settledVolumeDelta}, ` +
      `platform balance +${totals.platformBalanceDelta}`
  );

  const band = checkBand(report.loops, config.loops);
  report.band = band;
  if (band.ok) {
    note(
      `sanity band: ${band.minTgas}–${band.maxTgas} TGas per loop PASS; ` +
        `latency p50=${summary.p50LatencyMs} ms p95=${summary.p95LatencyMs} ms recorded`
    );
  } else {
    note(`sanity band: FAIL (${band.violations.length} violation(s))`);
    throw new Error(`sanity band failed: ${band.violations.join('; ')}`);
  }

  report.headline =
    `${summary.p50Tgas.toFixed(3)} TGas and ` +
    `${(summary.p50LatencyMs / 1000).toFixed(2)} s p50 / ` +
    `${(summary.p95LatencyMs / 1000).toFixed(2)} s p95 per gasless sale→80/20 payout ` +
    `(N=${summary.n}, ${config.network})`;
  note(
    `BENCH p50_tgas=${summary.p50Tgas.toFixed(3)} ` +
      `p95_tgas=${summary.p95Tgas.toFixed(3)} ` +
      `p50_latency_ms=${summary.p50LatencyMs} ` +
      `p95_latency_ms=${summary.p95LatencyMs} ` +
      `min_tgas=${summary.minTgas.toFixed(3)} ` +
      `max_tgas=${summary.maxTgas.toFixed(3)} ` +
      `min_latency_ms=${summary.minLatencyMs} ` +
      `max_latency_ms=${summary.maxLatencyMs} n=${summary.n}`
  );
  note(`HEADLINE: ${report.headline}`);
}

function reportJson(report: BenchReport): Record<string, unknown> {
  const totals = report.totals;
  return {
    ok: report.ok,
    ...(report.blocker === undefined ? {} : { blocker: report.blocker }),
    startedAt: report.startedAt,
    ...(report.finishedAt === undefined ? {} : { finishedAt: report.finishedAt }),
    ...(report.network === undefined ? {} : { network: report.network }),
    ...(report.facilitator === undefined ? {} : { facilitator: report.facilitator }),
    ...(report.rpc === undefined ? {} : { rpc: report.rpc }),
    ...(report.splitContract === undefined ? {} : { splitContract: report.splitContract }),
    ...(report.tokenContract === undefined ? {} : { tokenContract: report.tokenContract }),
    ...(report.buyer === undefined ? {} : { buyer: report.buyer }),
    ...(report.relayer === undefined ? {} : { relayer: report.relayer }),
    ...(report.tool === undefined ? {} : { tool: report.tool }),
    ...(report.pricePerCall === undefined ? {} : { pricePerCall: report.pricePerCall }),
    ...(report.developer === undefined ? {} : { developer: report.developer }),
    ...(report.split === undefined ? {} : { split: report.split }),
    ...(report.quoteAmount === undefined ? {} : { quoteAmount: report.quoteAmount }),
    loops: report.loops,
    ...(report.summary === undefined ? {} : { summary: report.summary }),
    ...(report.band === undefined ? {} : { band: report.band }),
    ...(totals === undefined
      ? {}
      : {
          totals: {
            callsDelta: totals.callsDelta,
            settledVolumeDelta: totals.settledVolumeDelta,
            platformBalanceDelta: totals.platformBalanceDelta,
          },
        }),
    ...(report.headline === undefined ? {} : { headline: report.headline }),
    ...(report.transcript === undefined ? {} : { transcript: report.transcript }),
  };
}

async function main(): Promise<void> {
  const report: BenchReport = {
    ok: false,
    startedAt: new Date().toISOString(),
    loops: [],
  };
  const lines: string[] = [];
  const cliArgs = process.argv.slice(2);
  const jsonRequested = cliArgs.includes('--json');
  let config: BenchConfig | null = null;
  const note = (line: string): void => {
    lines.push(line);
    if (!config?.json && !jsonRequested) {
      process.stdout.write(`${line}\n`);
    }
  };
  try {
    config = loadConfig(process.env, cliArgs);
    report.network = config.network;
    report.facilitator = config.facilitatorUrl;
    report.rpc = config.rpcUrl;
    report.splitContract = config.splitContract;
    report.tokenContract = config.tokenContract;
    report.buyer = config.buyerAccount;
    await runBench(config, report, note);
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.blocker = messageOf(error);
    lines.push(`BLOCKED: ${report.blocker}`);
  }
  report.finishedAt = new Date().toISOString();
  lines.push(`finished: ${report.finishedAt}`);

  const transcriptPath = config?.transcriptPath ?? defaultTranscriptPath();
  report.transcript = transcriptPath;
  try {
    await persistTranscript(transcriptPath, lines);
  } catch (error) {
    const transcriptError = `cannot write transcript ${transcriptPath}: ${messageOf(error)}`;
    report.ok = false;
    report.blocker =
      report.blocker === undefined ? transcriptError : `${report.blocker}; ${transcriptError}`;
    process.stderr.write(`portico bench: ${transcriptError}\n`);
  }

  if (jsonRequested || config?.json === true) {
    process.stdout.write(`${JSON.stringify(reportJson(report), null, 2)}\n`);
  } else if (!report.ok && report.blocker !== undefined) {
    process.stderr.write(`portico bench blocked: ${report.blocker}\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(error => {
  process.stderr.write(`portico bench failed: ${messageOf(error)}\n`);
  process.exitCode = 1;
});
