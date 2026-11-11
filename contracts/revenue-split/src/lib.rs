//! Portico revenue-split contract.
//!
//! W1 scaffold: complete state, split math, views, tool registry and admin
//! surface. W2 adds the NEP-141 `ft_on_transfer` entry point, developer
//! payouts and the stream lifecycle methods on top of these primitives.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub mod events;
pub mod ext;
pub mod ft_receiver;
pub mod ledger;
pub mod registry;
pub mod split;
pub mod stream;

use events::LedgerEvent;
use ledger::{LedgerEntry, TotalsView};
use registry::ToolInfo;
use split::{SplitView, MAX_FEE_BPS};
use stream::{Stream, StreamView};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    ft_account_id: AccountId,
    platform_wallet: AccountId,
    platform_fee_bps: u16,
    paused: bool,
    tools: LookupMap<String, ToolInfo>,
    developer_tools: LookupMap<AccountId, Vec<String>>,
    tools_count: u64,
    developer_balances: LookupMap<AccountId, u128>,
    total_developer_balance: u128,
    streams: LookupMap<u64, Stream>,
    streams_by_recipient: LookupMap<AccountId, Vec<u64>>,
    next_stream_id: u64,
    open_streams: u64,
    active_streams: u64,
    ledger: LookupMap<u64, LedgerEntry>,
    next_ledger_id: u64,
    settled_volume: u128,
}

#[near]
impl Contract {
    /// Creates the contract.
    ///
    /// The platform fee may be zero: the splitter allows `0..=MAX_FEE_BPS`,
    /// and the old 100-bps floor belongs to the origin tool registry only.
    #[init]
    pub fn new(
        owner_id: AccountId,
        ft_account_id: AccountId,
        platform_wallet: AccountId,
        platform_fee_bps: u16,
    ) -> Self {
        require!(
            platform_fee_bps <= MAX_FEE_BPS,
            "platform fee exceeds MAX_FEE_BPS"
        );
        Self {
            owner_id,
            ft_account_id,
            platform_wallet,
            platform_fee_bps,
            paused: false,
            tools: LookupMap::new(b"tools".as_slice()),
            developer_tools: LookupMap::new(b"devtools".as_slice()),
            tools_count: 0,
            developer_balances: LookupMap::new(b"devbal".as_slice()),
            total_developer_balance: 0,
            streams: LookupMap::new(b"streams".as_slice()),
            streams_by_recipient: LookupMap::new(b"streambyrcpt".as_slice()),
            next_stream_id: 1,
            open_streams: 0,
            active_streams: 0,
            ledger: LookupMap::new(b"ledger".as_slice()),
            next_ledger_id: 1,
            settled_volume: 0,
        }
    }

    /// Returns the aggregate counters.
    pub fn get_totals(&self) -> TotalsView {
        TotalsView {
            tools_count: self.tools_count,
            open_streams: self.open_streams,
            active_streams: self.active_streams,
            settled_volume: U128(self.settled_volume),
            total_developer_balance: U128(self.total_developer_balance),
        }
    }

    /// Returns ledger entries with `id > after_id`, oldest first.
    ///
    /// `limit` is clamped to `1..=100`; `after_id = None` starts at the oldest
    /// entry.
    pub fn get_ledger(&self, after_id: Option<u64>, limit: u32) -> Vec<LedgerEntry> {
        ledger::collect_page(&self.ledger, self.next_ledger_id, after_id, limit)
    }

    /// Splits `amount` at the current platform fee.
    pub fn calculate_split(&self, amount: U128) -> SplitView {
        split::split_amount(amount.0, self.platform_fee_bps)
    }

    /// Returns a tool's registry entry.
    pub fn get_tool_info(&self, name: String) -> Option<ToolInfo> {
        self.tools.get(&name).cloned()
    }

    /// Returns the names of every tool owned by `developer`.
    pub fn get_developer_tools(&self, developer: AccountId) -> Vec<String> {
        self.developer_tools
            .get(&developer)
            .cloned()
            .unwrap_or_default()
    }

    /// Returns whether a tool exists and is accepting calls.
    pub fn is_tool_active(&self, name: String) -> bool {
        self.tools.get(&name).is_some_and(|tool| tool.active)
    }

    /// Returns a stream's stored state.
    pub fn get_stream(&self, stream_id: u64) -> Option<Stream> {
        self.streams.get(&stream_id).cloned()
    }

