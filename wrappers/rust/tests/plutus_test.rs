//! Offline unit tests for the plutus namespace, ported to match the Python wrapper's coverage
//! (wrappers/python/tests/test_plutus.py). The happy-path data_hash vector already lives in
//! integration_test.rs; this adds the invalid-CBOR and empty-input error cases.

use mesmo::Mesmo;

fn lib() -> Mesmo {
    Mesmo::new().expect("Failed to create lib")
}

#[test]
fn test_plutus_data_hash_invalid_cbor() {
    let b = lib();
    let result = b.plutus().data_hash("zzzz");
    assert!(result.is_err(), "expected error for invalid CBOR");
}

#[test]
fn test_plutus_data_hash_empty() {
    let b = lib();
    let result = b.plutus().data_hash("");
    assert!(result.is_err(), "expected error for empty input");
}
