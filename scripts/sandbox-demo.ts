#!/usr/bin/env tsx
/**
 * PIN 3 reproducibility harness: the zero-funds demo on a fresh Linux sandbox.
 *
 * One command bootstraps everything the W4 demo needs, with no testnet
 * accounts, faucet, API key or previously deployed contract:
 *
 *   near-sandbox init --fast + run   (ephemeral RPC/network ports, temp home)
 *   deterministic demo accounts      (owner, buyer, developer, platform,
 *                                     relayer, stream subscriber)
 *   deploy + init                    (portico-payment-token, portico-revenue-split)
 *   NEP-145 registrations + FT seed  (buyer and subscriber receive raw units)
 *   facilitator :3002 + paywall :3003 (`pnpm --filter ... dev`)
 *   pnpm demo                        (scripts/demo.ts, zero-funds loop)
 *
 * The buyer account is created with a full-access key and *zero* liquid NEAR.
 * Everything it needs for the payment is paid by the relayer through NEP-366.
 *
 * Usage (from the repo root):
 *   pnpm sandbox:demo
 *
 * Optional environment:
 *   NEAR_SANDBOX_BIN            near-sandbox binary; otherwise auto-discovered
 *                               under target/debug/build/near-sandbox-<hash>/out/
 *                               .near/near-sandbox-<ver>/near-sandbox
 *   PORTICO_SANDBOX_RPC_URL     reuse an already-running sandbox instead of
 *                               spawning one
 *   PORTICO_SANDBOX_HOME        sandbox home to use/create; when reusing an
 *                               external sandbox this is where validator_key.json
 *                               is read from
 *   PORTICO_SANDBOX_ROOT_ACCOUNT / PORTICO_SANDBOX_ROOT_KEY
 *                               explicit root credentials for an external sandbox
 *   PORTICO_SANDBOX_KEEP_HOME=1 keep the created sandbox home after the run
 *   PORTICO_DEMO_TRANSCRIPT     transcript path (default:
 *                               <repo>/../W4-DEMO-TRANSCRIPT.txt, outside the repo)
 *   PORTICO_DEMO_MAX_MS         demo budget, default 120000
 *   PORTICO_FACILITATOR_PORT    default 3002
 *   PAYWALL_PORT                default 3003
 *
 * The deterministic ed25519 keys below are test fixtures for a disposable
 * local sandbox only. They are never used on any public network.
 *
 * Every step fails with its exact name and the child output that caused the
 * failure; there is no synthetic success path.
 */

import 'dotenv/config';

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, createConnection, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  actions,
  teraToGas,
  type Action,
  type KeyPairString,
} from 'near-api-js';
import { isRecord } from '../packages/sdk/src/guards.js';

const ONE_NEAR = 10n ** 24n;
const ONE_YOCTO = 1n;
const EMPTY_CODE_HASH = '11111111111111111111111111111111';
const FT_TOTAL_SUPPLY = (1_000_000_000n * 10n ** 18n).toString();
const FT_DEMO_FUNDING = 1_000n * 10n ** 18n;
const STORAGE_DEPOSIT_NEAR = ONE_NEAR / 100n;
const REGISTRATION_DEPOSIT_NEAR = ONE_NEAR;
const TOOL_NAME = 'web-search';
/** Registered contract price in raw FT units (CONSTANTS K20 / Step 8). */
const TOOL_PRICE = '1000000';
/**
 * Facilitator quote for `web-search`: 0.0001 display units at 6 decimals,
 * scaled by 1e12 raw units per price unit. `pay_tool` charges the registered
 * price and the FT resolver refunds the difference, so the demo pins the quote
 * it expects while the buyer's net spend stays at TOOL_PRICE.
 */
const QUOTED_AMOUNT = '100000000000000';
const STREAM_DEPOSIT = '1000000';
const STREAM_RATE = '10';
const CLIFF_BLOCKS = 3_600;
const DEFAULT_DEMO_MAX_MS = 120_000;
const DEFAULT_FACILITATOR_PORT = 3002;
const DEFAULT_PAYWALL_PORT = 3003;
const SANDBOX_INIT_TIMEOUT_MS = 180_000;
const SERVICE_HEALTH_TIMEOUT_MS = 90_000;
const ACCOUNT_ID_PATTERN = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;
const SECRET_KEY_PATTERN = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Deterministic sandbox keys. These are public test fixtures: they control
 * only disposable local accounts and carry no value.
 */
const DEMO_SECRET_KEYS = {
  owner:
    'ed25519:2QEk6MoJx12zgvHRLcKzgwRFbyKqB4HvjXCyRzz1H2nEmnWznjhgP4N3K2JUUdiEenHBLk1An6jEDd1egjNGr4e2',
  buyer:
    'ed25519:cSL6V9nEXT8RnE8aksQeEfBbNXC57qpGxrgbs2EF3PkBPmDRDY5YiDNtujrAenjRuHdffzME48JGHFF86w1H2N1',
  developer:
    'ed25519:2FmhLXLiodVVd5A1hy6ZkqVYHd7g3Wpk2eYB3Nd8yQ66BBLQb5Nis2fM76DvnGbRXxuVGwXEthBmZFMmMR23UhRB',
  platform:
    'ed25519:5ucrr6ruG8erGnJ8TVXiBhqHVD2BjTTxeJtopMyCsHNXnYg1jYAEKurX1hEJfeNJZFYcwLKfMfSFXYpn72ab2snL',
  relayer:
    'ed25519:u7iFbmPtJDknxnmqgt68Bxe6dJMatof4K1ZukvUavMktvbUZs5BrTakpqEuCk8LzEPc5KvgM8wQYmjM5QxoCPPu',
  subscriber:
    'ed25519:47J7CVHkbFAZGpZaYt1ujUdr4xUwNRBttYdCb3X5ZoVg8Hx7SFEsbSVShxx1CYmgDYNcPMxG3shxNqnk4kiJodPS',
} as const;

/** Keys controlling the two deployed contract accounts; test fixtures only. */
const CONTRACT_SECRET_KEYS = {
  token:
    'ed25519:3qz1cENp92jaG7m1qtpc1YvVdzcjnjFpWgH71aseMpKo44DYr7kxLXFpd9UE9DjDdcRJrxscQs5niL5LYRhvQh1W',
  split:
    'ed25519:62iQnPGCbk3X8CfQZUQ6UnC9PKbrcwMBzLGGx2EwUbZsWEZeNTRKBe3vn8ButdSiycGuweB5g3HSwxRJi9urAp1w',
} as const;

