//! Cross-contract calls into the payment FT and the gas budget for payouts.

use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_sdk::json_types::U128;
use near_sdk::{ext_contract, near, AccountId, Gas, NearToken};

/// Gas reserved for each `ft_transfer` payout leg.
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);

/// Gas reserved for the private callback that resolves one payout leg.
pub const GAS_FOR_FT_RESOLVE: Gas = Gas::from_tgas(5);

/// NEP-141 requires exactly one yoctoNEAR attached to `ft_transfer`.
pub const YOCTO_ONE: NearToken = NearToken::from_yoctonear(1);

/// The payment FT's NEP-141 and NEP-148 surface used by this contract.
#[ext_contract(ext_ft)]
pub trait Ft {
    /// Transfers `amount` from the predecessor to `receiver_id`.
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);

    /// Returns `account_id`'s raw FT balance.
    fn ft_balance_of(&self, account_id: AccountId) -> U128;

    /// Returns the FT metadata; `decimals` must be 18.
    fn ft_metadata(&self) -> FungibleTokenMetadata;
}

/// Arguments serialized into the private developer-payout callback.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json])]
pub struct PayoutCallbackArgs {
    /// Developer that was paid.
    pub developer: AccountId,
    /// Amount sent; restored to the developer balance when the callback
    /// records a failed transfer.
    pub amount: U128,
}

/// Arguments serialized into the private stream-payout callback.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json])]
pub struct StreamPayoutCallbackArgs {
    /// Stream that was paid out.
    pub stream_id: u64,
    /// Amount sent; restored to the stream when the callback records a failure.
    pub amount: U128,
}
