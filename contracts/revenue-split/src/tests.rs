//! Host-side unit tests for the revenue-split contract.
//!
//! These are real assertions against the contract state machine, the scheduled
//! promise receipts and the public ledger. Cross-contract execution is not
//! simulated: callbacks are invoked directly with the promise results the
//! runtime would supply, which is exactly the failure-restoration path that
//! matters.

use near_sdk::json_types::U128;
use near_sdk::mock::{MockAction, Receipt};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{
    env, testing_env, AccountId, Gas, NearToken, PromiseError, PromiseOrValue, PromiseResult,
    RuntimeFeesConfig,
};

use crate::ft_receiver::{parse_payment_msg, PaymentMsg};
use crate::ledger::{LedgerAction, LEDGER_RESERVE_BYTES, MAX_LEDGER_ENTRIES};
use crate::registry::registration_deposit;
use crate::split::{split_amount, BPS_DENOM};
use crate::stream::{StreamStatus, MAX_CLIFF_BLOCKS, MIN_CLIFF_BLOCKS};
use crate::Contract;

const SPLIT: &str = "split.portico.testnet";
const TOKEN: &str = "token.portico.testnet";
const OWNER: &str = "portico.testnet";
const PLATFORM: &str = "platform.portico.testnet";
const BUYER: &str = "buyer1.portico.testnet";
const DEV1: &str = "dev1.portico.testnet";
const DEV2: &str = "dev2.portico.testnet";

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const E18: u128 = 1_000_000_000_000_000_000;

fn id(account_id: &str) -> AccountId {
    account_id.parse().unwrap()
}

struct Fixture {
    contract: Contract,
    owner: AccountId,
    ft: AccountId,
    platform: AccountId,
    buyer: AccountId,
}

fn new_fixture(fee_bps: u16) -> Fixture {
    let owner = id(OWNER);
    let ft = id(TOKEN);
    let platform = id(PLATFORM);
    let buyer = id(BUYER);
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(SPLIT))
        .predecessor_account_id(owner.clone())
        .signer_account_id(owner.clone())
        .block_height(1_000)
        .account_balance(NearToken::from_near(1_000))
        .attached_deposit(NearToken::from_near(0))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
    let contract = Contract::new(owner.clone(), ft.clone(), platform.clone(), fee_bps);
    Fixture {
        contract,
        owner,
        ft,
        platform,
        buyer,
    }
}

fn set_env(predecessor: &AccountId, block_height: u64, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(SPLIT))
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .block_height(block_height)
        .account_balance(NearToken::from_near(1_000))
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn set_callback_env(promise_result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id(SPLIT))
            .predecessor_account_id(id(SPLIT))
            .signer_account_id(id(SPLIT))
            .block_height(1_000)
            .account_balance(NearToken::from_near(1_000))
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![promise_result],
    );
}

fn expect_value(result: PromiseOrValue<U128>) -> U128 {
    match result {
        PromiseOrValue::Value(value) => value,
        PromiseOrValue::Promise(_) => panic!("expected a value return, got a promise"),
    }
}

fn expect_promise(result: PromiseOrValue<U128>) {
    match result {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(value) => panic!("expected a promise return, got {value:?}"),
    }
}

#[derive(Debug)]
struct Call {
    receiver: AccountId,
    method: String,
    args: serde_json::Value,
    deposit: NearToken,
    gas: Gas,
}

fn function_calls() -> Vec<Call> {
    let mut calls = Vec::new();
    for Receipt {
        receiver_id, actions, ..
    } in get_created_receipts()
    {
        for action in actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } = action
            {
                calls.push(Call {
                    receiver: receiver_id.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: serde_json::from_slice(&args).unwrap(),
                    deposit: attached_deposit,
                    gas: prepaid_gas,
                });
            }
        }
    }
    calls
}

fn native_transfers() -> Vec<(AccountId, u128)> {
    let mut transfers = Vec::new();
    for Receipt {
        receiver_id, actions, ..
    } in get_created_receipts()
    {
        for action in actions {
            if let MockAction::Transfer { deposit, .. } = action {
                transfers.push((receiver_id.clone(), deposit.as_yoctonear()));
            }
        }
    }
    transfers
}

fn balance(contract: &Contract, account: &AccountId) -> u128 {
    contract.developer_balances.get(account).copied().unwrap_or(0)
}

fn pay(fixture: &mut Fixture, amount: u128, msg: &str, block_height: u64) -> PromiseOrValue<U128> {
    set_env(
        &fixture.ft.clone(),
        block_height,
        NearToken::from_yoctonear(0),
    );
    fixture
        .contract
        .ft_on_transfer(fixture.buyer.clone(), U128(amount), msg.to_string())
}

