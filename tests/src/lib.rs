//! Shared harness for the portico sandbox suite.
//!
//! Each integration test starts its own NEAR sandbox, deploys the compiled
//! `portico-revenue-split` and `portico-payment-token` WASMs, and creates the
//! owner, buyer, developer and platform accounts. The helper methods wrap the
//! NEP-141 transfer paths and the read-only views so every test asserts raw
//! FT units.
//!
//! # Assumptions
//!
//! * The contracts were built with `cargo near build`, so the WASMs live in
//!   `contracts/<crate>/target/near/<lib_name>.wasm`.
//! * All account ids are runtime sandbox accounts created with
//!   `Worker::dev_create_account`; the `*.portico.testnet` names used by the
//!   deployment examples never exist in the sandbox.
//! * Sandbox execution requires Linux x86 or macOS. On Windows run the suite
//!   in WSL2 or on the remote build box.
//! * `withdraw_developer_balance` and `withdraw_unaccrued` require exactly one
//!   yoctoNEAR; the helpers attach it.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use near_sdk::json_types::U128;
use near_sdk::{Gas, NearToken};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde::Deserialize;
use serde_json::{json, Value};

/// Payment FT decimals asserted by the contract and the facilitator.
pub const FT_DECIMALS: u8 = 18;
/// Default platform fee used by the deploy examples.
pub const FEE_BPS: u16 = 2000;
/// Basis-point denominator used by the split math.
pub const BPS_DENOM: u128 = 10_000;
/// One raw FT unit.
pub const ONE_YOCTO: u128 = 1;
/// One whole 18-decimal FT unit.
pub const E18: u128 = 1_000_000_000_000_000_000;
/// Initial supply minted to the FT owner (one billion whole tokens).
pub const TOTAL_SUPPLY: u128 = 1_000_000_000 * E18;
/// FT balance handed to the buyer in [`Harness::setup`].
pub const BUYER_FUNDING: u128 = 10_000_000 * E18;
/// Registration deposit attached by [`Harness::register_tool`] (one NEAR).
pub const REGISTRATION_DEPOSIT_YOCTO: u128 = 1_000_000_000_000_000_000_000_000;
/// Gas attached to `ft_transfer_call`; the FT reserves 30 Tgas for the receiver.
pub const FT_CALL_GAS_TGAS: u64 = 150;

/// Repository root, derived from this crate's manifest directory.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tests crate lives under the repository root")
        .to_path_buf()
}

/// Path to a `cargo near build` artifact under `contracts/<crate>/target/near`.
pub fn wasm_path(crate_dir: &str, wasm_file: &str) -> PathBuf {
    repo_root()
        .join("contracts")
        .join(crate_dir)
        .join("target")
        .join("near")
        .join(wasm_file)
}

pub fn revenue_split_wasm() -> PathBuf {
    wasm_path("revenue-split", "portico_revenue_split.wasm")
}

pub fn payment_token_wasm() -> PathBuf {
    wasm_path("payment-token", "portico_payment_token.wasm")
}

fn read_wasm(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).with_context(|| {
        format!(
            "read the WASM at {} (run `cargo near build` in the contract crate first)",
            path.display()
        )
    })
}

/// Start a local sandbox. The caller owns the worker for the test duration.
pub async fn sandbox() -> Result<Worker<Sandbox>> {
    near_workspaces::sandbox()
        .await
        .context("start the NEAR sandbox")
}

/// Convert a whole-token amount to raw 18-decimal units.
pub fn raw_amount(tokens: u128) -> u128 {
    tokens * 10u128.pow(u32::from(FT_DECIMALS))
}

/// Deterministic fuzz vectors: 20 amounts inside `1..=1000e18` plus `1e24`.
pub fn fuzz_amounts() -> Vec<u128> {
    let mut amounts = Vec::with_capacity(21);
    let step = 1_000 * E18 / 19;
    for index in 0..20u128 {
        amounts.push(1 + index * step);
    }
    amounts[0] = 1;
    amounts[19] = 1_000 * E18;
    amounts.push(1_000_000 * E18);
    amounts
}

/// `pay_developers` message: split `amount` between `developer` and platform.
pub fn pay_developers_msg(developer: &AccountId) -> Value {
    json!({
        "action": "pay_developers",
        "developer": developer,
        "memo": null,
    })
}

