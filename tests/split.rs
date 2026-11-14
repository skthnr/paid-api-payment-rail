//! Sandbox tests for the revenue-split payment paths.
//!
//! Every test starts its own sandbox through [`Harness::setup`] and asserts raw
//! FT balances, the per-account withdrawable balance, the public ledger and the
//! aggregate counters. Amounts are raw 18-decimal units.

use anyhow::Result;
use portico_tests::{
    batch_msg, expect_failure, expect_handled_failure, fuzz_amounts, must_succeed,
    pay_developers_msg, pay_tool_msg, pay_tools_msg, Harness, BPS_DENOM, E18, FEE_BPS,
};
use serde_json::json;

#[tokio::test]
async fn split_pays_developer_and_platform_from_one_transfer() -> Result<()> {
    let harness = Harness::setup().await?;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            100,
            pay_developers_msg(harness.developer.id()),
        )
        .await?;
    must_succeed(&outcome, "pay_developers");

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - 100
    );
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 80);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 20);
    assert_eq!(harness.developer_balance(harness.developer.id()).await?, 0);
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 20);

    let totals = harness.totals().await?;
    assert_eq!(totals.settled_volume.0, 100);
    assert_eq!(totals.total_developer_balance.0, 20);

    let split = harness.calculate_split(100).await?;
    assert_eq!(split.developer.0, 80);
    assert_eq!(split.platform.0, 20);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].id, 1);
    assert_eq!(ledger[0].payer, harness.buyer.id().to_string());
    assert_eq!(ledger[0].payee, harness.developer.id().to_string());
    assert_eq!(ledger[0].amount.0, 100);
    assert_eq!(ledger[0].action, "payment");
    assert_eq!(ledger[0].tool, None);
    assert_eq!(ledger[0].memo, None);
    assert!(ledger[0].block_height > 0);

    Ok(())
}

#[tokio::test]
async fn split_batch_pays_two_developers_and_platform() -> Result<()> {
    let harness = Harness::setup().await?;
    let second_developer = harness.new_registered_account().await?;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            100,
            batch_msg(&[
                (harness.developer.id(), 50),
                (second_developer.id(), 50),
            ]),
        )
        .await?;
    must_succeed(&outcome, "pay_developers_batch");

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - 100
    );
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 0);
    assert_eq!(harness.ft_balance(second_developer.id()).await?, 0);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 100);
    assert_eq!(harness.developer_balance(harness.developer.id()).await?, 40);
    assert_eq!(
        harness.developer_balance(second_developer.id()).await?,
        40
    );
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 20);
    assert_eq!(harness.totals().await?.total_developer_balance.0, 100);

    must_succeed(
        &harness.withdraw_balance(&harness.developer).await?,
        "first developer withdrawal",
    );
    must_succeed(
        &harness.withdraw_balance(&second_developer).await?,
        "second developer withdrawal",
    );
    must_succeed(
        &harness.withdraw_balance(&harness.platform).await?,
        "platform withdrawal",
    );

    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 40);
    assert_eq!(harness.ft_balance(second_developer.id()).await?, 40);
    assert_eq!(harness.ft_balance(harness.platform.id()).await?, 20);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert_eq!(harness.developer_balance(harness.developer.id()).await?, 0);
    assert_eq!(
        harness.developer_balance(second_developer.id()).await?,
        0
    );
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 0);
    assert_eq!(harness.totals().await?.total_developer_balance.0, 0);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 5);
    assert_eq!(ledger[0].action, "payment");
    assert_eq!(ledger[0].amount.0, 50);
    assert_eq!(ledger[0].payee, harness.developer.id().to_string());
    assert_eq!(ledger[1].action, "payment");
    assert_eq!(ledger[1].amount.0, 50);
    assert_eq!(ledger[1].payee, second_developer.id().to_string());
    assert_eq!(ledger[2].action, "developer_payout");
    assert_eq!(ledger[2].amount.0, 40);
    assert_eq!(ledger[3].action, "developer_payout");
    assert_eq!(ledger[3].amount.0, 40);
    assert_eq!(ledger[4].action, "developer_payout");
    assert_eq!(ledger[4].amount.0, 20);
    assert_eq!(ledger[4].payee, harness.platform.id().to_string());

    Ok(())
}

