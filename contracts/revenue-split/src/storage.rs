//! Payment-path storage bounds and the account-balance headroom guard.
//!
//! `ft_on_transfer` is called by the payment FT with unused gas only: no NEAR
//! deposit arrives together with a sale. The payment paths still write storage:
//!
//! * a first `developer_balances` entry for every payee (platform wallet,
//!   developer legs credited instead of transferred, stream refunds);
//! * a `streams` entry plus a `streams_by_recipient` index entry for every
//!   stream;
//! * a ledger entry for every settled movement ([`crate::ledger`]).
//!
//! Those writes are bounded in two independent ways:
//!
//! 1. **Collection caps.** [`MAX_DEV_BALS`] and [`MAX_STREAMS`] stop
//!    new keys once the cap is reached, while writes to an existing key still
//!    succeed: a repeat credit to a known payee, a `fund_stream` on a known
//!    stream, or a claim never grows the key set. The ledger has its own cap
//!    ([`crate::ledger::MAX_LEDGER_ENTRIES`]) and only stops appending entries.
//! 2. **Balance headroom.** Before a payment-path write that can add a key,
//!    `Contract::has_pay_headroom` requires
//!    `account_balance >= storage_byte_cost * (storage_usage + extra_bytes +
//!    PAY_HEADROOM_BYTES)`. The comparison uses saturating
//!    arithmetic on `u128`, so neither a huge `storage_usage` nor an absurd
//!    `extra_bytes` can wrap. The fixed headroom keeps a margin above the
//!    single-write estimate so the contract does not run exactly to the edge
//!    after every accepted sale.
//!
//! The per-entry byte constants are conservative Borsh estimates. A map entry
//! stores its prefix plus a Borsh key (`AccountId` = 4-byte length + up to 64
//! bytes) plus a Borsh value (`u128` = 16 bytes, `Stream` ≈ 233 bytes) and the
//! runtime charges the whole key/value pair; the constants add map bookkeeping
//! and the sibling index/ledger entries a single operation also writes.
//!
//! A payment path that would exceed a cap or the headroom returns the whole
//! transferred amount unused, before any state write, instead of panicking:
//! the FT resolver refunds the payer, so a sale either settles completely or
//! refunds completely. Callbacks (`on_payout_done`, `on_stream_*_done`) only
//! settle funds an earlier, preflighted path already accepted; they never
//! reject and never panic, so they are exempt from both guards even when their
//! restoring write lands one key above a cap.
//!
//! Because the check is against the whole account balance, the split account
//! must hold the stake for its existing state plus the headroom as liquid
//! NEAR. The tool-registration reserve alone is smaller than the headroom, so
//! deploy/demo setups fund the contract account with a small NEAR float (for
//! example 1 NEAR covers the default headroom and entry estimate).

use near_sdk::{env, AccountId};

use crate::Contract;

/// Largest number of distinct `developer_balances` keys the payment paths may
/// create.
///
/// Writes that update an existing balance key are still allowed at the cap, so
/// recovered revenue, stream refunds and repeated platform fees keep working.
pub const MAX_DEV_BALS: u64 = 10_000;

/// Largest number of streams the contract stores.
///
/// Streams are never deleted (a closed stream keeps its recovery state), so the
/// next stream id is also the live stream count.
pub const MAX_STREAMS: u64 = 10_000;

/// Fixed byte margin kept above `storage_usage + extra_bytes` by the headroom
/// check.
pub const PAY_HEADROOM_BYTES: u64 = 32_768;

/// Conservative storage cost of one new `developer_balances` entry.
pub const DEV_BAL_BYTES: u64 = 192;

/// Conservative storage cost of one new stream: the `streams` value, the
/// `streams_by_recipient` entry and the stream ledger entry.
pub const STREAM_BYTES: u64 = 1_024;

/// Storage stake required to hold `storage_usage + extra_bytes`.
///
/// Saturating: the product cannot wrap `u128`.
pub fn payment_storage_requirement(storage_usage: u64, extra_bytes: u64, byte_cost: u128) -> u128 {
    byte_cost.saturating_mul(u128::from(storage_usage).saturating_add(u128::from(extra_bytes)))
}

impl Contract {
    /// Returns `true` when the contract balance covers the bytes this payment
    /// write adds plus [`PAY_HEADROOM_BYTES`].
    ///
    /// `extra_bytes` is the conservative cost of the keys the caller is about
    /// to create; `0` always passes because existing-key writes never grow the
    /// key set.
    pub(crate) fn has_pay_headroom(&self, extra_bytes: u64) -> bool {
        if extra_bytes == 0 {
            return true;
        }
        let reserved = extra_bytes.saturating_add(PAY_HEADROOM_BYTES);
        let required = payment_storage_requirement(
            env::storage_usage(),
            reserved,
            env::storage_byte_cost().as_yoctonear(),
        );
        env::account_balance().as_yoctonear() >= required
    }

    /// Returns `true` when a payment path may credit every `(account, amount)`
    /// pair in `credits`.
    ///
    /// Only accounts that would gain a new balance key are charged: zero-amount
    /// legs create nothing, duplicates are counted once, and an already-funded
    /// payee never consumes cap or headroom.
    pub(crate) fn balance_writes_allowed(&self, credits: &[(&AccountId, u128)]) -> bool {
        let mut new_keys = 0u64;
        let mut seen: Vec<&AccountId> = Vec::with_capacity(credits.len());
        for &(account, amount) in credits {
            if amount == 0 || seen.contains(&account) {
                continue;
            }
            seen.push(account);
            if !self.developer_balances.contains_key(account) {
                new_keys = new_keys.saturating_add(1);
            }
        }
        if new_keys == 0 {
            return true;
        }
        if self.developer_balances_count.saturating_add(new_keys) > MAX_DEV_BALS {
            return false;
        }
        self.has_pay_headroom(
            DEV_BAL_BYTES.saturating_mul(new_keys),
        )
    }

    /// Returns `true` when `open_stream` may create the next stream.
    ///
    /// Ids start at 1, so `next_stream_id > MAX_STREAMS` means the cap is
    /// already reached.
    pub(crate) fn stream_creation_allowed(&self) -> bool {
        if self.next_stream_id > MAX_STREAMS {
            return false;
        }
        self.has_pay_headroom(STREAM_BYTES)
    }
}
