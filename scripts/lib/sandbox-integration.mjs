/**
 * Native near-sandbox 0.3.5 integration harness for portico.
 *
 * This is a `node --test` port of the 23 near-workspaces Rust scenarios in
 * `tests/split.rs` (12), `tests/registry.rs` (8) and `tests/stream.rs` (3).
 * Every assertion mirrors its Rust counterpart: raw FT balances, withdrawable
 * developer/platform balances, ledger entries, aggregate totals/events and
 * stream accrual. Transactions are signed with the pinned `near-api-js` 7.5.3
 * and submitted to a locally launched near-sandbox; views use raw JSON-RPC.
 *
 * IMPORTANT — Linux native FS only. near-sandbox 0.3.5 extracts/launches its
 * `neard` binary with a rename/chmod that fails with EXDEV on the Windows 9P
 * mount (`/mnt/d`). Run this file from a WSL2 native-Linux working directory
 * (e.g. /home/eya/portico-int) with the near-sandbox package vendored there:
 *
 *   cp scripts/lib/sandbox-integration.mjs /home/eya/portico-int/
 *   cd /home/eya/portico-int
 *   NEAR_RPC_TIMEOUT_SECS=180 node --test --test-force-exit sandbox-integration.mjs
 *
 * Path overrides (all optional): PORTICO_WORKDIR, PORTICO_REPO,
 * NEAR_SANDBOX_ESM, NEAR_API_JS_CJS, PORTICO_SPLIT_WASM, PORTICO_TOKEN_WASM.
 *
 * A single sandbox is shared across the run; each scenario calls setup(), which
 * creates a FRESH set of accounts and self-deploys FRESH copies of both WASMs,
 * so state is isolated exactly like the Rust `Harness::setup()` (one sandbox per
 * test). Account ids are `<label><seq>.test.near`, minted by the sandbox root.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const WORKDIR = process.env.PORTICO_WORKDIR || '/home/eya/portico-int';
const REPO = process.env.PORTICO_REPO || '/mnt/d/near/portico/repo';
const SANDBOX_ESM = process.env.NEAR_SANDBOX_ESM || `${WORKDIR}/vendor/near-sandbox/dist/esm/index.mjs`;
const NAJ_CJS = process.env.NEAR_API_JS_CJS || `${REPO}/node_modules/near-api-js/lib/index.cjs`;
const SPLIT_WASM = process.env.PORTICO_SPLIT_WASM || `${REPO}/contracts/revenue-split/target/near/portico_revenue_split.wasm`;
const TOKEN_WASM = process.env.PORTICO_TOKEN_WASM || `${REPO}/contracts/payment-token/target/near/portico_payment_token.wasm`;
const ROOT = 'test.near';

const TGAS = 1_000_000_000_000n;
const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const BUYER_FUNDING = 10_000_000n * E18;
const REGISTRATION_DEPOSIT = 10n ** 24n;        // 1 NEAR
const STORAGE_DEPOSIT = 10n * 10n ** 24n;       // 10 NEAR (registration_only refunds excess)
const ONE_YOCTO = 1n;
const FEE_BPS = 2000;
const BPS_DENOM = 10_000n;
const CLIFF_BLOCKS = 3600;

let Sandbox, naj, SB, provider, rootAccount;
let seq = 0;
let rpcId = 1000;

async function ensureSandbox() {
  if (SB) return;
  ({ Sandbox } = await import(SANDBOX_ESM));
  naj = require(NAJ_CJS);
  SB = await Sandbox.start({});
  const vk = JSON.parse(await readFile(`${SB.homeDir}/validator_key.json`, 'utf8'));
  provider = new naj.JsonRpcProvider({ url: SB.rpcUrl });
  rootAccount = new naj.Account(ROOT, provider, naj.KeyPair.fromString(vk.secret_key).toString());
}

async function viewJson(contractId, method, args = {}) {
  const res = await fetch(SB.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: ++rpcId, method: 'query',
      params: {
        request_type: 'call_function', finality: 'final', account_id: contractId,
        method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
}

async function makeAccount(label) {
  seq += 1;
  const id = `${label}${seq}.${ROOT}`;
  const kp = naj.KeyPair.fromRandom('ed25519');
  await rootAccount.createAccount({
    newAccountId: id,
    publicKey: kp.getPublicKey().toString(),
    nearToTransfer: 100n * 10n ** 24n,
  });
  return new naj.Account(id, provider, kp.toString());
}

const fc = (method, args, gas, deposit) => naj.actions.functionCall(method, args, gas, deposit);

// throwOnFailure:false -> always return the FinalExecutionOutcome so we can parse
// status/receipts ourselves (faithful to near-workspaces ExecutionFinalResult).
async function send(from, receiverId, actions, throwOnFailure = true) {
  return from.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure });
}

function isSuccess(o) {
  return !!(o && o.status && ('SuccessValue' in o.status || 'SuccessReceiptId' in o.status));
}
function isFailure(o) {
  return !!(o && o.status && 'Failure' in o.status);
}
function receiptFailures(o) {
  return (o?.receipts_outcome || []).filter(r => r.outcome?.status && 'Failure' in r.outcome.status);
}
function mustSucceed(o, label) {
  assert.ok(isSuccess(o), `${label} failed: ${JSON.stringify(o?.status)}`);
}
function expectFailure(o, label) {
  assert.ok(isFailure(o), `${label} unexpectedly succeeded: ${JSON.stringify(o?.status)}`);
}
function expectHandledFailure(o, label) {
  assert.ok(isSuccess(o), `${label} tx failed: ${JSON.stringify(o?.status)}`);
  assert.ok(receiptFailures(o).length > 0, `${label} expected >=1 failed receipt`);
}
/** Compare a U128 (JSON string) / number / bigint by numeric value. */
const eqU = (a, e, m) => {
  const av = BigInt(a), ev = BigInt(e);
  assert.equal(av, ev, m === undefined ? `U128: expected ${ev}, got ${av}` : m);
};