#[tokio::test]
async fn split_zero_amount_reverts_inside_the_ft() -> Result<()> {
    let harness = Harness::setup().await?;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            0,
            pay_developers_msg(harness.developer.id()),
        )
        .await?;
    expect_failure(&outcome, "zero-amount ft_transfer_call");

    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 0);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert!(harness.ledger(None, 100).await?.is_empty());

    let totals = harness.totals().await?;
    assert_eq!(totals.settled_volume.0, 0);
    assert_eq!(totals.total_developer_balance.0, 0);

    Ok(())
}

// The port has no developer registry in the payment path, so the origin
// zero-address vector lands on the FT-registration boundary: the split credits
// the platform cut and writes the payment entry, the developer `ft_transfer`
// fails because the account is not registered with the NEP-141, and the private
// callback restores the developer leg into the withdrawable balance.
#[tokio::test]
async fn split_pay_developers_to_unregistered_developer_settles_balance() -> Result<()> {
    let harness = Harness::setup().await?;
    let unlisted = harness.new_account().await?;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    let outcome = harness
        .ft_transfer_call(&harness.buyer, 100, pay_developers_msg(unlisted.id()))
        .await?;
    expect_handled_failure(&outcome, "unregistered developer payout");

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - 100
    );
    assert_eq!(harness.ft_balance(unlisted.id()).await?, 0);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 100);
    assert_eq!(harness.developer_balance(unlisted.id()).await?, 80);
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 20);
    assert_eq!(harness.totals().await?.total_developer_balance.0, 100);
    assert_eq!(harness.totals().await?.settled_volume.0, 100);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].action, "payment");
    assert_eq!(ledger[0].payee, unlisted.id().to_string());
    assert_eq!(ledger[0].amount.0, 100);

    assert_eq!(harness.ft_balance(harness.split.id()).await?, 100);
    must_succeed(
        &harness.withdraw_balance(&unlisted).await?,
        "restored balance withdrawal",
    );
    assert_eq!(harness.ft_balance(unlisted.id()).await?, 0);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 100);
    assert_eq!(harness.developer_balance(unlisted.id()).await?, 80);

    Ok(())
}

#[tokio::test]
async fn split_unknown_tool_returns_amount_unused() -> Result<()> {
    let harness = Harness::setup().await?;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    let outcome = harness
        .ft_transfer_call(&harness.buyer, 100, pay_tool_msg("missing-tool"))
        .await?;
    must_succeed(&outcome, "unknown-tool ft_transfer_call");

    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert!(harness.tool_info("missing-tool").await?.is_none());
    assert!(harness.ledger(None, 100).await?.is_empty());

    let totals = harness.totals().await?;
    assert_eq!(totals.settled_volume.0, 0);
    assert_eq!(totals.tools_count, 0);

    Ok(())
}

#[tokio::test]
async fn split_fuzz_vectors_match_bps_math() -> Result<()> {
    let harness = Harness::setup().await?;
    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;
    let vectors = fuzz_amounts();

    let mut expected_platform = 0u128;
    let mut expected_developer = 0u128;
    let mut expected_volume = 0u128;

    for (index, amount) in vectors.iter().enumerate() {
        let platform = amount
            .checked_mul(u128::from(FEE_BPS))
            .expect("fee multiplication overflow")
            / BPS_DENOM;
        let developer = amount - platform;
        expected_platform += platform;
        expected_developer += developer;
        expected_volume += amount;

        let outcome = harness
            .ft_transfer_call(
                &harness.buyer,
                *amount,
                pay_developers_msg(harness.developer.id()),
            )
            .await?;
        must_succeed(&outcome, "fuzz pay_developers");

        assert_eq!(
            harness.ft_balance(harness.developer.id()).await?,
            expected_developer,
            "developer leg after vector {index} of {amount}"
        );
        assert_eq!(
            harness.ft_balance(harness.split.id()).await?,
            expected_platform,
            "platform escrow after vector {index} of {amount}"
        );
        assert_eq!(
            harness.developer_balance(harness.platform.id()).await?,
            expected_platform,
            "platform balance after vector {index} of {amount}"
        );
        assert_eq!(
            harness.totals().await?.settled_volume.0,
            expected_volume,
            "settled volume after vector {index} of {amount}"
        );
    }

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - expected_volume
    );
    assert_eq!(harness.developer_balance(harness.developer.id()).await?, 0);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), vectors.len());
    for (index, (entry, amount)) in ledger.iter().zip(vectors.iter()).enumerate() {
        assert_eq!(entry.id, index as u64 + 1);
        assert_eq!(entry.amount.0, *amount);
        assert_eq!(entry.action, "payment");
        assert_eq!(entry.payee, harness.developer.id().to_string());
    }

    Ok(())
}

