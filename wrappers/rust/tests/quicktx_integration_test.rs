//! Integration tests for QuickTx with Yaci DevKit.
//!
//! Requires:
//! - Yaci DevKit running on port 10000
//! - Native library built: ./gradlew :core:nativeCompile
//!
//! Run with:
//!   cd wrappers/rust && MESMO_LIB_PATH=../../core/build/native/nativeCompile \
//!       cargo test --features providers --test quicktx_integration_test -- --test-threads=1
//!
//! Shared DevKit plumbing lives in `tests/common/mod.rs` (see that module for the harness the intents
//! integration suite also uses).

mod common;

use mesmo::Mesmo;
use common::*;

// --- YAML builders ---

fn payment_yaml(from: &str, to: &str, quantity: &str) -> String {
    format!(
        "version: 1.0\n\
         transaction:\n\
         \x20 - tx:\n\
         \x20     from: {from}\n\
         \x20     intents:\n\
         \x20       - type: payment\n\
         \x20         address: {to}\n\
         \x20         amounts:\n\
         \x20           - unit: lovelace\n\
         \x20             quantity: \"{quantity}\"\n"
    )
}

// --- Integration Tests ---

#[test]
fn test_integration_simple_ada_transfer() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();

    let lib = Mesmo::new().expect("create lib");
    let (sender, mnemonic) = fund_sender(&lib, 150);
    let (receiver, _, _) = get_testnet_account(&lib);

    let utxos = devkit_get_utxos(&sender);
    let pp = devkit_get_protocol_params();

    let yaml = payment_yaml(&sender, &receiver, "5000000");
    let result = lib.quicktx().build(&yaml, &utxos, &pp, None, 0).expect("build failed");
    assert!(!result.tx_cbor.is_empty());
    assert_eq!(result.tx_hash.len(), 64);

    let signed_tx = {
        let acct = lib
            .accounts()
            .from_mnemonic(&mnemonic, mesmo::Network::Testnet, 0, 0)
            .expect("open account");
        acct.sign_tx(&result.tx_cbor, mesmo::accounts::SigningRole::PAYMENT)
            .expect("sign failed")
    };
    let tx_hash = devkit_submit_tx(&signed_tx);
    assert!(!tx_hash.is_empty());

    wait_for_block();
    let receiver_utxos = devkit_get_utxos(&receiver);
    assert_eq!(total_lovelace(&receiver_utxos), 5_000_000);
}

// Pay two receivers in one transaction. Mirrors Go's TestIntegrationMultipleReceivers.
#[test]
fn test_integration_multiple_receivers() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();

    let lib = Mesmo::new().expect("create lib");
    let (sender, mnemonic) = fund_sender(&lib, 150);
    let (r1, _, _) = get_testnet_account(&lib);
    let (r2, _, _) = get_testnet_account(&lib);

    let utxos = devkit_get_utxos(&sender);
    let pp = devkit_get_protocol_params();

    let yaml = format!(
        "version: 1.0\n\
         transaction:\n\
         \x20 - tx:\n\
         \x20     from: {sender}\n\
         \x20     intents:\n\
         \x20       - type: payment\n\
         \x20         address: {r1}\n\
         \x20         amounts:\n\
         \x20           - unit: lovelace\n\
         \x20             quantity: \"3000000\"\n\
         \x20       - type: payment\n\
         \x20         address: {r2}\n\
         \x20         amounts:\n\
         \x20           - unit: lovelace\n\
         \x20             quantity: \"2000000\"\n"
    );

    let result = lib.quicktx().build(&yaml, &utxos, &pp, None, 0).expect("build failed");
    let signed_tx = {
        let acct = lib
            .accounts()
            .from_mnemonic(&mnemonic, mesmo::Network::Testnet, 0, 0)
            .expect("open account");
        acct.sign_tx(&result.tx_cbor, mesmo::accounts::SigningRole::PAYMENT)
            .expect("sign failed")
    };
    let tx_hash = devkit_submit_tx(&signed_tx);
    assert!(!tx_hash.is_empty());

    wait_for_block();
    assert_eq!(total_lovelace(&devkit_get_utxos(&r1)), 3_000_000);
    assert_eq!(total_lovelace(&devkit_get_utxos(&r2)), 2_000_000);
}

#[test]
fn test_integration_insufficient_funds() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();

    let lib = Mesmo::new().expect("create lib");
    let (sender, _) = fund_sender(&lib, 2);
    let (receiver, _, _) = get_testnet_account(&lib);

    let utxos = devkit_get_utxos(&sender);
    let pp = devkit_get_protocol_params();

    let yaml = payment_yaml(&sender, &receiver, "100000000");
    let result = lib.quicktx().build(&yaml, &utxos, &pp, None, 0);
    assert!(result.is_err(), "expected insufficient funds error");
}

// The shipped YaciProvider fetches the devnet's real chain data and feeds build via build_with.
#[cfg(feature = "providers")]
#[test]
fn test_integration_build_with_yaci_provider() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();

    let lib = Mesmo::new().expect("create lib");
    let (sender, _mnemonic) = fund_sender(&lib, 150);
    let (receiver, _, _) = get_testnet_account(&lib);

    let provider = mesmo::providers::YaciProvider::default(); // local DevKit cluster
    let yaml = payment_yaml(&sender, &receiver, "5000000");
    let result = lib
        .quicktx()
        .build_with(&yaml, &provider, &[sender.as_str()], 0, None)
        .expect("build_with failed");

    assert!(!result.tx_cbor.is_empty());
    assert_eq!(result.tx_hash.len(), 64);
}

// Submit a treasury donation, learning the required current_treasury_value from the ledger's own
// ConwayTreasuryValueMismatch rejection (retry loop). See the intents suite's more detailed copy for
// the full rationale; kept here too as the QuickTx-level donation smoke test.
#[test]
fn test_integration_donation_treasury() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();

    let lib = Mesmo::new().expect("create lib");
    let utxos = devkit_get_utxos(INTENT_SENDER);
    let pp = devkit_get_protocol_params();
    let base_yaml = read_fixture("donation.yaml");

    let mut treasury = String::from("0");
    let mut last_err = String::new();
    for _ in 0..5 {
        let yaml = base_yaml.replace(
            "current_treasury_value: 0",
            &format!("current_treasury_value: {}", treasury),
        );
        let result = lib.quicktx().build(&yaml, &utxos, &pp, None, 0).expect("build");
        let signed = intent_sign(&lib, &result.tx_cbor, &["payment"]);
        match devkit_try_submit(&signed) {
            Ok(tx_hash) => {
                assert!(!tx_hash.is_empty(), "empty tx hash from submit");
                return; // accepted
            }
            Err(e) => {
                last_err = e;
                match parse_expected_treasury(&last_err) {
                    Some(v) => treasury = v,
                    None => panic!("unexpected submit error: {}", last_err),
                }
            }
        }
    }
    panic!("donation submit failed after retries: {}", last_err);
}
