//! Offline unit tests for the crypto namespace, ported to match the Python wrapper's coverage
//! (wrappers/python/tests/test_crypto.py). Covers exact Blake2b vectors, the 12-word mnemonic path,
//! and the negative / error cases (invalid hex, invalid signing key).

use mesmo::Bridge;

fn bridge() -> Bridge {
    Bridge::new().expect("Failed to create bridge")
}

#[test]
fn test_crypto_blake2b_256_known_vector() {
    // Blake2b-256 of "Hello" (0x48656c6c6f).
    let b = bridge();
    let hash = b.crypto().blake2b_256("48656c6c6f").expect("Failed to hash");
    assert_eq!(
        hash,
        "8b7ca7d27d9fc55fa30abfe515b3afb24e3fe89fdd02e2ac92bca2c96680642e"
    );
}

#[test]
fn test_crypto_blake2b_224_known_vector() {
    // Blake2b-224 of "Hello" (0x48656c6c6f).
    let b = bridge();
    let hash = b.crypto().blake2b_224("48656c6c6f").expect("Failed to hash");
    assert_eq!(
        hash,
        "376352b84882685054b2010033c2e9f479466fd10a609230240c06db"
    );
}

#[test]
fn test_crypto_generate_12_word_mnemonic() {
    let b = bridge();
    let mnemonic = b
        .crypto()
        .generate_mnemonic(12)
        .expect("Failed to generate mnemonic");
    assert_eq!(mnemonic.split_whitespace().count(), 12);
    assert!(b.crypto().validate_mnemonic(&mnemonic));
}

#[test]
fn test_crypto_invalid_mnemonic_rejected() {
    let b = bridge();
    assert!(!b.crypto().validate_mnemonic("not a valid mnemonic"));
}

// --- Negative / Error Tests ---

#[test]
fn test_crypto_blake2b_256_invalid_hex() {
    let b = bridge();
    let result = b.crypto().blake2b_256("not_valid_hex!");
    assert!(result.is_err(), "expected error for invalid hex input");
}

#[test]
fn test_crypto_sign_invalid_key() {
    let b = bridge();
    let bad_key = "zz".repeat(32);
    let result = b.crypto().sign("68656c6c6f", &bad_key);
    assert!(result.is_err(), "expected error signing with invalid key");
}
