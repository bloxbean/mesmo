//! Offline unit tests for the managed-accounts namespace, ported to match the Python wrapper's
//! coverage (wrappers/python/tests/test_account.py). Covers testnet address prefixes, address
//! derivation by index, key material via crypto::derive_key, and the negative / error cases
//! (invalid + empty mnemonic, invalid CBOR).

use ccl::accounts::SigningRole;
use ccl::{Bridge, Network};
use serde_json::Value;

fn bridge() -> Bridge {
    Bridge::new().expect("Failed to create bridge")
}

/// Create a managed account; return its public info and the one-shot recovery phrase.
fn create(bridge: &Bridge, network: Network) -> (Value, String) {
    let acct = bridge
        .accounts()
        .create(network)
        .expect("Failed to create account");
    let info = acct.info().expect("Failed to get info");
    let phrase = acct
        .export_recovery_phrase()
        .expect("Failed to export recovery phrase");
    (info, phrase)
}

#[test]
fn test_account_create_testnet() {
    let b = bridge();
    let (info, _phrase) = create(&b, ccl::Network::Testnet);
    assert!(info["base_address"]
        .as_str()
        .unwrap()
        .starts_with("addr_test1"));
}

#[test]
fn test_account_from_mnemonic_restores_all_addresses() {
    // Restoring from a mnemonic must reproduce the base, enterprise and stake addresses.
    let b = bridge();
    let (created, mnemonic) = create(&b, ccl::Network::Mainnet);

    let acct = b
        .accounts()
        .from_mnemonic(&mnemonic, ccl::Network::Mainnet, 0, 0)
        .expect("Failed to restore account");
    let restored = acct.info().expect("Failed to get info");

    assert_eq!(created["base_address"], restored["base_address"]);
    assert_eq!(created["enterprise_address"], restored["enterprise_address"]);
    assert_eq!(created["stake_address"], restored["stake_address"]);
}

#[test]
fn test_account_different_indices() {
    // Different address indices under the same mnemonic yield different base addresses.
    let b = bridge();
    let (_created, mnemonic) = create(&b, ccl::Network::Mainnet);

    let info_at = |index: u32| -> Value {
        let acct = b
            .accounts()
            .from_mnemonic(&mnemonic, ccl::Network::Mainnet, 0, index)
            .expect("Failed to open account");
        acct.info().expect("Failed to get info")
    };

    assert_ne!(info_at(0)["base_address"], info_at(1)["base_address"]);
}

#[test]
fn test_derive_key_public_key_length() {
    // Public key is a 32-byte Ed25519 key -> 64 hex chars, via the stateless derivation utility.
    let b = bridge();
    let (_created, mnemonic) = create(&b, ccl::Network::Mainnet);

    let key_json = b
        .crypto()
        .derive_key(&mnemonic, 0, 0, "payment")
        .expect("Failed to derive key");
    let key: Value = serde_json::from_str(&key_json).expect("Invalid JSON");
    assert_eq!(key["public_key"].as_str().unwrap().len(), 64);
}

// --- Negative / Error Tests ---

#[test]
fn test_account_from_invalid_mnemonic() {
    let b = bridge();
    let result = b.accounts().from_mnemonic(
        "invalid words that are not a valid mnemonic phrase at all",
        ccl::Network::Mainnet,
        0,
        0,
    );
    assert!(result.is_err(), "expected error for invalid mnemonic");
}

#[test]
fn test_account_from_empty_mnemonic() {
    let b = bridge();
    let result = b.accounts().from_mnemonic("", ccl::Network::Mainnet, 0, 0);
    assert!(result.is_err(), "expected error for empty mnemonic");
}

#[test]
fn test_account_sign_tx_invalid_cbor() {
    let b = bridge();
    let (_created, mnemonic) = create(&b, ccl::Network::Testnet);

    let acct = b
        .accounts()
        .from_mnemonic(&mnemonic, ccl::Network::Testnet, 0, 0)
        .expect("Failed to open account");
    let result = acct.sign_tx("deadbeef", SigningRole::PAYMENT);
    assert!(result.is_err(), "expected error signing invalid CBOR");
}
