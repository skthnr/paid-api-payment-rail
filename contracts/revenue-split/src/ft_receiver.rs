//! NEP-141 `ft_on_transfer` entry point and its private payout callbacks.
//!
//! `ft_on_transfer` dispatches the JSON `msg` payload on [`PaymentMsg`];
//! amounts inside `msg` are `U128` strings, the NEAR JSON convention.
//!
//! # Settlement model
//!
//! A single-payment developer leg leaves the contract through exactly one
//! `ft_transfer` promise whose private [`Contract::on_payout_done`] callback
//! ends the promise chain in `U128`, so the FT resolver refunds the payer
//! correctly. Every other leg (the platform cut, batch developer legs and
//! stream refunds paid to a subscriber) is credited to `developer_balances`
//! and withdrawn through [`Contract::withdraw_developer_balance`]. That keeps
//! every `ft_on_transfer` return path ending in a `U128`-returning method and
//! never leaves a payout promise detached from the refund chain.
//!
//! # Refunds
//!
//! Every rejection path returns the full transferred amount unused and writes
//! no state: a predecessor other than the payment FT, the paused kill switch,
//! a message that does not parse, an unknown or inactive tool, a batch whose
//! total does not match its prices, and a payment that would exceed the
//! payment-path storage caps or the account-balance headroom
//! ([`crate::storage`]). Selling never panics on storage: the payer is
//! refunded instead.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, Promise, PromiseError, PromiseOrValue, env, near};

use crate::Contract;
use crate::ContractExt;
use crate::events::LedgerEvent;
use crate::ext::{GAS_FOR_FT_RESOLVE, GAS_FOR_FT_TRANSFER, YOCTO_ONE, ext_ft};
use crate::ledger::LedgerAction;
use crate::registry::ToolInfo;
use crate::split::{PaymentItem, SplitView, split_amount};

/// Largest `payments`/`tools` batch accepted in one `ft_on_transfer` message.
///
/// A batch settles through balance credits only, so the cap bounds state
/// growth and log volume (each item emits one ledger entry and one event)
/// rather than gas.
pub const MAX_BATCH_ITEMS: usize = 10;

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