#[tokio::test]
async fn split_pay_tool_charges_price_and_refunds_excess() -> Result<()> {
    let harness = Harness::setup().await?;
    let price = 1_000_000u128;
    must_succeed(
        &harness
            .register_tool(
                &harness.developer,
                "web-search",
                harness.developer.id(),
                price,
            )
            .await?,
        "register_tool",
    );

    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;

    let outcome = harness
        .ft_transfer_call(&harness.buyer, price, pay_tool_msg("web-search"))
        .await?;
    must_succeed(&outcome, "exact-price pay_tool");

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - price
    );
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 800_000);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 200_000);
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 200_000);

    let tool = harness
        .tool_info("web-search")
        .await?
        .expect("registered tool");
    assert_eq!(tool.total_calls, 1);
    assert_eq!(tool.total_revenue.0, price);
    assert_eq!(harness.totals().await?.settled_volume.0, price);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].action, "tool_call");
    assert_eq!(ledger[0].tool.as_deref(), Some("web-search"));
    assert_eq!(ledger[0].amount.0, price);

    let excess = 500_000u128;
    let outcome = harness
        .ft_transfer_call(&harness.buyer, price + excess, pay_tool_msg("web-search"))
        .await?;
    must_succeed(&outcome, "excess pay_tool");

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - 2 * price
    );
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 1_600_000);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 400_000);
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 400_000);
    assert_eq!(
        harness.totals().await?.settled_volume.0,
        2 * price
    );

    let tool = harness
        .tool_info("web-search")
        .await?
        .expect("registered tool");
    assert_eq!(tool.total_calls, 2);
    assert_eq!(tool.total_revenue.0, 2 * price);
    assert_eq!(harness.ledger(None, 100).await?.len(), 2);

    let underpay = price - 1;
    let outcome = harness
        .ft_transfer_call(&harness.buyer, underpay, pay_tool_msg("web-search"))
        .await?;
    must_succeed(&outcome, "underpaid pay_tool");

    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - 2 * price
    );
    let tool = harness
        .tool_info("web-search")
        .await?
        .expect("registered tool");
    assert_eq!(tool.total_calls, 2);
    assert_eq!(tool.total_revenue.0, 2 * price);
    assert_eq!(harness.ledger(None, 100).await?.len(), 2);

    Ok(())
}

#[tokio::test]
async fn split_pay_tool_inactive_tool_refunds() -> Result<()> {
    let harness = Harness::setup().await?;
    let price = 1_000_000u128;
    must_succeed(
        &harness
            .register_tool(
                &harness.developer,
                "web-search",
                harness.developer.id(),
                price,
            )
            .await?,
        "register_tool",
    );
    must_succeed(
        &harness
            .call_split(
                &harness.developer,
                "deactivate_tool",
                json!({"name": "web-search"}),
                0,
                50,
            )
            .await?,
        "deactivate_tool",
    );
    assert!(!harness.is_tool_active("web-search").await?);

    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;
    let outcome = harness
        .ft_transfer_call(&harness.buyer, price, pay_tool_msg("web-search"))
        .await?;
    must_succeed(&outcome, "inactive-tool pay_tool");

    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert!(harness.ledger(None, 100).await?.is_empty());

    let tool = harness
        .tool_info("web-search")
        .await?
        .expect("registered tool");
    assert_eq!(tool.total_calls, 0);
    assert_eq!(tool.total_revenue.0, 0);

    Ok(())
}