/// `pay_developers_batch` message: one leg per requested payment.
pub fn batch_msg(payments: &[(&AccountId, u128)]) -> Value {
    let payments: Vec<Value> = payments
        .iter()
        .map(|(developer, amount)| {
            json!({
                "developer": developer,
                "amount": U128::from(*amount),
                "memo": null,
            })
        })
        .collect();
    json!({
        "action": "pay_developers_batch",
        "payments": payments,
    })
}

/// `pay_tool` message: settle one registered tool call.
pub fn pay_tool_msg(tool: &str) -> Value {
    json!({
        "action": "pay_tool",
        "tool": tool,
    })
}

/// `pay_tools` message: settle a batch of registered tool calls atomically.
pub fn pay_tools_msg(tools: &[&str]) -> Value {
    json!({
        "action": "pay_tools",
        "tools": tools,
    })
}

/// `open_stream` message: open a per-block stream from the transferred deposit.
pub fn open_stream_msg(recipient: &AccountId, rate_per_block: u128, cliff_blocks: u64) -> Value {
    json!({
        "action": "open_stream",
        "recipient": recipient,
        "rate_per_block": U128::from(rate_per_block),
        "cliff_blocks": cliff_blocks,
    })
}

/// `fund_stream` message: add the transferred amount to an existing stream.
pub fn fund_stream_msg(stream_id: u64) -> Value {
    json!({
        "action": "fund_stream",
        "stream_id": stream_id,
    })
}

/// Asserts that a transaction's final status is success.
pub fn must_succeed(result: &ExecutionFinalResult, label: &str) {
    assert!(
        result.is_success(),
        "{label} failed: {:?}",
        result.failures()
    );
}

/// Asserts that a transaction failed at the top level (a panic reverted it).
pub fn expect_failure(result: &ExecutionFinalResult, label: &str) {
    assert!(
        result.is_failure(),
        "{label} unexpectedly succeeded; logs: {:?}",
        result.logs()
    );
}

/// Asserts that a transaction resolved successfully but handled a failed
/// payout receipt through its private callback.
pub fn expect_handled_failure(result: &ExecutionFinalResult, label: &str) {
    assert!(
        result.is_success(),
        "{label} transaction failed: {:?}",
        result.failures()
    );
    assert!(
        !result.receipt_failures().is_empty(),
        "{label} expected at least one failed receipt"
    );
}

/// `calculate_split` view.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SplitView {
    pub developer: U128,
    pub platform: U128,
}

/// `get_totals` view.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TotalsView {
    pub tools_count: u64,
    pub open_streams: u64,
    pub active_streams: u64,
    pub settled_volume: U128,
    pub total_developer_balance: U128,
}

/// `get_tool_info` view.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ToolInfoView {
    pub developer: String,
    pub price_per_call: U128,
    pub total_calls: u64,
    pub total_revenue: U128,
    pub active: bool,
    pub created_at_block: u64,
}

/// `get_ledger` entry view.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LedgerEntryView {
    pub id: u64,
    pub payer: String,
    pub payee: String,
    pub amount: U128,
    pub action: String,
    pub tool: Option<String>,
    pub memo: Option<String>,
    pub block_height: u64,
}

/// `get_stream` view.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StreamView {
    pub subscriber: String,
    pub recipient: String,
    pub deposit: U128,
    pub rate_per_block: U128,
    pub start_block: u64,
    pub cliff_end_block: u64,
    pub withdrawn: U128,
    pub accrued_base: U128,
    pub status: String,
    pub paused_blocks: u64,
    pub paused_at: u64,
}

/// `get_stream_view` accrual snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StreamAccrualView {
    pub accrued: U128,
    pub claimable: U128,
    pub escrow_remaining: U128,
    pub status: String,
}

/// Deployed contracts and accounts for one sandbox test.
pub struct Harness {
    pub worker: Worker<Sandbox>,
    pub split: Contract,
    pub token: Contract,
    pub owner: Account,
    pub buyer: Account,
    pub developer: Account,
    pub platform: Account,
}

