//! Sandbox tests for the revenue-split tool registry.
//!
//! Covers registration and its storage deposit, the read-only views, the
//! developer-only price/status authority, owner-only force deactivation, the
//! pause gate and the inactive-tool refund path.

use anyhow::Result;
use near_sdk::json_types::U128;
use portico_tests::{expect_failure, must_succeed, Harness};
use serde_json::json;

#[tokio::test]
async fn registry_registration_and_views() -> Result<()> {
    let harness = Harness::setup().await?;
    let price = 2_000_000u128;

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

    let info = harness
        .tool_info("web-search")
        .await?
        .expect("registered tool");
    assert_eq!(info.developer, harness.developer.id().to_string());
    assert_eq!(info.price_per_call.0, price);
    assert_eq!(info.total_calls, 0);
    assert_eq!(info.total_revenue.0, 0);
    assert!(info.active);
    assert!(info.created_at_block > 0);

    let full = harness
        .full_tool_info("web-search")
        .await?
        .expect("registered tool");
    assert_eq!(full, info);

    assert!(harness.is_tool_active("web-search").await?);
    assert_eq!(
        harness.developer_tools(harness.developer.id()).await?,
        vec!["web-search".to_string()]
    );
    assert_eq!(harness.totals().await?.tools_count, 1);

    let outcome = harness
        .register_tool(&harness.buyer, "web-search", harness.buyer.id(), price)
        .await?;
    expect_failure(&outcome, "duplicate registration");
    assert_eq!(harness.totals().await?.tools_count, 1);
    assert_eq!(
        harness.developer_tools(harness.buyer.id()).await?,
        Vec::<String>::new()
    );

    must_succeed(
        &harness
            .register_tool(&harness.buyer, "summarize", harness.buyer.id(), price / 2)
            .await?,
        "second registration",
    );
    assert_eq!(harness.totals().await?.tools_count, 2);
    assert_eq!(
        harness.developer_tools(harness.buyer.id()).await?,
        vec!["summarize".to_string()]
    );

    Ok(())
}

#[tokio::test]
async fn registry_rejects_underfunded_registration() -> Result<()> {
    let harness = Harness::setup().await?;
    let price = 1_000_000u128;

    let free = harness
        .register_tool_with_deposit(
            &harness.developer,
            "free-tool",
            harness.developer.id(),
            price,
            0,
        )
        .await?;
    expect_failure(&free, "registration without a storage deposit");
    assert!(harness.tool_info("free-tool").await?.is_none());

    let dust = harness
        .register_tool_with_deposit(
            &harness.developer,
            "dust-tool",
            harness.developer.id(),
            price,
            1,
        )
        .await?;
    expect_failure(&dust, "registration with a one-yocto deposit");
    assert!(harness.tool_info("dust-tool").await?.is_none());

    assert_eq!(harness.totals().await?.tools_count, 0);
    assert_eq!(
        harness.developer_tools(harness.developer.id()).await?,
        Vec::<String>::new()
    );

    must_succeed(
        &harness
            .register_tool(
                &harness.developer,
                "funded-tool",
                harness.developer.id(),
                price,
            )
            .await?,
        "funded registration",
    );
    assert_eq!(harness.totals().await?.tools_count, 1);

    Ok(())
}