    /// Returns a stream's accrual snapshot at the current block height.
    pub fn get_stream_view(&self, stream_id: u64) -> StreamView {
        let stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("stream not found"));
        let now_block = env::block_height();
        StreamView {
            accrued: U128(stream.accrued_at(now_block)),
            claimable: U128(stream.claimable_at(now_block)),
            escrow_remaining: U128(stream.escrow_remaining_at(now_block)),
            status: stream.status,
        }
    }

    /// Sets the platform fee; owner only, `0..=MAX_FEE_BPS`.
    pub fn set_platform_fee(&mut self, bps: u16) {
        self.assert_owner();
        require!(
            bps <= MAX_FEE_BPS,
            "platform fee exceeds MAX_FEE_BPS"
        );
        let old_fee_bps = self.platform_fee_bps;
        self.platform_fee_bps = bps;
        LedgerEvent::PlatformFeeUpdated {
            old_fee_bps,
            new_fee_bps: bps,
        }
        .emit();
    }

    /// Sets the platform wallet; owner only.
    pub fn set_platform_wallet(&mut self, wallet: AccountId) {
        self.assert_owner();
        let old_wallet = self.platform_wallet.clone();
        self.platform_wallet = wallet.clone();
        LedgerEvent::PlatformWalletUpdated {
            old_wallet,
            new_wallet: wallet,
        }
        .emit();
    }

    /// Enables or disables value-in operations; owner only.
    ///
    /// The pause gates registration and value-in paths only, never payouts or
    /// refunds.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    /// Deactivates any tool; owner only.
    pub fn force_deactivate_tool(&mut self, name: String) {
        self.assert_owner();
        let mut tool = self
            .tools
            .get(&name)
            .cloned()
            .unwrap_or_else(|| env::panic_str("tool not found"));
        tool.active = false;
        self.tools.insert(name, tool);
    }

    /// Registers a tool and charges its storage growth to the caller.
    ///
    /// The attached deposit must cover `env::storage_byte_cost() * bytes
    /// added`; any excess is refunded to the predecessor.
    #[payable]
    pub fn register_tool(&mut self, name: String, developer: AccountId, price: U128) {
        self.assert_not_paused();
        registry::validate_tool_name(&name).unwrap_or_else(|error| env::panic_str(error));
        registry::validate_price(price.0).unwrap_or_else(|error| env::panic_str(error));
        require!(!self.tools.contains_key(&name), "tool already registered");

        let storage_usage_start = env::storage_usage();
        let tool = ToolInfo {
            developer: developer.clone(),
            price_per_call: price,
            total_calls: 0,
            total_revenue: U128(0),
            active: true,
            created_at_block: env::block_height(),
        };
        self.tools.insert(name.clone(), tool);
        registry::index_add(&mut self.developer_tools, &developer, &name);
        self.tools_count = self
            .tools_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("tools_count overflow"));

        // `store::LookupMap` buffers writes, so flush before pricing the growth.
        self.tools.flush();
        self.developer_tools.flush();
        let required_deposit =
            env::storage_byte_cost()
                .as_yoctonear()
                .saturating_mul(u128::from(
                    env::storage_usage().saturating_sub(storage_usage_start),
                ));
        let attached_deposit = env::attached_deposit().as_yoctonear();
        require!(
            attached_deposit >= required_deposit,
            "insufficient storage deposit for tool registration"
        );
        let refund = attached_deposit - required_deposit;
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }

        LedgerEvent::ToolRegistered {
            tool: name,
            developer,
            price_per_call: price,
        }
        .emit();
    }

    /// Updates a tool's price; the tool's developer only.
    pub fn update_tool_price(&mut self, name: String, new_price: U128) {
        let mut tool = self
            .tools
            .get(&name)
            .cloned()
            .unwrap_or_else(|| env::panic_str("tool not found"));
        require!(
            env::predecessor_account_id() == tool.developer,
            "only the tool developer can update the price"
        );
        registry::validate_price(new_price.0).unwrap_or_else(|error| env::panic_str(error));
        let developer = tool.developer.clone();
        let old_price = tool.price_per_call;
        tool.price_per_call = new_price;
        self.tools.insert(name.clone(), tool);
        LedgerEvent::ToolPriceUpdated {
            tool: name,
            developer,
            old_price,
            new_price,
        }
        .emit();
    }

    /// Transfers a tool to another developer; the current developer only.
    pub fn update_tool_developer(&mut self, name: String, new_developer: AccountId) {
        let mut tool = self
            .tools
            .get(&name)
            .cloned()
            .unwrap_or_else(|| env::panic_str("tool not found"));
        require!(
            env::predecessor_account_id() == tool.developer,
            "only the tool developer can transfer the tool"
        );
        require!(
            tool.developer != new_developer,
            "tool already belongs to the new developer"
        );
        registry::index_remove(&mut self.developer_tools, &tool.developer, &name);
        registry::index_add(&mut self.developer_tools, &new_developer, &name);
        tool.developer = new_developer;
        self.tools.insert(name, tool);
    }

    /// Stops a tool from accepting calls; the tool's developer only.
    pub fn deactivate_tool(&mut self, name: String) {
        self.set_tool_active(name, false);
    }

    /// Re-enables a tool; the tool's developer only.
    pub fn reactivate_tool(&mut self, name: String) {
        self.set_tool_active(name, true);
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the owner can call this method"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "contract is paused for value-in operations");
    }

    fn set_tool_active(&mut self, name: String, active: bool) {
        let mut tool = self
            .tools
            .get(&name)
            .cloned()
            .unwrap_or_else(|| env::panic_str("tool not found"));
        require!(
            env::predecessor_account_id() == tool.developer,
            "only the tool developer can change tool status"
        );
        tool.active = active;
        self.tools.insert(name, tool);
    }
}
