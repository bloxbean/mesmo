//! Build and sign a payment transaction fully offline from a TxPlan (YAML).
//!
//! The transaction is defined as a TxPlan YAML document; we supply the UTXOs and protocol
//! parameters ourselves (no node / no provider), build the unsigned CBOR, then sign it locally.
//! Submitting it is a separate, online step.
//!
//! Run from wrappers/rust:
//!
//! ```text
//! LIB_DIR=../../core/build/native/nativeCompile
//! CCL_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
//!   cargo run --example transaction
//! ```
use ccl::{Bridge, Network};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bridge = Bridge::new()?;

    let sender = bridge.accounts().create(Network::Testnet)?; // managed handle — signs below
    let sender_info = sender.info()?;
    let receiver = bridge.accounts().create(Network::Testnet)?;
    let receiver_info = receiver.info()?;
    let sender_addr = sender_info["base_address"].as_str().unwrap();
    let receiver_addr = receiver_info["base_address"].as_str().unwrap();

    // Minimal protocol parameters (CCL test-resource values).
    let protocol_params = json!({
        "min_fee_a": 44, "min_fee_b": 155381, "max_tx_size": 16384,
        "key_deposit": "2000000", "pool_deposit": "500000000",
        "coins_per_utxo_size": "4310", "max_val_size": "5000",
        "max_tx_ex_mem": "10000000", "max_tx_ex_steps": "10000000000",
        "price_mem": 0.0577, "price_step": 0.0000721, "collateral_percent": 150,
        "max_collateral_inputs": 3
    });

    // A static UTXO the sender controls (100 ADA), instead of querying a node.
    let utxos = json!([{
        "tx_hash": "a".repeat(64),
        "output_index": 0,
        "address": sender_addr,
        "amount": [{"unit": "lovelace", "quantity": "100000000"}]
    }]);

    // Define the transaction as a TxPlan YAML document: pay 5 ADA to the receiver.
    let yaml = format!(
        "version: 1.0\n\
         transaction:\n\
         \x20 - tx:\n\
         \x20     from: {sender_addr}\n\
         \x20     intents:\n\
         \x20       - type: payment\n\
         \x20         address: {receiver_addr}\n\
         \x20         amounts:\n\
         \x20           - unit: lovelace\n\
         \x20             quantity: \"5000000\"\n"
    );

    // Build the unsigned transaction offline.
    let result = bridge.quicktx().build(&yaml, &utxos, &protocol_params, None, 0)?;
    println!("Built unsigned transaction from TxPlan YAML");
    println!("  tx hash: {}", result.tx_hash);
    println!("  fee    : {}", result.fee);
    println!("  cbor   : {}...", &result.tx_cbor[..80]);

    // Sign it with the sender's mnemonic.
    let signed = sender.sign_tx(&result.tx_cbor, ccl::accounts::SigningRole::PAYMENT)?;
    println!("Signed transaction cbor: {}...", &signed[..80]);
    println!("\nNext step (not shown): submit `signed` to a Cardano node over HTTP.");
    Ok(())
}
