//! Offline unit tests for governance identity and key derivation, ported to match the Python
//! wrapper's coverage (wrappers/python/tests/test_governance.py). Governance *identity* (DRep id,
//! committee ids and credentials) is public data on the managed account's info; raw governance
//! key material comes from crypto::derive_key.

use ccl::Bridge;
use serde_json::Value;

fn bridge() -> Bridge {
    Bridge::new().expect("Failed to create bridge")
}

fn managed_mnemonic(bridge: &Bridge) -> (Value, String) {
    let acct = bridge
        .accounts()
        .create(ccl::Network::Mainnet)
        .expect("Failed to create account");
    let info = acct.info().expect("Failed to get info");
    let phrase = acct
        .export_recovery_phrase()
        .expect("Failed to export recovery phrase");
    (info, phrase)
}

#[test]
fn test_gov_identifiers_in_account_info() {
    let b = bridge();
    let (info, _phrase) = managed_mnemonic(&b);
    assert!(info["drep_id"].as_str().unwrap().starts_with("drep1"));
    assert!(info["committee_cold_id"]
        .as_str()
        .unwrap()
        .starts_with("cc_cold1"));
    assert!(info["committee_hot_id"]
        .as_str()
        .unwrap()
        .starts_with("cc_hot1"));
    // blake2b-224 credentials, hex
    assert_eq!(info["committee_cold_credential"].as_str().unwrap().len(), 56);
    assert_eq!(info["committee_hot_credential"].as_str().unwrap().len(), 56);
}

#[test]
fn test_derive_key_matches_account_credentials() {
    let b = bridge();
    let (info, mnemonic) = managed_mnemonic(&b);
    for (role, field) in [
        ("committee_cold", "committee_cold_credential"),
        ("committee_hot", "committee_hot_credential"),
    ] {
        let key_json = b
            .crypto()
            .derive_key(&mnemonic, 0, 0, role)
            .expect("Failed to derive key");
        let key: Value = serde_json::from_str(&key_json).expect("Invalid JSON");
        assert_eq!(key["public_key_hash"], info[field], "role {role}");
    }
}

// --- Negative / Error Tests ---

#[test]
fn test_derive_key_from_invalid_mnemonic() {
    let b = bridge();
    let result = b.crypto().derive_key("not a valid mnemonic", 0, 0, "drep");
    assert!(result.is_err(), "expected error for invalid mnemonic");
}

#[test]
fn test_derive_key_rejects_unknown_role() {
    let b = bridge();
    let mnemonic = b
        .crypto()
        .generate_mnemonic(24)
        .expect("Failed to generate mnemonic");
    let result = b.crypto().derive_key(&mnemonic, 0, 0, "bogus");
    assert!(result.is_err(), "expected error for unknown role");
}

#[test]
fn test_derive_key_returns_cip105_bech32_encodings_for_gov_roles() {
    let b = bridge();
    let mnemonic = b.crypto().generate_mnemonic(24).expect("mnemonic");
    for (role, prefix) in [("drep", "drep"), ("committee_cold", "cc_cold"), ("committee_hot", "cc_hot")] {
        let key: Value =
            serde_json::from_str(&b.crypto().derive_key(&mnemonic, 0, 0, role).expect("derive")).expect("json");
        assert!(
            key["bech32_verification_key"].as_str().unwrap().starts_with(&format!("{prefix}_vk1")),
            "{role}"
        );
        assert!(
            key["bech32_verification_key_hash"].as_str().unwrap().starts_with(&format!("{prefix}_vkh1")),
            "{role}"
        );
    }
    // Non-governance roles carry no CIP-105 encodings by design.
    let payment: Value =
        serde_json::from_str(&b.crypto().derive_key(&mnemonic, 0, 0, "payment").expect("derive")).expect("json");
    assert!(payment.get("bech32_verification_key").is_none());
}
