//! Host-side unit tests for the payment FT.
//!
//! These pin the external behavior the facilitator depends on: NEP-148
//! metadata with 18 decimals, the init mint, NEP-141 transfers and NEP-145
//! storage management. Cross-contract receivers are not simulated.

use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_contract_standards::storage_management::StorageManagement;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadataProvider;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken};

use crate::{Contract, TOKEN_DECIMALS, TOKEN_NAME, TOKEN_SYMBOL};

fn owner() -> AccountId {
    "portico.testnet".parse().unwrap()
}

fn user() -> AccountId {
    "buyer1.portico.testnet".parse().unwrap()
}

fn set_env(predecessor: &AccountId, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("token.portico.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .account_balance(NearToken::from_near(100))
        .attached_deposit(deposit)
        .prepaid_gas(near_sdk::Gas::from_tgas(100))
        .build());
}

fn deploy(total_supply: u128) -> (Contract, AccountId) {
    let owner = owner();
    set_env(&owner, NearToken::from_near(0));
    let contract = Contract::new(owner.clone(), U128(total_supply));
    (contract, owner)
}

#[test]
fn metadata_is_pinned_to_eighteen_decimals() {
    let (contract, _) = deploy(1_000);
    let metadata = contract.ft_metadata();
    assert_eq!(metadata.spec, FT_METADATA_SPEC);
    assert_eq!(metadata.name, TOKEN_NAME);
    assert_eq!(metadata.symbol, TOKEN_SYMBOL);
    assert_eq!(metadata.decimals, TOKEN_DECIMALS);
    assert_eq!(metadata.decimals, 18);
    assert!(metadata.icon.is_none());
    assert!(metadata.reference.is_none());
}

#[test]
fn init_supply_is_minted_to_the_owner() {
    let (contract, owner) = deploy(5_000_000_000_000_000_000_000_000);
    assert_eq!(contract.ft_total_supply(), U128(5_000_000_000_000_000_000_000_000));
    assert_eq!(contract.ft_balance_of(owner), U128(5_000_000_000_000_000_000_000_000));
    assert_eq!(contract.ft_balance_of(user()), U128(0));
}

#[test]
fn transfer_moves_the_balance_without_changing_supply() {
    let (mut contract, owner) = deploy(1_000);
    set_env(&owner, NearToken::from_millinear(10));
    contract.storage_deposit(Some(user()), None);

    set_env(&owner, NearToken::from_yoctonear(1));
    contract.ft_transfer(user(), U128(250), Some("payout".to_string()));

    assert_eq!(contract.ft_balance_of(owner), U128(750));
    assert_eq!(contract.ft_balance_of(user()), U128(250));
    assert_eq!(contract.ft_total_supply(), U128(1_000));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfer_requires_one_yocto() {
    let (mut contract, owner) = deploy(1_000);
    set_env(&owner, NearToken::from_millinear(10));
    contract.storage_deposit(Some(user()), None);
    set_env(&owner, NearToken::from_yoctonear(0));
    contract.ft_transfer(user(), U128(250), None);
}

#[test]
fn storage_deposit_registers_and_bounds_are_positive() {
    let (mut contract, _) = deploy(1_000);
    assert!(contract.storage_balance_of(user()).is_none());
    let bounds = contract.storage_balance_bounds();
    assert!(bounds.min.as_yoctonear() > 0);
    assert_eq!(bounds.max, Some(bounds.min));

    set_env(&owner(), NearToken::from_millinear(10));
    let balance = contract.storage_deposit(Some(user()), Some(true));
    assert!(balance.total.as_yoctonear() >= bounds.min.as_yoctonear());
    let stored = contract.storage_balance_of(user()).unwrap();
    assert_eq!(stored.total, balance.total);
    assert_eq!(stored.available, balance.available);
}

#[test]
fn storage_withdraw_and_unregister_release_the_account() {
    let (mut contract, owner) = deploy(0);
    set_env(&owner, NearToken::from_millinear(10));
    contract.storage_deposit(Some(user()), Some(true));

    set_env(&user(), NearToken::from_yoctonear(1));
    let withdrawn = contract.storage_withdraw(None);
    assert_eq!(withdrawn.available, NearToken::from_yoctonear(0));

    set_env(&user(), NearToken::from_yoctonear(1));
    assert!(contract.storage_unregister(None));
    assert!(contract.storage_balance_of(user()).is_none());
}

#[test]
#[should_panic(expected = "is not registered")]
fn transfer_to_an_unregistered_account_is_rejected() {
    let (mut contract, owner) = deploy(1_000);
    set_env(&owner, NearToken::from_yoctonear(1));
    contract.ft_transfer(user(), U128(250), None);
}

