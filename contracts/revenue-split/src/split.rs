//! Fee split math for the revenue-split contract.
//!
//! All amounts are raw FT units. The platform cut is
//! `floor(amount * fee_bps / 10_000)` and the developer receives the
//! remainder, so the two legs always add back up to `amount`.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// Largest platform fee the contract accepts, in basis points (50%).
pub const MAX_FEE_BPS: u16 = 5_000;

/// Basis-point denominator.
pub const BPS_DENOM: u128 = 10_000;

/// Result of splitting one gross amount between the two payees.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json])]
pub struct SplitView {
    /// Amount credited to the developer.
    pub developer: U128,
    /// Amount credited to the platform wallet.
    pub platform: U128,
}

/// One resolved developer payout leg.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json])]
pub struct SplitLeg {
    /// Developer that receives this leg.
    pub developer: AccountId,
    /// Leg amount in raw FT units.
    pub amount: U128,
    /// Memo forwarded to the FT transfer.
    pub memo: Option<String>,
}

/// One requested payment before the split is applied.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json])]
pub struct PaymentItem {
    /// Developer that should receive the developer leg.
    pub developer: AccountId,
    /// Gross amount in raw FT units.
    pub amount: U128,
    /// Memo recorded in the ledger entry.
    pub memo: Option<String>,
}

impl PaymentItem {
    /// Resolves the developer leg of this payment at `fee_bps`.
    ///
    /// The platform leg is aggregated by the caller, so it is not returned
    /// here.
    pub fn split(&self, fee_bps: u16) -> SplitLeg {
        SplitLeg {
            developer: self.developer.clone(),
            amount: split_amount(self.amount.0, fee_bps).developer,
            memo: self.memo.clone(),
        }
    }
}

/// Splits `amount` into the developer and platform legs at `fee_bps`.
///
/// # Panics
///
/// Panics when `fee_bps > MAX_FEE_BPS` or when `amount * fee_bps` overflows
/// `u128`. Both cases are unreachable for state written through this
/// contract: `new` and `set_platform_fee` enforce the fee bound.
pub fn split_amount(amount: u128, fee_bps: u16) -> SplitView {
    assert!(fee_bps <= MAX_FEE_BPS, "fee exceeds MAX_FEE_BPS");
    let platform = amount
        .checked_mul(u128::from(fee_bps))
        .expect("split multiplication overflow")
        / BPS_DENOM;
    let developer = amount
        .checked_sub(platform)
        .expect("split subtraction underflow");
    SplitView {
        developer: U128(developer),
        platform: U128(platform),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_fee_leaves_everything_to_the_developer() {
        let split = split_amount(1_000, 0);
        assert_eq!(split.developer, U128(1_000));
        assert_eq!(split.platform, U128(0));
    }

    #[test]
    fn twenty_percent_splits_eighty_twenty() {
        let split = split_amount(100, 2_000);
        assert_eq!(split.developer, U128(80));
        assert_eq!(split.platform, U128(20));
    }

    #[test]
    fn maximum_fee_splits_fifty_fifty() {
        let split = split_amount(1_000_000, MAX_FEE_BPS);
        assert_eq!(split.developer, U128(500_000));
        assert_eq!(split.platform, U128(500_000));
    }

    #[test]
    fn platform_leg_floors_and_developer_keeps_the_remainder() {
        let split = split_amount(101, 2_000);
        assert_eq!(split.platform, U128(20));
        assert_eq!(split.developer, U128(81));
        assert_eq!(split.developer.0 + split.platform.0, 101);
    }

    #[test]
    fn small_amounts_floor_the_platform_leg_to_zero() {
        let split = split_amount(4, 2_000);
        assert_eq!(split.platform, U128(0));
        assert_eq!(split.developer, U128(4));
    }

    #[test]
    fn payment_item_resolves_its_developer_leg() {
        let item = PaymentItem {
            developer: "dev1.portico.testnet".parse().unwrap(),
            amount: U128(250),
            memo: Some("memo".to_string()),
        };
        let leg = item.split(2_000);
        assert_eq!(leg.developer, item.developer);
        assert_eq!(leg.amount, U128(200));
        assert_eq!(leg.memo.as_deref(), Some("memo"));
    }
}
