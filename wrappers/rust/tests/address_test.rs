//! Offline unit tests for the address namespace error paths, ported to match the Python wrapper's
//! coverage (wrappers/python/tests/test_address.py). The happy-path info / to_bytes / from_bytes /
//! validate cases already live in integration_test.rs; this fills the two negative cases.

use mesmo::Mesmo;

fn lib() -> Mesmo {
    Mesmo::new().expect("Failed to create lib")
}

#[test]
fn test_address_info_invalid() {
    let b = lib();
    let result = b.address().info("not_a_valid_address");
    assert!(result.is_err(), "expected error for invalid address");
}

#[test]
fn test_address_from_bytes_invalid() {
    let b = lib();
    let result = b.address().from_bytes("zzzz");
    assert!(result.is_err(), "expected error for invalid bytes");
}