#[tokio::test]
async fn registry_price_and_status_auth() -> Result<()> {
    let harness = Harness::setup().await?;
    must_succeed(
        &harness
            .register_tool(
                &harness.developer,
                "web-search",
                harness.developer.id(),
                1_000_000,
            )
            .await?,
        "register_tool",
    );

    let new_price = U128::from(3_000_000u128);
    let buyer_price = harness
        .call_split(
            &harness.buyer,
            "update_tool_price",
            json!({"name": "web-search", "new_price": new_price}),
            0,
            50,
        )
        .await?;
    expect_failure(&buyer_price, "buyer price update");

    let owner_price = harness
        .call_split(
            &harness.owner,
            "update_tool_price",
            json!({"name": "web-search", "new_price": new_price}),
            0,
            50,
        )
        .await?;
    expect_failure(&owner_price, "owner price update");

    must_succeed(
        &harness
            .call_split(
                &harness.developer,
                "update_tool_price",
                json!({"name": "web-search", "new_price": new_price}),
                0,
                50,
            )
            .await?,
        "developer price update",
    );
    assert_eq!(
        harness
            .tool_info("web-search")
            .await?
            .expect("registered tool")
            .price_per_call
            .0,
        3_000_000
    );

    let buyer_deactivate = harness
        .call_split(
            &harness.buyer,
            "deactivate_tool",
            json!({"name": "web-search"}),
            0,
            50,
        )
        .await?;
    expect_failure(&buyer_deactivate, "buyer deactivation");

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
        "developer deactivation",
    );
    assert!(!harness.is_tool_active("web-search").await?);

    must_succeed(
        &harness
            .call_split(
                &harness.developer,
                "reactivate_tool",
                json!({"name": "web-search"}),
                0,
                50,
            )
            .await?,
        "developer reactivation",
    );
    assert!(harness.is_tool_active("web-search").await?);

    let unknown = harness
        .call_split(
            &harness.developer,
            "deactivate_tool",
            json!({"name": "unknown-tool"}),
            0,
            50,
        )
        .await?;
    expect_failure(&unknown, "deactivate an unknown tool");

    Ok(())
}

#[tokio::test]
async fn registry_transfer_tool_changes_authority() -> Result<()> {
    let harness = Harness::setup().await?;
    must_succeed(
        &harness
            .register_tool(
                &harness.developer,
                "web-search",
                harness.developer.id(),
                1_000_000,
            )
            .await?,
        "register_tool",
    );

    let stolen = harness
        .call_split(
            &harness.buyer,
            "update_tool_developer",
            json!({"name": "web-search", "new_developer": harness.buyer.id()}),
            0,
            50,
        )
        .await?;
    expect_failure(&stolen, "buyer tool transfer");

    must_succeed(
        &harness
            .call_split(
                &harness.developer,
                "update_tool_developer",
                json!({"name": "web-search", "new_developer": harness.buyer.id()}),
                0,
                50,
            )
            .await?,
        "developer tool transfer",
    );

    assert_eq!(
        harness.developer_tools(harness.developer.id()).await?,
        Vec::<String>::new()
    );
    assert_eq!(
        harness.developer_tools(harness.buyer.id()).await?,
        vec!["web-search".to_string()]
    );
    assert_eq!(
        harness
            .tool_info("web-search")
            .await?
            .expect("registered tool")
            .developer,
        harness.buyer.id().to_string()
    );

    let old_developer = harness
        .call_split(
            &harness.developer,
            "update_tool_price",
            json!({"name": "web-search", "new_price": U128::from(4_000_000u128)}),
            0,
            50,
        )
        .await?;
    expect_failure(&old_developer, "former developer price update");

    must_succeed(
        &harness
            .call_split(
                &harness.buyer,
                "update_tool_price",
                json!({"name": "web-search", "new_price": U128::from(5_000_000u128)}),
                0,
                50,
            )
            .await?,
        "new developer price update",
    );
    assert_eq!(
        harness
            .tool_info("web-search")
            .await?
            .expect("registered tool")
            .price_per_call
            .0,
        5_000_000
    );

    Ok(())
}

#[tokio::test]
async fn registry_force_deactivate_owner_only() -> Result<()> {
    let harness = Harness::setup().await?;
    must_succeed(
        &harness
            .register_tool(
                &harness.developer,
                "web-search",
                harness.developer.id(),
                1_000_000,
            )
            .await?,
        "register_tool",
    );

    let buyer_force = harness
        .call_split(
            &harness.buyer,
            "force_deactivate_tool",
            json!({"name": "web-search"}),
            0,
            50,
        )
        .await?;
    expect_failure(&buyer_force, "buyer force deactivation");
    assert!(harness.is_tool_active("web-search").await?);

    let developer_force = harness
        .call_split(
            &harness.developer,
            "force_deactivate_tool",
            json!({"name": "web-search"}),
            0,
            50,
        )
        .await?;
    expect_failure(&developer_force, "developer force deactivation");
    assert!(harness.is_tool_active("web-search").await?);

    must_succeed(
        &harness
            .call_split(
                &harness.owner,
                "force_deactivate_tool",
                json!({"name": "web-search"}),
                0,
                50,
            )
            .await?,
        "owner force deactivation",
    );
    assert!(!harness.is_tool_active("web-search").await?);
    assert!(
        !harness
            .tool_info("web-search")
            .await?
            .expect("registered tool")
            .active
    );

    let missing = harness
        .call_split(
            &harness.owner,
            "force_deactivate_tool",
            json!({"name": "missing-tool"}),
            0,
            50,
        )
        .await?;
    expect_failure(&missing, "force deactivate an unknown tool");

    Ok(())
}