impl Harness {
    /// Boots a sandbox, deploys both contracts, initializes them, registers
    /// the value-moving accounts with the FT and funds the buyer.
    pub async fn setup() -> Result<Self> {
        let worker = sandbox().await?;
        let split_wasm = read_wasm(&revenue_split_wasm())?;
        let token_wasm = read_wasm(&payment_token_wasm())?;
        let split = worker
            .dev_deploy(&split_wasm)
            .await
            .context("deploy the revenue-split contract")?;
        let token = worker
            .dev_deploy(&token_wasm)
            .await
            .context("deploy the payment-token contract")?;
        let owner = worker
            .dev_create_account()
            .await
            .context("create the owner account")?;
        let buyer = worker
            .dev_create_account()
            .await
            .context("create the buyer account")?;
        let developer = worker
            .dev_create_account()
            .await
            .context("create the developer account")?;
        let platform = worker
            .dev_create_account()
            .await
            .context("create the platform account")?;

        let harness = Self {
            worker,
            split,
            token,
            owner,
            buyer,
            developer,
            platform,
        };
        harness.init_token().await?;
        harness.init_split().await?;
        harness
            .storage_deposit(&harness.owner, harness.split.id())
            .await?;
        for account in [&harness.buyer, &harness.developer, &harness.platform] {
            harness
                .storage_deposit(&harness.owner, account.id())
                .await?;
        }
        let _ = harness
            .ft_transfer(&harness.owner, harness.buyer.id(), BUYER_FUNDING)
            .await?;
        Ok(harness)
    }

