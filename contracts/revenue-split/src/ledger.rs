//! Public ledger state, the append helper and pagination.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId};

use crate::Contract;

/// On-chain ledger capacity.
///
/// `ft_on_transfer` runs without an attached deposit, so every payment-path
/// write is unfunded. The ledger is therefore capped: once this many entries
/// are stored, further payments still emit their event but skip the storage
/// write, keeping the on-chain footprint bounded.
pub const MAX_LEDGER_ENTRIES: u64 = 100_000;

/// Bytes of storage a tool registration pre-funds for later payment writes.
///
/// `ft_on_transfer` receives no attached deposit from the FT, so the ledger
/// entry, the first `developer_balances` write for each payee and the tool
/// counter updates of a sale are unfunded. `register_tool` therefore requires
/// this fixed reserve on top of its own storage growth. The reserve is not the
/// only backstop: [`crate::storage`] caps the developer-balance and stream key
/// sets and checks the account balance against
/// `storage_byte_cost * (storage_usage + entry bytes + headroom)` before a new
/// payment-path key, so a sale that outgrows the reserve refunds instead of
/// aborting.
pub const LEDGER_RESERVE_BYTES: u64 = 8_192;

/// Largest page `get_ledger` returns, regardless of the requested limit.
pub const MAX_LEDGER_PAGE: u32 = 100;

/// Kind of value movement recorded in the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
pub enum LedgerAction {
    /// Direct developer payment.
    Payment,
    /// Tool call settled through the registry.
    ToolCall,
    /// Developer balance withdrawal.
    DeveloperPayout,
    /// Stream claim paid to the recipient.
    StreamClaim,
    /// Stream deposit credited.
    StreamFund,
    /// Unaccrued stream funds withdrawn by the subscriber.
    StreamWithdraw,
    /// Stream closed and its remaining escrow refunded.
    StreamClose,
}

/// One public ledger entry.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub struct LedgerEntry {
    /// Monotonic entry id, starting at 1.
    pub id: u64,
    /// Account whose funds moved.
    pub payer: AccountId,
    /// Account that received the funds.
    pub payee: AccountId,
    /// Amount that moved, in raw FT units.
    pub amount: U128,
    /// Kind of movement.
    pub action: LedgerAction,
    /// Tool name when the movement is tied to a registered tool.
    pub tool: Option<String>,
    /// Free-form memo supplied by the payer.
    pub memo: Option<String>,
    /// Block height at which the entry was written.
    pub block_height: u64,
}

/// Aggregate counters exposed by `get_totals`.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json])]
pub struct TotalsView {
    /// Number of registered tools.
    pub tools_count: u64,
    /// Streams that have not been closed.
    pub open_streams: u64,
    /// Streams that are currently accruing (not paused, not closed).
    pub active_streams: u64,
    /// Total gross volume settled through the contract.
    pub settled_volume: U128,
    /// Sum of all withdrawable developer balances.
    pub total_developer_balance: U128,
}

impl Contract {
    /// Appends one entry to the public ledger.
    ///
    /// Ledger ids start at 1 and grow monotonically. Once
    /// [`MAX_LEDGER_ENTRIES`] entries are stored the ledger is full; the call
    /// then returns `false` without writing anything, and the caller still
    /// emits its event, so off-chain indexers keep the full history while
    /// on-chain storage stays bounded. Returns `true` when the entry was
    /// persisted.
    pub fn append_ledger_entry(
        &mut self,
        payer: AccountId,
        payee: AccountId,
        amount: u128,
        action: LedgerAction,
        tool: Option<String>,
        memo: Option<String>,
    ) -> bool {
        if self.next_ledger_id > MAX_LEDGER_ENTRIES {
            return false;
        }
        let id = self.next_ledger_id;
        let entry = LedgerEntry {
            id,
            payer,
            payee,
            amount: U128(amount),
            action,
            tool,
            memo,
            block_height: env::block_height(),
        };
        self.ledger.insert(id, entry);
        self.next_ledger_id = id + 1;
        true
    }
}

impl Contract {
    /// Adds `amount` to the monotonic settled-volume counter.
    pub(crate) fn add_settled_volume(&mut self, amount: u128) {
        self.settled_volume = self
            .settled_volume
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("settled volume overflow"));
    }

    /// Rolls back a settled amount whose payout leg failed.
    ///
    /// Saturating and infallible: used from private callbacks.
    pub(crate) fn sub_settled_volume(&mut self, amount: u128) {
        self.settled_volume = self.settled_volume.saturating_sub(amount);
    }
}

/// Clamps a requested page size to `1..=MAX_LEDGER_PAGE`.
pub fn clamp_page_limit(limit: u32) -> u32 {
    limit.clamp(1, MAX_LEDGER_PAGE)
}

/// Returns the entries with `id > after_id` in ascending id order.
///
/// `after_id = None` starts at the oldest entry. Ids are contiguous because the
/// ledger never deletes, so the scan visits at most `limit` stored entries.
pub fn collect_page(
    ledger: &LookupMap<u64, LedgerEntry>,
    next_ledger_id: u64,
    after_id: Option<u64>,
    limit: u32,
) -> Vec<LedgerEntry> {
    let limit = clamp_page_limit(limit) as usize;
    let start = after_id.map_or(1, |id| id.saturating_add(1));
    let mut page = Vec::with_capacity(limit);
    let mut id = start;
    while id < next_ledger_id && page.len() < limit {
        if let Some(entry) = ledger.get(&id) {
            page.push(entry.clone());
        }
        id += 1;
    }
    page
}
