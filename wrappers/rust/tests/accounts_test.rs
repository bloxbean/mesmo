//! Managed-account object tests (ADR-0016 slice 5): owned-handle lifecycle, typed-role signing
//! parity with the mnemonic-per-call path, one-shot recovery-phrase export, secret hygiene, and
//! the owned-value guarantees (storable next to the Bridge; hard-invalidated by Bridge drop).
//! Fully offline.

use ccl::accounts::{Account, SigningRole};
use ccl::{error_codes, Bridge, Network};
use serde_json::{json, Value};

const TEST_MNEMONIC: &str =
    "test walk nut penalty hip pave soap entry language right filter choice";
const TESTNET: Network = Network::Testnet;

fn protocol_params() -> Value {
    json!({
        "min_fee_a": 44, "min_fee_b": 155381, "max_tx_size": 16384,
        "key_deposit": "2000000", "pool_deposit": "500000000",
        "coins_per_utxo_size": "4310", "max_val_size": "5000",
        "max_tx_ex_mem": "10000000", "max_tx_ex_steps": "10000000000",
        "price_mem": 0.0577, "price_step": 0.0000721, "collateral_percent": 150,
        "max_collateral_inputs": 3
    })
}

fn unsigned_stake_reg(bridge: &Bridge, info: &Value) -> String {
    let base = info["base_address"].as_str().unwrap();
    let stake = info["stake_address"].as_str().unwrap();
    let yaml = format!(
        "version: 1.0\ntransaction:\n  - tx:\n      from: {base}\n      intents:\n        - type: stake_registration\n          stake_address: {stake}\n"
    );
    let utxos = json!([{
        "tx_hash": "a".repeat(64), "output_index": 0, "address": base,
        "amount": [{"unit": "lovelace", "quantity": "2000000000"}]
    }]);
    bridge
        .quicktx()
        .build(&yaml, &utxos, &protocol_params(), None, 1)
        .expect("build")
        .tx_cbor
}

#[test]
fn open_info_matches_pinned_derivation() {
    let bridge = Bridge::new().unwrap();
    let acct = bridge.accounts().from_mnemonic(TEST_MNEMONIC, TESTNET, 0, 0).unwrap();
    let info = acct.info().unwrap();

    // Pinned CIP-1852 derivation for the standard CCL test mnemonic at testnet 0/0; the
    // mnemonic-path equivalence proof lives in the core's AccountKeyDerivationParityTest.
    assert_eq!(
        info["base_address"],
        "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer\
3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp"
    );
    assert_eq!(
        info["stake_address"],
        "stake_test1uqevw2xnsc0pvn9t9r9c7qryfqfeerchgrlm3ea2nefr9hqp8n5xl"
    );
    assert_eq!(
        info["change_address"],
        "addr_test1qz4kjk0as0x7ptt54l6cnfyzejqg22cku0qhqx6al4g2xe\
pjcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq5hxe5g"
    );
    assert_eq!(info["network"], 1);
    assert!(info.get("mnemonic").is_none());
}

#[test]
fn sign_determinism_and_role_witnesses() {
    let bridge = Bridge::new().unwrap();
    let acct = bridge.accounts().from_mnemonic(TEST_MNEMONIC, TESTNET, 0, 0).unwrap();
    let unsigned = unsigned_stake_reg(&bridge, &acct.info().unwrap());

    let managed = acct.sign_tx(&unsigned, SigningRole::PAYMENT).unwrap();
    // Deterministic: signing twice yields byte-identical output.
    assert_eq!(managed, acct.sign_tx(&unsigned, SigningRole::PAYMENT).unwrap());

    let managed2 = acct
        .sign_tx(&unsigned, SigningRole::PAYMENT | SigningRole::STAKE)
        .unwrap();
    // The stake role adds a second witness.
    assert!(managed2.len() > managed.len());

    // Mask order is irrelevant — canonical application order fixes the output.
    assert_eq!(
        acct.sign_tx(&unsigned, SigningRole::STAKE | SigningRole::PAYMENT).unwrap(),
        managed2
    );
}