// ---- ft_transfer_call message builders (mirror tests/src/lib.rs) ----
const payDevelopersMsg = developer => ({ action: 'pay_developers', developer, memo: null });
const batchMsg = payments => ({
  action: 'pay_developers_batch',
  payments: payments.map(([developer, amount]) => ({ developer, amount: amount.toString(), memo: null })),
});
const payToolMsg = tool => ({ action: 'pay_tool', tool });
const payToolsMsg = tools => ({ action: 'pay_tools', tools });
const openStreamMsg = (recipient, ratePerBlock, cliffBlocks) => ({
  action: 'open_stream', recipient, rate_per_block: ratePerBlock.toString(), cliff_blocks: cliffBlocks,
});

function fuzzAmounts() {
  const step = 1_000n * E18 / 19n;
  const amounts = [];
  for (let i = 0n; i < 20n; i += 1n) amounts.push(1n + i * step);
  amounts[0] = 1n;
  amounts[19] = 1_000n * E18;
  amounts.push(1_000_000n * E18);
  return amounts;
}

async function setup() {
  await ensureSandbox();
  const owner = await makeAccount('owner');
  const buyer = await makeAccount('buyer');
  const developer = await makeAccount('dev');
  const platform = await makeAccount('platform');
  const token = await makeAccount('token');
  const split = await makeAccount('split');
  const tokenCode = new Uint8Array(await readFile(TOKEN_WASM));
  const splitCode = new Uint8Array(await readFile(SPLIT_WASM));

  // self-deploy + init (strict: a setup failure throws loudly)
  mustSucceed(await send(token, token.accountId, [naj.actions.deployContract(tokenCode)]), 'deploy token');
  mustSucceed(await send(token, token.accountId, [fc('new', { owner_id: owner.accountId, total_supply: TOTAL_SUPPLY.toString() }, 100n * TGAS, 0n)]), 'token.new');
  mustSucceed(await send(split, split.accountId, [naj.actions.deployContract(splitCode)]), 'deploy split');
  mustSucceed(await send(split, split.accountId, [fc('new', { owner_id: owner.accountId, ft_account_id: token.accountId, platform_wallet: platform.accountId, platform_fee_bps: FEE_BPS }, 100n * TGAS, 0n)]), 'split.new');

  for (const id of [buyer.accountId, split.accountId, developer.accountId, platform.accountId]) {
    mustSucceed(await send(owner, token.accountId, [fc('storage_deposit', { account_id: id, registration_only: true }, 30n * TGAS, STORAGE_DEPOSIT)]), `storage_deposit(${id})`);
  }
  mustSucceed(await send(owner, token.accountId, [fc('ft_transfer', { receiver_id: buyer.accountId, amount: BUYER_FUNDING.toString(), memo: null }, 30n * TGAS, ONE_YOCTO)]), 'seed buyer');

  const h = {
    owner, buyer, developer, platform, token, split,
    // scenario transactions (throwOnFailure:false -> parse outcome ourselves)
    callSplit: (from, method, args, deposit, gasTgas) =>
      send(from, split.accountId, [fc(method, args, BigInt(gasTgas) * TGAS, deposit)], false),
    registerTool: (from, name, developerId, price, deposit = REGISTRATION_DEPOSIT) =>
      h.callSplit(from, 'register_tool', { name, developer: developerId, price: price.toString() }, deposit, 100),
    withdrawBalance: from => h.callSplit(from, 'withdraw_developer_balance', {}, ONE_YOCTO, 50),
    claim: (from, streamId) => h.callSplit(from, 'claim', { stream_id: streamId }, 0n, 50),
    ftc: (amount, msg) => send(buyer, token.accountId, [fc('ft_transfer_call', {
      receiver_id: split.accountId, amount: amount.toString(), memo: null, msg: JSON.stringify(msg),
    }, 150n * TGAS, ONE_YOCTO)], false),
    storageDeposit: accountId => send(owner, token.accountId, [fc('storage_deposit', { account_id: accountId, registration_only: true }, 30n * TGAS, STORAGE_DEPOSIT)], true),
    newAccount: () => makeAccount('extra'),
    newRegisteredAccount: async () => {
      const a = await makeAccount('reg');
      mustSucceed(await h.storageDeposit(a.accountId), 'storage_deposit(new account)');
      return a;
    },
    // views
    ftBalance: accountId => viewJson(token.accountId, 'ft_balance_of', { account_id: accountId }).then(BigInt),
    developerBalance: accountId => viewJson(split.accountId, 'get_developer_balance', { account: accountId }).then(BigInt),
    totals: () => viewJson(split.accountId, 'get_totals'),
    ledger: (afterId = null, limit = 100) => viewJson(split.accountId, 'get_ledger', { after_id: afterId, limit }),
    calculateSplit: amount => viewJson(split.accountId, 'calculate_split', { amount: amount.toString() }),
    toolInfo: name => viewJson(split.accountId, 'get_tool_info', { name }),
    fullToolInfo: name => viewJson(split.accountId, 'get_full_tool_info', { name }),
    developerTools: developerId => viewJson(split.accountId, 'get_developer_tools', { developer: developerId }),
    isToolActive: name => viewJson(split.accountId, 'is_tool_active', { name }),
    stream: streamId => viewJson(split.accountId, 'get_stream', { stream_id: streamId }),
    streamAccrual: streamId => viewJson(split.accountId, 'get_stream_view', { stream_id: streamId }),
    streamDeposit: streamId => viewJson(split.accountId, 'get_stream_deposit', { stream_id: streamId }).then(BigInt),
  };
  return h;
}