#[tokio::test]
async fn split_failed_payout_restores_developer_and_refunds_excess() -> Result<()> {
    let harness = Harness::setup().await?;
    let unlisted = harness.new_account().await?;
    let price = 1_000_000u128;
    let excess = 500_000u128;
    must_succeed(
        &harness
            .register_tool(&harness.developer, "ghost-tool", unlisted.id(), price)
            .await?,
        "register_tool",
    );

    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;
    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            price + excess,
            pay_tool_msg("ghost-tool"),
        )
        .await?;
    expect_handled_failure(&outcome, "failed developer payout");

    assert_eq!(harness.ft_balance(unlisted.id()).await?, 0);
    assert_eq!(harness.developer_balance(unlisted.id()).await?, 800_000);
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 200_000);
    assert_eq!(
        harness.ft_balance(harness.buyer.id()).await?,
        buyer_start - price
    );
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 1_000_000);
    assert_eq!(harness.totals().await?.settled_volume.0, price);

    let tool = harness
        .tool_info("ghost-tool")
        .await?
        .expect("registered tool");
    assert_eq!(tool.total_calls, 1);
    assert_eq!(tool.total_revenue.0, price);

    Ok(())
}

#[tokio::test]
async fn split_paused_contract_refunds_value_in() -> Result<()> {
    let harness = Harness::setup().await?;
    must_succeed(
        &harness
            .call_split(
                &harness.owner,
                "set_paused",
                json!({"paused": true}),
                0,
                30,
            )
            .await?,
        "set_paused(true)",
    );

    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;
    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            100,
            pay_developers_msg(harness.developer.id()),
        )
        .await?;
    must_succeed(&outcome, "paused pay_developers");

    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 0);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert!(harness.ledger(None, 100).await?.is_empty());
    assert_eq!(harness.totals().await?.settled_volume.0, 0);

    must_succeed(
        &harness
            .call_split(
                &harness.owner,
                "set_paused",
                json!({"paused": false}),
                0,
                30,
            )
            .await?,
        "set_paused(false)",
    );
    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            100,
            pay_developers_msg(harness.developer.id()),
        )
        .await?;
    must_succeed(&outcome, "unpaused pay_developers");
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, 80);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 20);

    Ok(())
}

#[tokio::test]
async fn split_volume_and_balance_views_track_large_units() -> Result<()> {
    let harness = Harness::setup().await?;
    let amount = 1_000 * E18;

    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            amount,
            pay_developers_msg(harness.developer.id()),
        )
        .await?;
    must_succeed(&outcome, "large-unit pay_developers");

    let split = harness.calculate_split(amount).await?;
    assert_eq!(split.platform.0, amount / 5);
    assert_eq!(split.developer.0, amount - amount / 5);
    assert_eq!(harness.ft_balance(harness.developer.id()).await?, split.developer.0);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, split.platform.0);
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, split.platform.0);

    Ok(())
}

#[tokio::test]
async fn split_pay_tools_batch_credits_each_leg_once() -> Result<()> {
    let harness = Harness::setup().await?;
    let first_price = 1_000_000u128;
    let second_price = 2_000_000u128;
    for (name, price) in [("web-search", first_price), ("image-gen", second_price)] {
        must_succeed(
            &harness
                .register_tool(&harness.developer, name, harness.developer.id(), price)
                .await?,
            "register batch tool",
        );
    }

    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;
    let total = first_price + second_price;
    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            total,
            pay_tools_msg(&["web-search", "image-gen"]),
        )
        .await?;
    must_succeed(&outcome, "pay_tools batch");

    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start - total);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, total); // escrow reserve backing balances
    assert_eq!(harness.developer_balance(harness.developer.id()).await?, 2_400_000);
    assert_eq!(harness.developer_balance(harness.platform.id()).await?, 600_000);
    assert_eq!(harness.totals().await?.settled_volume.0, total);

    let ledger = harness.ledger(None, 100).await?;
    assert_eq!(ledger.len(), 2);
    assert!(ledger.iter().all(|entry| entry.action == "tool_call"));
    assert!(ledger.iter().all(|entry| entry.payee == harness.developer.id().to_string()));
    assert_eq!(harness.tool_info("web-search").await?.unwrap().total_calls, 1);
    assert_eq!(harness.tool_info("image-gen").await?.unwrap().total_calls, 1);

    Ok(())
}
