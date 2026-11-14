#!/usr/bin/env node
/**
 * Deploy the portico payment FT and seed the demo accounts.
 *
 * The FT is self-deployed (the documented global-FT path is codeless on
 * testnet), pinned to 18 decimals. This script drives cargo-near and
 * near-cli-rs; key material stays in the near-cli keychain.
 *
 * Usage (from the repo root):
 *   pnpm deploy:ft
 *   pnpm deploy:ft -- --dry-run
 *   pnpm deploy:ft -- --skip-build
 */

try {
  process.loadEnvFile();
} catch {
  /* .env optional */
}
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAccountId, isU128 } from '../packages/sdk/src/guards.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tokenDir = path.join(repoRoot, 'contracts', 'payment-token');
const wasmPath = path.join(tokenDir, 'target', 'near', 'portico_payment_token.wasm');
const dryRun = process.argv.includes('--dry-run');
const skipBuild = process.argv.includes('--skip-build');

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value !== undefined && value !== '') {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${name} is required`);
}

function account(name: string, fallback?: string): string {
  const value = env(name, fallback);
  if (!isAccountId(value)) {
    throw new Error(`${name} is not a valid NEAR account id: ${value}`);
  }
  return value;
}

function amount(name: string, fallback: string): string {
  const value = env(name, fallback);
  if (!isU128(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive integer amount in raw FT units`);
  }
  return value;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(command: string, args: string[], cwd = repoRoot): void {
  const printable = [command, ...args].map(shellQuote).join(' ');
  if (dryRun) {
    console.log(`[dry-run] (cd ${cwd}) ${printable}`);
    return;
  }
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}

function nearCall(
  contract: string,
  method: string,
  args: Record<string, unknown>,
  signer: string,
  gas: string,
  deposit: string
): void {
  run('near', [
    'contract',
    'call-function',
    'as-transaction',
    contract,
    method,
    'json-args',
    JSON.stringify(args),
    'prepaid-gas',
    gas,
    'attached-deposit',
    deposit,
    'sign-as',
    signer,
    'network-config',
    'testnet',
    'sign-with-keychain',
    'send',
  ]);
}

function main(): void {
  const token = account('PORTICO_TOKEN_CONTRACT', 'token.portico.testnet');
  const deployer = account('PORTICO_DEPLOYER_ACCOUNT', 'portico.testnet');
  const buyer = account('PORTICO_BUYER_ACCOUNT', 'buyer1.portico.testnet');
  const developer = account('PORTICO_DEV_ACCOUNT', 'dev1.portico.testnet');
  const split = account('PORTICO_SPLIT_CONTRACT', 'split.portico.testnet');
  const platform = account('PORTICO_PLATFORM_WALLET', 'portico.testnet');
  const totalSupply = amount('PORTICO_FT_TOTAL_SUPPLY', '1000000000000000000000000000');
  const seedAmount = amount('PORTICO_FT_SEED_AMOUNT', '1000000000000000000000000');
  const storageDepositNear = env('PORTICO_STORAGE_DEPOSIT_NEAR', '0.01');

  if (BigInt(seedAmount) > BigInt(totalSupply)) {
    throw new Error('PORTICO_FT_SEED_AMOUNT exceeds PORTICO_FT_TOTAL_SUPPLY');
  }
  if (!/^\d+(\.\d+)?$/.test(storageDepositNear)) {
    throw new Error('PORTICO_STORAGE_DEPOSIT_NEAR must be a decimal NEAR amount');
  }

  console.log(`portico payment FT: ${token} (18 decimals)`);
  console.log(`deployer: ${deployer}  buyer: ${buyer}  split: ${split}  developer: ${developer}`);

  if (!skipBuild) {
    run('cargo', ['near', 'build', 'non-reproducible-wasm'], tokenDir);
  }

  run('near', [
    'contract',
    'deploy',
    token,
    'use-file',
    wasmPath,
    'without-init-call',
    'network-config',
    'testnet',
    'sign-with-keychain',
    'send',
  ]);

  nearCall(
    token,
    'new',
    { owner_id: deployer, total_supply: totalSupply },
    deployer,
    '100 Tgas',
    '0 NEAR'
  );

  const registrations = [buyer, split, developer, platform];
  for (const registrant of [...new Set(registrations)]) {
    nearCall(
      token,
      'storage_deposit',
      { account_id: registrant, registration_only: true },
      deployer,
      '30 Tgas',
      `${storageDepositNear} NEAR`
    );
  }

  nearCall(
    token,
    'ft_transfer',
    { receiver_id: buyer, amount: seedAmount, memo: 'portico demo seed' },
    deployer,
    '30 Tgas',
    '1 yoctoNEAR'
  );

  console.log(`done: minted ${totalSupply} raw units; seeded ${buyer} with ${seedAmount}`);
}

try {
  main();
} catch (error) {
  console.error(`deploy-ft failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