type Role = keyof typeof DEMO_SECRET_KEYS;

const ROLE_NEAR: Record<Role, bigint> = {
  owner: 100n * ONE_NEAR,
  // The buyer must keep a zero liquid balance for the whole run.
  buyer: 0n,
  developer: 20n * ONE_NEAR,
  platform: 20n * ONE_NEAR,
  relayer: 100n * ONE_NEAR,
  subscriber: 50n * ONE_NEAR,
};

/** Account ids created below the sandbox root account. */
interface AccountIds {
  owner: string;
  buyer: string;
  developer: string;
  platform: string;
  relayer: string;
  subscriber: string;
  token: string;
  split: string;
}

interface SandboxDemoConfig {
  repoRoot: string;
  transcriptPath: string;
  externalRpcUrl?: string;
  sandboxBin?: string;
  sandboxHome?: string;
  ownsHome: boolean;
  keepHome: boolean;
  explicitRootAccount?: string;
  explicitRootKey?: string;
  facilitatorPort: number;
  paywallPort: number;
  demoMaxMs: number;
  benchMode: boolean;
  benchTranscriptPath: string;
  tokenWasm: string;
  splitWasm: string;
}

interface SandboxRuntime {
  rpcUrl: string;
  rootAccount: string;
  rootSecretKey: string;
  home: string | null;
  ownsHome: boolean;
}

interface ChainSetup {
  provider: JsonRpcProvider;
  ids: AccountIds;
  accounts: Record<Role, Account>;
}

interface StepTiming {
  label: string;
  ms: number;
}

interface TxOutcome {
  final_execution_status: string;
  status: unknown;
  transaction: { hash: string };
  receipts_outcome: Array<{
    id: string;
    outcome: { status: unknown; logs?: string[] };
  }>;
}

interface ManagedProcess {
  child: ChildProcess;
  lines: string[];
}

/** A failure that names the exact setup or demo step. */
class DemoFailure extends Error {
  public readonly step: string;

  public constructor(step: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DemoFailure';
    this.step = step;
  }
}

function fail(step: string, message: string, cause?: unknown): never {
  throw new DemoFailure(step, message, cause === undefined ? undefined : { cause });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Line-buffered transcript outside the repository. */
class Transcript {
  private readonly startedAt = Date.now();

  public constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }

  public line(source: string, text: string, stream: 'out' | 'err' = 'out'): void {
    const elapsed = String(Date.now() - this.startedAt).padStart(7, ' ');
    const body = text.length > 4_000 ? `${text.slice(0, 4_000)}...` : text;
    const output = `[${elapsed}ms] ${source}: ${body}\n`;
    appendFileSync(this.path, output);
    if (stream === 'err') {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }
  }
}

let transcript: Transcript | null = null;
let runtime: SandboxRuntime | null = null;
let mainSucceeded = false;
let cleanedUp = false;

const processes = new Map<string, ManagedProcess>();
const stepTimings: StepTiming[] = [];

function record(source: string, text: string, stream: 'out' | 'err' = 'out'): void {
  transcript?.line(source, text, stream);
}

