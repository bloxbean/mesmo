//! Tests for the optional chain-data provider helpers (the `providers` feature).
//!
//! Covers the HTTP-shaping logic (pagination, address injection, project_id header) against a local
//! mock server, plus an offline build_with round-trip using a stub provider and the real
//! offline build. The live Yaci round-trip is covered by the DevKit integration tests.
#![cfg(feature = "providers")]

use ccl::providers::{BlockfrostProvider, ChainDataProvider};
use ccl::{Bridge, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

const SENDER: &str = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";
const RECEIVER: &str = "addr_test1qz7svwszky8gcmhrfza7a89z9u0dfzd3l7h23sqlc5yml7ejcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwqcqrvr0";

fn static_protocol_params() -> Value {
    json!({
        "min_fee_a": 44, "min_fee_b": 155381, "max_tx_size": 16384, "max_val_size": "5000",
        "key_deposit": "2000000", "pool_deposit": "500000000", "coins_per_utxo_size": "4310",
        "max_tx_ex_mem": "14000000", "max_tx_ex_steps": "10000000000",
        "price_mem": 0.0577, "price_step": 0.0000721, "collateral_percent": 150,
        "max_collateral_inputs": 3, "min_fee_ref_script_cost_per_byte": 15
    })
}

fn static_utxos() -> Value {
    json!([{
        "tx_hash": "a".repeat(64), "output_index": 0, "address": SENDER,
        "amount": [{ "unit": "lovelace", "quantity": "2000000000" }]
    }])
}

/// A provider with no network at all — proves the trait + build_with composition and the
/// real offline build work end to end.
struct StubProvider;
impl ChainDataProvider for StubProvider {
    fn utxos(&self, address: &str) -> Result<Value> {
        assert_eq!(address, SENDER);
        Ok(static_utxos())
    }
    fn protocol_params(&self) -> Result<Value> {
        Ok(static_protocol_params())
    }
}

#[test]
fn build_with_offline() {
    let bridge = Bridge::new().expect("bridge");
    let yaml = format!(
        "version: 1.0\ntransaction:\n  - tx:\n      from: {SENDER}\n      intents:\n        - type: payment\n          address: {RECEIVER}\n          amounts:\n            - unit: lovelace\n              quantity: \"5000000\"\n"
    );
    let res = bridge
        .quicktx()
        .build_with(&yaml, &StubProvider, &[SENDER], 0, None)
        .expect("build_with");
    assert_eq!(res.tx_hash.len(), 64);
    assert!(!res.tx_cbor.is_empty());
}

/// Minimal one-shot-per-connection HTTP/1.1 mock server. Returns the base URL; records each request
/// line (with a marker when the project_id header is present) into `log`.
fn spawn_mock(log: Arc<Mutex<Vec<String>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut headers = String::new();
            loop {
                let mut l = String::new();
                if reader.read_line(&mut l).unwrap() == 0 || l == "\r\n" {
                    break;
                }
                headers.push_str(&l);
            }
            let has_pid = headers.to_lowercase().contains("project_id: proj123");
            log.lock()
                .unwrap()
                .push(format!("{}{}", request_line.trim(), if has_pid { " [pid]" } else { "" }));

            let body = if request_line.contains("page=1") {
                let items: Vec<Value> = (0..100)
                    .map(|i| json!({"tx_hash": format!("{:064x}", i), "output_index": 0,
                                    "amount": [{"unit": "lovelace", "quantity": "1000000"}]}))
                    .collect();
                serde_json::to_string(&items).unwrap()
            } else if request_line.contains("page=2") {
                serde_json::to_string(&vec![json!({"tx_hash": "ff".repeat(32), "output_index": 1,
                    "amount": [{"unit": "lovelace", "quantity": "2000000"}]})])
                .unwrap()
            } else {
                "[]".to_string()
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            stream.write_all(resp.as_bytes()).unwrap();
        }
    });
    base
}

#[test]
fn blockfrost_paginates_injects_address_and_sends_project_id() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let base = spawn_mock(log.clone());

    let provider = BlockfrostProvider::with_url("proj123", &base);
    let utxos = provider.utxos("addr_test1abc").expect("utxos");
    let arr = utxos.as_array().unwrap();

    assert_eq!(arr.len(), 101); // paged until a short page
    assert!(arr.iter().all(|u| u["address"] == "addr_test1abc")); // address injected on every UTXO

    let log = log.lock().unwrap();
    assert!(log.iter().all(|r| r.contains("[pid]")), "project_id header missing: {:?}", *log);
}

#[test]
fn blockfrost_unknown_network_errs() {
    assert!(BlockfrostProvider::new("p", "nope").is_err());
}

/// Multi-sender fetch: UTXOs are merged per sender and de-duplicated by (tx_hash, output_index) —
/// with naive concatenation the shared UTXO would double-count and the build would misbehave.
struct TwoSenderProvider;
impl ChainDataProvider for TwoSenderProvider {
    fn utxos(&self, address: &str) -> Result<Value> {
        let shared = static_utxos();
        if address == SENDER {
            Ok(shared)
        } else {
            let mut arr = shared.as_array().unwrap().clone();
            arr.push(json!({
                "tx_hash": "b".repeat(64), "output_index": 1, "address": address,
                "amount": [{ "unit": "lovelace", "quantity": "7000000" }]
            }));
            Ok(Value::Array(arr))
        }
    }
    fn protocol_params(&self) -> Result<Value> {
        Ok(static_protocol_params())
    }
}

#[test]
fn build_with_merges_and_dedupes_across_senders() {
    let bridge = Bridge::new().expect("bridge");
    let yaml = format!(
        "version: 1.0\ntransaction:\n  - tx:\n      from: {SENDER}\n      intents:\n        - type: payment\n          address: {RECEIVER}\n          amounts:\n            - unit: lovelace\n              quantity: \"5000000\"\n"
    );
    let res = bridge
        .quicktx()
        .build_with(&yaml, &TwoSenderProvider, &[SENDER, RECEIVER], 0, None)
        .expect("multi-sender build_with");
    assert_eq!(res.tx_hash.len(), 64);
}
