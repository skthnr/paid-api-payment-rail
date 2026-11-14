//! Per-block accrual streams and their lifecycle.
//!
//! `cliff_blocks` is a duration measured from `start_block`, so the stream
//! stores `cliff_end_block = start_block + cliff_blocks` and accrual begins at
//! `max(start_block, cliff_end_block)`. Paused blocks are subtracted from the
//! elapsed height, so paused time never accrues.
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
//!
//! # Rate epochs
//!
//! `update_stream_rate` must not reprice history with a single stored rate.
//! The stream therefore carries `accrued_base`, the amount earned before the
//! current rate epoch, and the accrual formula adds `accrued_base` to the
//! epoch's `rate * elapsed`. The field is zero for a freshly opened stream,
//! which makes the base formula equal to plain accrual until the first rate
//! change. `withdrawn` stays a lifetime counter.
//!
//! # Lifecycle
//!
//! `claim` is permissionless and refuses while the stream is `Paused`;
//! `close_stream`, `pause_stream`, `resume_stream`, `update_stream_rate` and
//! `withdraw_unaccrued` are subscriber-only. No value-out path is gated by the
//! contract-wide `paused` switch. A claim deducts `withdrawn` before its
//! transfer and the private callback restores it on failure, so a double claim
//! can never pay twice.

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Promise, PromiseOrValue};

use crate::events::LedgerEvent;
use crate::ledger::LedgerAction;
use crate::Contract;
use crate::ContractExt;

/// Lowest accepted `cliff_blocks` duration, in blocks.
pub const MIN_CLIFF_BLOCKS: u64 = 3_600;

/// Highest accepted `cliff_blocks` duration, in blocks (365 days at 1 s/block).
pub const MAX_CLIFF_BLOCKS: u64 = 31_536_000;

/// Largest page `get_streams_by_recipient` returns, regardless of the
/// requested limit.
pub const MAX_STREAM_PAGE: u32 = 100;