async function withStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = Date.now();
  record('sandbox-demo', `step ${label}: start`);
  try {
    const value = await run();
    const ms = Date.now() - start;
    stepTimings.push({ label, ms });
    record('sandbox-demo', `step ${label}: ok (${ms} ms)`);
    return value;
  } catch (error) {
    record(
      'sandbox-demo',
      `step ${label}: failed after ${Date.now() - start} ms: ${messageOf(error)}`,
      'err'
    );
    throw error;
  }
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = envValue(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('configuration', `${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

function httpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    fail('configuration', `${name} is not a valid URL: ${value}`, cause);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('configuration', `${name} must use http or https`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function loadConfig(): SandboxDemoConfig {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const transcriptPath = resolve(
    envValue('PORTICO_DEMO_TRANSCRIPT') ?? join(repoRoot, '..', 'W4-DEMO-TRANSCRIPT.txt')
  );
  const externalRpcUrlRaw = envValue('PORTICO_SANDBOX_RPC_URL');
  const externalRpcUrl =
    externalRpcUrlRaw === undefined
      ? undefined
      : httpUrl(externalRpcUrlRaw, 'PORTICO_SANDBOX_RPC_URL');
  const sandboxHomeRaw = envValue('PORTICO_SANDBOX_HOME');
  const sandboxHome = sandboxHomeRaw === undefined ? undefined : resolve(sandboxHomeRaw);
  const ownsHome = sandboxHome === undefined;
  const facilitatorPort = integerEnv(
    'PORTICO_FACILITATOR_PORT',
    DEFAULT_FACILITATOR_PORT,
    1,
    65_535
  );
  const paywallPort = integerEnv('PAYWALL_PORT', DEFAULT_PAYWALL_PORT, 1, 65_535);
  if (facilitatorPort === paywallPort) {
    fail('configuration', 'PORTICO_FACILITATOR_PORT and PAYWALL_PORT must differ');
  }
  const demoMaxMs = integerEnv('PORTICO_DEMO_MAX_MS', DEFAULT_DEMO_MAX_MS, 1_000, 3_600_000);
  const benchMode =
    envValue('PORTICO_SANDBOX_BENCH') === '1' || envValue('PORTICO_SANDBOX_BENCH') === 'true';
  const benchTranscriptPath = resolve(
    envValue('PORTICO_BENCH_TRANSCRIPT') ?? join(repoRoot, '..', 'W4-NUMBERS.txt')
  );
  const tokenWasm = resolveContractWasm(repoRoot, 'payment-token', 'portico_payment_token');
  const splitWasm = resolveContractWasm(repoRoot, 'revenue-split', 'portico_revenue_split');
  const explicitRootAccount = envValue('PORTICO_SANDBOX_ROOT_ACCOUNT');
  if (explicitRootAccount !== undefined && !ACCOUNT_ID_PATTERN.test(explicitRootAccount)) {
    fail(
      'configuration',
      `PORTICO_SANDBOX_ROOT_ACCOUNT is not a valid NEAR account id: ${explicitRootAccount}`
    );
  }
  const explicitRootKey = envValue('PORTICO_SANDBOX_ROOT_KEY');
  if (explicitRootKey !== undefined && !SECRET_KEY_PATTERN.test(explicitRootKey)) {
    fail('configuration', 'PORTICO_SANDBOX_ROOT_KEY must be an ed25519 or secp256k1 secret key');
  }
  return {
    repoRoot,
    transcriptPath,
    ...(externalRpcUrl === undefined ? {} : { externalRpcUrl }),
    ...(externalRpcUrl === undefined ? { sandboxBin: resolveSandboxBin(repoRoot) } : {}),
    ...(sandboxHome === undefined ? {} : { sandboxHome }),
    ownsHome,
    keepHome:
      envValue('PORTICO_SANDBOX_KEEP_HOME') === '1' ||
      envValue('PORTICO_SANDBOX_KEEP_HOME') === 'true',
    ...(explicitRootAccount === undefined ? {} : { explicitRootAccount }),
    ...(explicitRootKey === undefined ? {} : { explicitRootKey }),
    facilitatorPort,
    paywallPort,
    demoMaxMs,
    benchMode,
    benchTranscriptPath,
    tokenWasm,
    splitWasm,
  };
}

function resolveContractWasm(repoRoot: string, crateDir: string, baseName: string): string {
  const nearDir = join(repoRoot, 'contracts', crateDir, 'target', 'near');
  const candidates = [
    join(nearDir, `${baseName}.wasm`),
    join(nearDir, `${baseName.replace(/_/g, '-')}.wasm`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  fail(
    'contract wasm',
    `${baseName}.wasm is missing under contracts/${crateDir}/target/near; build it with: ` +
      `(cd contracts/${crateDir} && cargo near build non-reproducible-wasm)`
  );
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      // X_OK: the sandbox is spawned directly, so it must be executable.
      accessSync(path, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a near-sandbox binary. The Rust near-sandbox crate downloads it under
 * `<build-script-out>/.near/near-sandbox-<version>/near-sandbox`; a global
 * install uses `~/.near/near-sandbox-<version>/near-sandbox`.
 */
function resolveSandboxBin(repoRoot: string): string {
  if (process.platform === 'win32') {
    fail(
      'sandbox binary',
      'near-sandbox runs on Linux x86_64/ARM64 or macOS ARM64 only; run this script on ' +
        'Linux (or WSL2), or point PORTICO_SANDBOX_RPC_URL at a sandbox already running there'
    );
  }
  const explicit = envValue('NEAR_SANDBOX_BIN');
  if (explicit !== undefined) {
    const resolved = resolve(explicit);
    if (!isExecutableFile(resolved)) {
      fail('sandbox binary', `NEAR_SANDBOX_BIN is not an executable file: ${resolved}`);
    }
    return resolved;
  }

  const buildRoots = [
    join(repoRoot, 'target', 'debug', 'build'),
    join(repoRoot, 'tests', 'target', 'debug', 'build'),
    ...listDirNames(join(repoRoot, 'contracts')).map(name =>
      join(repoRoot, 'contracts', name, 'target', 'debug', 'build')
    ),
  ];
  const candidates: string[] = [];
  for (const buildRoot of buildRoots) {
    for (const buildDir of listDirNames(buildRoot).filter(name =>
      name.startsWith('near-sandbox-')
    )) {
      const outNear = join(buildRoot, buildDir, 'out', '.near');
      for (const versionDir of listDirNames(outNear).filter(name =>
        name.startsWith('near-sandbox-')
      )) {
        candidates.push(join(outNear, versionDir, 'near-sandbox'));
      }
      for (const versionDir of listDirNames(join(buildRoot, buildDir)).filter(name =>
        name.startsWith('near-sandbox-')
      )) {
        candidates.push(join(buildRoot, buildDir, versionDir, 'near-sandbox'));
      }
    }
  }
  for (const versionDir of listDirNames(join(homedir(), '.near')).filter(name =>
    name.startsWith('near-sandbox-')
  )) {
    candidates.push(join(homedir(), '.near', versionDir, 'near-sandbox'));
  }

  for (const candidate of candidates.sort().reverse()) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  fail(
    'sandbox binary',
    'no near-sandbox binary found; set NEAR_SANDBOX_BIN, or build the workspace test ' +
      'target that depends on near-sandbox (it downloads into ' +
      'target/debug/build/near-sandbox-*/out/.near/near-sandbox-*/near-sandbox)'
  );
}

function spawnManaged(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A process group lets cleanup take `tsx watch` and its server down too.
    detached: process.platform !== 'win32',
  });
  const entry: ManagedProcess = { child, lines: [] };
  processes.set(name, entry);

  const attach = (stream: NodeJS.ReadableStream | null, isError: boolean): void => {
    if (stream === null) {
      return;
    }
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', line => {
      entry.lines.push(line);
      if (entry.lines.length > 400) {
        entry.lines.shift();
      }
      record(name, line, isError ? 'err' : 'out');
    });
  };
  attach(child.stdout, false);
  attach(child.stderr, true);
  child.once('error', error => {
    record(name, `spawn error: ${messageOf(error)}`, 'err');
  });
  child.once('exit', (code, signal) => {
    record(name, `exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });
  return child;
}

function tailOf(name: string, count = 25): string {
  const entry = processes.get(name);
  if (entry === undefined || entry.lines.length === 0) {
    return '(no output)';
  }
  return entry.lines.slice(-count).join('\n');
}

function processIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(name: string, timeoutMs: number): Promise<number> {
  const entry = processes.get(name);
  if (entry === undefined) {
    return Promise.reject(new DemoFailure(name, `unknown managed process ${name}`));
  }
  if (!processIsRunning(entry.child)) {
    return Promise.resolve(entry.child.exitCode ?? 1);
  }
  return new Promise<number>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      entry.child.removeListener('exit', onExit);
      reject(new DemoFailure(name, `${name} did not exit within ${timeoutMs} ms\n${tailOf(name)}`));
    }, timeoutMs);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      resolvePromise(code ?? 1);
    };
    entry.child.once('exit', onExit);
  });
}

