//! Offline unit tests for the transaction namespace, ported to match the Python wrapper's coverage
//! (wrappers/python/tests/test_transaction.py). Rust previously had almost no dedicated Tx unit
//! tests; this adds the input-count assertion and the malformed / invalid-hex error cases.

use mesmo::Bridge;
use serde_json::Value;

// A known valid transaction CBOR hex (built from Java tests).
const SAMPLE_TX_CBOR: &str = "84a300d901028182582073198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002010181825839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc1a001e8480021a00029810a0f5f6";

fn bridge() -> Bridge {
    Bridge::new().expect("Failed to create bridge")
}

#[test]
fn test_tx_to_json_has_one_input() {
    let b = bridge();
    let tx_json = b
        .tx()
        .to_json(SAMPLE_TX_CBOR)
        .expect("Failed to convert to JSON");
    let parsed: Value = serde_json::from_str(&tx_json).expect("Invalid JSON");
    let inputs = parsed["body"]["inputs"].as_array().expect("inputs array");
    assert_eq!(inputs.len(), 1);
}

#[test]
fn test_tx_deserialize_has_inputs() {
    let b = bridge();
    let result = b
        .tx()
        .deserialize(SAMPLE_TX_CBOR)
        .expect("Failed to deserialize");
    let parsed: Value = serde_json::from_str(&result).expect("Invalid JSON");
    assert!(parsed["body"]["inputs"].is_array());
}

// --- Negative / Error Tests ---

#[test]
fn test_tx_hash_malformed_cbor() {
    let b = bridge();
    let result = b.tx().hash("deadbeef");
    assert!(result.is_err(), "expected error for malformed CBOR");
}

#[test]
fn test_tx_hash_invalid_hex() {
    let b = bridge();
    let result = b.tx().hash("not_hex!");
    assert!(result.is_err(), "expected error for invalid hex");
}

#[test]
fn test_tx_deserialize_malformed() {
    let b = bridge();
    let result = b.tx().deserialize("deadbeef");
    assert!(result.is_err(), "expected error deserializing malformed CBOR");
}
