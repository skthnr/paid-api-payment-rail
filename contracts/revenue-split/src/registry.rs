//! Tool registry state, validation and the developer-to-tool index.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId};

use crate::ledger::LEDGER_RESERVE_BYTES;

/// Maximum accepted tool-name length, in bytes.
pub const MAX_TOOL_NAME_BYTES: usize = 64;

/// A registered tool.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub struct ToolInfo {
    /// Developer that receives the developer leg of every call.
    pub developer: AccountId,
    /// Price per call in raw FT units.
    pub price_per_call: U128,
    /// Number of settled calls.
    pub total_calls: u64,
    /// Gross revenue settled for this tool, in raw FT units.
    pub total_revenue: U128,
    /// Whether calls are currently accepted.
    pub active: bool,
    /// Block height of registration.
    pub created_at_block: u64,
}

/// Validates a tool name: 1 to 64 bytes inclusive.
pub fn validate_tool_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() {
        return Err("tool name must not be empty");
    }
    if name.len() > MAX_TOOL_NAME_BYTES {
        return Err("tool name exceeds 64 bytes");
    }
    Ok(())
}

/// Validates a price: any positive raw amount.
pub fn validate_price(price: u128) -> Result<(), &'static str> {
    if price == 0 {
        return Err("price must be greater than zero");
    }
    Ok(())
}

/// Deposit a `register_tool` call must attach.
///
/// It covers the bytes the registration itself adds plus
/// [`LEDGER_RESERVE_BYTES`], the fixed reserve that funds the unfunded
/// payment-path writes a registered tool can trigger.
///
/// # Panics
///
/// Panics on `u128` overflow, which is unreachable for protocol storage
/// costs and byte counts.
pub fn registration_deposit(storage_growth_bytes: u64, byte_cost: u128) -> u128 {
    let total_bytes = u128::from(storage_growth_bytes)
        .checked_add(u128::from(LEDGER_RESERVE_BYTES))
        .expect("registration deposit overflow");
    total_bytes
        .checked_mul(byte_cost)
        .expect("registration deposit overflow")
}

/// Adds `name` to `developer`'s tool list, ignoring duplicates.
pub fn index_add(index: &mut LookupMap<AccountId, Vec<String>>, developer: &AccountId, name: &str) {
    let mut names = index.get(developer).cloned().unwrap_or_default();
    if names.iter().any(|existing| existing.as_str() == name) {
        return;
    }
    names.push(name.to_string());
    index.insert(developer.clone(), names);
}

/// Removes `name` from `developer`'s tool list, dropping the list when empty.
pub fn index_remove(
    index: &mut LookupMap<AccountId, Vec<String>>,
    developer: &AccountId,
    name: &str,
) {
    let Some(names) = index.get(developer).cloned() else {
        return;
    };
    let filtered: Vec<String> = names
        .into_iter()
        .filter(|existing| existing.as_str() != name)
        .collect();
    if filtered.is_empty() {
        index.remove(developer);
    } else {
        index.insert(developer.clone(), filtered);
    }
}