function signalManaged(name: string, signal: NodeJS.Signals): void {
  const entry = processes.get(name);
  if (entry === undefined || !processIsRunning(entry.child)) {
    return;
  }
  const pid = entry.child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      entry.child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

async function stopManaged(name: string): Promise<void> {
  const entry = processes.get(name);
  if (entry === undefined || !processIsRunning(entry.child)) {
    return;
  }
  record('sandbox-demo', `stopping ${name}`);
  signalManaged(name, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (processIsRunning(entry.child) && Date.now() < deadline) {
    await delay(100);
  }
  if (processIsRunning(entry.child)) {
    signalManaged(name, 'SIGKILL');
    const killed = Date.now() + 2_000;
    while (processIsRunning(entry.child) && Date.now() < killed) {
      await delay(100);
    }
  }
}

async function cleanup(): Promise<void> {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  // Demo first (should already be gone), then services, then the node.
  await stopManaged('demo');
  await stopManaged('paywall');
  await stopManaged('facilitator');
  await stopManaged('sandbox');
  if (runtime !== null && runtime.ownsHome && runtime.home !== null) {
    const keep =
      !mainSucceeded ||
      envValue('PORTICO_SANDBOX_KEEP_HOME') === '1' ||
      envValue('PORTICO_SANDBOX_KEEP_HOME') === 'true';
    if (keep) {
      record('sandbox-demo', `keeping sandbox home for inspection: ${runtime.home}`);
    } else {
      try {
        rmSync(runtime.home, { recursive: true, force: true });
        record('sandbox-demo', `removed sandbox home ${runtime.home}`);
      } catch (error) {
        record('sandbox-demo', `could not remove ${runtime.home}: ${messageOf(error)}`, 'err');
      }
    }
  }
}

function installSignalHandlers(): void {
  const shutdown = (signal: string, code: number): void => {
    record('sandbox-demo', `received ${signal}; cleaning up`, 'err');
    void cleanup().finally(() => {
      process.exit(code);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT', 130));
  process.once('SIGTERM', () => shutdown('SIGTERM', 143));
}

async function reservePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => {
      return new Promise<Server>((resolvePromise, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolvePromise(server));
      });
    })
  );
  const ports: number[] = [];
  for (const server of servers) {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      fail('sandbox ports', 'could not allocate an ephemeral loopback port');
    }
    ports.push(address.port);
  }
  await Promise.all(
    servers.map(server => {
      return new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    })
  );
  return ports;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise<boolean>(resolvePromise => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function assertPortFree(port: number, service: string): Promise<void> {
  if (await isPortOpen(port)) {
    fail(
      'service ports',
      `port ${port} (${service}) is already in use; stop that process and rerun`
    );
  }
}

interface ValidatorKeyFile {
  account_id: string;
  secret_key: string;
}

function readValidatorKey(home: string): ValidatorKeyFile {
  const keyPath = join(home, 'validator_key.json');
  if (!existsSync(keyPath)) {
    fail(
      'sandbox credentials',
      `validator_key.json is missing from ${home}; run near-sandbox init --fast there first`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyPath, 'utf8'));
  } catch (cause) {
    fail('sandbox credentials', `cannot parse ${keyPath}`, cause);
  }
  if (
    !isRecord(parsed) ||
    typeof parsed['account_id'] !== 'string' ||
    typeof parsed['secret_key'] !== 'string'
  ) {
    fail('sandbox credentials', `${keyPath} has no account_id/secret_key`);
  }
  const account = parsed['account_id'];
  const key = parsed['secret_key'];
  if (!ACCOUNT_ID_PATTERN.test(account)) {
    fail('sandbox credentials', `${keyPath} has an invalid account id: ${account}`);
  }
  if (!SECRET_KEY_PATTERN.test(key)) {
    fail('sandbox credentials', `${keyPath} has an invalid secret key`);
  }
  return { account_id: account, secret_key: key };
}

function sandboxEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Keep the node quiet unless the operator explicitly asks for logs.
    RUST_LOG: process.env.RUST_LOG ?? 'near=warn,stats=warn,network=warn',
  };
}

async function waitForRpc(rpcUrl: string, processName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  for (;;) {
    const entry = processes.get(processName);
    if (entry !== undefined && !processIsRunning(entry.child)) {
      fail(
        'start sandbox',
        `near-sandbox exited before RPC became ready (code ${entry.child.exitCode ?? 'null'})\n` +
          tailOf(processName)
      );
    }
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'portico-sandbox-demo',
          method: 'status',
          params: {},
        }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const body: unknown = await response.json();
        if (isRecord(body) && isRecord(body['result'])) {
          const sync = body['result']['sync_info'];
          if (isRecord(sync) && typeof sync['latest_block_height'] === 'number') {
            record('sandbox-demo', `sandbox RPC ready at ${rpcUrl}`);
            return;
          }
        }
        lastError = 'status response has no sync_info.latest_block_height';
      }
    } catch (error) {
      lastError = messageOf(error);
    }
    if (Date.now() >= deadline) {
      fail(
        'start sandbox',
        `sandbox RPC ${rpcUrl} did not become ready within ${timeoutMs} ms: ${lastError}\n` +
          tailOf(processName)
      );
    }
    await delay(250);
  }
}

async function prepareSandbox(config: SandboxDemoConfig): Promise<SandboxRuntime> {
  if (config.externalRpcUrl !== undefined) {
    let rootAccount = config.explicitRootAccount;
    let rootSecretKey = config.explicitRootKey;
    if ((rootAccount === undefined || rootSecretKey === undefined) && config.sandboxHome) {
      const validatorKey = readValidatorKey(config.sandboxHome);
      rootAccount = rootAccount ?? validatorKey.account_id;
      rootSecretKey = rootSecretKey ?? validatorKey.secret_key;
      record('sandbox-demo', `root credentials read from ${config.sandboxHome}`);
    }
    if (rootAccount === undefined || rootSecretKey === undefined) {
      fail(
        'sandbox credentials',
        'PORTICO_SANDBOX_RPC_URL requires PORTICO_SANDBOX_HOME (with validator_key.json) or ' +
          'PORTICO_SANDBOX_ROOT_ACCOUNT and PORTICO_SANDBOX_ROOT_KEY'
      );
    }
    record('sandbox-demo', `reusing external sandbox at ${config.externalRpcUrl}`);
    return {
      rpcUrl: config.externalRpcUrl,
      rootAccount,
      rootSecretKey,
      home: config.sandboxHome ?? null,
      ownsHome: false,
    };
  }

  const bin = config.sandboxBin;
  if (bin === undefined) {
    fail('sandbox binary', 'internal error: no sandbox binary resolved');
  }
  const home = config.sandboxHome ?? mkdtempSync(join(tmpdir(), 'portico-sandbox-'));
  mkdirSync(home, { recursive: true });
  const env = sandboxEnvironment();

  if (!existsSync(join(home, 'genesis.json'))) {
    const init = spawnManaged('sandbox-init', bin, ['--home', home, 'init', '--fast'], {
      cwd: config.repoRoot,
      env,
    });
    void init;
    const code = await waitForExit('sandbox-init', SANDBOX_INIT_TIMEOUT_MS);
    if (code !== 0) {
      fail(
        'sandbox init',
        `near-sandbox init --fast exited with ${code}\n${tailOf('sandbox-init')}`
      );
    }
  }
  const validatorKey = readValidatorKey(home);
  const ports = await reservePorts(2);
  const rpcPort = ports[0];
  const netPort = ports[1];
  if (rpcPort === undefined || netPort === undefined) {
    fail('sandbox ports', 'could not reserve RPC/network ports');
  }
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  record(
    'sandbox-demo',
    `starting ${bin} on ${rpcUrl} (network 127.0.0.1:${netPort}, home ${home})`
  );
  spawnManaged(
    'sandbox',
    bin,
    [
      '--home',
      home,
      'run',
      '--rpc-addr',
      `127.0.0.1:${rpcPort}`,
      '--network-addr',
      `127.0.0.1:${netPort}`,
    ],
    { cwd: config.repoRoot, env }
  );
  await waitForRpc(rpcUrl, 'sandbox', 90_000);
  return {
    rpcUrl,
    rootAccount: validatorKey.account_id,
    rootSecretKey: validatorKey.secret_key,
    home,
    ownsHome: config.ownsHome,
  };
}

