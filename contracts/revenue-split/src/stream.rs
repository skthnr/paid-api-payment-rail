//! Per-block accrual streams.
//!
//! `cliff_blocks` is a duration measured from `start_block`, so the stream
//! stores `cliff_end_block = start_block + cliff_blocks` and accrual begins at
//! `max(start_block, cliff_end_block)`. Paused blocks are subtracted from the
//! elapsed height, so a paused stream never accrues.
//!
//! The view splits accrual into three numbers that always satisfy
//! `accrued + escrow_remaining == deposit` and
//! `claimable == accrued - withdrawn`:
//!
//! * `accrued`: total earned so far, capped at `deposit`;
//! * `claimable`: earned but not yet withdrawn;
//! * `escrow_remaining`: deposit that has not accrued yet.
//!
//! Section 3.3 of the specification writes the cap as
//! `min(deposit - withdrawn, rate * elapsed)` and then
//! `claimable = accrued - withdrawn`. Applying both literally double-subtracts
//! `withdrawn` after the first claim, so this module keeps the documented
//! `claimable` identity and caps total accrual at `deposit` instead, which is
//! the only form that preserves the two invariants above.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// Lifecycle of a stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
pub enum StreamStatus {
    /// Accruing normally.
    Open,
    /// Paused; paused time does not accrue.
    Paused,
    /// Terminally settled; no further claims or refunds.
    Closed,
}

/// A per-block accrual stream.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub struct Stream {
    /// Account that funded the stream and may close it.
    pub subscriber: AccountId,
    /// Account that receives accrued funds.
    pub recipient: AccountId,
    /// Total funded escrow in raw FT units.
    pub deposit: U128,
    /// Accrual per block in raw FT units.
    pub rate_per_block: U128,
    /// Block height at which the stream was opened.
    pub start_block: u64,
    /// Block height at which accrual may begin (`start_block + cliff_blocks`).
    pub cliff_end_block: u64,
    /// Amount already paid out in raw FT units.
    pub withdrawn: U128,
    /// Current lifecycle state.
    pub status: StreamStatus,
    /// Blocks accumulated while the stream was paused.
    pub paused_blocks: u64,
    /// Block height of the last pause; zero while not paused.
    pub paused_at: u64,
}

impl Stream {
    /// Total amount accrued at `now_block`, capped at the deposit.
    pub fn accrued_at(&self, now_block: u64) -> u128 {
        accrued(
            self.deposit.0,
            self.withdrawn.0,
            self.rate_per_block.0,
            self.start_block,
            self.cliff_end_block,
            self.paused_blocks,
            now_block,
        )
    }

    /// Amount accrued but not yet withdrawn at `now_block`.
    pub fn claimable_at(&self, now_block: u64) -> u128 {
        claimable(
            self.deposit.0,
            self.withdrawn.0,
            self.rate_per_block.0,
            self.start_block,
            self.cliff_end_block,
            self.paused_blocks,
            now_block,
        )
    }

    /// Deposit that has not accrued at `now_block`.
    pub fn escrow_remaining_at(&self, now_block: u64) -> u128 {
        escrow_remaining(self.deposit.0, self.accrued_at(now_block))
    }
}

/// Public view of a stream.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json])]
pub struct StreamView {
    /// Total earned so far, capped at the deposit.
    pub accrued: U128,
    /// Earned and not yet withdrawn.
    pub claimable: U128,
    /// Deposit that has not accrued yet.
    pub escrow_remaining: U128,
    /// Current lifecycle state.
    pub status: StreamStatus,
}

/// Blocks that have accrued at `now_block`.
///
/// Starts at `max(start_block, cliff_end_block)` and subtracts paused time
/// with saturating arithmetic.
pub fn elapsed_blocks(
    start_block: u64,
    cliff_end_block: u64,
    paused_blocks: u64,
    now_block: u64,
) -> u64 {
    now_block
        .saturating_sub(start_block.max(cliff_end_block))
        .saturating_sub(paused_blocks)
}

/// Total amount accrued at `now_block`, capped at `deposit`.
///
/// `withdrawn` is already-settled accrual and therefore a lower bound for the
/// reported total, and an upper bound for the reported claimable amount.
pub fn accrued(
    deposit: u128,
    withdrawn: u128,
    rate_per_block: u128,
    start_block: u64,
    cliff_end_block: u64,
    paused_blocks: u64,
    now_block: u64,
) -> u128 {
    let earned = rate_per_block.saturating_mul(u128::from(elapsed_blocks(
        start_block,
        cliff_end_block,
        paused_blocks,
        now_block,
    )));
    earned.min(deposit).max(withdrawn.min(deposit))
}