/// Lifecycle of a stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
pub enum StreamStatus {
    /// Accruing normally.
    Open,
    /// Paused; paused time does not accrue.
    Paused,
    /// Closed and frozen: accrual stopped, counters released.
    ///
    /// A recovery-only `claim` can still settle accrual whose payout leg
    /// failed during [`Contract::close_stream`].
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
    /// Accrual accumulated before the current rate epoch.
    ///
    /// Zero for a freshly opened stream. `update_stream_rate` moves the
    /// already-earned amount here and restarts the accrual clock, so a new
    /// rate applies only from that block onward instead of repricing history.
    pub accrued_base: U128,
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
        accrued_with_base(
            self.deposit.0,
            self.withdrawn.0,
            self.accrued_base.0,
            self.rate_per_block.0,
            self.start_block,
            self.cliff_end_block,
            self.paused_blocks,
            now_block,
        )
    }

    /// Amount accrued but not yet withdrawn at `now_block`.
    pub fn claimable_at(&self, now_block: u64) -> u128 {
        claimable_with_base(
            self.deposit.0,
            self.withdrawn.0,
            self.accrued_base.0,
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

    /// Paused blocks as of `now_block`, including an in-progress pause.
    ///
    /// `paused_blocks` is only folded forward on resume or close, so a paused
    /// stream must count `now_block - paused_at` explicitly or its view would
    /// keep accruing while time is frozen.
    pub fn paused_blocks_at(&self, now_block: u64) -> u64 {
        if self.status == StreamStatus::Paused {
            self.paused_blocks
                .saturating_add(now_block.saturating_sub(self.paused_at))
        } else {
            self.paused_blocks
        }
    }

    /// Full accrual view at `now_block`, honoring an in-progress pause.
    pub fn view_at(&self, now_block: u64) -> StreamView {
        let paused_blocks = self.paused_blocks_at(now_block);
        let accrued = accrued_with_base(
            self.deposit.0,
            self.withdrawn.0,
            self.accrued_base.0,
            self.rate_per_block.0,
            self.start_block,
            self.cliff_end_block,
            paused_blocks,
            now_block,
        );
        StreamView {
            accrued: U128(accrued),
            claimable: U128(accrued.saturating_sub(self.withdrawn.0)),
            escrow_remaining: U128(escrow_remaining(self.deposit.0, accrued)),
            status: self.status,
        }
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

/// Validates a cliff duration: `3_600..=31_536_000` blocks inclusive.
pub fn validate_cliff_blocks(cliff_blocks: u64) -> Result<(), &'static str> {
    if cliff_blocks < MIN_CLIFF_BLOCKS {
        return Err("cliff_blocks is below the 3600-block minimum");
    }
    if cliff_blocks > MAX_CLIFF_BLOCKS {
        return Err("cliff_blocks exceeds the 31536000-block maximum");
    }
    Ok(())
}

/// Validates an accrual rate: any positive raw amount.
pub fn validate_rate(rate_per_block: u128) -> Result<(), &'static str> {
    if rate_per_block == 0 {
        return Err("rate_per_block must be greater than zero");
    }
    Ok(())
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

/// Total amount accrued at `now_block` for a stream with a rate epoch.
///
/// `accrued_base` is the amount carried over from a previous rate epoch; a
/// stream that never changed its rate has `accrued_base = 0`.
pub fn accrued_with_base(
    deposit: u128,
    withdrawn: u128,
    accrued_base: u128,
    rate_per_block: u128,
    start_block: u64,
    cliff_end_block: u64,
    paused_blocks: u64,
    now_block: u64,
) -> u128 {
    let earned = accrued_base.saturating_add(rate_per_block.saturating_mul(u128::from(
        elapsed_blocks(start_block, cliff_end_block, paused_blocks, now_block),
    )));
    earned.min(deposit).max(withdrawn.min(deposit))
}

/// Amount accrued but not yet withdrawn for a rate-epoch stream.
pub fn claimable_with_base(
    deposit: u128,
    withdrawn: u128,
    accrued_base: u128,
    rate_per_block: u128,
    start_block: u64,
    cliff_end_block: u64,
    paused_blocks: u64,
    now_block: u64,
) -> u128 {
    accrued_with_base(
        deposit,
        withdrawn,
        accrued_base,
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

#[near]
impl Contract {
    /// Claims a stream's earned, not yet withdrawn amount for its recipient.
    ///
    /// Permissionless: the recipient always receives the funds and no third-party
    /// fee is paid. Refuses while the stream is paused. `withdrawn` is
    /// increased before the transfer is scheduled and restored by
    /// [`Contract::on_stream_payout_done`] if the transfer fails.
    pub fn claim(&mut self, stream_id: u64) -> Promise {
        let (recipient, amount) = self
            .settle_stream_claim(stream_id)
            .unwrap_or_else(|| env::panic_str("nothing to claim"));
        self.stream_payout_promise(stream_id, recipient, amount)
    }

    /// Returns a stream's remaining escrow deposit.
    pub fn get_stream_deposit(&self, stream_id: u64) -> U128 {
        self.streams
            .get(&stream_id)
            .map(|stream| stream.deposit)
            .unwrap_or_else(|| env::panic_str("stream not found"))
    }

    /// Returns the stream ids of `account`'s recipient index with `id >
    /// after_id`, oldest first.
    ///
    /// `after_id = None` starts at the first stream; `limit` is clamped to
    /// `1..=MAX_STREAM_PAGE`, so a caller cannot request an unbounded page.
    pub fn get_streams_by_recipient(
        &self,
        account: AccountId,
        after_id: Option<u64>,
        limit: u32,
    ) -> Vec<u64> {
        let limit = limit.clamp(1, MAX_STREAM_PAGE) as usize;
        let after = after_id.unwrap_or(0);
        self.streams_by_recipient
            .get(&account)
            .map(|ids| {
                ids.iter()
                    .copied()
                    .filter(|stream_id| *stream_id > after)
                    .take(limit)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Closes a stream; the subscriber only.
    ///
    /// Settles `accrued - withdrawn` to the recipient through one FT transfer
    /// and credits `deposit - accrued` to the subscriber's withdrawable
    /// balance, then freezes the stream. Closing while paused folds the
    /// in-progress pause into `paused_blocks` first, so paused time does not
    /// accrue.
    pub fn close_stream(&mut self, stream_id: u64) -> PromiseOrValue<U128> {
        let mut stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("stream not found"));
        require!(
            env::predecessor_account_id() == stream.subscriber,
            "only the stream subscriber can close it"
        );
        require!(
            stream.status != StreamStatus::Closed,
            "stream is already closed"
        );

        let now_block = env::block_height();
        if stream.status == StreamStatus::Paused {
            stream.paused_blocks = stream.paused_blocks_at(now_block);
            stream.paused_at = 0;
        }
        let accrued = stream.accrued_at(now_block);
        let claimable = accrued.saturating_sub(stream.withdrawn.0);
        let refund = stream.deposit.0.saturating_sub(accrued);
        let was_active = stream.status == StreamStatus::Open;

        stream.withdrawn = U128(accrued);
        stream.deposit = U128(accrued);
        stream.accrued_base = U128(accrued);
        stream.start_block = now_block;
        stream.cliff_end_block = now_block;
        stream.paused_blocks = 0;
        stream.status = StreamStatus::Closed;
        stream.paused_at = 0;
        let subscriber = stream.subscriber.clone();
        let recipient = stream.recipient.clone();
        self.streams.insert(stream_id, stream);

        self.open_streams = self.open_streams.saturating_sub(1);
        if was_active {
            self.active_streams = self.active_streams.saturating_sub(1);
        }
        if claimable > 0 {
            self.add_settled_volume(claimable);
            self.append_ledger_entry(
                subscriber.clone(),
                recipient.clone(),
                claimable,
                LedgerAction::StreamClaim,
                None,
                None,
            );
            LedgerEvent::StreamClaimed {
                stream_id,
                recipient: recipient.clone(),
                amount: U128(claimable),
            }
            .emit();
        }
        self.append_ledger_entry(
            subscriber.clone(),
            subscriber.clone(),
            refund,
            LedgerAction::StreamClose,
            None,
            None,
        );
        // Subscriber-only settlement of escrow the subscriber already funded:
        // the payment-path caps do not gate it, and a storage abort would
        // revert the whole close rather than lose a sale.
        self.credit_developer_balance(&subscriber, refund);
        LedgerEvent::StreamCancelled {
            stream_id,
            subscriber,
            refunded: U128(refund),
            paid: U128(claimable),
        }
        .emit();

        if claimable == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        PromiseOrValue::Promise(self.stream_payout_promise(stream_id, recipient, claimable))
    }
}

#[near]
impl Contract {
    /// Pauses accrual; the subscriber only.
    ///
    /// Paused time is excluded from accrual and `claim` refuses until the
    /// stream resumes, but closing and refunds stay available.
    pub fn pause_stream(&mut self, stream_id: u64) {
        let mut stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("stream not found"));
        require!(
            env::predecessor_account_id() == stream.subscriber,
            "only the stream subscriber can pause it"
        );
        require!(
            stream.status == StreamStatus::Open,
            "stream is not open"
        );
        let paused_at_block = env::block_height();
        require!(
            paused_at_block >= stream.cliff_end_block,
            "cannot pause before the accrual cliff"
        );
        stream.status = StreamStatus::Paused;
        stream.paused_at = paused_at_block;
        self.streams.insert(stream_id, stream);
        self.active_streams = self.active_streams.saturating_sub(1);
        LedgerEvent::StreamPaused {
            stream_id,
            paused_at_block,
        }
        .emit();
    }

    /// Resumes a paused stream; the subscriber only.
    ///
    /// Folds the elapsed pause into `paused_blocks`, so the frozen interval
    /// never accrues.
    pub fn resume_stream(&mut self, stream_id: u64) {
        let mut stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("stream not found"));
        require!(
            env::predecessor_account_id() == stream.subscriber,
            "only the stream subscriber can resume it"
        );
        require!(
            stream.status == StreamStatus::Paused,
            "stream is not paused"
        );
        let now_block = env::block_height();
        stream.paused_blocks = stream.paused_blocks_at(now_block);
        stream.paused_at = 0;
        stream.status = StreamStatus::Open;
        let paused_blocks = stream.paused_blocks;
        self.streams.insert(stream_id, stream);
        self.active_streams = self.active_streams.saturating_add(1);
        LedgerEvent::StreamResumed {
            stream_id,
            paused_blocks,
        }
        .emit();
    }

    /// Replaces a stream's accrual rate; the subscriber only.
    ///
    /// The already-earned amount is preserved as `accrued_base` and the
    /// accrual clock restarts at the current block, so the new rate applies
    /// only from now on instead of repricing history. Before the cliff the
    /// original cliff end is kept, so the new rate only starts earning when
    /// the cliff was already due to end. Rejects paused/closed streams and
    /// zero rates.
    pub fn update_stream_rate(&mut self, stream_id: u64, rate_per_block: U128) {
        let mut stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("stream not found"));
        require!(
            env::predecessor_account_id() == stream.subscriber,
            "only the stream subscriber can update the rate"
        );
        require!(
            stream.status == StreamStatus::Open,
            "only an open stream can change its rate"
        );
        validate_rate(rate_per_block.0).unwrap_or_else(|error| env::panic_str(error));

        let now_block = env::block_height();
        let accrued_now = stream.accrued_at(now_block);
        stream.accrued_base = U128(accrued_now);
        stream.start_block = now_block;
        if now_block >= stream.cliff_end_block {
            stream.cliff_end_block = now_block;
            stream.paused_blocks = 0;
        }
        stream.paused_at = 0;
        let old_rate_per_block = stream.rate_per_block;
        stream.rate_per_block = rate_per_block;
        self.streams.insert(stream_id, stream);
        LedgerEvent::StreamRateUpdated {
            stream_id,
            old_rate_per_block,
            new_rate_per_block: rate_per_block,
        }
        .emit();
    }

    /// Refunds unaccrued escrow to the subscriber through one FT transfer.
    ///
    /// The subscriber only; requires exactly one yoctoNEAR, rejects zero and
    /// any amount above `deposit - accrued`. The deposit is reduced before
    /// the transfer is scheduled and restored by
    /// [`Contract::on_stream_refund_done`] on failure, which also leaves the
    /// recovery path open on a closed stream whose refund leg failed.
    #[payable]
    pub fn withdraw_unaccrued(&mut self, stream_id: u64, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        let mut stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("stream not found"));
        let subscriber = stream.subscriber.clone();
        require!(
            env::predecessor_account_id() == subscriber,
            "only the stream subscriber can withdraw unaccrued funds"
        );
        require!(amount.0 > 0, "amount must be greater than zero");
        let now_block = env::block_height();
        let unaccrued = stream.view_at(now_block).escrow_remaining.0;
        require!(
            amount.0 <= unaccrued,
            "amount exceeds the unaccrued deposit"
        );
        stream.deposit = U128(stream.deposit.0.saturating_sub(amount.0));
        self.streams.insert(stream_id, stream);
        self.append_ledger_entry(
            subscriber.clone(),
            subscriber.clone(),
            amount.0,
            LedgerAction::StreamWithdraw,
            None,
            None,
        );
        LedgerEvent::StreamWithdrawn {
            stream_id,
            subscriber: subscriber.clone(),
            amount,
        }
        .emit();
        self.stream_refund_promise(stream_id, subscriber, amount.0)
    }
}

impl Contract {
    /// Creates a stream from a first deposit, or returns `false` untouched.
    pub(crate) fn open_stream_deposit(
        &mut self,
        funder: &AccountId,
        amount: u128,
        recipient: AccountId,
        rate_per_block: u128,
        cliff_blocks: u64,
    ) -> bool {
        if !self.stream_creation_allowed() {
            return false;
        }
        if validate_cliff_blocks(cliff_blocks).is_err() || validate_rate(rate_per_block).is_err() {
            return false;
        }
        let start_block = env::block_height();
        let Some(cliff_end_block) = start_block.checked_add(cliff_blocks) else {
            return false;
        };
        let Some(next_stream_id) = self.next_stream_id.checked_add(1) else {
            return false;
        };
        let stream_id = self.next_stream_id;
        self.next_stream_id = next_stream_id;

        let stream = Stream {
            subscriber: funder.clone(),
            recipient: recipient.clone(),
            deposit: U128(amount),
            rate_per_block: U128(rate_per_block),
            start_block,
            cliff_end_block,
            withdrawn: U128(0),
            accrued_base: U128(0),
            status: StreamStatus::Open,
            paused_blocks: 0,
            paused_at: 0,
        };
        self.streams.insert(stream_id, stream);
        self.open_streams = self.open_streams.saturating_add(1);
        self.active_streams = self.active_streams.saturating_add(1);
        let mut ids = self
            .streams_by_recipient
            .get(&recipient)
            .cloned()
            .unwrap_or_default();
        ids.push(stream_id);
        self.streams_by_recipient.insert(recipient.clone(), ids);

        self.append_ledger_entry(
            funder.clone(),
            recipient.clone(),
            amount,
            LedgerAction::StreamFund,
            None,
            None,
        );
        LedgerEvent::StreamOpened {
            stream_id,
            subscriber: funder.clone(),
            recipient,
            rate_per_block: U128(rate_per_block),
            deposit: U128(amount),
            cliff_end_block,
        }
        .emit();
        true
    }

    /// Adds `amount` to an existing non-closed stream, or returns `false`.
    pub(crate) fn fund_stream_deposit(
        &mut self,
        funder: &AccountId,
        amount: u128,
        stream_id: u64,
    ) -> bool {
        let Some(mut stream) = self.streams.get(&stream_id).cloned() else {
            return false;
        };
        if stream.status == StreamStatus::Closed {
            return false;
        }
        let deposit = match stream.deposit.0.checked_add(amount) {
            Some(deposit) => deposit,
            None => return false,
        };
        stream.deposit = U128(deposit);
        let recipient = stream.recipient.clone();
        self.streams.insert(stream_id, stream);
        self.append_ledger_entry(
            funder.clone(),
            recipient,
            amount,
            LedgerAction::StreamFund,
            None,
            None,
        );
        LedgerEvent::StreamFunded {
            stream_id,
            funder: funder.clone(),
            amount: U128(amount),
        }
        .emit();
        true
    }

    /// Deducts one stream's claimable accrual and records it.
    ///
    /// Returns `None` when there is nothing to claim. The deduction happens
    /// before any transfer is scheduled, which is what makes double claims
    /// impossible.
    fn settle_stream_claim(&mut self, stream_id: u64) -> Option<(AccountId, u128)> {
        let mut stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("stream not found"));
        require!(
            stream.status != StreamStatus::Paused,
            "stream is paused"
        );
        let now_block = env::block_height();
        let claimable = stream.claimable_at(now_block);
        if claimable == 0 {
            return None;
        }
        stream.withdrawn = U128(
            stream
                .withdrawn
                .0
                .checked_add(claimable)
                .unwrap_or_else(|| env::panic_str("stream withdrawal overflow")),
        );
        let subscriber = stream.subscriber.clone();
        let recipient = stream.recipient.clone();
        self.streams.insert(stream_id, stream);
        self.add_settled_volume(claimable);
        self.append_ledger_entry(
            subscriber,
            recipient.clone(),
            claimable,
            LedgerAction::StreamClaim,
            None,
            None,
        );
        LedgerEvent::StreamClaimed {
            stream_id,
            recipient: recipient.clone(),
            amount: U128(claimable),
        }
        .emit();
        Some((recipient, claimable))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_accrual_before_the_cliff() {
        // start 100, cliff duration 50 => cliff_end 150.
        assert_eq!(accrued_with_base(1_000, 0, 0, 10, 100, 150, 0, 120), 0);
        assert_eq!(claimable_with_base(1_000, 0, 0, 10, 100, 150, 0, 120), 0);
    }

    #[test]
    fn no_accrual_at_the_cliff_boundary() {
        assert_eq!(accrued_with_base(1_000, 0, 0, 10, 100, 150, 0, 150), 0);
    }

    #[test]
    fn accrual_starts_one_block_after_the_cliff() {
        assert_eq!(accrued_with_base(1_000, 0, 0, 10, 100, 150, 0, 151), 10);
    }

    #[test]
    fn accrual_uses_the_later_of_start_and_cliff_end() {
        // A stream already past its cliff at start starts at `start_block`.
        assert_eq!(accrued_with_base(1_000, 0, 0, 10, 100, 90, 0, 110), 100);
    }

    #[test]
    fn paused_blocks_are_subtracted_from_elapsed() {
        // 100 elapsed blocks minus 40 paused blocks, at 10 per block.
        assert_eq!(accrued_with_base(1_000, 0, 0, 10, 100, 150, 40, 250), 600);
    }

    #[test]
    fn paused_blocks_never_underflow_elapsed() {
        assert_eq!(accrued_with_base(1_000, 0, 0, 10, 100, 150, 10_000, 200), 0);
    }

    #[test]
    fn accrual_is_capped_by_the_deposit() {
        assert_eq!(accrued_with_base(500, 0, 0, 10, 100, 150, 0, 1_000), 500);
        assert_eq!(claimable_with_base(500, 0, 0, 10, 100, 150, 0, 1_000), 500);
        assert_eq!(
            escrow_remaining(500, accrued_with_base(500, 0, 0, 10, 100, 150, 0, 1_000)),
            0
        );
    }

    #[test]
    fn zero_rate_never_accrues() {
        assert_eq!(accrued_with_base(1_000, 0, 0, 0, 100, 150, 0, 1_000), 0);
        assert_eq!(claimable_with_base(1_000, 0, 0, 0, 100, 150, 0, 1_000), 0);
    }

    #[test]
    fn claimable_subtracts_withdrawn_and_escrow_is_the_remainder() {
        let deposit = 1_000;
        let withdrawn = 500;
        // 80 blocks elapsed at 10 per block => 800 earned.
        let total = accrued_with_base(deposit, withdrawn, 0, 10, 100, 150, 0, 230);
        let pending = claimable_with_base(deposit, withdrawn, 0, 10, 100, 150, 0, 230);
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
        let total = accrued_with_base(deposit, withdrawn, 0, 10, 100, 150, 0, 10_000);
        assert_eq!(total, deposit);
        assert_eq!(
            claimable_with_base(deposit, withdrawn, 0, 10, 100, 150, 0, 10_000),
            750
        );
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
            accrued_base: U128(0),
            status: StreamStatus::Open,
            paused_blocks: 0,
            paused_at: 0,
        };
        assert_eq!(stream.accrued_at(200), 500);
        assert_eq!(stream.claimable_at(200), 400);
        assert_eq!(stream.escrow_remaining_at(200), 500);
    }

    #[test]
    fn paused_stream_view_freezes_accrual() {
        let stream = Stream {
            subscriber: "buyer1.portico.testnet".parse().unwrap(),
            recipient: "dev1.portico.testnet".parse().unwrap(),
            deposit: U128(1_000),
            rate_per_block: U128(10),
            start_block: 100,
            cliff_end_block: 150,
            withdrawn: U128(0),
            accrued_base: U128(0),
            status: StreamStatus::Paused,
            paused_blocks: 0,
            paused_at: 210,
        };
        // Freezes at the pause block: 210 - 150 = 60 blocks.
        assert_eq!(stream.paused_blocks_at(300), 90);
        assert_eq!(stream.view_at(300).accrued, U128(600));
        assert_eq!(stream.view_at(300).claimable, U128(600));
        // The uncorrected helper keeps counting, which is why value paths use
        // `view_at` or settle the pause first.
        assert_eq!(stream.accrued_at(300), 1_000);
    }

    #[test]
    fn rate_epoch_math_preserves_the_base_and_adds_new_accrual() {
        let stream = Stream {
            subscriber: "buyer1.portico.testnet".parse().unwrap(),
            recipient: "dev1.portico.testnet".parse().unwrap(),
            deposit: U128(10_000),
            rate_per_block: U128(25),
            start_block: 200,
            cliff_end_block: 200,
            withdrawn: U128(1_000),
            accrued_base: U128(1_000),
            status: StreamStatus::Open,
            paused_blocks: 0,
            paused_at: 0,
        };
        // The epoch started at 200; 100 blocks at 25 plus the 1_000 base.
        assert_eq!(stream.accrued_at(300), 3_500);
        assert_eq!(stream.claimable_at(300), 2_500);
        // The base alone is already earned at the epoch start.
        assert_eq!(stream.accrued_at(200), 1_000);
        assert_eq!(stream.claimable_at(200), 0);
    }

    #[test]
    fn cliff_duration_bounds_are_inclusive() {
        assert!(validate_cliff_blocks(MIN_CLIFF_BLOCKS).is_ok());
        assert!(validate_cliff_blocks(MAX_CLIFF_BLOCKS).is_ok());
        assert!(validate_cliff_blocks(MIN_CLIFF_BLOCKS - 1).is_err());
        assert!(validate_cliff_blocks(MAX_CLIFF_BLOCKS + 1).is_err());
        assert!(validate_rate(0).is_err());
        assert!(validate_rate(1).is_ok());
    }
}
