//! Sandbox tests for the revenue-split per-block streams.
//!
//! The cliff is a duration measured from `start_block`, so the tests advance
//! the sandbox with `Worker::fast_forward` to exact heights relative to the
//! stored `cliff_end_block`. Accrual assertions are capped by the deposit, and
//! the block-dependent close path pins the expected accrual to the block that
//! emitted the `stream_cancelled` event.

use anyhow::Result;
use near_sdk::json_types::U128;
use portico_tests::{
    expect_failure, must_succeed, open_stream_msg, Harness, E18, ONE_YOCTO,
};
use serde_json::json;

const CLIFF_BLOCKS: u64 = 3_600;


#[tokio::test]
async fn stream_close_before_cliff_refunds_deposit() -> Result<()> {
    let harness = Harness::setup().await?;
    let deposit = 10 * E18;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    must_succeed(
        &harness
            .ft_transfer_call(
                &harness.buyer,
                deposit,
                open_stream_msg(harness.developer.id(), E18, CLIFF_BLOCKS),
            )
            .await?,
        "open_stream",
    );
    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - deposit
    );

    must_succeed(
        &harness
            .call_split(
                &harness.buyer,
                "close_stream",
                json!({"stream_id": 1}),
                0,
                100,
            )
            .await?,
        "close_stream before the cliff",
    );

    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 0);
    assert_eq!(harness.developer_balance(harness.buyer.id()).await?, deposit);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, deposit);

    let stream = harness.stream(1).await?.expect("stream 1");
    assert_eq!(stream.status, "closed");
    assert_eq!(stream.deposit.0, 0);
    assert_eq!(stream.withdrawn.0, 0);
    assert_eq!(harness.stream_deposit(1).await?, 0);

    let totals = harness.totals().await?;
    assert_eq!(totals.open_streams, 0);
    assert_eq!(totals.active_streams, 0);
    assert_eq!(totals.settled_volume.0, 0);

    let accrual = harness.stream_accrual(1).await?;
    assert_eq!(accrual.accrued.0, 0);
    assert_eq!(accrual.claimable.0, 0);
    assert_eq!(accrual.escrow_remaining.0, 0);
    assert_eq!(accrual.status, "closed");

    let again = harness
        .call_split(
            &harness.buyer,
            "close_stream",
            json!({"stream_id": 1}),
            0,
            100,
        )
        .await?;
    expect_failure(&again, "close an already closed stream");

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 2);
    assert_eq!(ledger[0].action, "stream_fund");
    assert_eq!(ledger[0].amount.0, deposit);
    assert_eq!(ledger[1].action, "stream_close");
    assert_eq!(ledger[1].amount.0, deposit);
    assert_eq!(ledger[1].payer, harness.buyer.id().to_string());
    assert_eq!(ledger[1].payee, harness.buyer.id().to_string());

    must_succeed(
        &harness.withdraw_balance(&harness.buyer).await?,
        "withdraw the stream refund",
    );
    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert_eq!(harness.developer_balance(harness.buyer.id()).await?, 0);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 3);
    assert_eq!(ledger[2].action, "developer_payout");
    assert_eq!(ledger[2].amount.0, deposit);
    assert_eq!(ledger[2].payee, harness.buyer.id().to_string());

    Ok(())
}