function accountIdsFor(rootAccount: string): AccountIds {
  if (!rootAccount.includes('.')) {
    fail(
      'sandbox credentials',
      `sandbox root account "${rootAccount}" has no parent domain, so subaccounts cannot be ` +
        'created; use a near-sandbox home whose validator account is test.near'
    );
  }
  const sub = (prefix: string): string => {
    const id = `${prefix}.${rootAccount}`;
    if (!ACCOUNT_ID_PATTERN.test(id)) {
      fail('sandbox credentials', `derived account id is invalid: ${id}`);
    }
    return id;
  };
  return {
    owner: sub('owner'),
    buyer: sub('buyer'),
    developer: sub('developer'),
    platform: sub('platform'),
    relayer: sub('relayer'),
    subscriber: sub('subscriber'),
    token: sub('token'),
    split: sub('split'),
  };
}

function assertFinalSuccess(outcome: TxOutcome, label: string): void {
  if (outcome.final_execution_status !== 'FINAL') {
    fail(label, `transaction did not reach FINAL (status ${outcome.final_execution_status})`);
  }
  if (!(isRecord(outcome.status) && 'SuccessValue' in outcome.status)) {
    fail(label, `transaction failed: ${JSON.stringify(outcome.status)}`);
  }
  for (const receipt of outcome.receipts_outcome ?? []) {
    if (isRecord(receipt.outcome.status) && 'Failure' in receipt.outcome.status) {
      const logs =
        receipt.outcome.logs === undefined || receipt.outcome.logs.length === 0
          ? ''
          : ` logs: ${receipt.outcome.logs.slice(-3).join(' | ')}`;
      fail(label, `receipt ${receipt.id} failed: ${JSON.stringify(receipt.outcome.status)}${logs}`);
    }
  }
}

async function send(
  account: Account,
  receiverId: string,
  actionList: Action[],
  label: string
): Promise<TxOutcome> {
  let response: unknown;
  try {
    response = await account.signAndSendTransaction({
      receiverId,
      actions: actionList,
      waitUntil: 'FINAL',
      throwOnFailure: true,
    });
  } catch (cause) {
    fail(label, `transaction to ${receiverId} failed: ${messageOf(cause)}`, cause);
  }
  const outcome = response as unknown as TxOutcome;
  assertFinalSuccess(outcome, label);
  return outcome;
}

async function viewAccountMaybe(
  provider: JsonRpcProvider,
  accountId: string
): Promise<{ amount: bigint; code_hash: string } | null> {
  try {
    const view = await provider.viewAccount({
      accountId,
      blockQuery: { finality: 'final' },
    });
    return { amount: view.amount, code_hash: view.code_hash };
  } catch (error) {
    if (/does not exist/i.test(messageOf(error))) {
      return null;
    }
    fail('account view', `view_account(${accountId}) failed: ${messageOf(error)}`, error);
  }
}

function isUninitializedError(error: unknown): boolean {
  return /not initialized|MethodNotFound|Method not found|method is not found|does not exist|Contract method is not found/i.test(
    messageOf(error)
  );
}

/** Call a view; `null` means "method missing or contract not initialized yet". */
async function viewMaybe(
  provider: JsonRpcProvider,
  contractId: string,
  method: string,
  args: Record<string, unknown>
): Promise<unknown> {
  try {
    const result = await provider.callFunction<object>({
      contractId,
      method,
      args,
      blockQuery: { finality: 'final' },
    });
    return result === undefined ? null : result;
  } catch (error) {
    if (isUninitializedError(error)) {
      return null;
    }
    fail('contract view', `${method} on ${contractId} failed: ${messageOf(error)}`, error);
  }
}

function parseU128(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (isRecord(value)) {
    const inner = value['0'];
    if (typeof inner === 'string' && /^\d+$/.test(inner)) {
      return BigInt(inner);
    }
  }
  fail(label, `expected a u128 value, got ${JSON.stringify(value)}`);
}

async function ensureAccount(
  provider: JsonRpcProvider,
  root: Account,
  accountId: string,
  secretKey: string,
  nearAmount: bigint,
  step: string
): Promise<Account> {
  const keyPair = KeyPair.fromString(secretKey as KeyPairString);
  const publicKey = keyPair.getPublicKey().toString();
  const existing = await viewAccountMaybe(provider, accountId);

  if (existing === null) {
    const actionList: Action[] = [actions.createAccount()];
    if (nearAmount > 0n) {
      actionList.push(actions.transfer(nearAmount));
    }
    actionList.push(actions.addFullAccessKey(keyPair.getPublicKey()));
    await send(root, accountId, actionList, `${step}: create ${accountId}`);
    record('sandbox-demo', `created ${accountId} with ${nearAmount} yocto NEAR`);
  } else {
    let permission: unknown;
    try {
      const accessKey = await provider.viewAccessKey({
        accountId,
        publicKey,
        finalityQuery: { finality: 'final' },
      });
      permission = accessKey.permission;
    } catch (error) {
      fail(
        step,
        `${accountId} already exists without the deterministic sandbox key ${publicKey}; ` +
          `remove the sandbox home or use a fresh sandbox (${messageOf(error)})`,
        error
      );
    }
    if (permission !== 'FullAccess') {
      fail(step, `${accountId} key ${publicKey} is not FullAccess`);
    }
    if (nearAmount === 0n) {
      if (existing.amount !== 0n) {
        fail(
          step,
          `${accountId} must hold zero liquid NEAR but already holds ${existing.amount} yocto; ` +
            'use a fresh sandbox'
        );
      }
    } else if (existing.amount < nearAmount) {
      await send(
        root,
        accountId,
        [actions.transfer(nearAmount - existing.amount)],
        `${step}: fund ${accountId}`
      );
    }
  }

  const account = new Account(accountId, provider, secretKey as KeyPairString);
  const view = await provider.viewAccount({
    accountId,
    blockQuery: { finality: 'final' },
  });
  if (nearAmount === 0n && view.amount !== 0n) {
    fail(step, `${accountId} must hold zero liquid NEAR, found ${view.amount} yocto`);
  }
  return account;
}