fn register_tool(fixture: &mut Fixture, name: &str, developer: &AccountId, price: u128) {
    set_env(&fixture.owner.clone(), 1_000, NearToken::from_near(1));
    fixture
        .contract
        .register_tool(name.to_string(), developer.clone(), U128(price));
}

fn open_demo_stream(fixture: &mut Fixture) {
    let msg = serde_json::json!({
        "action": "open_stream",
        "recipient": DEV1,
        "rate_per_block": "10",
        "cliff_blocks": 3_600u64,
    })
    .to_string();
    assert_eq!(expect_value(pay(fixture, 100_000, &msg, 1_000)), U128(0));
}

// ---------------------------------------------------------------- vectors ---

#[test]
fn vectors_single_payment_splits_eighty_twenty() {
    let mut fixture = new_fixture(2_000);
    assert_eq!(
        fixture.contract.calculate_split(U128(100)),
        crate::split::SplitView {
            developer: U128(80),
            platform: U128(20),
        }
    );

    let msg = serde_json::json!({
        "action": "pay_developers",
        "developer": DEV1,
        "memo": "sale",
    })
    .to_string();
    expect_promise(pay(&mut fixture, 100, &msg, 1_000));

    let calls = function_calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    let transfer = calls
        .iter()
        .find(|call| call.method == "ft_transfer")
        .expect("missing ft_transfer");
    assert_eq!(transfer.receiver, fixture.ft);
    assert_eq!(transfer.args["receiver_id"], serde_json::json!(DEV1));
    assert_eq!(transfer.args["amount"], serde_json::json!("80"));
    assert_eq!(transfer.args["memo"], serde_json::json!("sale"));
    assert_eq!(transfer.deposit, NearToken::from_yoctonear(1));
    assert_eq!(transfer.gas, Gas::from_tgas(10));

    let callback = calls
        .iter()
        .find(|call| call.method == "on_payout_done")
        .expect("missing on_payout_done");
    assert_eq!(callback.receiver, id(SPLIT));
    assert_eq!(callback.args["developer"], serde_json::json!(DEV1));
    assert_eq!(callback.args["amount"], serde_json::json!("80"));
    assert_eq!(callback.args["unused"], serde_json::json!("0"));
    assert_eq!(callback.gas, Gas::from_tgas(5));

    assert_eq!(balance(&fixture.contract, &fixture.platform), 20);
    assert_eq!(fixture.contract.total_developer_balance, 20);

    let ledger = fixture.contract.get_ledger(None, 10);
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].action, LedgerAction::Payment);
    assert_eq!(ledger[0].payer, fixture.buyer);
    assert_eq!(ledger[0].payee, id(DEV1));
    assert_eq!(ledger[0].amount, U128(100));
    assert_eq!(ledger[0].memo.as_deref(), Some("sale"));
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(100));
}

#[test]
fn vectors_batch_two_payments_credit_forty_forty_twenty() {
    let mut fixture = new_fixture(2_000);
    let msg = serde_json::json!({
        "action": "pay_developers_batch",
        "payments": [
            {"developer": DEV1, "amount": "50", "memo": "a"},
            {"developer": DEV2, "amount": "50", "memo": "b"},
        ],
    })
    .to_string();
    assert_eq!(expect_value(pay(&mut fixture, 100, &msg, 1_000)), U128(0));
    assert!(function_calls().is_empty());

    assert_eq!(balance(&fixture.contract, &id(DEV1)), 40);
    assert_eq!(balance(&fixture.contract, &id(DEV2)), 40);
    assert_eq!(balance(&fixture.contract, &fixture.platform), 20);
    assert_eq!(fixture.contract.total_developer_balance, 100);

    let ledger = fixture.contract.get_ledger(None, 10);
    assert_eq!(ledger.len(), 2);
    assert_eq!(ledger[0].payee, id(DEV1));
    assert_eq!(ledger[0].amount, U128(50));
    assert_eq!(ledger[1].payee, id(DEV2));
    assert_eq!(ledger[1].amount, U128(50));
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(100));
}

