# Cardano Client Lib for Rust

The `mesmo` crate (imported as `ccl`) brings [Cardano Client Lib (CCL)](https://github.com/bloxbean/cardano-client-lib)'s offline Cardano operations — key derivation, address handling, transaction building and signing, Plutus data, governance keys — to Rust as a native library. No JVM at runtime: the crate links against `libmesmo`, a GraalVM native-image build of CCL fetched automatically at build time.

## Documentation

| Document | Contents |
|---|---|
| [API reference](api.md) | Every type and method: `Bridge`, account, address, crypto, tx, plutus, script, gov, wallet, quicktx |
| [Building transactions](transactions.md) | The full workflow with worked examples: payments, staking, governance, minting, Plutus |
| [Providers & evaluators](providers.md) | The `providers` feature: fetching UTXOs/protocol params from Yaci DevKit or Blockfrost; remote script-cost evaluation |
| [Troubleshooting](troubleshooting.md) | Native library fetching, platform support, common errors |
| [TxPlan (YAML) reference](../quicktx.md) | The transaction description format used by `quicktx().build` — shared by all four language wrappers |

## Installation

Once published to crates.io:

```toml
[dependencies]
cardano-client-lib = "0.1"
# with the optional HTTP providers:
# cardano-client-lib = { version = "0.1", features = ["providers"] }
```

Until then, use a git dependency:

```toml
[dependencies]
cardano-client-lib = { git = "https://github.com/bloxbean/mesmo", package = "cardano-client-lib" }
```

The import name is `ccl` regardless: `use mesmo::{Bridge, Network};`.

**First build needs network access:** crates.io can't host the ~50 MB native library, so `build.rs` downloads the prebuilt `libmesmo` for your platform from the project's GitHub releases (once, cached in the build directory). An rpath is set automatically — **no `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` needed at runtime**. To build against a local library instead, set `MESMO_LIB_PATH` — see [troubleshooting](troubleshooting.md#how-the-native-library-is-obtained).

Features:

| Feature | Default | Adds |
|---|---|---|
| `providers` | off | `mesmo::providers` module (Yaci/Blockfrost chain-data providers + evaluators, pulls in `ureq`) |

## Quick start

```rust
use mesmo::{Bridge, Network};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bridge = Bridge::new()?; // torn down automatically on drop (RAII)

    // Create a new managed account (testnet). Its info never contains the phrase;
    // export the recovery phrase once, deliberately.
    let account = bridge.accounts().create(Network::Testnet)?;
    let info = account.info()?;
    println!("{}", info["base_address"]);  // addr_test1...
    println!("{}", info["stake_address"]); // stake_test1...
    let mnemonic = account.export_recovery_phrase()?;

    // Restore it later from the phrase.
    let _restored = bridge.accounts().from_mnemonic(&mnemonic, Network::Testnet, 0, 0)?;
    Ok(())
}
```

### Build, sign, and inspect a transaction — fully offline

Transactions are described as a [TxPlan YAML document](../quicktx.md). You supply the UTXOs and protocol parameters (from any source — see [providers](providers.md) for ready-made ones), and get back an unsigned transaction:

```rust
let yaml = format!(r#"
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: payment
          address: {receiver}
          amounts:
            - unit: lovelace
              quantity: "5000000"
"#);

let result = bridge.quicktx().build(&yaml, &utxos, &protocol_params, None)?;
// result.tx_cbor, result.tx_hash, result.fee

let signed = sender.sign_tx(&result.tx_cbor, SigningRole::PAYMENT)?; // sender = bridge.accounts().from_mnemonic(...)
// submit `signed` with any HTTP client — the library never talks to the network
```

With a provider (requires the `providers` feature), fetching the chain data is one call:

```rust
use mesmo::providers::YaciProvider;

let provider = YaciProvider::default(); // local Yaci DevKit
let result = bridge.quicktx().build_with(&yaml, &provider, &[sender.as_str()], 0, None)?;
```

## Design in one paragraph

The native library is **offline and stateless** — it derives, builds, signs, hashes, and serializes, but never performs I/O. Anything that touches the network (fetching UTXOs, protocol parameters, submitting transactions, remote script evaluation) lives in the optional `providers` module or in your code, where you control HTTP. Plutus execution units are computed offline in-process (via Scalus) by default, so even script transactions build without a network connection.

## Threading

`Bridge` is deliberately **`!Send` and `!Sync`**: the underlying GraalVM isolate thread is bound to the OS thread that created it, so moving a bridge across threads would corrupt the VM. The compiler enforces this — create **one `Bridge` per thread**. Teardown is RAII (`Drop`); there is no `close()` to forget, and the borrow checker prevents use-after-free of the bridge by the API handles.

## Networks

```rust
pub enum Network { Mainnet, Testnet }
```

Every key-derivation method takes a typed `Network` — there is no integer API. Note the underlying values are CCL enum ordinals, which are the **inverse** of Cardano's on-chain network id for mainnet/testnet (`Mainnet` → ordinal 0, but a mainnet address's on-chain `network_id` is `1`). See [API reference → Networks](api.md#networks).

## Examples

Runnable examples live in [`wrappers/rust/examples/`](../../wrappers/rust/examples):

- `account.rs` — create/restore accounts, derive keys and DRep id
- `primitives.rs` — mnemonics, Blake2b hashing, Ed25519 sign/verify, address parsing
- `transaction.rs` — offline QuickTx build + sign
- `evaluator.rs` — Plutus mint with offline Scalus units vs. remote Blockfrost evaluation (needs `--features providers`)

```bash
cargo run --example account
cargo run --example evaluator --features providers
```