#[tokio::test]
async fn registry_rejects_invalid_tools() -> Result<()> {
    let harness = Harness::setup().await?;
    let long_name = "a".repeat(65);

    let empty = harness
        .register_tool(&harness.developer, "", harness.developer.id(), 1_000_000)
        .await?;
    expect_failure(&empty, "empty tool name");

    let long = harness
        .register_tool(
            &harness.developer,
            &long_name,
            harness.developer.id(),
            1_000_000,
        )
        .await?;
    expect_failure(&long, "65-byte tool name");

    let zero_price = harness
        .register_tool(&harness.developer, "free-tool", harness.developer.id(), 0)
        .await?;
    expect_failure(&zero_price, "zero price");

    assert_eq!(harness.totals().await?.tools_count, 0);
    assert!(harness.tool_info("").await?.is_none());
    assert!(harness.tool_info(&long_name).await?.is_none());
    assert!(harness.tool_info("free-tool").await?.is_none());

    let missing_price = harness
        .call_split(
            &harness.developer,
            "update_tool_price",
            json!({"name": "missing-tool", "new_price": U128::from(1_000_000u128)}),
            0,
            50,
        )
        .await?;
    expect_failure(&missing_price, "update an unknown tool price");

    Ok(())
}

#[tokio::test]
async fn registry_paused_blocks_registration() -> Result<()> {
    let harness = Harness::setup().await?;

    let buyer_pause = harness
        .call_split(&harness.buyer, "set_paused", json!({"paused": true}), 0, 30)
        .await?;
    expect_failure(&buyer_pause, "buyer pause");

    must_succeed(
        &harness
            .call_split(&harness.owner, "set_paused", json!({"paused": true}), 0, 30)
            .await?,
        "owner pause",
    );

    let paused_registration = harness
        .register_tool(
            &harness.developer,
            "web-search",
            harness.developer.id(),
            1_000_000,
        )
        .await?;
    expect_failure(&paused_registration, "registration while paused");
    assert!(harness.tool_info("web-search").await?.is_none());
    assert_eq!(harness.totals().await?.tools_count, 0);

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
        "owner unpause",
    );
    must_succeed(
        &harness
            .register_tool(
                &harness.developer,
                "web-search",
                harness.developer.id(),
                1_000_000,
            )
            .await?,
        "registration after unpause",
    );
    assert_eq!(harness.totals().await?.tools_count, 1);

    Ok(())
}

#[tokio::test]
async fn registry_inactive_tool_refunds_payment() -> Result<()> {
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

    let buyer_start = harness.ft_balance(harness.buyer.id()).await?;
    let outcome = harness
        .ft_transfer_call(
            &harness.buyer,
            price,
            portico_tests::pay_tool_msg("web-search"),
        )
        .await?;
    must_succeed(&outcome, "inactive-tool payment");

    assert_eq!(harness.ft_balance(harness.buyer.id()).await?, buyer_start);
    assert_eq!(harness.ft_balance(harness.split.id()).await?, 0);
    assert!(harness.ledger(None, 100).await?.is_empty());
    assert_eq!(harness.totals().await?.settled_volume.0, 0);

    let tool = harness
        .tool_info("web-search")
        .await?
        .expect("registered tool");
    assert_eq!(tool.total_calls, 0);
    assert_eq!(tool.total_revenue.0, 0);

    Ok(())
}