#[test]
fn vectors_batch_total_mismatch_refunds_the_whole_amount() {
    let mut fixture = new_fixture(2_000);
    let msg = serde_json::json!({
        "action": "pay_developers_batch",
        "payments": [
            {"developer": DEV1, "amount": "50", "memo": null},
            {"developer": DEV2, "amount": "50", "memo": null},
        ],
    })
    .to_string();
    assert_eq!(expect_value(pay(&mut fixture, 101, &msg, 1_000)), U128(101));
    assert_eq!(fixture.contract.total_developer_balance, 0);
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(0));
    assert!(fixture.contract.get_ledger(None, 10).is_empty());
}

#[test]
fn vectors_zero_amount_is_returned_unused() {
    let mut fixture = new_fixture(2_000);
    let msg = serde_json::json!({"action": "pay_developers", "developer": DEV1}).to_string();
    assert_eq!(expect_value(pay(&mut fixture, 0, &msg, 1_000)), U128(0));
    assert!(function_calls().is_empty());
    assert!(fixture.contract.get_ledger(None, 10).is_empty());
}

#[test]
fn vectors_unknown_action_refunds_without_state() {
    let mut fixture = new_fixture(2_000);
    let msg = serde_json::json!({"action": "mystery"}).to_string();
    assert_eq!(expect_value(pay(&mut fixture, 100, &msg, 1_000)), U128(100));
    assert!(function_calls().is_empty());
    assert!(fixture.contract.get_ledger(None, 10).is_empty());
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(0));
}

#[test]
fn vectors_foreign_predecessor_refunds_without_state() {
    let mut fixture = new_fixture(2_000);
    let msg = serde_json::json!({"action": "pay_developers", "developer": DEV1}).to_string();
    set_env(
        &fixture.buyer.clone(),
        1_000,
        NearToken::from_yoctonear(0),
    );
    let result = fixture
        .contract
        .ft_on_transfer(fixture.buyer.clone(), U128(100), msg);
    assert_eq!(expect_value(result), U128(100));
    assert!(function_calls().is_empty());
    assert!(fixture.contract.get_ledger(None, 10).is_empty());
}

#[test]
fn split_fuzz_matches_basis_point_math() {
    for fee_bps in [0u16, 2_000, 5_000] {
        for step in 1..=1_000u128 {
            let amount = step * E18;
            let split = split_amount(amount, fee_bps);
            let expected_platform = amount * u128::from(fee_bps) / BPS_DENOM;
            assert_eq!(split.platform.0, expected_platform, "amount {amount}");
            assert_eq!(
                split.developer.0 + split.platform.0,
                amount,
                "amount {amount}"
            );
        }
        let extra = 1_000 * E18 * 1_000;
        let split = split_amount(extra, fee_bps);
        assert_eq!(split.platform.0, extra * u128::from(fee_bps) / BPS_DENOM);
        assert_eq!(split.developer.0 + split.platform.0, extra);
        assert_eq!(split.developer.0, extra - split.platform.0);
    }
}

// ------------------------------------------------------------------ split ---

#[test]
fn split_pay_tool_settles_the_price_and_refunds_the_excess() {
    let mut fixture = new_fixture(2_000);
    register_tool(&mut fixture, "web-search", &id(DEV1), 100);

    let msg = serde_json::json!({"action": "pay_tool", "tool": "web-search"}).to_string();
    expect_promise(pay(&mut fixture, 150, &msg, 1_000));

    let calls = function_calls();
    let transfer = calls
        .iter()
        .find(|call| call.method == "ft_transfer")
        .expect("missing ft_transfer");
    assert_eq!(transfer.args["receiver_id"], serde_json::json!(DEV1));
    assert_eq!(transfer.args["amount"], serde_json::json!("80"));
    let callback = calls
        .iter()
        .find(|call| call.method == "on_payout_done")
        .expect("missing on_payout_done");
    assert_eq!(callback.args["unused"], serde_json::json!("50"));

    let tool = fixture.contract.get_tool_info("web-search".to_string()).unwrap();
    assert_eq!(tool.total_calls, 1);
    assert_eq!(tool.total_revenue, U128(100));
    assert_eq!(balance(&fixture.contract, &fixture.platform), 20);
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(100));

    let ledger = fixture.contract.get_ledger(None, 10);
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].action, LedgerAction::ToolCall);
    assert_eq!(ledger[0].tool.as_deref(), Some("web-search"));
    assert_eq!(ledger[0].amount, U128(100));

    // Underpaying returns the whole amount and leaves every counter alone.
    assert_eq!(expect_value(pay(&mut fixture, 99, &msg, 1_001)), U128(99));
    let tool = fixture.contract.get_tool_info("web-search".to_string()).unwrap();
    assert_eq!(tool.total_calls, 1);
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(100));
}