const t = (name, fn) => test(name, { timeout: 180000 }, fn);

describe('portico native sandbox integration (23 scenarios)', { concurrency: false }, () => {
  // --------------------------- split.rs (12) ---------------------------
  t('split_pays_developer_and_platform_from_one_transfer', async () => {
    const h = await setup();
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(100n, payDevelopersMsg(h.developer.accountId)), 'pay_developers');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - 100n, 'buyer');
    eqU(await h.ftBalance(h.developer.accountId), 80n, 'dev ft');
    eqU(await h.ftBalance(h.split.accountId), 20n, 'split ft');
    eqU(await h.developerBalance(h.developer.accountId), 0n, 'dev balance');
    eqU(await h.developerBalance(h.platform.accountId), 20n, 'platform balance');
    const totals = await h.totals();
    eqU(totals.settled_volume, 100n, 'settled_volume');
    eqU(totals.total_developer_balance, 20n, 'total_developer_balance');
    const split = await h.calculateSplit(100n);
    eqU(split.developer, 80n, 'split.developer');
    eqU(split.platform, 20n, 'split.platform');
    const ledger = await h.ledger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].id, 1);
    assert.equal(ledger[0].payer, h.buyer.accountId);
    assert.equal(ledger[0].payee, h.developer.accountId);
    eqU(ledger[0].amount, 100n);
    assert.equal(ledger[0].action, 'payment');
    assert.ok(ledger[0].tool == null);
    assert.ok(ledger[0].memo == null);
    assert.ok(ledger[0].block_height > 0);
  });

  t('split_batch_pays_two_developers_and_platform', async () => {
    const h = await setup();
    const second = await h.newRegisteredAccount();
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(100n, batchMsg([[h.developer.accountId, 50n], [second.accountId, 50n]])), 'pay_developers_batch');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - 100n);
    eqU(await h.ftBalance(h.developer.accountId), 0n);
    eqU(await h.ftBalance(second.accountId), 0n);
    eqU(await h.ftBalance(h.split.accountId), 100n);
    eqU(await h.developerBalance(h.developer.accountId), 40n);
    eqU(await h.developerBalance(second.accountId), 40n);
    eqU(await h.developerBalance(h.platform.accountId), 20n);
    eqU((await h.totals()).total_developer_balance, 100n);
    mustSucceed(await h.withdrawBalance(h.developer), 'first developer withdrawal');
    mustSucceed(await h.withdrawBalance(second), 'second developer withdrawal');
    mustSucceed(await h.withdrawBalance(h.platform), 'platform withdrawal');
    eqU(await h.ftBalance(h.developer.accountId), 40n);
    eqU(await h.ftBalance(second.accountId), 40n);
    eqU(await h.ftBalance(h.platform.accountId), 20n);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    eqU(await h.developerBalance(h.developer.accountId), 0n);
    eqU(await h.developerBalance(second.accountId), 0n);
    eqU(await h.developerBalance(h.platform.accountId), 0n);
    eqU((await h.totals()).total_developer_balance, 0n);
    const ledger = await h.ledger();
    assert.equal(ledger.length, 5);
    assert.equal(ledger[0].action, 'payment'); eqU(ledger[0].amount, 50n); assert.equal(ledger[0].payee, h.developer.accountId);
    assert.equal(ledger[1].action, 'payment'); eqU(ledger[1].amount, 50n); assert.equal(ledger[1].payee, second.accountId);
    assert.equal(ledger[2].action, 'developer_payout'); eqU(ledger[2].amount, 40n);
    assert.equal(ledger[3].action, 'developer_payout'); eqU(ledger[3].amount, 40n);
    assert.equal(ledger[4].action, 'developer_payout'); eqU(ledger[4].amount, 20n); assert.equal(ledger[4].payee, h.platform.accountId);
  });

  t('split_zero_amount_reverts_inside_the_ft', async () => {
    const h = await setup();
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    expectFailure(await h.ftc(0n, payDevelopersMsg(h.developer.accountId)), 'zero-amount ft_transfer_call');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.developer.accountId), 0n);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    assert.equal((await h.ledger()).length, 0);
    const totals = await h.totals();
    eqU(totals.settled_volume, 0n);
    eqU(totals.total_developer_balance, 0n);
  });

  t('split_pay_developers_to_unregistered_developer_settles_balance', async () => {
    const h = await setup();
    const unlisted = await h.newAccount();
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    expectHandledFailure(await h.ftc(100n, payDevelopersMsg(unlisted.accountId)), 'unregistered developer payout');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - 100n);
    eqU(await h.ftBalance(unlisted.accountId), 0n);
    eqU(await h.ftBalance(h.split.accountId), 100n);
    eqU(await h.developerBalance(unlisted.accountId), 80n);
    eqU(await h.developerBalance(h.platform.accountId), 20n);
    eqU((await h.totals()).total_developer_balance, 100n);
    eqU((await h.totals()).settled_volume, 100n);
    const ledger = await h.ledger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].action, 'payment');
    assert.equal(ledger[0].payee, unlisted.accountId);
    eqU(ledger[0].amount, 100n);
    eqU(await h.ftBalance(h.split.accountId), 100n);
    mustSucceed(await h.withdrawBalance(unlisted), 'restored balance withdrawal');
    eqU(await h.ftBalance(unlisted.accountId), 0n);
    eqU(await h.ftBalance(h.split.accountId), 100n);
    eqU(await h.developerBalance(unlisted.accountId), 80n);
  });

  t('split_unknown_tool_returns_amount_unused', async () => {
    const h = await setup();
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(100n, payToolMsg('missing-tool')), 'unknown-tool ft_transfer_call');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    assert.ok((await h.toolInfo('missing-tool')) == null);
    assert.equal((await h.ledger()).length, 0);
    const totals = await h.totals();
    eqU(totals.settled_volume, 0n);
    assert.equal(totals.tools_count, 0);
  });

  t('split_fuzz_vectors_match_bps_math', async () => {
    const h = await setup();
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    const vectors = fuzzAmounts();
    let expectedPlatform = 0n, expectedDeveloper = 0n, expectedVolume = 0n;
    for (let index = 0; index < vectors.length; index += 1) {
      const amount = vectors[index];
      const platform = amount * BigInt(FEE_BPS) / BPS_DENOM;
      const developer = amount - platform;
      expectedPlatform += platform;
      expectedDeveloper += developer;
      expectedVolume += amount;
      mustSucceed(await h.ftc(amount, payDevelopersMsg(h.developer.accountId)), `fuzz pay_developers ${index}`);
      eqU(await h.ftBalance(h.developer.accountId), expectedDeveloper, `dev leg ${index}`);
      eqU(await h.ftBalance(h.split.accountId), expectedPlatform, `platform escrow ${index}`);
      eqU(await h.developerBalance(h.platform.accountId), expectedPlatform, `platform balance ${index}`);
      eqU((await h.totals()).settled_volume, expectedVolume, `settled volume ${index}`);
    }
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - expectedVolume);
    eqU(await h.developerBalance(h.developer.accountId), 0n);
    const ledger = await h.ledger();
    assert.equal(ledger.length, vectors.length);
    for (let index = 0; index < vectors.length; index += 1) {
      assert.equal(ledger[index].id, index + 1);
      eqU(ledger[index].amount, vectors[index]);
      assert.equal(ledger[index].action, 'payment');
      assert.equal(ledger[index].payee, h.developer.accountId);
    }
  });

  t('split_pay_tool_charges_price_and_refunds_excess', async () => {
    const h = await setup();
    const price = 1_000_000n;
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, price), 'register_tool');
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(price, payToolMsg('web-search')), 'exact-price pay_tool');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - price);
    eqU(await h.ftBalance(h.developer.accountId), 800_000n);
    eqU(await h.ftBalance(h.split.accountId), 200_000n);
    eqU(await h.developerBalance(h.platform.accountId), 200_000n);
    let tool = await h.toolInfo('web-search');
    assert.equal(tool.total_calls, 1);
    eqU(tool.total_revenue, price);
    eqU((await h.totals()).settled_volume, price);
    let ledger = await h.ledger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].action, 'tool_call');
    assert.equal(ledger[0].tool, 'web-search');
    eqU(ledger[0].amount, price);
    const excess = 500_000n;
    mustSucceed(await h.ftc(price + excess, payToolMsg('web-search')), 'excess pay_tool');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - 2n * price);
    eqU(await h.ftBalance(h.developer.accountId), 1_600_000n);
    eqU(await h.ftBalance(h.split.accountId), 400_000n);
    eqU(await h.developerBalance(h.platform.accountId), 400_000n);
    eqU((await h.totals()).settled_volume, 2n * price);
    tool = await h.toolInfo('web-search');
    assert.equal(tool.total_calls, 2);
    eqU(tool.total_revenue, 2n * price);
    assert.equal((await h.ledger()).length, 2);
    const underpay = price - 1n;
    mustSucceed(await h.ftc(underpay, payToolMsg('web-search')), 'underpaid pay_tool');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - 2n * price);
    tool = await h.toolInfo('web-search');
    assert.equal(tool.total_calls, 2);
    eqU(tool.total_revenue, 2n * price);
    assert.equal((await h.ledger()).length, 2);
  });

  t('split_pay_tool_inactive_tool_refunds', async () => {
    const h = await setup();
    const price = 1_000_000n;
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, price), 'register_tool');
    mustSucceed(await h.callSplit(h.developer, 'deactivate_tool', { name: 'web-search' }, 0n, 50), 'deactivate_tool');
    assert.equal(await h.isToolActive('web-search'), false);
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(price, payToolMsg('web-search')), 'inactive-tool pay_tool');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    assert.equal((await h.ledger()).length, 0);
    const tool = await h.toolInfo('web-search');
    assert.equal(tool.total_calls, 0);
    eqU(tool.total_revenue, 0n);
  });

  t('split_failed_payout_restores_developer_and_refunds_excess', async () => {
    const h = await setup();
    const unlisted = await h.newAccount();
    const price = 1_000_000n, excess = 500_000n;
    mustSucceed(await h.registerTool(h.developer, 'ghost-tool', unlisted.accountId, price), 'register_tool');
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    expectHandledFailure(await h.ftc(price + excess, payToolMsg('ghost-tool')), 'failed developer payout');
    eqU(await h.ftBalance(unlisted.accountId), 0n);
    eqU(await h.developerBalance(unlisted.accountId), 800_000n);
    eqU(await h.developerBalance(h.platform.accountId), 200_000n);
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - price);
    eqU(await h.ftBalance(h.split.accountId), 1_000_000n);
    eqU((await h.totals()).settled_volume, price);
    const tool = await h.toolInfo('ghost-tool');
    assert.equal(tool.total_calls, 1);
    eqU(tool.total_revenue, price);
  });

  t('split_paused_contract_refunds_value_in', async () => {
    const h = await setup();
    mustSucceed(await h.callSplit(h.owner, 'set_paused', { paused: true }, 0n, 30), 'set_paused(true)');
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(100n, payDevelopersMsg(h.developer.accountId)), 'paused pay_developers');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.developer.accountId), 0n);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    assert.equal((await h.ledger()).length, 0);
    eqU((await h.totals()).settled_volume, 0n);
    mustSucceed(await h.callSplit(h.owner, 'set_paused', { paused: false }, 0n, 30), 'set_paused(false)');
    mustSucceed(await h.ftc(100n, payDevelopersMsg(h.developer.accountId)), 'unpaused pay_developers');
    eqU(await h.ftBalance(h.developer.accountId), 80n);
    eqU(await h.ftBalance(h.split.accountId), 20n);
  });

  t('split_volume_and_balance_views_track_large_units', async () => {
    const h = await setup();
    const amount = 1_000n * E18;
    mustSucceed(await h.ftc(amount, payDevelopersMsg(h.developer.accountId)), 'large-unit pay_developers');
    const split = await h.calculateSplit(amount);
    eqU(split.platform, amount / 5n);
    eqU(split.developer, amount - amount / 5n);
    eqU(await h.ftBalance(h.developer.accountId), split.developer);
    eqU(await h.ftBalance(h.split.accountId), split.platform);
    eqU(await h.developerBalance(h.platform.accountId), split.platform);
  });

  t('split_pay_tools_batch_credits_each_leg_once', async () => {
    const h = await setup();
    const firstPrice = 1_000_000n, secondPrice = 2_000_000n;
    for (const [name, price] of [['web-search', firstPrice], ['image-gen', secondPrice]]) {
      mustSucceed(await h.registerTool(h.developer, name, h.developer.accountId, price), 'register batch tool');
    }
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    const total = firstPrice + secondPrice;
    mustSucceed(await h.ftc(total, payToolsMsg(['web-search', 'image-gen'])), 'pay_tools batch');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - total);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    eqU(await h.developerBalance(h.developer.accountId), 2_400_000n);
    eqU(await h.developerBalance(h.platform.accountId), 600_000n);
    eqU((await h.totals()).settled_volume, total);
    const ledger = await h.ledger();
    assert.equal(ledger.length, 2);
    assert.ok(ledger.every(e => e.action === 'tool_call'));
    assert.ok(ledger.every(e => e.payee === h.developer.accountId));
    assert.equal((await h.toolInfo('web-search')).total_calls, 1);
    assert.equal((await h.toolInfo('image-gen')).total_calls, 1);
  });

  // --------------------------- registry.rs (8) ---------------------------
  t('registry_registration_and_views', async () => {
    const h = await setup();
    const price = 2_000_000n;
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, price), 'register_tool');
    const info = await h.toolInfo('web-search');
    assert.ok(info != null);
    assert.equal(info.developer, h.developer.accountId);
    eqU(info.price_per_call, price);
    assert.equal(info.total_calls, 0);
    eqU(info.total_revenue, 0n);
    assert.equal(info.active, true);
    assert.ok(info.created_at_block > 0);
    assert.deepStrictEqual(await h.fullToolInfo('web-search'), info);
    assert.equal(await h.isToolActive('web-search'), true);
    assert.deepStrictEqual(await h.developerTools(h.developer.accountId), ['web-search']);
    assert.equal((await h.totals()).tools_count, 1);
    expectFailure(await h.registerTool(h.buyer, 'web-search', h.buyer.accountId, price), 'duplicate registration');
    assert.equal((await h.totals()).tools_count, 1);
    assert.deepStrictEqual(await h.developerTools(h.buyer.accountId), []);
    mustSucceed(await h.registerTool(h.buyer, 'summarize', h.buyer.accountId, price / 2n), 'second registration');
    assert.equal((await h.totals()).tools_count, 2);
    assert.deepStrictEqual(await h.developerTools(h.buyer.accountId), ['summarize']);
  });

  t('registry_rejects_underfunded_registration', async () => {
    const h = await setup();
    const price = 1_000_000n;
    expectFailure(await h.registerTool(h.developer, 'free-tool', h.developer.accountId, price, 0n), 'registration without a storage deposit');
    assert.ok((await h.toolInfo('free-tool')) == null);
    expectFailure(await h.registerTool(h.developer, 'dust-tool', h.developer.accountId, price, 1n), 'registration with a one-yocto deposit');
    assert.ok((await h.toolInfo('dust-tool')) == null);
    assert.equal((await h.totals()).tools_count, 0);
    assert.deepStrictEqual(await h.developerTools(h.developer.accountId), []);
    mustSucceed(await h.registerTool(h.developer, 'funded-tool', h.developer.accountId, price), 'funded registration');
    assert.equal((await h.totals()).tools_count, 1);
  });

  t('registry_price_and_status_auth', async () => {
    const h = await setup();
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, 1_000_000n), 'register_tool');
    const newPrice = '3000000';
    expectFailure(await h.callSplit(h.buyer, 'update_tool_price', { name: 'web-search', new_price: newPrice }, 0n, 50), 'buyer price update');
    expectFailure(await h.callSplit(h.owner, 'update_tool_price', { name: 'web-search', new_price: newPrice }, 0n, 50), 'owner price update');
    mustSucceed(await h.callSplit(h.developer, 'update_tool_price', { name: 'web-search', new_price: newPrice }, 0n, 50), 'developer price update');
    eqU((await h.toolInfo('web-search')).price_per_call, 3_000_000n);
    expectFailure(await h.callSplit(h.buyer, 'deactivate_tool', { name: 'web-search' }, 0n, 50), 'buyer deactivation');
    mustSucceed(await h.callSplit(h.developer, 'deactivate_tool', { name: 'web-search' }, 0n, 50), 'developer deactivation');
    assert.equal(await h.isToolActive('web-search'), false);
    mustSucceed(await h.callSplit(h.developer, 'reactivate_tool', { name: 'web-search' }, 0n, 50), 'developer reactivation');
    assert.equal(await h.isToolActive('web-search'), true);
    expectFailure(await h.callSplit(h.developer, 'deactivate_tool', { name: 'unknown-tool' }, 0n, 50), 'deactivate an unknown tool');
  });

  t('registry_transfer_tool_changes_authority', async () => {
    const h = await setup();
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, 1_000_000n), 'register_tool');
    expectFailure(await h.callSplit(h.buyer, 'update_tool_developer', { name: 'web-search', new_developer: h.buyer.accountId }, 0n, 50), 'buyer tool transfer');
    mustSucceed(await h.callSplit(h.developer, 'update_tool_developer', { name: 'web-search', new_developer: h.buyer.accountId }, 0n, 50), 'developer tool transfer');
    assert.deepStrictEqual(await h.developerTools(h.developer.accountId), []);
    assert.deepStrictEqual(await h.developerTools(h.buyer.accountId), ['web-search']);
    assert.equal((await h.toolInfo('web-search')).developer, h.buyer.accountId);
    expectFailure(await h.callSplit(h.developer, 'update_tool_price', { name: 'web-search', new_price: '4000000' }, 0n, 50), 'former developer price update');
    mustSucceed(await h.callSplit(h.buyer, 'update_tool_price', { name: 'web-search', new_price: '5000000' }, 0n, 50), 'new developer price update');
    eqU((await h.toolInfo('web-search')).price_per_call, 5_000_000n);
  });

  t('registry_force_deactivate_owner_only', async () => {
    const h = await setup();
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, 1_000_000n), 'register_tool');
    expectFailure(await h.callSplit(h.buyer, 'force_deactivate_tool', { name: 'web-search' }, 0n, 50), 'buyer force deactivation');
    assert.equal(await h.isToolActive('web-search'), true);
    expectFailure(await h.callSplit(h.developer, 'force_deactivate_tool', { name: 'web-search' }, 0n, 50), 'developer force deactivation');
    assert.equal(await h.isToolActive('web-search'), true);
    mustSucceed(await h.callSplit(h.owner, 'force_deactivate_tool', { name: 'web-search' }, 0n, 50), 'owner force deactivation');
    assert.equal(await h.isToolActive('web-search'), false);
    assert.equal((await h.toolInfo('web-search')).active, false);
    expectFailure(await h.callSplit(h.owner, 'force_deactivate_tool', { name: 'missing-tool' }, 0n, 50), 'force deactivate an unknown tool');
  });

  t('registry_rejects_invalid_tools', async () => {
    const h = await setup();
    const longName = 'a'.repeat(65);
    expectFailure(await h.registerTool(h.developer, '', h.developer.accountId, 1_000_000n), 'empty tool name');
    expectFailure(await h.registerTool(h.developer, longName, h.developer.accountId, 1_000_000n), '65-byte tool name');
    expectFailure(await h.registerTool(h.developer, 'free-tool', h.developer.accountId, 0n), 'zero price');
    assert.equal((await h.totals()).tools_count, 0);
    assert.ok((await h.toolInfo('')) == null);
    assert.ok((await h.toolInfo(longName)) == null);
    assert.ok((await h.toolInfo('free-tool')) == null);
    expectFailure(await h.callSplit(h.developer, 'update_tool_price', { name: 'missing-tool', new_price: '1000000' }, 0n, 50), 'update an unknown tool price');
  });

  t('registry_paused_blocks_registration', async () => {
    const h = await setup();
    expectFailure(await h.callSplit(h.buyer, 'set_paused', { paused: true }, 0n, 30), 'buyer pause');
    mustSucceed(await h.callSplit(h.owner, 'set_paused', { paused: true }, 0n, 30), 'owner pause');
    expectFailure(await h.registerTool(h.developer, 'web-search', h.developer.accountId, 1_000_000n), 'registration while paused');
    assert.ok((await h.toolInfo('web-search')) == null);
    assert.equal((await h.totals()).tools_count, 0);
    mustSucceed(await h.callSplit(h.owner, 'set_paused', { paused: false }, 0n, 30), 'owner unpause');
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, 1_000_000n), 'registration after unpause');
    assert.equal((await h.totals()).tools_count, 1);
  });

  t('registry_inactive_tool_refunds_payment', async () => {
    const h = await setup();
    const price = 1_000_000n;
    mustSucceed(await h.registerTool(h.developer, 'web-search', h.developer.accountId, price), 'register_tool');
    mustSucceed(await h.callSplit(h.developer, 'deactivate_tool', { name: 'web-search' }, 0n, 50), 'deactivate_tool');
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(price, payToolMsg('web-search')), 'inactive-tool payment');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    assert.equal((await h.ledger()).length, 0);
    eqU((await h.totals()).settled_volume, 0n);
    const tool = await h.toolInfo('web-search');
    assert.equal(tool.total_calls, 0);
    eqU(tool.total_revenue, 0n);
  });

  // --------------------------- stream.rs (3) ---------------------------
  t('stream_close_before_cliff_refunds_deposit', async () => {
    const h = await setup();
    const deposit = 10n * E18;
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(deposit, openStreamMsg(h.developer.accountId, E18, CLIFF_BLOCKS)), 'open_stream');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - deposit);
    mustSucceed(await h.callSplit(h.buyer, 'close_stream', { stream_id: 1 }, 0n, 100), 'close_stream before the cliff');
    eqU(await h.ftBalance(h.developer.accountId), 0n);
    eqU(await h.developerBalance(h.buyer.accountId), deposit);
    eqU(await h.ftBalance(h.split.accountId), deposit);
    const stream = await h.stream(1);
    assert.ok(stream != null);
    assert.equal(stream.status, 'closed');
    eqU(stream.deposit, 0n);
    eqU(stream.withdrawn, 0n);
    eqU(await h.streamDeposit(1), 0n);
    const totals = await h.totals();
    assert.equal(totals.open_streams, 0);
    assert.equal(totals.active_streams, 0);
    eqU(totals.settled_volume, 0n);
    const accrual = await h.streamAccrual(1);
    eqU(accrual.accrued, 0n);
    eqU(accrual.claimable, 0n);
    eqU(accrual.escrow_remaining, 0n);
    assert.equal(accrual.status, 'closed');
    expectFailure(await h.callSplit(h.buyer, 'close_stream', { stream_id: 1 }, 0n, 100), 'close an already closed stream');
    let ledger = await h.ledger();
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].action, 'stream_fund'); eqU(ledger[0].amount, deposit);
    assert.equal(ledger[1].action, 'stream_close'); eqU(ledger[1].amount, deposit);
    assert.equal(ledger[1].payer, h.buyer.accountId);
    assert.equal(ledger[1].payee, h.buyer.accountId);
    mustSucceed(await h.withdrawBalance(h.buyer), 'withdraw the stream refund');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    eqU(await h.developerBalance(h.buyer.accountId), 0n);
    ledger = await h.ledger();
    assert.equal(ledger.length, 3);
    assert.equal(ledger[2].action, 'developer_payout'); eqU(ledger[2].amount, deposit);
    assert.equal(ledger[2].payee, h.buyer.accountId);
  });

  t('stream_withdraw_unaccrued_bounds_and_close_refund', async () => {
    const h = await setup();
    const deposit = 10n * E18, rate = E18;
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(deposit, openStreamMsg(h.developer.accountId, rate, CLIFF_BLOCKS)), 'open_stream');
    expectFailure(await h.callSplit(h.owner, 'withdraw_unaccrued', { stream_id: 1, amount: E18.toString() }, ONE_YOCTO, 50), 'non-subscriber unaccrued withdrawal');
    expectFailure(await h.callSplit(h.buyer, 'withdraw_unaccrued', { stream_id: 1, amount: '0' }, ONE_YOCTO, 50), 'zero unaccrued withdrawal');
    expectFailure(await h.callSplit(h.buyer, 'withdraw_unaccrued', { stream_id: 1, amount: (deposit + E18).toString() }, ONE_YOCTO, 50), 'unaccrued withdrawal above the deposit');
    expectFailure(await h.callSplit(h.developer, 'withdraw_unaccrued', { stream_id: 1, amount: E18.toString() }, ONE_YOCTO, 50), 'recipient unaccrued withdrawal');
    mustSucceed(await h.callSplit(h.buyer, 'withdraw_unaccrued', { stream_id: 1, amount: (2n * E18).toString() }, ONE_YOCTO, 50), 'subscriber unaccrued withdrawal');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart - deposit + 2n * E18);
    eqU(await h.ftBalance(h.split.accountId), 8n * E18);
    eqU(await h.streamDeposit(1), 8n * E18);
    const accrual = await h.streamAccrual(1);
    eqU(accrual.accrued, 0n);
    eqU(accrual.claimable, 0n);
    eqU(accrual.escrow_remaining, 8n * E18);
    expectFailure(await h.callSplit(h.buyer, 'withdraw_unaccrued', { stream_id: 1, amount: (9n * E18).toString() }, ONE_YOCTO, 50), 'unaccrued withdrawal above the remaining deposit');
    mustSucceed(await h.callSplit(h.buyer, 'close_stream', { stream_id: 1 }, 0n, 100), 'close_stream after the withdrawal');
    eqU(await h.ftBalance(h.developer.accountId), 0n);
    eqU(await h.developerBalance(h.buyer.accountId), 8n * E18);
    eqU(await h.ftBalance(h.split.accountId), 8n * E18);
    eqU(await h.streamDeposit(1), 0n);
    assert.equal((await h.stream(1)).status, 'closed');
    let ledger = await h.ledger();
    assert.equal(ledger.length, 3);
    assert.equal(ledger[0].action, 'stream_fund'); eqU(ledger[0].amount, deposit);
    assert.equal(ledger[1].action, 'stream_withdraw'); eqU(ledger[1].amount, 2n * E18);
    assert.equal(ledger[1].payer, h.buyer.accountId);
    assert.equal(ledger[2].action, 'stream_close'); eqU(ledger[2].amount, 8n * E18);
    expectFailure(await h.claim(h.buyer, 999), 'claim an unknown stream');
    mustSucceed(await h.withdrawBalance(h.buyer), 'withdraw the stream refund');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    eqU(await h.developerBalance(h.buyer.accountId), 0n);
    ledger = await h.ledger();
    assert.equal(ledger.length, 4);
    assert.equal(ledger[3].action, 'developer_payout'); eqU(ledger[3].amount, 8n * E18);
  });

  t('stream_open_rejects_invalid_parameters', async () => {
    const h = await setup();
    const buyerStart = await h.ftBalance(h.buyer.accountId);
    mustSucceed(await h.ftc(E18, openStreamMsg(h.developer.accountId, 0n, CLIFF_BLOCKS)), 'open_stream with a zero rate');
    mustSucceed(await h.ftc(E18, openStreamMsg(h.developer.accountId, E18, CLIFF_BLOCKS - 1)), 'open_stream below the cliff minimum');
    mustSucceed(await h.ftc(E18, openStreamMsg(h.developer.accountId, E18, 31_536_001)), 'open_stream above the cliff maximum');
    eqU(await h.ftBalance(h.buyer.accountId), buyerStart);
    eqU(await h.ftBalance(h.split.accountId), 0n);
    assert.ok((await h.stream(1)) == null);
    assert.equal((await h.ledger()).length, 0);
    const totals = await h.totals();
    assert.equal(totals.open_streams, 0);
    assert.equal(totals.active_streams, 0);
  });
});

after(async () => {
  if (SB) {
    try { await SB.tearDown(); } catch { /* best-effort teardown */ }
  }
});