/// Amount accrued but not yet withdrawn at `now_block`.
pub fn claimable(
    deposit: u128,
    withdrawn: u128,
    rate_per_block: u128,
    start_block: u64,
    cliff_end_block: u64,
    paused_blocks: u64,
    now_block: u64,
) -> u128 {
    accrued(
        deposit,
        withdrawn,
        rate_per_block,
        start_block,
        cliff_end_block,
        paused_blocks,
        now_block,
    )
    .saturating_sub(withdrawn)
}

/// Deposit that has not accrued yet.
pub fn escrow_remaining(deposit: u128, accrued: u128) -> u128 {
    deposit.saturating_sub(accrued)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_accrual_before_the_cliff() {
        // start 100, cliff duration 50 => cliff_end 150.
        assert_eq!(accrued(1_000, 0, 10, 100, 150, 0, 120), 0);
        assert_eq!(claimable(1_000, 0, 10, 100, 150, 0, 120), 0);
    }

    #[test]
    fn no_accrual_at_the_cliff_boundary() {
        assert_eq!(accrued(1_000, 0, 10, 100, 150, 0, 150), 0);
    }

    #[test]
    fn accrual_starts_one_block_after_the_cliff() {
        assert_eq!(accrued(1_000, 0, 10, 100, 150, 0, 151), 10);
    }

    #[test]
    fn accrual_uses_the_later_of_start_and_cliff_end() {
        // A stream already past its cliff at start starts at `start_block`.
        assert_eq!(accrued(1_000, 0, 10, 100, 90, 0, 110), 100);
    }

    #[test]
    fn paused_blocks_are_subtracted_from_elapsed() {
        // 100 elapsed blocks minus 40 paused blocks, at 10 per block.
        assert_eq!(accrued(1_000, 0, 10, 100, 150, 40, 250), 600);
    }

    #[test]
    fn paused_blocks_never_underflow_elapsed() {
        assert_eq!(accrued(1_000, 0, 10, 100, 150, 10_000, 200), 0);
    }

    #[test]
    fn accrual_is_capped_by_the_deposit() {
        assert_eq!(accrued(500, 0, 10, 100, 150, 0, 1_000), 500);
        assert_eq!(claimable(500, 0, 10, 100, 150, 0, 1_000), 500);
        assert_eq!(escrow_remaining(500, accrued(500, 0, 10, 100, 150, 0, 1_000)), 0);
    }

    #[test]
    fn zero_rate_never_accrues() {
        assert_eq!(accrued(1_000, 0, 0, 100, 150, 0, 1_000), 0);
        assert_eq!(claimable(1_000, 0, 0, 100, 150, 0, 1_000), 0);
    }

    #[test]
    fn claimable_subtracts_withdrawn_and_escrow_is_the_remainder() {
        let deposit = 1_000;
        let withdrawn = 500;
        // 80 blocks elapsed at 10 per block => 800 earned.
        let total = accrued(deposit, withdrawn, 10, 100, 150, 0, 230);
        let pending = claimable(deposit, withdrawn, 10, 100, 150, 0, 230);
        let escrow = escrow_remaining(deposit, total);
        assert_eq!(total, 800);
        assert_eq!(pending, 300);
        assert_eq!(escrow, 200);
        assert_eq!(total + escrow, deposit);
        assert_eq!(total, withdrawn + pending);
    }

    #[test]
    fn fully_accrued_stream_has_no_escrow_left() {
        let deposit = 1_000;
        let withdrawn = 250;
        let total = accrued(deposit, withdrawn, 10, 100, 150, 0, 10_000);
        assert_eq!(total, deposit);
        assert_eq!(claimable(deposit, withdrawn, 10, 100, 150, 0, 10_000), 750);
        assert_eq!(escrow_remaining(deposit, total), 0);
    }

    #[test]
    fn stream_view_helpers_match_the_free_functions() {
        let stream = Stream {
            subscriber: "buyer1.portico.testnet".parse().unwrap(),
            recipient: "dev1.portico.testnet".parse().unwrap(),
            deposit: U128(1_000),
            rate_per_block: U128(10),
            start_block: 100,
            cliff_end_block: 150,
            withdrawn: U128(100),
            status: StreamStatus::Open,
            paused_blocks: 0,
            paused_at: 0,
        };
        assert_eq!(stream.accrued_at(200), 500);
        assert_eq!(stream.claimable_at(200), 400);
        assert_eq!(stream.escrow_remaining_at(200), 500);
    }
}