#[test]
fn split_paused_value_in_is_refunded() {
    let mut fixture = new_fixture(2_000);
    set_env(&fixture.owner.clone(), 1_000, NearToken::from_near(0));
    fixture.contract.set_paused(true);
    let msg = serde_json::json!({"action": "pay_developers", "developer": DEV1}).to_string();
    assert_eq!(expect_value(pay(&mut fixture, 100, &msg, 1_000)), U128(100));
    assert!(fixture.contract.get_ledger(None, 10).is_empty());
    assert!(function_calls().is_empty());
}

#[test]
fn split_withdraw_developer_balance_deducts_before_sending() {
    let mut fixture = new_fixture(2_000);
    fixture.contract.credit_developer_balance(&id(DEV1), 500);
    assert_eq!(fixture.contract.total_developer_balance, 500);

    set_env(&id(DEV1), 1_000, NearToken::from_yoctonear(1));
    let _promise = fixture.contract.withdraw_developer_balance();
    drop(_promise);

    assert_eq!(balance(&fixture.contract, &id(DEV1)), 0);
    assert_eq!(fixture.contract.total_developer_balance, 0);
    let calls = function_calls();
    let transfer = calls
        .iter()
        .find(|call| call.method == "ft_transfer")
        .expect("missing ft_transfer");
    assert_eq!(transfer.args["receiver_id"], serde_json::json!(DEV1));
    assert_eq!(transfer.args["amount"], serde_json::json!("500"));
    let ledger = fixture.contract.get_ledger(None, 10);
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].action, LedgerAction::DeveloperPayout);
    assert_eq!(ledger[0].amount, U128(500));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn split_withdraw_requires_one_yocto() {
    let mut fixture = new_fixture(2_000);
    fixture.contract.credit_developer_balance(&id(DEV1), 500);
    set_env(&id(DEV1), 1_000, NearToken::from_yoctonear(0));
    let _ = fixture.contract.withdraw_developer_balance();
}

#[test]
#[should_panic(expected = "no developer balance to withdraw")]
fn split_withdraw_rejects_an_empty_balance() {
    let mut fixture = new_fixture(2_000);
    set_env(&id(DEV1), 1_000, NearToken::from_yoctonear(1));
    let _ = fixture.contract.withdraw_developer_balance();
}

#[test]
fn split_callback_failure_settles_as_a_developer_balance() {
    let mut fixture = new_fixture(2_000);
    set_callback_env(PromiseResult::Failed);
    let unused = fixture
        .contract
        .on_payout_done(id(DEV1), U128(80), U128(50), Err(PromiseError::Failed));
    assert_eq!(unused, U128(50));
    assert_eq!(balance(&fixture.contract, &id(DEV1)), 80);
    assert_eq!(fixture.contract.total_developer_balance, 80);
}

#[test]
fn split_callback_success_returns_only_the_overpayment() {
    let mut fixture = new_fixture(2_000);
    set_callback_env(PromiseResult::Successful(vec![]));
    let unused = fixture
        .contract
        .on_payout_done(id(DEV1), U128(80), U128(50), Ok(()));
    assert_eq!(unused, U128(50));
    assert_eq!(balance(&fixture.contract, &id(DEV1)), 0);
    assert_eq!(fixture.contract.total_developer_balance, 0);
}

