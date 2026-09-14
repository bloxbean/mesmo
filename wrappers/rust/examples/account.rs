//! Account creation and key derivation (offline).
//!
//! Run from wrappers/rust:
//!
//! ```text
//! LIB_DIR=../../core/build/native/nativeCompile
//! CCL_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
//!   cargo run --example account
//! ```
use ccl::{Bridge, Network};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bridge = Bridge::new()?;

    // 1. Create a brand-new testnet account (managed handle; the recovery phrase is
    //    exported once, deliberately — it is never part of the account's info).
    let created = bridge.accounts().create(Network::Testnet)?;
    let info = created.info()?;
    let mnemonic = created.export_recovery_phrase()?;
    let base_address = info["base_address"].as_str().unwrap().to_string();
    println!("Created account");
    println!("  base address: {}", base_address);
    println!("  DRep ID     : {}", info["drep_id"].as_str().unwrap());
    println!("  mnemonic    : {}", mnemonic);

    // 2. Restore the same account from its phrase — the address must match.
    let restored = bridge.accounts().from_mnemonic(&mnemonic, Network::Testnet, 0, 0)?;
    let restored_info = restored.info()?;
    assert_eq!(restored_info["base_address"].as_str().unwrap(), base_address);
    println!("Restored from mnemonic — address matches: {}", base_address);

    // 3. Raw key material, when interop genuinely needs it, comes from the stateless
    //    derivation utility — handles never expose key bytes.
    let key_json = bridge.crypto().derive_key(&mnemonic, 0, 0, "payment")?;
    let key: serde_json::Value = serde_json::from_str(&key_json)?;
    println!("  private key (extended, hex): {}", key["private_key"].as_str().unwrap());
    println!("  public key (hex)           : {}", key["public_key"].as_str().unwrap());
    Ok(())
}
