//! Crypto and address primitives (offline).
//!
//! Run from wrappers/rust:
//!
//! ```text
//! LIB_DIR=../../core/build/native/nativeCompile
//! CCL_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
//!   cargo run --example primitives
//! ```
use ccl::{Bridge, Network};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bridge = Bridge::new()?;

    // --- Mnemonics ---
    let mnemonic = bridge.crypto().generate_mnemonic(24)?;
    println!("Generated 24-word mnemonic: {}", mnemonic);
    println!("  valid? {}", bridge.crypto().validate_mnemonic(&mnemonic));
    println!(
        "  'not a real mnemonic' valid? {}",
        bridge.crypto().validate_mnemonic("not a real mnemonic")
    );

    // --- Blake2b hashing (hex in -> hex out). "Hello" == 48656c6c6f ---
    println!("Blake2b-256('Hello'): {}", bridge.crypto().blake2b_256("48656c6c6f")?);
    println!("Blake2b-224('Hello'): {}", bridge.crypto().blake2b_224("48656c6c6f")?);

    // --- Ed25519 signing ---
    // derive_key returns the 64-byte extended BIP32-Ed25519 key; pass it whole to
    // sign — the extended form is detected by length. (Never slice it: its first
    // half is a clamped scalar, not a seed.)
    let mnemonic = bridge.crypto().generate_mnemonic(24)?;
    let key_json = bridge.crypto().derive_key(&mnemonic, 0, 0, "payment")?;
    let key: serde_json::Value = serde_json::from_str(&key_json)?;
    let priv_ext = key["private_key"].as_str().unwrap().to_string();
    let pub_key = key["public_key"].as_str().unwrap().to_string();
    let message_hex = "68656c6c6f"; // "hello"
    let signature = bridge.crypto().sign(message_hex, &priv_ext)?;
    println!("Ed25519 signature: {}", signature);
    // A tampered signature is correctly rejected.
    let fake_sig = "00".repeat(64);
    println!(
        "  verify(fake signature) -> {}",
        bridge.crypto().verify(&fake_sig, message_hex, &pub_key)
    );

    // --- Address parsing & validation ---
    let acct = bridge.accounts().from_mnemonic(&mnemonic, Network::Testnet, 0, 0)?;
    let acct_info = acct.info()?;
    let addr = acct_info["base_address"].as_str().unwrap();
    println!("Address valid? {}", bridge.address().validate(addr));
    println!("Address info  : {}", bridge.address().info(addr)?);
    let raw = bridge.address().to_bytes(addr)?;
    println!(
        "Address -> bytes -> address round-trips: {}",
        bridge.address().from_bytes(&raw)? == addr
    );
    Ok(())
}