#[test]
fn split_msg_actions_parse_with_the_expected_shape() {
    let parsed = parse_payment_msg(r#"{"action":"pay_tool","tool":"web-search"}"#).unwrap();
    assert_eq!(
        parsed,
        PaymentMsg::PayTool {
            tool: "web-search".to_string()
        }
    );
    assert!(parse_payment_msg("").is_err());
    assert!(parse_payment_msg("not json").is_err());
}

// --------------------------------------------------------------- registry ---

#[test]
fn registry_registration_deposit_includes_the_ledger_reserve() {
    let byte_cost = 10_000_000_000_000_000_000u128;
    assert_eq!(
        registration_deposit(1_000, byte_cost),
        (1_000 + u128::from(LEDGER_RESERVE_BYTES)) * byte_cost
    );
    assert_eq!(
        registration_deposit(0, byte_cost),
        u128::from(LEDGER_RESERVE_BYTES) * byte_cost
    );
}

#[test]
fn registry_registration_refunds_everything_above_growth_and_reserve() {
    let mut fixture = new_fixture(2_000);
    register_tool(&mut fixture, "web-search", &id(DEV1), 100);

    let tool = fixture.contract.get_tool_info("web-search".to_string()).unwrap();
    assert_eq!(tool.developer, id(DEV1));
    assert_eq!(tool.price_per_call, U128(100));
    assert!(tool.active);
    assert_eq!(fixture.contract.get_totals().tools_count, 1);
    assert_eq!(
        fixture.contract.get_developer_tools(id(DEV1)),
        vec!["web-search".to_string()]
    );

    let transfers = native_transfers();
    assert_eq!(transfers.len(), 1);
    let (refundee, refunded) = &transfers[0];
    assert_eq!(*refundee, fixture.owner);
    let reserve_cost =
        u128::from(LEDGER_RESERVE_BYTES) * env::storage_byte_cost().as_yoctonear();
    assert!(*refunded > 0);
    assert!(*refunded <= ONE_NEAR - reserve_cost);
}

#[test]
#[should_panic(expected = "insufficient storage deposit for tool registration")]
fn registry_registration_requires_the_storage_reserve() {
    let mut fixture = new_fixture(2_000);
    set_env(&fixture.owner.clone(), 1_000, NearToken::from_yoctonear(1));
    fixture
        .contract
        .register_tool("web-search".to_string(), id(DEV1), U128(100));
}

#[test]
fn registry_pay_tools_requires_the_exact_total_and_settles_every_tool() {
    let mut fixture = new_fixture(2_000);
    register_tool(&mut fixture, "web-search", &id(DEV1), 100);
    register_tool(&mut fixture, "image-gen", &id(DEV2), 100);

    let msg = serde_json::json!({
        "action": "pay_tools",
        "tools": ["web-search", "image-gen"],
    })
    .to_string();
    assert_eq!(expect_value(pay(&mut fixture, 199, &msg, 1_000)), U128(199));
    assert_eq!(
        fixture.contract.get_tool_info("web-search".to_string()).unwrap().total_calls,
        0
    );

    assert_eq!(expect_value(pay(&mut fixture, 200, &msg, 1_001)), U128(0));
    assert_eq!(balance(&fixture.contract, &id(DEV1)), 80);
    assert_eq!(balance(&fixture.contract, &id(DEV2)), 80);
    assert_eq!(balance(&fixture.contract, &fixture.platform), 40);
    assert_eq!(
        fixture.contract.get_tool_info("web-search".to_string()).unwrap().total_calls,
        1
    );
    assert_eq!(
        fixture.contract.get_tool_info("image-gen".to_string()).unwrap().total_calls,
        1
    );
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(200));
    let ledger = fixture.contract.get_ledger(None, 10);
    assert_eq!(ledger.len(), 2);
    assert!(ledger
        .iter()
        .all(|entry| entry.action == LedgerAction::ToolCall && entry.tool.is_some()));
}

#[test]
fn registry_inactive_tool_refunds_the_whole_amount() {
    let mut fixture = new_fixture(2_000);
    register_tool(&mut fixture, "web-search", &id(DEV1), 100);
    set_env(&id(DEV1), 1_000, NearToken::from_near(0));
    fixture.contract.deactivate_tool("web-search".to_string());
    assert!(!fixture.contract.is_tool_active("web-search".to_string()));

    let msg = serde_json::json!({"action": "pay_tool", "tool": "web-search"}).to_string();
    assert_eq!(expect_value(pay(&mut fixture, 100, &msg, 1_000)), U128(100));
    assert_eq!(
        fixture.contract.get_tool_info("web-search".to_string()).unwrap().total_calls,
        0
    );
    assert!(function_calls().is_empty());
}

#[test]
#[should_panic(expected = "only the tool developer can update the price")]
fn registry_price_update_is_developer_only() {
    let mut fixture = new_fixture(2_000);
    register_tool(&mut fixture, "web-search", &id(DEV1), 100);
    set_env(&fixture.buyer.clone(), 1_000, NearToken::from_near(0));
    fixture
        .contract
        .update_tool_price("web-search".to_string(), U128(200));
}

#[test]
#[should_panic(expected = "only the owner can call this method")]
fn registry_force_deactivate_is_owner_only() {
    let mut fixture = new_fixture(2_000);
    register_tool(&mut fixture, "web-search", &id(DEV1), 100);
    set_env(&id(DEV1), 1_000, NearToken::from_near(0));
    fixture
        .contract
        .force_deactivate_tool("web-search".to_string());
}

// ----------------------------------------------------------------- stream ---