#[near]
impl Contract {
    /// NEP-141 receiver and the only value-in payment entry point.
    ///
    /// Dispatches on the `msg` action, moves the settled legs and returns the
    /// unused amount so the FT resolver refunds the sender. State is written
    /// only after every check for the selected action passed.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if !assert_ft_predecessor(&env::predecessor_account_id(), &self.ft_account_id) {
            return PromiseOrValue::Value(amount);
        }
        if amount.0 == 0 || self.paused {
            return PromiseOrValue::Value(amount);
        }
        let action = match parse_payment_msg(&msg) {
            Ok(action) => action,
            Err(_) => return PromiseOrValue::Value(amount),
        };
        match action {
            PaymentMsg::PayDevelopers { developer, memo } => {
                self.pay_developers(sender_id, amount, developer, memo)
            }
            PaymentMsg::PayDevelopersBatch { payments } => {
                self.pay_developers_batch(sender_id, amount, payments)
            }
            PaymentMsg::CreditDeveloper { developer } => {
                self.credit_developer(sender_id, amount, developer)
            }
            PaymentMsg::PayTool { tool } => self.pay_tool(sender_id, amount, tool),
            PaymentMsg::PayTools { tools } => self.pay_tools(sender_id, amount, tools),
            PaymentMsg::OpenStream {
                recipient,
                rate_per_block,
                cliff_blocks,
            } => self.handle_open_stream(
                &sender_id,
                amount,
                recipient,
                rate_per_block.0,
                cliff_blocks,
            ),
            PaymentMsg::FundStream { stream_id } => {
                self.handle_fund_stream(&sender_id, amount, stream_id)
            }
        }
    }

    /// Private callback for one developer payout leg.
    ///
    /// Never panics. A failed `ft_transfer` (for example, the recipient is not
    /// registered with the FT) is settled as a withdrawable developer balance,
    /// which keeps the payment atomic with the platform credit already taken
    /// at dispatch time and loses no value. `unused` carries the payer's
    /// overpayment, which was never part of the payout; it is returned
    /// unchanged so the FT resolver refunds it.
    #[private]
    pub fn on_payout_done(
        &mut self,
        developer: AccountId,
        amount: U128,
        unused: U128,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> U128 {
        if res.is_err() {
            self.restore_developer_balance(&developer, amount.0);
        }
        unused
    }

    /// Private callback for one stream claim transfer.
    ///
    /// Never panics. A failed transfer restores `withdrawn` and
    /// `settled_volume`, so the recipient can claim the same accrual again;
    /// the amount is returned unused for symmetry with the FT resolver.
    #[private]
    pub fn on_stream_payout_done(
        &mut self,
        stream_id: u64,
        amount: U128,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> U128 {
        if res.is_err() {
            if let Some(mut stream) = self.streams.get(&stream_id).cloned() {
                stream.withdrawn = U128(stream.withdrawn.0.saturating_sub(amount.0));
                self.streams.insert(stream_id, stream);
            }
            self.sub_settled_volume(amount.0);
            return amount;
        }
        U128(0)
    }

    /// Private callback for one stream refund transfer.
    ///
    /// Never panics. A failed transfer restores the withdrawn deposit so the
    /// subscriber can retry through [`Contract::withdraw_unaccrued`].
    #[private]
    pub fn on_stream_refund_done(
        &mut self,
        stream_id: u64,
        amount: U128,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> U128 {
        if res.is_err() {
            if let Some(mut stream) = self.streams.get(&stream_id).cloned() {
                stream.deposit = U128(stream.deposit.0.saturating_add(amount.0));
                self.streams.insert(stream_id, stream);
            }
            return amount;
        }
        U128(0)
    }
}

impl Contract {
    /// Splits a single payment and pays the developer leg.
    fn pay_developers(
        &mut self,
        sender: AccountId,
        amount: U128,
        developer: AccountId,
        memo: Option<String>,
    ) -> PromiseOrValue<U128> {
        let split = split_amount(amount.0, self.platform_fee_bps);
        let platform = self.platform_wallet.clone();
        // The developer leg normally leaves by FT transfer, but
        // `on_payout_done` credits it to the balance when that transfer fails,
        // so the preflight reserves both keys before any state write.
        if !self.balance_writes_allowed(&[
            (&platform, split.platform.0),
            (&developer, split.developer.0),
        ]) {
            return PromiseOrValue::Value(amount);
        }
        self.credit_developer_balance(&platform, split.platform.0);
        self.add_settled_volume(amount.0);
        self.append_ledger_entry(
            sender.clone(),
            developer.clone(),
            amount.0,
            LedgerAction::Payment,
            None,
            memo.clone(),
        );
        LedgerEvent::PaymentProcessed {
            payer: sender,
            developer: developer.clone(),
            amount,
            developer_amount: split.developer,
            platform_amount: split.platform,
            memo: memo.clone(),
        }
        .emit();
        if split.developer.0 == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        PromiseOrValue::Promise(self.direct_payout_promise(developer, split.developer.0, 0, memo))
    }

    /// Splits a batch atomically; every leg is credited to a balance.
    fn pay_developers_batch(
        &mut self,
        sender: AccountId,
        amount: U128,
        payments: Vec<PaymentItem>,
    ) -> PromiseOrValue<U128> {
        if payments.is_empty() || payments.len() > MAX_BATCH_ITEMS {
            return PromiseOrValue::Value(amount);
        }
        let mut total = 0u128;
        for item in &payments {
            if item.amount.0 == 0 {
                return PromiseOrValue::Value(amount);
            }
            let Some(next) = total.checked_add(item.amount.0) else {
                return PromiseOrValue::Value(amount);
            };
            total = next;
        }
        if total != amount.0 {
            return PromiseOrValue::Value(amount);
        }

        let fee_bps = self.platform_fee_bps;
        let mut legs: Vec<(AccountId, U128, SplitView, Option<String>)> =
            Vec::with_capacity(payments.len());
        let mut platform_total = 0u128;
        for item in payments {
            let split = split_amount(item.amount.0, fee_bps);
            platform_total = platform_total.saturating_add(split.platform.0);
            legs.push((item.developer, item.amount, split, item.memo));
        }
        let platform = self.platform_wallet.clone();
        let mut credits: Vec<(&AccountId, u128)> = legs
            .iter()
            .map(|(developer, _, split, _)| (developer, split.developer.0))
            .collect();
        credits.push((&platform, platform_total));
        if !self.balance_writes_allowed(&credits) {
            return PromiseOrValue::Value(amount);
        }
        for (developer, item_amount, split, memo) in legs {
            self.credit_developer_balance(&developer, split.developer.0);
            self.append_ledger_entry(
                sender.clone(),
                developer.clone(),
                item_amount.0,
                LedgerAction::Payment,
                None,
                memo.clone(),
            );
            LedgerEvent::PaymentProcessed {
                payer: sender.clone(),
                developer,
                amount: item_amount,
                developer_amount: split.developer,
                platform_amount: split.platform,
                memo,
            }
            .emit();
        }
        self.credit_developer_balance(&platform, platform_total);
        self.add_settled_volume(amount.0);
        PromiseOrValue::Value(U128(0))
    }

    /// Credits the transferred amount to a developer's withdrawable balance.
    fn credit_developer(
        &mut self,
        sender: AccountId,
        amount: U128,
        developer: AccountId,
    ) -> PromiseOrValue<U128> {
        if !self.balance_writes_allowed(&[(&developer, amount.0)]) {
            return PromiseOrValue::Value(amount);
        }
        self.credit_developer_balance(&developer, amount.0);
        self.add_settled_volume(amount.0);
        self.append_ledger_entry(
            sender.clone(),
            developer.clone(),
            amount.0,
            LedgerAction::Payment,
            None,
            None,
        );
        LedgerEvent::PaymentProcessed {
            payer: sender,
            developer,
            amount,
            developer_amount: amount,
            platform_amount: U128(0),
            memo: None,
        }
        .emit();
        PromiseOrValue::Value(U128(0))
    }

    /// Updates one tool's counters and optionally credits its developer leg.
    ///
    /// The platform leg is aggregated by the caller so the batch path can
    /// credit it once. `pay_tool` passes `false`: the developer leg leaves by
    /// FT transfer, and the payout callback restores the balance only if that
    /// transfer fails. The batch path passes `true` because it settles every
    /// leg into a balance.
    fn settle_tool_leg(
        &mut self,
        sender: &AccountId,
        name: &str,
        mut tool: ToolInfo,
        split: &SplitView,
        credit_developer: bool,
    ) {
        let price = tool.price_per_call.0;
        tool.total_calls = tool
            .total_calls
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("tool call counter overflow"));
        tool.total_revenue = U128(
            tool.total_revenue
                .0
                .checked_add(price)
                .unwrap_or_else(|| env::panic_str("tool revenue overflow")),
        );
        let developer = tool.developer.clone();
        self.tools.insert(name.to_string(), tool);
        if credit_developer {
            self.credit_developer_balance(&developer, split.developer.0);
        }
        self.append_ledger_entry(
            sender.clone(),
            developer.clone(),
            price,
            LedgerAction::ToolCall,
            Some(name.to_string()),
            None,
        );
        LedgerEvent::ToolCalled {
            payer: sender.clone(),
            tool: name.to_string(),
            developer,
            amount: U128(price),
        }
        .emit();
    }

    /// Settles one tool call for exactly its price and refunds the excess.
    fn pay_tool(
        &mut self,
        sender: AccountId,
        amount: U128,
        tool_name: String,
    ) -> PromiseOrValue<U128> {
        let Some(tool) = self.tools.get(&tool_name).cloned() else {
            return PromiseOrValue::Value(amount);
        };
        if !tool.active {
            return PromiseOrValue::Value(amount);
        }
        let price = tool.price_per_call.0;
        if amount.0 < price {
            return PromiseOrValue::Value(amount);
        }

        let split = split_amount(price, self.platform_fee_bps);
        let developer = tool.developer.clone();
        let platform = self.platform_wallet.clone();
        if !self.balance_writes_allowed(&[
            (&platform, split.platform.0),
            (&developer, split.developer.0),
        ]) {
            return PromiseOrValue::Value(amount);
        }
        self.credit_developer_balance(&platform, split.platform.0);
        self.add_settled_volume(price);
        self.settle_tool_leg(&sender, &tool_name, tool, &split, false);

        let excess = amount.0 - price;
        if split.developer.0 == 0 {
            return PromiseOrValue::Value(U128(excess));
        }
        PromiseOrValue::Promise(self.direct_payout_promise(
            developer,
            split.developer.0,
            excess,
            None,
        ))
    }

    /// Settles a tool batch only when the transferred amount equals the sum of
    /// the prices; every leg is credited to a balance.
    fn pay_tools(
        &mut self,
        sender: AccountId,
        amount: U128,
        names: Vec<String>,
    ) -> PromiseOrValue<U128> {
        if names.is_empty() || names.len() > MAX_BATCH_ITEMS {
            return PromiseOrValue::Value(amount);
        }
        let fee_bps = self.platform_fee_bps;
        let mut total = 0u128;
        let mut platform_total = 0u128;
        let mut resolved = Vec::with_capacity(names.len());
        for name in names {
            let Some(tool) = self.tools.get(&name).cloned() else {
                return PromiseOrValue::Value(amount);
            };
            if !tool.active {
                return PromiseOrValue::Value(amount);
            }
            let split = split_amount(tool.price_per_call.0, fee_bps);
            let Some(next) = total.checked_add(tool.price_per_call.0) else {
                return PromiseOrValue::Value(amount);
            };
            total = next;
            platform_total = platform_total.saturating_add(split.platform.0);
            resolved.push((name, tool, split));
        }
        if total != amount.0 {
            return PromiseOrValue::Value(amount);
        }

        let platform = self.platform_wallet.clone();
        let mut credits: Vec<(&AccountId, u128)> = Vec::with_capacity(resolved.len() + 1);
        for (_, tool, split) in &resolved {
            if split.developer.0 > 0 {
                credits.push((&tool.developer, split.developer.0));
            }
        }
        if platform_total > 0 {
            credits.push((&platform, platform_total));
        }
        if !self.balance_writes_allowed(&credits) {
            return PromiseOrValue::Value(amount);
        }

        // Keep one balance write per distinct payee. `settle_tool_leg` keeps
        // its `credit_developer` guard disabled here; the aggregate below is
        // the single developer credit, and the platform is credited once.
        let mut aggregated: Vec<(AccountId, u128)> = Vec::with_capacity(credits.len());
        for (account, credit) in credits {
            if let Some((_, sum)) = aggregated.iter_mut().find(|(known, _)| known == account) {
                *sum = sum
                    .checked_add(credit)
                    .unwrap_or_else(|| env::panic_str("developer balance overflow"));
            } else {
                aggregated.push((account.clone(), credit));
            }
        }
        for (name, tool, split) in resolved {
            self.settle_tool_leg(&sender, &name, tool, &split, false);
        }
        for (account, credit) in aggregated {
            self.credit_developer_balance(&account, credit);
        }
        self.add_settled_volume(amount.0);
        PromiseOrValue::Value(U128(0))
    }

    /// Opens a stream from the transferred deposit.
    fn handle_open_stream(
        &mut self,
        funder: &AccountId,
        amount: U128,
        recipient: AccountId,
        rate_per_block: u128,
        cliff_blocks: u64,
    ) -> PromiseOrValue<U128> {
        if self.open_stream_deposit(funder, amount.0, recipient, rate_per_block, cliff_blocks) {
            PromiseOrValue::Value(U128(0))
        } else {
            PromiseOrValue::Value(amount)
        }
    }

    /// Adds the transferred amount to an existing stream's deposit.
    fn handle_fund_stream(
        &mut self,
        funder: &AccountId,
        amount: U128,
        stream_id: u64,
    ) -> PromiseOrValue<U128> {
        if self.fund_stream_deposit(funder, amount.0, stream_id) {
            PromiseOrValue::Value(U128(0))
        } else {
            PromiseOrValue::Value(amount)
        }
    }

    /// Schedules a bare NEP-141 `ft_transfer` from this contract.
    ///
    /// Attaches exactly one yoctoNEAR, as NEP-141 requires, and reserves
    /// [`GAS_FOR_FT_TRANSFER`] for the transfer.
    fn ft_transfer_promise(
        &self,
        recipient: AccountId,
        amount: u128,
        memo: Option<String>,
    ) -> Promise {
        ext_ft::ext(self.ft_account_id.clone())
            .with_attached_deposit(YOCTO_ONE)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(recipient, U128(amount), memo)
    }

    /// Schedules one developer payout leg followed by its private `U128`
    /// callback.
    pub(crate) fn direct_payout_promise(
        &self,
        recipient: AccountId,
        amount: u128,
        unused: u128,
        memo: Option<String>,
    ) -> Promise {
        self.ft_transfer_promise(recipient.clone(), amount, memo)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_FT_RESOLVE)
                    .on_payout_done(recipient, U128(amount), U128(unused)),
            )
    }

    /// Schedules one stream claim leg followed by its restoring callback.
    pub(crate) fn stream_payout_promise(
        &self,
        stream_id: u64,
        recipient: AccountId,
        amount: u128,
    ) -> Promise {
        self.ft_transfer_promise(recipient, amount, None).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_FT_RESOLVE)
                .on_stream_payout_done(stream_id, U128(amount)),
        )
    }

    /// Schedules one stream refund leg followed by its restoring callback.
    pub(crate) fn stream_refund_promise(
        &self,
        stream_id: u64,
        subscriber: AccountId,
        amount: u128,
    ) -> Promise {
        self.ft_transfer_promise(subscriber, amount, None).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_FT_RESOLVE)
                .on_stream_refund_done(stream_id, U128(amount)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msg_parses_every_documented_action() {
        let developer: AccountId = "dev1.portico.testnet".parse().unwrap();
        let recipient: AccountId = "dev1.portico.testnet".parse().unwrap();

        let cases = [
            (
                r#"{"action":"pay_developers","developer":"dev1.portico.testnet","memo":"sale"}"#,
                PaymentMsg::PayDevelopers {
                    developer: developer.clone(),
                    memo: Some("sale".to_string()),
                },
            ),
            (
                r#"{"action":"pay_developers","developer":"dev1.portico.testnet"}"#,
                PaymentMsg::PayDevelopers {
                    developer: developer.clone(),
                    memo: None,
                },
            ),
            (
                r#"{"action":"pay_developers_batch","payments":[{"developer":"dev1.portico.testnet","amount":"50","memo":null}]}"#,
                PaymentMsg::PayDevelopersBatch {
                    payments: vec![PaymentItem {
                        developer: developer.clone(),
                        amount: U128(50),
                        memo: None,
                    }],
                },
            ),
            (
                r#"{"action":"credit_developer","developer":"dev1.portico.testnet"}"#,
                PaymentMsg::CreditDeveloper {
                    developer: developer.clone(),
                },
            ),
            (
                r#"{"action":"pay_tool","tool":"web-search"}"#,
                PaymentMsg::PayTool {
                    tool: "web-search".to_string(),
                },
            ),
            (
                r#"{"action":"pay_tools","tools":["web-search","image-gen"]}"#,
                PaymentMsg::PayTools {
                    tools: vec!["web-search".to_string(), "image-gen".to_string()],
                },
            ),
            (
                r#"{"action":"open_stream","recipient":"dev1.portico.testnet","rate_per_block":"10","cliff_blocks":3600}"#,
                PaymentMsg::OpenStream {
                    recipient,
                    rate_per_block: U128(10),
                    cliff_blocks: 3_600,
                },
            ),
            (
                r#"{"action":"fund_stream","stream_id":7}"#,
                PaymentMsg::FundStream { stream_id: 7 },
            ),
        ];
        for (msg, expected) in cases {
            assert_eq!(parse_payment_msg(msg).unwrap(), expected, "{msg}");
        }
    }

    #[test]
    fn msg_rejects_empty_malformed_and_unknown_actions() {
        assert_eq!(
            parse_payment_msg("   ").unwrap_err(),
            PaymentMsgError::Empty
        );
        assert!(matches!(
            parse_payment_msg("{").unwrap_err(),
            PaymentMsgError::Invalid(_)
        ));
        assert!(matches!(
            parse_payment_msg(r#"{"action":"mystery"}"#).unwrap_err(),
            PaymentMsgError::Invalid(_)
        ));
        assert!(matches!(
            parse_payment_msg(r#"{"action":"pay_tool"}"#).unwrap_err(),
            PaymentMsgError::Invalid(_)
        ));
    }

    #[test]
    fn msg_predecessor_allowlist_only_accepts_the_ft() {
        let ft: AccountId = "token.portico.testnet".parse().unwrap();
        let buyer: AccountId = "buyer1.portico.testnet".parse().unwrap();
        assert!(assert_ft_predecessor(&ft, &ft));
        assert!(!assert_ft_predecessor(&buyer, &ft));
    }
}