async function ensureContract(
  provider: JsonRpcProvider,
  root: Account,
  accountId: string,
  secretKey: string,
  wasmPath: string,
  label: string
): Promise<Account> {
  const account = await ensureAccount(
    provider,
    root,
    accountId,
    secretKey,
    20n * ONE_NEAR,
    `deploy ${label}`
  );
  const view = await viewAccountMaybe(provider, accountId);
  if (view === null) {
    fail(`deploy ${label}`, `${accountId} disappeared after creation`);
  }
  if (view.code_hash === EMPTY_CODE_HASH) {
    const code = new Uint8Array(readFileSync(wasmPath));
    await send(account, accountId, [actions.deployContract(code)], `deploy ${label} (${wasmPath})`);
    record('sandbox-demo', `deployed ${label} to ${accountId} (${code.byteLength} bytes)`);
  } else {
    record('sandbox-demo', `${label} already deployed at ${accountId} (${view.code_hash})`);
  }
  return account;
}

async function setupChain(config: SandboxDemoConfig, sandbox: SandboxRuntime): Promise<ChainSetup> {
  const ids = accountIdsFor(sandbox.rootAccount);
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(sandbox.rootAccount, provider, sandbox.rootSecretKey as KeyPairString);

  const rootView = await provider.viewAccount({
    accountId: sandbox.rootAccount,
    blockQuery: { finality: 'final' },
  });
  if (rootView.amount < 500n * ONE_NEAR) {
    fail(
      'fund demo accounts',
      `sandbox root ${sandbox.rootAccount} holds only ${rootView.amount} yocto NEAR; ` +
        'at least 500 NEAR is needed to fund the demo accounts'
    );
  }

  const accounts = {} as Record<Role, Account>;
  for (const role of Object.keys(DEMO_SECRET_KEYS) as Role[]) {
    accounts[role] = await ensureAccount(
      provider,
      root,
      ids[role],
      DEMO_SECRET_KEYS[role],
      ROLE_NEAR[role],
      'create demo accounts'
    );
  }

  await ensureContract(
    provider,
    root,
    ids.token,
    CONTRACT_SECRET_KEYS.token,
    config.tokenWasm,
    'payment token'
  );
  await ensureContract(
    provider,
    root,
    ids.split,
    CONTRACT_SECRET_KEYS.split,
    config.splitWasm,
    'revenue split'
  );

  const tokenMetadata = await viewMaybe(provider, ids.token, 'ft_metadata', {});
  if (tokenMetadata === null) {
    await send(
      accounts.owner,
      ids.token,
      [
        actions.functionCall(
          'new',
          { owner_id: ids.owner, total_supply: FT_TOTAL_SUPPLY },
          teraToGas(100),
          0n
        ),
      ],
      'initialize FT'
    );
    record('sandbox-demo', `initialized FT ${ids.token} with supply ${FT_TOTAL_SUPPLY}`);
  } else {
    if (!isRecord(tokenMetadata) || Number(tokenMetadata['decimals']) !== 18) {
      fail(
        'initialize FT',
        `${ids.token} is initialized with unexpected metadata: ${JSON.stringify(tokenMetadata)}`
      );
    }
    record('sandbox-demo', `reusing initialized FT ${ids.token}`);
  }

  const splitTotals = await viewMaybe(provider, ids.split, 'get_totals', {});
  if (splitTotals === null) {
    await send(
      accounts.owner,
      ids.split,
      [
        actions.functionCall(
          'new',
          {
            owner_id: ids.owner,
            ft_account_id: ids.token,
            platform_wallet: ids.platform,
            platform_fee_bps: 2_000,
          },
          teraToGas(100),
          0n
        ),
      ],
      'initialize revenue split'
    );
    record('sandbox-demo', `initialized split ${ids.split} at 2000 bps`);
  } else {
    record('sandbox-demo', `reusing initialized split ${ids.split}`);
  }

  for (const accountId of [ids.buyer, ids.split, ids.developer, ids.platform, ids.subscriber]) {
    const storage = await viewMaybe(provider, ids.token, 'storage_balance_of', {
      account_id: accountId,
    });
    if (storage === null) {
      await send(
        accounts.owner,
        ids.token,
        [
          actions.functionCall(
            'storage_deposit',
            { account_id: accountId, registration_only: true },
            teraToGas(30),
            STORAGE_DEPOSIT_NEAR
          ),
        ],
        `storage_deposit(${accountId})`
      );
      record('sandbox-demo', `registered ${accountId} with the FT (0.01 NEAR)`);
    }
  }

  for (const role of ['buyer', 'subscriber'] as const) {
    const accountId = ids[role];
    const balanceRaw = await viewMaybe(provider, ids.token, 'ft_balance_of', {
      account_id: accountId,
    });
    const balance = parseU128(balanceRaw, `ft_balance_of(${accountId})`);
    if (balance < FT_DEMO_FUNDING) {
      await send(
        accounts.owner,
        ids.token,
        [
          actions.functionCall(
            'ft_transfer',
            {
              receiver_id: accountId,
              amount: (FT_DEMO_FUNDING - balance).toString(),
              memo: null,
            },
            teraToGas(30),
            ONE_YOCTO
          ),
        ],
        `ft_transfer(${accountId})`
      );
      record(
        'sandbox-demo',
        `funded ${accountId} with ${(FT_DEMO_FUNDING - balance).toString()} raw FT units`
      );
    }
  }

  const toolInfo = await viewMaybe(provider, ids.split, 'get_tool_info', { name: TOOL_NAME });
  if (toolInfo === null) {
    await send(
      accounts.owner,
      ids.split,
      [
        actions.functionCall(
          'register_tool',
          { name: TOOL_NAME, developer: ids.developer, price: TOOL_PRICE },
          teraToGas(100),
          REGISTRATION_DEPOSIT_NEAR
        ),
      ],
      `register_tool(${TOOL_NAME})`
    );
    record('sandbox-demo', `registered ${TOOL_NAME} -> ${ids.developer} at ${TOOL_PRICE}`);
  } else {
    if (
      !isRecord(toolInfo) ||
      toolInfo['developer'] !== ids.developer ||
      parseU128(toolInfo['price_per_call'], 'get_tool_info.price_per_call') !==
        BigInt(TOOL_PRICE) ||
      toolInfo['active'] !== true
    ) {
      fail(
        `register_tool(${TOOL_NAME})`,
        `existing tool differs from the demo fixtures: ${JSON.stringify(toolInfo)}`
      );
    }
  }

  const buyerView = await provider.viewAccount({
    accountId: ids.buyer,
    blockQuery: { finality: 'final' },
  });
  if (buyerView.amount !== 0n) {
    fail(
      'buyer zero NEAR',
      `buyer ${ids.buyer} holds ${buyerView.amount} yocto NEAR; the demo requires zero`
    );
  }
  const buyerKey = KeyPair.fromString(DEMO_SECRET_KEYS.buyer as KeyPairString)
    .getPublicKey()
    .toString();
  const buyerAccessKey = await provider.viewAccessKey({
    accountId: ids.buyer,
    publicKey: buyerKey,
    finalityQuery: { finality: 'final' },
  });
  if (buyerAccessKey.permission !== 'FullAccess') {
    fail('buyer zero NEAR', `buyer key ${buyerKey} is not FullAccess`);
  }
  record('sandbox-demo', `buyer ${ids.buyer} is initialized, FullAccess, 0 NEAR`);

  return { provider, ids, accounts };
}