#[test]
fn stream_open_claim_and_close_settle_exactly_once() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);

    let stream = fixture.contract.get_stream(1).unwrap();
    assert_eq!(stream.subscriber, fixture.buyer);
    assert_eq!(stream.recipient, id(DEV1));
    assert_eq!(stream.start_block, 1_000);
    assert_eq!(stream.cliff_end_block, 4_600);
    assert_eq!(stream.deposit, U128(100_000));
    assert_eq!(stream.rate_per_block, U128(10));
    assert_eq!(stream.status, StreamStatus::Open);
    assert_eq!(
        fixture
            .contract
            .streams_by_recipient
            .get(&id(DEV1))
            .cloned()
            .unwrap(),
        vec![1]
    );
    let totals = fixture.contract.get_totals();
    assert_eq!(totals.open_streams, 1);
    assert_eq!(totals.active_streams, 1);

    set_env(&fixture.buyer.clone(), 4_600, NearToken::from_near(0));
    assert_eq!(fixture.contract.get_stream_view(1).claimable, U128(0));

    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    assert_eq!(fixture.contract.get_stream_view(1).claimable, U128(1_000));
    let _promise = fixture.contract.claim(1);
    drop(_promise);
    let calls = function_calls();
    let transfer = calls
        .iter()
        .find(|call| call.method == "ft_transfer")
        .expect("missing ft_transfer");
    assert_eq!(transfer.args["receiver_id"], serde_json::json!(DEV1));
    assert_eq!(transfer.args["amount"], serde_json::json!("1000"));
    assert!(calls.iter().any(|call| call.method == "on_stream_payout_done"));
    assert_eq!(
        fixture.contract.get_stream(1).unwrap().withdrawn,
        U128(1_000)
    );
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(1_000));
    assert_eq!(fixture.contract.get_stream_view(1).claimable, U128(0));

    set_env(&fixture.buyer.clone(), 5_000, NearToken::from_near(0));
    expect_promise(fixture.contract.close_stream(1));
    let stream = fixture.contract.get_stream(1).unwrap();
    assert_eq!(stream.status, StreamStatus::Closed);
    assert_eq!(stream.deposit, U128(4_000));
    assert_eq!(stream.withdrawn, U128(4_000));
    let totals = fixture.contract.get_totals();
    assert_eq!(totals.open_streams, 0);
    assert_eq!(totals.active_streams, 0);
    assert_eq!(totals.settled_volume, U128(4_000));
    assert_eq!(balance(&fixture.contract, &fixture.buyer), 96_000);
    assert_eq!(fixture.contract.total_developer_balance, 96_000);

    let calls = function_calls();
    let transfer = calls
        .iter()
        .find(|call| call.method == "ft_transfer")
        .expect("missing close payout");
    assert_eq!(transfer.args["receiver_id"], serde_json::json!(DEV1));
    assert_eq!(transfer.args["amount"], serde_json::json!("3000"));

    let ledger = fixture.contract.get_ledger(None, 10);
    assert!(ledger
        .iter()
        .any(|entry| entry.action == LedgerAction::StreamClaim && entry.amount == U128(3_000)));
    assert!(ledger
        .iter()
        .any(|entry| entry.action == LedgerAction::StreamClose && entry.amount == U128(96_000)));
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn stream_double_claim_pays_once() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    let _first = fixture.contract.claim(1);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    let _second = fixture.contract.claim(1);
}

#[test]
fn stream_close_before_the_cliff_refunds_everything() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 2_000, NearToken::from_near(0));
    assert_eq!(expect_value(fixture.contract.close_stream(1)), U128(0));
    assert!(function_calls().is_empty());
    let stream = fixture.contract.get_stream(1).unwrap();
    assert_eq!(stream.status, StreamStatus::Closed);
    assert_eq!(stream.deposit, U128(0));
    assert_eq!(balance(&fixture.contract, &fixture.buyer), 100_000);
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(0));
}

#[test]
fn stream_pause_freezes_accrual_and_resume_corrects_it() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);

    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    fixture.contract.pause_stream(1);
    let stream = fixture.contract.get_stream(1).unwrap();
    assert_eq!(stream.status, StreamStatus::Paused);
    assert_eq!(stream.paused_at, 4_700);
    assert_eq!(fixture.contract.get_totals().active_streams, 0);
    assert_eq!(fixture.contract.get_totals().open_streams, 1);

    set_env(&fixture.buyer.clone(), 5_700, NearToken::from_near(0));
    let view = fixture.contract.get_stream_view(1);
    assert_eq!(view.accrued, U128(1_000));
    assert_eq!(view.claimable, U128(1_000));

    set_env(&fixture.buyer.clone(), 5_700, NearToken::from_near(0));
    fixture.contract.resume_stream(1);
    let stream = fixture.contract.get_stream(1).unwrap();
    assert_eq!(stream.status, StreamStatus::Open);
    assert_eq!(stream.paused_blocks, 1_000);
    assert_eq!(stream.paused_at, 0);
    assert_eq!(fixture.contract.get_totals().active_streams, 1);

    set_env(&fixture.buyer.clone(), 5_800, NearToken::from_near(0));
    let view = fixture.contract.get_stream_view(1);
    assert_eq!(view.accrued, U128(2_000));
    assert_eq!(view.claimable, U128(2_000));
}

