//! Build a Plutus-script transaction and get its execution units two ways.
//!
//! A Plutus build needs each redeemer's execution units. This example mints a token with an
//! always-succeeds validator and shows both ways to obtain them:
//!   1. the offline default — the bridge computes the units in-process with Scalus (no network); and
//!   2. a remote TransactionEvaluator (Blockfrost) — illustrative, requires a project id.
//!
//! libccl never makes HTTP calls (ADR-0013 / ADR-0002), so a remote evaluator lives here in the
//! wrapper: `build_with` runs a two-pass (draft -> evaluate -> rebuild). Needs the `providers` feature.
//!
//! Run from wrappers/rust:
//!
//! ```sh
//! LIB_DIR=../../core/build/native/nativeCompile \
//! DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
//!   cargo run --example evaluator --features providers
//! ```
use ccl::providers::ChainDataProvider;
use ccl::{Bridge, Result};
use serde_json::Value;
use std::fs;
use std::path::Path;

/// A trivial provider that returns fixed fixtures (stands in for Blockfrost/Yaci/…).
struct LocalProvider {
    utxos: Value,
    params: Value,
}

impl ChainDataProvider for LocalProvider {
    fn utxos(&self, _address: &str) -> Result<Value> {
        Ok(self.utxos.clone())
    }
    fn protocol_params(&self) -> Result<Value> {
        Ok(self.params.clone())
    }
}

fn main() -> Result<()> {
    // Shared fixtures: an always-succeeds mint (TxPlan YAML), the sender's UTXOs, and protocol
    // parameters *with cost models* (Scalus needs them to run the UPLC machine).
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/plutus-mint-scalus");
    let yaml = fs::read_to_string(dir.join("mint.yaml")).expect("mint.yaml");
    let utxos: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("utxos.json")).expect("utxos.json"))
            .expect("parse utxos");
    let params: Value = serde_json::from_str(
        &fs::read_to_string(dir.join("protocol-params.json")).expect("protocol-params.json"),
    )
    .expect("parse params");
    let sender = utxos[0]["address"].as_str().expect("sender address").to_string();

    let provider = LocalProvider { utxos, params };
    let bridge = Bridge::new()?;

    // 1) Offline default: no evaluator -> Scalus runs the validator and stamps the computed units.
    let result = bridge
        .quicktx()
        .build_with(&yaml, &provider, &[sender.as_str()], 0, None)?;
    println!(
        "offline (Scalus) — fee: {}  tx_hash: {}",
        result.fee, result.tx_hash
    );

    // 2) Remote evaluator (illustrative — needs a Blockfrost project id). The two-pass builds a
    //    draft, POSTs it to /utils/txs/evaluate, and rebuilds with the returned units:
    //
    //    use ccl::providers::BlockfrostEvaluator;
    //    let evaluator = BlockfrostEvaluator::new("preprod_your_project_id", "preprod")?;
    //    let result = bridge.quicktx().build_with(&yaml, &provider, &sender, Some(&evaluator))?;
    //
    // To supply units yourself, call build() directly with the units as a JSON array.
    Ok(())
}