#[test]
fn empty_role_mask_rejected() {
    let bridge = Bridge::new().unwrap();
    let acct = bridge.accounts().from_mnemonic(TEST_MNEMONIC, TESTNET, 0, 0).unwrap();
    let unsigned = unsigned_stake_reg(&bridge, &acct.info().unwrap());
    let err = acct.sign_tx(&unsigned, SigningRole(0)).unwrap_err();
    assert_eq!(err.code, error_codes::CCL_ERROR_INVALID_ARGUMENT);
}

#[test]
fn lifecycle_close_idempotent_use_after_close_typed() {
    let bridge = Bridge::new().unwrap();
    let acct = bridge.accounts().from_mnemonic(TEST_MNEMONIC, TESTNET, 0, 0).unwrap();
    acct.close().unwrap();
    acct.close().unwrap(); // idempotent
    let err = acct.info().unwrap_err();
    assert_eq!(err.code, error_codes::CCL_ERROR_INVALID_HANDLE);
}

#[test]
fn create_export_once_and_restore() {
    let bridge = Bridge::new().unwrap();
    let acct = bridge.accounts().create(TESTNET).unwrap();
    let base = acct.info().unwrap()["base_address"].clone();

    let phrase = acct.export_recovery_phrase().unwrap();
    assert_eq!(phrase.split_whitespace().count(), 24);

    let restored = bridge.accounts().from_mnemonic(&phrase, TESTNET, 0, 0).unwrap();
    assert_eq!(restored.info().unwrap()["base_address"], base);

    // One-shot.
    let err = acct.export_recovery_phrase().unwrap_err();
    assert_eq!(err.code, error_codes::CCL_ERROR_INVALID_ARGUMENT);

    // Imported accounts never export.
    let err = restored.export_recovery_phrase().unwrap_err();
    assert_eq!(err.code, error_codes::CCL_ERROR_INVALID_ARGUMENT);
}

#[test]
fn debug_never_contains_secrets() {
    let bridge = Bridge::new().unwrap();
    let acct = bridge.accounts().create(TESTNET).unwrap();
    let phrase = acct.export_recovery_phrase().unwrap();
    let debug = format!("{:?}", acct);
    assert!(!debug.contains("addr")); // not even public data, just the handle
    assert!(!debug.contains(phrase.split_whitespace().next().unwrap()));
    acct.close().unwrap();
    assert_eq!(format!("{:?}", acct), "<ccl::Account closed>");
}

/// The owned-handle promise (ADR-0016 amendment): an Account can live in the same struct as its
/// Bridge — impossible with the originally sketched `Account<'bridge>` borrow.
#[test]
fn owned_account_storable_next_to_bridge() {
    struct WalletService {
        _bridge: Bridge,
        account: Account,
    }
    let bridge = Bridge::new().unwrap();
    let account = bridge.accounts().from_mnemonic(TEST_MNEMONIC, TESTNET, 0, 0).unwrap();
    let service = WalletService { _bridge: bridge, account };
    assert!(service.account.info().unwrap()["base_address"]
        .as_str()
        .unwrap()
        .starts_with("addr_test1"));
}

/// Dropping the Bridge hard-invalidates outstanding Accounts: calls fail with a typed error,
/// never a dangling-isolate dereference.
#[test]
fn bridge_drop_invalidates_outstanding_accounts() {
    let bridge = Bridge::new().unwrap();
    let acct = bridge.accounts().from_mnemonic(TEST_MNEMONIC, TESTNET, 0, 0).unwrap();
    drop(bridge);
    let err = acct.info().unwrap_err();
    assert_eq!(err.code, error_codes::CCL_ERROR_INVALID_HANDLE);
    acct.close().unwrap(); // and close after bridge-drop is a safe no-op
}