#[test]
#[should_panic(expected = "stream is paused")]
fn stream_claim_refuses_while_paused() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    fixture.contract.pause_stream(1);
    set_env(&fixture.buyer.clone(), 5_700, NearToken::from_near(0));
    let _ = fixture.contract.claim(1);
}

#[test]
fn stream_withdraw_unaccrued_reduces_the_deposit() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    let _promise = fixture
        .contract
        .withdraw_unaccrued(1, U128(50_000));
    drop(_promise);
    assert_eq!(fixture.contract.get_stream(1).unwrap().deposit, U128(50_000));
    let calls = function_calls();
    let transfer = calls
        .iter()
        .find(|call| call.method == "ft_transfer")
        .expect("missing refund transfer");
    assert_eq!(transfer.args["receiver_id"], serde_json::json!(BUYER));
    assert_eq!(transfer.args["amount"], serde_json::json!("50000"));
    let ledger = fixture.contract.get_ledger(None, 10);
    assert!(ledger
        .iter()
        .any(|entry| entry.action == LedgerAction::StreamWithdraw));
}

#[test]
#[should_panic(expected = "amount exceeds the unaccrued deposit")]
fn stream_withdraw_unaccrued_rejects_more_than_escrow() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    let _ = fixture.contract.withdraw_unaccrued(1, U128(99_001));
}

#[test]
fn stream_callback_failure_restores_the_claim() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    let _promise = fixture.contract.claim(1);
    drop(_promise);
    assert_eq!(
        fixture.contract.get_stream(1).unwrap().withdrawn,
        U128(1_000)
    );
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(1_000));

    set_callback_env(PromiseResult::Failed);
    let unused = fixture
        .contract
        .on_stream_payout_done(1, U128(1_000), Err(PromiseError::Failed));
    assert_eq!(unused, U128(1_000));
    assert_eq!(fixture.contract.get_stream(1).unwrap().withdrawn, U128(0));
    assert_eq!(fixture.contract.get_totals().settled_volume, U128(0));
    // The restored accrual is claimable again.
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    assert_eq!(fixture.contract.get_stream_view(1).claimable, U128(1_000));
}

#[test]
fn stream_refund_callback_failure_restores_the_deposit() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    let _promise = fixture
        .contract
        .withdraw_unaccrued(1, U128(50_000));
    drop(_promise);
    assert_eq!(fixture.contract.get_stream(1).unwrap().deposit, U128(50_000));

    set_callback_env(PromiseResult::Failed);
    let unused = fixture
        .contract
        .on_stream_refund_done(1, U128(50_000), Err(PromiseError::Failed));
    assert_eq!(unused, U128(50_000));
    assert_eq!(
        fixture.contract.get_stream(1).unwrap().deposit,
        U128(100_000)
    );
}

#[test]
fn stream_rate_update_preserves_old_accrual_and_reprices_forward() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    assert_eq!(fixture.contract.get_stream_view(1).claimable, U128(1_000));
    fixture.contract.update_stream_rate(1, U128(25));
    let stream = fixture.contract.get_stream(1).unwrap();
    assert_eq!(stream.rate_per_block, U128(25));
    assert_eq!(stream.accrued_base, U128(1_000));
    assert_eq!(stream.start_block, 4_700);
    assert_eq!(stream.cliff_end_block, 4_700);
    assert_eq!(
        fixture.contract.get_stream_view(1).claimable,
        U128(1_000),
        "the already-earned amount is preserved"
    );

    set_env(&fixture.buyer.clone(), 4_800, NearToken::from_near(0));
    assert_eq!(
        fixture.contract.get_stream_view(1).claimable,
        U128(3_500),
        "100 new blocks at 25 add to the preserved 1_000"
    );
}

