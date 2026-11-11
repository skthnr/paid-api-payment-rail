//! Tool registry state, validation and the developer-to-tool index.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId};

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
