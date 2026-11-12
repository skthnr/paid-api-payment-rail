//! NEP-297 events emitted by the revenue-split contract.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// Every value-moving or registry mutation emits exactly one of these.
///
/// The `event` field is the snake_case variant name and the `data` field
/// carries the variant payload, so each log line is
/// `EVENT_JSON:{"standard":"portico","version":"1.0.0","event":...,"data":...}`.
#[near(event_json(standard = "portico"))]
#[derive(Clone, Debug)]
pub enum LedgerEvent {
    /// A direct developer payment was split and credited.
    #[event_version("1.0.0")]
    PaymentProcessed {
        /// Account whose FT transfer funded the payment.
        payer: AccountId,
        /// Developer that received the developer leg.
        developer: AccountId,
        /// Gross amount transferred, in raw FT units.
        amount: U128,
        /// Developer leg, paid out or credited to the developer balance.
        developer_amount: U128,
        /// Platform leg credited to the platform wallet's balance.
        platform_amount: U128,
        /// Optional payer memo.
        #[serde(skip_serializing_if = "Option::is_none")]
        memo: Option<String>,
    },
    /// A registered tool was called and paid for.
    #[event_version("1.0.0")]
    ToolCalled {
        /// Account whose FT transfer funded the call.
        payer: AccountId,
        /// Tool name.
        tool: String,
        /// Developer that owns the tool.
        developer: AccountId,
        /// Settled price of the call in raw FT units.
        amount: U128,
    },
    /// A tool was registered.
    #[event_version("1.0.0")]
    ToolRegistered {
        /// Tool name.
        tool: String,
        /// Developer that owns the tool.
        developer: AccountId,
        /// Registered price per call in raw FT units.
        price_per_call: U128,
    },
    /// A tool price changed.
    #[event_version("1.0.0")]
    ToolPriceUpdated {
        /// Tool name.
        tool: String,
        /// Developer that owns the tool.
        developer: AccountId,
        /// Previous price per call in raw FT units.
        old_price: U128,
        /// New price per call in raw FT units.
        new_price: U128,
    },
    /// A developer withdrew their accrued balance.
    #[event_version("1.0.0")]
    DeveloperWithdrawal {
        /// Developer that withdrew.
        developer: AccountId,
        /// Amount sent, in raw FT units.
        amount: U128,
    },
    /// The platform fee changed.
    #[event_version("1.0.0")]
    PlatformFeeUpdated {
        /// Previous fee in basis points.
        old_fee_bps: u16,
        /// New fee in basis points.
        new_fee_bps: u16,
    },
    /// The platform wallet changed.
    #[event_version("1.0.0")]
    PlatformWalletUpdated {
        /// Previous platform wallet.
        old_wallet: AccountId,
        /// New platform wallet.
        new_wallet: AccountId,
    },
    /// A stream deposit was credited.
    #[event_version("1.0.0")]
    StreamFunded {
        /// Stream id.
        stream_id: u64,
        /// Account whose FT transfer funded the stream.
        funder: AccountId,
        /// Amount added to escrow, in raw FT units.
        amount: U128,
    },
    /// A stream was opened.
    #[event_version("1.0.0")]
    StreamOpened {
        /// Stream id.
        stream_id: u64,
        /// Account that funded the stream.
        subscriber: AccountId,
        /// Account that receives accrual.
        recipient: AccountId,
        /// Accrual per block in raw FT units.
        rate_per_block: U128,
        /// Initial deposit in raw FT units.
        deposit: U128,
        /// Block height at which accrual may begin.
        cliff_end_block: u64,
    },
    /// A stream recipient claimed accrued funds.
    #[event_version("1.0.0")]
    StreamClaimed {
        /// Stream id.
        stream_id: u64,
        /// Recipient that claimed.
        recipient: AccountId,
        /// Amount sent, in raw FT units.
        amount: U128,
    },
    /// A stream was closed and its remainder refunded.
    #[event_version("1.0.0")]
    StreamCancelled {
        /// Stream id.
        stream_id: u64,
        /// Subscriber that closed the stream.
        subscriber: AccountId,
        /// Unaccrued amount refunded to the subscriber.
        refunded: U128,
        /// Accrued amount paid to the recipient.
        paid: U128,
    },
    /// A stream was paused.
    #[event_version("1.0.0")]
    StreamPaused {
        /// Stream id.
        stream_id: u64,
        /// Block height at which the pause started.
        paused_at_block: u64,
    },
    /// A stream was resumed.
    #[event_version("1.0.0")]
    StreamResumed {
        /// Stream id.
        stream_id: u64,
        /// Cumulative paused blocks after the resume.
        paused_blocks: u64,
    },
    /// Unaccrued stream funds were withdrawn by the subscriber.
    #[event_version("1.0.0")]
    StreamWithdrawn {
        /// Stream id.
        stream_id: u64,
        /// Subscriber that withdrew.
        subscriber: AccountId,
        /// Amount refunded, in raw FT units.
        amount: U128,
    },
}