#[test]
fn stream_rate_update_before_the_cliff_keeps_the_cliff() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 2_000, NearToken::from_near(0));
    fixture.contract.update_stream_rate(1, U128(25));
    let stream = fixture.contract.get_stream(1).unwrap();
    assert_eq!(stream.rate_per_block, U128(25));
    assert_eq!(stream.accrued_base, U128(0));
    assert_eq!(stream.start_block, 2_000);
    assert_eq!(stream.cliff_end_block, 4_600);

    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    assert_eq!(
        fixture.contract.get_stream_view(1).claimable,
        U128(2_500),
        "the new rate earns only after the original cliff"
    );
}

#[test]
#[should_panic(expected = "rate_per_block must be greater than zero")]
fn stream_rate_update_rejects_zero() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    fixture.contract.update_stream_rate(1, U128(0));
}

#[test]
#[should_panic(expected = "only an open stream can change its rate")]
fn stream_rate_update_rejects_paused_streams() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.buyer.clone(), 4_700, NearToken::from_near(0));
    fixture.contract.pause_stream(1);
    fixture.contract.update_stream_rate(1, U128(25));
}

#[test]
#[should_panic(expected = "only the stream subscriber can pause it")]
fn stream_pause_is_subscriber_only() {
    let mut fixture = new_fixture(2_000);
    open_demo_stream(&mut fixture);
    set_env(&fixture.platform.clone(), 4_700, NearToken::from_near(0));
    fixture.contract.pause_stream(1);
}

#[test]
fn stream_cliff_bounds_are_enforced() {
    assert!(MIN_CLIFF_BLOCKS == 3_600);
    assert!(MAX_CLIFF_BLOCKS == 31_536_000);
    let mut fixture = new_fixture(2_000);
    for cliff_blocks in [MIN_CLIFF_BLOCKS - 1, MAX_CLIFF_BLOCKS + 1] {
        let msg = serde_json::json!({
            "action": "open_stream",
            "recipient": DEV1,
            "rate_per_block": "10",
            "cliff_blocks": cliff_blocks,
        })
        .to_string();
        assert_eq!(expect_value(pay(&mut fixture, 100_000, &msg, 1_000)), U128(100_000));
    }
    assert_eq!(fixture.contract.get_totals().open_streams, 0);
}

// ------------------------------------------------------------------ ledger ---

#[test]
fn ledger_appends_paginates_and_caps() {
    let mut fixture = new_fixture(2_000);
    set_env(&fixture.owner.clone(), 1_000, NearToken::from_near(0));
    for amount in 1..=3u128 {
        assert!(fixture.contract.append_ledger_entry(
            fixture.buyer.clone(),
            id(DEV1),
            amount,
            LedgerAction::Payment,
            None,
            None,
        ));
    }
    let page = fixture.contract.get_ledger(None, 2);
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].id, 1);
    assert_eq!(page[1].id, 2);
    let tail = fixture.contract.get_ledger(Some(2), 100);
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].id, 3);
    assert_eq!(fixture.contract.get_ledger(None, 0).len(), 1);

    fixture.contract.next_ledger_id = MAX_LEDGER_ENTRIES + 1;
    assert!(!fixture.contract.append_ledger_entry(
        fixture.buyer.clone(),
        id(DEV1),
        4,
        LedgerAction::Payment,
        None,
        None,
    ));
}

// ------------------------------------------------------------- payout rail ---

#[test]
fn payout_rail_creates_the_account_transfer_and_key() {
    let mut fixture = new_fixture(2_000);
    let public_key: near_sdk::PublicKey =
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap();
    set_env(&fixture.owner.clone(), 1_000, NearToken::from_near(1));
    let _promise = fixture
        .contract
        .create_developer_account("dev1".to_string(), public_key.clone());
    drop(_promise);

    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, id("dev1.split.portico.testnet"));
    let actions = &receipts[0].actions;
    assert!(actions
        .iter()
        .any(|action| matches!(action, MockAction::CreateAccount { .. })));
    assert!(actions.iter().any(|action| matches!(
        action,
        MockAction::Transfer { deposit, .. } if *deposit == NearToken::from_near(1)
    )));
    assert!(actions.iter().any(|action| matches!(
        action,
        MockAction::AddKeyWithFullAccess { public_key: added, .. } if added.to_string() == public_key.to_string()
    )));
}

#[test]
#[should_panic(expected = "single account-id segment")]
fn payout_rail_rejects_nested_account_names() {
    let mut fixture = new_fixture(2_000);
    let public_key: near_sdk::PublicKey =
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap();
    set_env(&fixture.owner.clone(), 1_000, NearToken::from_near(1));
    let _ = fixture
        .contract
        .create_developer_account("nested.dev1".to_string(), public_key);
}