function serviceEnvironment(
  config: SandboxDemoConfig,
  sandbox: SandboxRuntime,
  ids: AccountIds
): NodeJS.ProcessEnv {
  const facilitatorUrl = `http://127.0.0.1:${config.facilitatorPort}`;
  const paywallUrl = `http://127.0.0.1:${config.paywallPort}`;
  return {
    ...process.env,
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    PORTICO_NETWORK: 'near:testnet',
    PORTICO_RPC_URL: sandbox.rpcUrl,
    PORTICO_SPLIT_CONTRACT: ids.split,
    PORTICO_TOKEN_CONTRACT: ids.token,
    PORTICO_EXPECTED_DECIMALS: '18',
    PORTICO_RELAYER_ID: ids.relayer,
    PORTICO_RELAYER_SECRET_KEYS: JSON.stringify([DEMO_SECRET_KEYS.relayer]),
    PORTICO_PLATFORM_WALLET: ids.platform,
    PORTICO_FEE_BPS: '2000',
    PORTICO_FACILITATOR_PORT: String(config.facilitatorPort),
    HOST: '127.0.0.1',
    FACILITATOR_URL: facilitatorUrl,
    PORTICO_MAX_TIMEOUT_SECONDS: '60',
    PORTICO_FINALITY_LAG_BLOCKS: '3',
    PORTICO_SETTLEMENT_CACHE_TTL_MS: '120000',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_MAX: '1000',
    PORTICO_ALLOWED_ORIGINS: paywallUrl,
    PAYWALL_PORT: String(config.paywallPort),
    PAYWALL_PRICE: TOOL_PRICE,
    PAYWALL_TOOL: TOOL_NAME,
    PAYWALL_RESOURCE_URL: `${paywallUrl}/premium`,
    PAYWALL_DESCRIPTION: 'portico sandbox premium resource',
    PAYWALL_MAX_TIMEOUT_SECONDS: '60',
    PAYWALL_ALLOWED_ORIGINS: paywallUrl,
  };
}

function demoEnvironment(
  config: SandboxDemoConfig,
  sandbox: SandboxRuntime,
  ids: AccountIds
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FACILITATOR_URL: `http://127.0.0.1:${config.facilitatorPort}`,
    PORTICO_RPC_URL: sandbox.rpcUrl,
    PORTICO_NETWORK: 'near:testnet',
    PORTICO_TOKEN_CONTRACT: ids.token,
    PORTICO_SPLIT_CONTRACT: ids.split,
    PORTICO_BUYER_ACCOUNT: ids.buyer,
    PORTICO_BUYER_SECRET_KEY: DEMO_SECRET_KEYS.buyer,
    PORTICO_STREAM_SUBSCRIBER_ACCOUNT: ids.subscriber,
    PORTICO_STREAM_SUBSCRIBER_SECRET_KEY: DEMO_SECRET_KEYS.subscriber,
    PORTICO_STREAM_RECIPIENT: ids.developer,
    PORTICO_DEV_ACCOUNT: ids.developer,
    PORTICO_DEMO_TOOL: TOOL_NAME,
    PORTICO_DEMO_EXPECTED_AMOUNT: QUOTED_AMOUNT,
    PORTICO_DEMO_CLIFF_BLOCKS: String(CLIFF_BLOCKS),
    PORTICO_DEMO_STREAM_DEPOSIT: STREAM_DEPOSIT,
    PORTICO_DEMO_STREAM_RATE: STREAM_RATE,
    PORTICO_DEMO_MAX_MS: String(config.demoMaxMs),
    PORTICO_MAX_TIMEOUT_SECONDS: '60',
    PORTICO_SANDBOX_RPC_URL: sandbox.rpcUrl,
  };
}