#[tokio::test]
async fn stream_withdraw_unaccrued_bounds_and_close_refund() -> Result<()> {
    let harness = Harness::setup().await?;
    let deposit = 10 * E18;
    let rate = E18;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    must_succeed(
        &harness
            .ft_transfer_call(
                &harness.buyer,
                deposit,
                open_stream_msg(harness.developer.id(), rate, CLIFF_BLOCKS),
            )
            .await?,
        "open_stream",
    );

    let owner_withdraw = harness
        .call_split(
            &harness.owner,
            "withdraw_unaccrued",
            json!({"stream_id": 1, "amount": U128::from(E18)}),
            ONE_YOCTO,
            50,
        )
        .await?;
    expect_failure(&owner_withdraw, "non-subscriber unaccrued withdrawal");

    let zero = harness
        .call_split(
            &harness.buyer,
            "withdraw_unaccrued",
            json!({"stream_id": 1, "amount": U128::from(0u128)}),
            ONE_YOCTO,
            50,
        )
        .await?;
    expect_failure(&zero, "zero unaccrued withdrawal");

    let over = harness
        .call_split(
            &harness.buyer,
            "withdraw_unaccrued",
            json!({"stream_id": 1, "amount": U128::from(deposit + E18)}),
            ONE_YOCTO,
            50,
        )
        .await?;
    expect_failure(&over, "unaccrued withdrawal above the deposit");

    let non_subscriber = harness
        .call_split(
            &harness.developer,
            "withdraw_unaccrued",
            json!({"stream_id": 1, "amount": U128::from(E18)}),
            ONE_YOCTO,
            50,
        )
        .await?;
    expect_failure(&non_subscriber, "recipient unaccrued withdrawal");

    must_succeed(
        &harness
            .call_split(
                &harness.buyer,
                "withdraw_unaccrued",
                json!({"stream_id": 1, "amount": U128::from(2 * E18)}),
                ONE_YOCTO,
                50,
            )
            .await?,
        "subscriber unaccrued withdrawal",
    );

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - deposit + 2 * E18
    );
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 8 * E18);
    assert_eq!(harness.stream_deposit(1).await?, 8 * E18);

    let accrual = harness.stream_accrual(1).await?;
    assert_eq!(accrual.accrued.0, 0);
    assert_eq!(accrual.claimable.0, 0);
    assert_eq!(accrual.escrow_remaining.0, 8 * E18);

    let too_much = harness
        .call_split(
            &harness.buyer,
            "withdraw_unaccrued",
            json!({"stream_id": 1, "amount": U128::from(9 * E18)}),
            ONE_YOCTO,
            50,
        )
        .await?;
    expect_failure(&too_much, "unaccrued withdrawal above the remaining deposit");

    must_succeed(
        &harness
            .call_split(
                &harness.buyer,
                "close_stream",
                json!({"stream_id": 1}),
                0,
                100,
            )
            .await?,
        "close_stream after the withdrawal",
    );

    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 0);
    assert_eq!(harness.developer_balance(harness.buyer.id()).await?, 8 * E18);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 8 * E18);
    assert_eq!(harness.stream_deposit(1).await?, 0);
    assert_eq!(harness.stream(1).await?.expect("stream 1").status, "closed");

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 3);
    assert_eq!(ledger[0].action, "stream_fund");
    assert_eq!(ledger[0].amount.0, deposit);
    assert_eq!(ledger[1].action, "stream_withdraw");
    assert_eq!(ledger[1].amount.0, 2 * E18);
    assert_eq!(ledger[1].payer, harness.buyer.id().to_string());
    assert_eq!(ledger[2].action, "stream_close");
    assert_eq!(ledger[2].amount.0, 8 * E18);

    let missing = harness.claim(&harness.buyer, 999).await?;
    expect_failure(&missing, "claim an unknown stream");

    must_succeed(
        &harness.withdraw_balance(&harness.buyer).await?,
        "withdraw the stream refund",
    );
    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert_eq!(harness.developer_balance(harness.buyer.id()).await?, 0);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 4);
    assert_eq!(ledger[3].action, "developer_payout");
    assert_eq!(ledger[3].amount.0, 8 * E18);

    Ok(())
}

#[tokio::test]
async fn stream_open_rejects_invalid_parameters() -> Result<()> {
    let harness = Harness::setup().await?;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    let zero_rate = harness
        .ft_transfer_call(
            &harness.buyer,
            E18,
            open_stream_msg(harness.developer.id(), 0, CLIFF_BLOCKS),
        )
        .await?;
    must_succeed(&zero_rate, "open_stream with a zero rate");

    let short_cliff = harness
        .ft_transfer_call(
            &harness.buyer,
            E18,
            open_stream_msg(harness.developer.id(), E18, CLIFF_BLOCKS - 1),
        )
        .await?;
    must_succeed(&short_cliff, "open_stream below the cliff minimum");

    let long_cliff = harness
        .ft_transfer_call(
            &harness.buyer,
            E18,
            open_stream_msg(harness.developer.id(), E18, 31_536_001),
        )
        .await?;
    must_succeed(&long_cliff, "open_stream above the cliff maximum");

    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert!(harness.stream(1).await?.is_none());
    assert!(harness.ledger(None, 100).await?.is_empty());

    let totals = harness.totals().await?;
    assert_eq!(totals.open_streams, 0);
    assert_eq!(totals.active_streams, 0);

    Ok(())
}