    async fn init_token(&self) -> Result<()> {
        let outcome = self
            .owner
            .call(self.token.id(), "new")
            .args_json(json!({
                "owner_id": self.owner.id().to_string(),
                "total_supply": U128::from(TOTAL_SUPPLY),
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await
            .context("call payment_token.new")?;
        must_succeed(&outcome, "payment_token.new");
        Ok(())
    }

    async fn init_split(&self) -> Result<()> {
        let outcome = self
            .owner
            .call(self.split.id(), "new")
            .args_json(json!({
                "owner_id": self.owner.id().to_string(),
                "ft_account_id": self.token.id().to_string(),
                "platform_wallet": self.platform.id().to_string(),
                "platform_fee_bps": FEE_BPS,
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await
            .context("call revenue_split.new")?;
        must_succeed(&outcome, "revenue_split.new");
        Ok(())
    }

    /// Creates another sandbox account without FT registration.
    pub async fn new_account(&self) -> Result<Account> {
        self.worker
            .dev_create_account()
            .await
            .context("create a dev account")
    }

    /// Creates another sandbox account and registers it with the FT.
    pub async fn new_registered_account(&self) -> Result<Account> {
        let account = self.new_account().await?;
        self.storage_deposit(&self.owner, account.id()).await?;
        Ok(account)
    }

    /// NEP-145 `storage_deposit` with `registration_only = true`.
    pub async fn storage_deposit(&self, funder: &Account, account: &AccountId) -> Result<()> {
        let outcome = funder
            .call(self.token.id(), "storage_deposit")
            .args_json(json!({
                "account_id": account,
                "registration_only": true,
            }))
            .deposit(NearToken::from_millinear(10))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .context("call payment_token.storage_deposit")?;
        must_succeed(&outcome, "payment_token.storage_deposit");
        Ok(())
    }

    /// NEP-141 `ft_transfer` with the required one yoctoNEAR.
    pub async fn ft_transfer(
        &self,
        from: &Account,
        to: &AccountId,
        amount: u128,
    ) -> Result<ExecutionFinalResult> {
        let outcome = from
            .call(self.token.id(), "ft_transfer")
            .args_json(json!({
                "receiver_id": to,
                "amount": U128::from(amount),
                "memo": null,
            }))
            .deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .context("call payment_token.ft_transfer")?;
        must_succeed(&outcome, "payment_token.ft_transfer");
        Ok(outcome)
    }

    /// NEP-141 `ft_transfer_call` into the split contract.
    pub async fn ft_transfer_call(
        &self,
        from: &Account,
        amount: u128,
        msg: Value,
    ) -> Result<ExecutionFinalResult> {
        let msg = serde_json::to_string(&msg).context("serialize the ft_transfer_call msg")?;
        from.call(self.token.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.split.id(),
                "amount": U128::from(amount),
                "memo": null,
                "msg": msg,
            }))
            .deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .gas(Gas::from_tgas(FT_CALL_GAS_TGAS))
            .transact()
            .await
            .context("call payment_token.ft_transfer_call")
    }

    /// Calls a revenue-split method from `caller`.
    pub async fn call_split(
        &self,
        caller: &Account,
        method: &str,
        args: Value,
        deposit_yocto: u128,
        gas_tgas: u64,
    ) -> Result<ExecutionFinalResult> {
        caller
            .call(self.split.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(deposit_yocto))
            .gas(Gas::from_tgas(gas_tgas))
            .transact()
            .await
            .with_context(|| format!("call revenue_split.{method}"))
    }

    /// Registers a tool with a one-NEAR storage deposit.
    pub async fn register_tool(
        &self,
        caller: &Account,
        name: &str,
        developer: &AccountId,
        price: u128,
    ) -> Result<ExecutionFinalResult> {
        self.register_tool_with_deposit(
            caller,
            name,
            developer,
            price,
            REGISTRATION_DEPOSIT_YOCTO,
        )
        .await
    }

    /// Registers a tool with an explicit storage deposit, for the
    /// underfunded-registration path.
    pub async fn register_tool_with_deposit(
        &self,
        caller: &Account,
        name: &str,
        developer: &AccountId,
        price: u128,
        deposit_yocto: u128,
    ) -> Result<ExecutionFinalResult> {
        self.call_split(
            caller,
            "register_tool",
            json!({
                "name": name,
                "developer": developer,
                "price": U128::from(price),
            }),
            deposit_yocto,
            100,
        )
        .await
    }

    /// Withdraws a caller's whole withdrawable balance (one yoctoNEAR).
    pub async fn withdraw_balance(&self, account: &Account) -> Result<ExecutionFinalResult> {
        self.call_split(
            account,
            "withdraw_developer_balance",
            json!({}),
            ONE_YOCTO,
            50,
        )
        .await
    }

    /// Claims a stream's accrual. Claims are permissionless.
    pub async fn claim(&self, caller: &Account, stream_id: u64) -> Result<ExecutionFinalResult> {
        self.call_split(
            caller,
            "claim",
            json!({"stream_id": stream_id}),
            0,
            50,
        )
        .await
    }

    /// Raw FT balance of `account`.
    pub async fn ft_balance(&self, account: &AccountId) -> Result<u128> {
        let value: U128 = self
            .token
            .view("ft_balance_of")
            .args_json(json!({"account_id": account}))
            .await
            .context("view payment_token.ft_balance_of")?
            .json()
            .context("decode payment_token.ft_balance_of")?;
        Ok(value.0)
    }

    /// Withdrawable balance of `account` in the split contract.
    pub async fn developer_balance(&self, account: &AccountId) -> Result<u128> {
        let value: U128 = self
            .split
            .view("get_developer_balance")
            .args_json(json!({"account": account}))
            .await
            .context("view revenue_split.get_developer_balance")?
            .json()
            .context("decode revenue_split.get_developer_balance")?;
        Ok(value.0)
    }

    /// Aggregate counters.
    pub async fn totals(&self) -> Result<TotalsView> {
        self.split
            .view("get_totals")
            .await
            .context("view revenue_split.get_totals")?
            .json()
            .context("decode revenue_split.get_totals")
    }

    /// Ledger page with entries whose id is greater than `after_id`.
    pub async fn ledger(&self, after_id: Option<u64>, limit: u32) -> Result<Vec<LedgerEntryView>> {
        self.split
            .view("get_ledger")
            .args_json(json!({"after_id": after_id, "limit": limit}))
            .await
            .context("view revenue_split.get_ledger")?
            .json()
            .context("decode revenue_split.get_ledger")
    }

    /// `calculate_split` view.
    pub async fn calculate_split(&self, amount: u128) -> Result<SplitView> {
        self.split
            .view("calculate_split")
            .args_json(json!({"amount": U128::from(amount)}))
            .await
            .context("view revenue_split.calculate_split")?
            .json()
            .context("decode revenue_split.calculate_split")
    }

    /// `get_tool_info` view.
    pub async fn tool_info(&self, name: &str) -> Result<Option<ToolInfoView>> {
        self.split
            .view("get_tool_info")
            .args_json(json!({"name": name}))
            .await
            .context("view revenue_split.get_tool_info")?
            .json()
            .context("decode revenue_split.get_tool_info")
    }

    /// `get_full_tool_info` view; same record as [`Harness::tool_info`].
    pub async fn full_tool_info(&self, name: &str) -> Result<Option<ToolInfoView>> {
        self.split
            .view("get_full_tool_info")
            .args_json(json!({"name": name}))
            .await
            .context("view revenue_split.get_full_tool_info")?
            .json()
            .context("decode revenue_split.get_full_tool_info")
    }

    /// `get_developer_tools` view.
    pub async fn developer_tools(&self, developer: &AccountId) -> Result<Vec<String>> {
        self.split
            .view("get_developer_tools")
            .args_json(json!({"developer": developer}))
            .await
            .context("view revenue_split.get_developer_tools")?
            .json()
            .context("decode revenue_split.get_developer_tools")
    }

    /// `is_tool_active` view.
    pub async fn is_tool_active(&self, name: &str) -> Result<bool> {
        self.split
            .view("is_tool_active")
            .args_json(json!({"name": name}))
            .await
            .context("view revenue_split.is_tool_active")?
            .json()
            .context("decode revenue_split.is_tool_active")
    }

    /// `get_stream` view.
    pub async fn stream(&self, stream_id: u64) -> Result<Option<StreamView>> {
        self.split
            .view("get_stream")
            .args_json(json!({"stream_id": stream_id}))
            .await
            .context("view revenue_split.get_stream")?
            .json()
            .context("decode revenue_split.get_stream")
    }

    /// `get_stream_view` accrual snapshot.
    pub async fn stream_accrual(&self, stream_id: u64) -> Result<StreamAccrualView> {
        self.split
            .view("get_stream_view")
            .args_json(json!({"stream_id": stream_id}))
            .await
            .context("view revenue_split.get_stream_view")?
            .json()
            .context("decode revenue_split.get_stream_view")
    }

    /// `get_stream_deposit` view.
    pub async fn stream_deposit(&self, stream_id: u64) -> Result<u128> {
        let value: U128 = self
            .split
            .view("get_stream_deposit")
            .args_json(json!({"stream_id": stream_id}))
            .await
            .context("view revenue_split.get_stream_deposit")?
            .json()
            .context("decode revenue_split.get_stream_deposit")?;
        Ok(value.0)
    }

    /// `get_streams_by_recipient` view.
    pub async fn streams_by_recipient(
        &self,
        recipient: &AccountId,
        after_id: Option<u64>,
        limit: u32,
    ) -> Result<Vec<u64>> {
        self.split
            .view("get_streams_by_recipient")
            .args_json(json!({
                "account": recipient,
                "after_id": after_id,
                "limit": limit,
            }))
            .await
            .context("view revenue_split.get_streams_by_recipient")?
            .json()
            .context("decode revenue_split.get_streams_by_recipient")
    }

    /// Latest block height.
    pub async fn block_height(&self) -> Result<u64> {
        Ok(self
            .worker
            .view_block()
            .await
            .context("view the latest block")?
            .height())
    }

    /// Advances the sandbox by `blocks` and returns the resulting height.
    pub async fn fast_forward(&self, blocks: u64) -> Result<u64> {
        self.worker
            .fast_forward(blocks)
            .await
            .context("fast forward the sandbox")?;
        self.block_height().await
    }

    /// Advances the sandbox to `target_height` exactly.
    pub async fn fast_forward_to(&self, target_height: u64) -> Result<u64> {
        let current = self.block_height().await?;
        if target_height > current {
            self.fast_forward(target_height - current).await?;
        }
        let reached = self.block_height().await?;
        anyhow::ensure!(
            reached == target_height,
            "expected block {target_height}, reached {reached}"
        );
        Ok(reached)
    }

    /// Advances to `cliff_end_block + extra_blocks` for `stream_id`.
    pub async fn fast_forward_to_stream_phase(
        &self,
        stream_id: u64,
        extra_blocks: u64,
    ) -> Result<u64> {
        let stream = self
            .stream(stream_id)
            .await?
            .ok_or_else(|| anyhow!("stream {stream_id} is not stored"))?;
        let target = stream
            .cliff_end_block
            .checked_add(extra_blocks)
            .ok_or_else(|| anyhow!("stream {stream_id} phase target overflow"))?;
        self.fast_forward_to(target).await
    }

    /// Execution height of the first receipt that ran on `executor` and
    /// logged `event`, used to pin block-dependent accrual assertions.
    pub async fn event_block_height(
        &self,
        result: &ExecutionFinalResult,
        executor: &AccountId,
        event: &str,
    ) -> Result<Option<u64>> {
        for outcome in result.outcomes() {
            let emitted = outcome.logs.iter().any(|line| line.contains(event));
            if &outcome.executor_id == executor && emitted {
                let block = self
                    .worker
                    .view_block()
                    .block_hash(outcome.block_hash)
                    .await
                    .context("view a block by hash")?;
                return Ok(Some(block.height()));
            }
        }
        Ok(None)
    }
}
