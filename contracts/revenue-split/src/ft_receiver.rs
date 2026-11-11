//! NEP-141 `msg` payloads accepted by `ft_on_transfer`.
//!
//! W2 wires the `ft_on_transfer` entry point. It reads the gross `amount` from
//! the FT transfer and dispatches on [`PaymentMsg`]; amounts inside `msg` are
//! `U128` strings, the NEAR JSON convention.

use near_sdk::{json_types::U128, AccountId};

use crate::split::PaymentItem;

/// Action payload carried in the FT transfer `msg`.
#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "::near_sdk::serde", tag = "action", rename_all = "snake_case")]
pub enum PaymentMsg {
    /// Split the transferred amount between `developer` and the platform.
    PayDevelopers {
        /// Developer that receives the developer leg.
        developer: AccountId,
        /// Optional memo recorded in the ledger entry.
        memo: Option<String>,
    },
    /// Split one FT transfer across several developer payments.
    ///
    /// The transferred amount must equal the sum of `payments[].amount`; each
    /// item resolves to a developer leg through [`PaymentItem::split`].
    PayDevelopersBatch {
        /// Requested payments.
        payments: Vec<PaymentItem>,
    },
    /// Credit the transferred amount to `developer`'s withdrawable balance.
    CreditDeveloper {
        /// Developer that receives the credit.
        developer: AccountId,
    },
    /// Pay for one tool call; the transferred amount must cover the price.
    PayTool {
        /// Registered tool name.
        tool: String,
    },
    /// Atomically pay for several tool calls.
    ///
    /// The transferred amount must equal the sum of the tools'
    /// `price_per_call`; otherwise the whole amount is returned unused.
    PayTools {
        /// Registered tool names.
        tools: Vec<String>,
    },
    /// Open a stream; the transferred amount becomes the initial deposit.
    OpenStream {
        /// Account that receives accrual.
        recipient: AccountId,
        /// Accrual per block in raw FT units; must be greater than zero.
        rate_per_block: U128,
        /// Cliff duration in blocks from the open block.
        cliff_blocks: u64,
    },
    /// Add the transferred amount to an existing stream's deposit.
    FundStream {
        /// Existing stream id.
        stream_id: u64,
    },
}

/// Why a `msg` payload was rejected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentMsgError {
    /// The FT was called with an empty message.
    Empty,
    /// The message is not valid JSON or names an unsupported action/field.
    Invalid(String),
}

impl core::fmt::Display for PaymentMsgError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Empty => f.write_str("ft_on_transfer msg must not be empty"),
            Self::Invalid(reason) => write!(f, "invalid ft_on_transfer msg: {reason}"),
        }
    }
}

/// Parses the FT `msg`; empty, malformed and unknown-action messages are rejected.
pub fn parse_payment_msg(msg: &str) -> Result<PaymentMsg, PaymentMsgError> {
    let trimmed = msg.trim();
    if trimmed.is_empty() {
        return Err(PaymentMsgError::Empty);
    }
    near_sdk::serde_json::from_str(trimmed)
        .map_err(|error| PaymentMsgError::Invalid(error.to_string()))
}

/// Returns `true` only when `predecessor` is the allowlisted FT contract.
///
/// W2's `ft_on_transfer` must reject every other caller by returning the full
/// `amount` unused, which NEP-141 refunds to the sender.
pub fn assert_ft_predecessor(predecessor: &AccountId, ft_account_id: &AccountId) -> bool {
    predecessor == ft_account_id
}
