//! Shared harness for the portico sandbox suite.
//!
//! The W2/W3 test files (`split.rs`, `registry.rs`, `stream.rs`) use these
//! helpers to start a local NEAR sandbox, deploy the compiled WASM and drive
//! block heights. Sandbox execution requires Linux x86 or macOS; on Windows it
//! runs inside WSL2 or on the remote build box.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::Worker;

/// Payment FT decimals asserted by the contract and the facilitator.
pub const FT_DECIMALS: u8 = 18;
/// Default platform fee used by the deploy examples.
pub const FEE_BPS: u16 = 2000;
/// Basis-point denominator used by the split math.
pub const BPS_DENOM: u128 = 10_000;
/// One NEP-141 transfer deposit.
pub const ONE_YOCTO: u128 = 1;
/// Ledger page clamp enforced by the contract view.
pub const LEDGER_LIMIT_MAX: u32 = 100;

pub const SPLIT_ACCOUNT: &str = "split.portico.testnet";
pub const TOKEN_ACCOUNT: &str = "token.portico.testnet";
pub const BUYER_ACCOUNT: &str = "buyer1.portico.testnet";
pub const DEVELOPER_ACCOUNT: &str = "dev1.portico.testnet";
pub const PLATFORM_ACCOUNT: &str = "portico.testnet";

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