async function waitForHealth(name: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  for (;;) {
    const entry = processes.get(name);
    if (entry !== undefined && !processIsRunning(entry.child)) {
      fail(
        'start services',
        `${name} exited before ${url} became healthy (code ${entry.child.exitCode ?? 'null'})\n` +
          tailOf(name)
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body: unknown = await response.json();
        if (isRecord(body) && body['status'] === 'ok') {
          record('sandbox-demo', `${name} healthy at ${url}`);
          return;
        }
        lastError = `unexpected health body: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = messageOf(error);
    }
    if (Date.now() >= deadline) {
      fail(
        'start services',
        `${name} did not become healthy at ${url} within ${timeoutMs} ms: ${lastError}\n` +
          tailOf(name)
      );
    }
    await delay(250);
  }
}

function parseDemoTotalMs(output: string): number {
  const match = /^\s*total:\s*(\d+(?:\.\d+)?)\s*$/m.exec(output);
  if (match === null) {
    fail('run demo', 'demo output has no "total: <ms>" timing line');
  }
  const raw = match[1];
  if (raw === undefined) {
    fail('run demo', 'demo total timing line is empty');
  }
  return Number(raw);
}

async function main(): Promise<void> {
  const config = loadConfig();
  transcript = new Transcript(config.transcriptPath);
  installSignalHandlers();

  const pnpm =
    process.platform === 'win32'
      ? { command: 'pnpm.cmd', shell: true }
      : { command: 'pnpm', shell: false };
  record('sandbox-demo', 'portico sandbox demo (PIN 3 reproducibility harness)');
  record('sandbox-demo', `repo: ${config.repoRoot}`);
  record('sandbox-demo', `node: ${process.version} (${process.platform}/${process.arch})`);
  record('sandbox-demo', `transcript: ${config.transcriptPath}`);
  record('sandbox-demo', `token wasm: ${config.tokenWasm}`);
  record('sandbox-demo', `split wasm: ${config.splitWasm}`);
  if (config.sandboxBin !== undefined) {
    record('sandbox-demo', `near-sandbox: ${config.sandboxBin}`);
  }

  await withStep('start sandbox', async () => {
    const sandbox = await prepareSandbox(config);
    runtime = sandbox;
    return sandbox;
  });
  const sandbox = runtime;
  if (sandbox === null) {
    fail('start sandbox', 'internal error: sandbox runtime was not initialized');
  }
  record('sandbox-demo', `sandbox root: ${sandbox.rootAccount} at ${sandbox.rpcUrl}`);

  const chain = await withStep('setup chain', () => setupChain(config, sandbox));

  await withStep('start services', async () => {
    await assertPortFree(config.facilitatorPort, 'facilitator');
    await assertPortFree(config.paywallPort, 'paywall');
    const env = serviceEnvironment(config, sandbox, chain.ids);
    spawnManaged('facilitator', pnpm.command, ['--filter', '@portico/facilitator', 'dev'], {
      cwd: config.repoRoot,
      env,
    });
    spawnManaged('paywall', pnpm.command, ['--filter', 'paywall', 'dev'], {
      cwd: config.repoRoot,
      env,
    });
    await Promise.all([
      waitForHealth(
        'facilitator',
        `http://127.0.0.1:${config.facilitatorPort}/health`,
        SERVICE_HEALTH_TIMEOUT_MS
      ),
      waitForHealth(
        'paywall',
        `http://127.0.0.1:${config.paywallPort}/health`,
        SERVICE_HEALTH_TIMEOUT_MS
      ),
    ]);
  });

  const demoStarted = Date.now();
  const demoMs = await withStep(config.benchMode ? 'run bench' : 'run demo', async () => {
    if (config.benchMode) {
      spawnManaged('bench', pnpm.command, ['bench', '--json'], {
        cwd: config.repoRoot,
        env: {
          ...demoEnvironment(config, sandbox, chain.ids),
          PORTICO_BENCH_TRANSCRIPT: config.benchTranscriptPath,
        },
      });
      const benchCode = await waitForExit('bench', 30 * 60_000);
      const benchOutput = tailOf('bench', 2_000);
      if (benchCode !== 0) {
        fail('run bench', `pnpm bench exited with ${benchCode}\n${benchOutput}`);
      }
      record('sandbox-demo', `bench transcript ${config.benchTranscriptPath}`);
      return Date.now() - demoStarted;
    }
    spawnManaged('demo', pnpm.command, ['demo'], {
      cwd: config.repoRoot,
      env: demoEnvironment(config, sandbox, chain.ids),
    });
    const code = await waitForExit('demo', config.demoMaxMs + 60_000);
    const wallMs = Date.now() - demoStarted;
    const output = tailOf('demo', 400);
    if (code !== 0) {
      fail('run demo', `pnpm demo exited with ${code}\n${output}`);
    }
    if (!/^OK: quote -> verify -> settle -> ledger sale -> stream -> claim/m.test(output)) {
      fail('run demo', `demo did not print its OK line\n${output}`);
    }
    const reportedMs = parseDemoTotalMs(output);
    if (reportedMs >= config.demoMaxMs) {
      fail(
        'run demo',
        `demo reported ${reportedMs} ms, which is not under the ${config.demoMaxMs} ms budget`
      );
    }
    if (wallMs >= config.demoMaxMs) {
      fail(
        'run demo',
        `demo wall clock ${wallMs} ms includes startup and is not under the ` +
          `${config.demoMaxMs} ms budget (demo reported ${reportedMs} ms)`
      );
    }
    record(
      'sandbox-demo',
      `demo reported ${reportedMs} ms; wall clock ${wallMs} ms (< ${config.demoMaxMs} ms)`
    );
    return reportedMs;
  });

  await withStep('assert buyer zero NEAR', async () => {
    const buyerView = await chain.provider.viewAccount({
      accountId: chain.ids.buyer,
      blockQuery: { finality: 'final' },
    });
    if (buyerView.amount !== 0n) {
      fail(
        'assert buyer zero NEAR',
        `buyer ${chain.ids.buyer} holds ${buyerView.amount} yocto NEAR after the run`
      );
    }
    record(
      'sandbox-demo',
      `buyer ${chain.ids.buyer} still holds 0 NEAR after the sale and stream claim`
    );
  });

  mainSucceeded = true;
  record('sandbox-demo', 'timings (ms):');
  for (const timing of stepTimings) {
    record('sandbox-demo', `  ${timing.label}: ${timing.ms}`);
  }
  record(
    'sandbox-demo',
    `OK: sandbox demo completed; demo total ${demoMs} ms (< ${config.demoMaxMs} ms), ` +
      `buyer ${chain.ids.buyer} holds 0 NEAR`
  );
  record('sandbox-demo', `transcript: ${config.transcriptPath}`);
}

main()
  .catch(error => {
    const step = error instanceof DemoFailure ? error.step : 'startup';
    const detail = messageOf(error);
    record('sandbox-demo', `FAILED at ${step}: ${detail}`, 'err');
    if (error instanceof DemoFailure && error.cause !== undefined) {
      record('sandbox-demo', `cause: ${messageOf(error.cause)}`, 'err');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
