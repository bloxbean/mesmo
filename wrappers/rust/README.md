# Cardano Client Bindings — Rust

Rust bindings for [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib)
via the Cardano Client Bindings native library.

> Part of the [Cardano Client Bindings](../../README.md) project. See the
> [top-level README](../../README.md) for the full API reference and
> [`docs/quicktx.md`](../../docs/quicktx.md) for transaction building.

## Requirements

- Rust (stable, 2021 edition).

The native library is **fetched automatically at build time** — no separate download and no
`CCL_LIB_PATH` / `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH` needed.

## Installing

```bash
cargo add cardano-client-lib          # published as cardano-client-lib, imported as `ccl`
```

`build.rs` sources `libccl.*` for your target — in priority order: `CCL_LIB_PATH` (a dir), the
in-tree monorepo build, or **downloaded from the GitHub release** — then stages it and sets an
`rpath`, so both linking and runtime "just work" with **no environment variables**.

- Override the release tag it fetches from with `CCL_LIB_VERSION`.
- crates.io can't host the ~50 MB binary, so the crate carries only source + `build.rs`; the lib is
  pulled at build time (needs network on the first build). See
  [ADR-0012](../../docs/adr/0012-native-lib-bundled-in-wrapper-packages.md).

## Running the examples

From `wrappers/rust`, **no env vars required**:

```bash
cargo run --example account
```

For development against a locally built library, point `CCL_LIB_PATH` at it (optional — the in-tree
build is found automatically):

```bash
./gradlew :core:nativeCompile            # build from source (needs Oracle GraalVM 25.0.3), or
make download-lib                        # download a pre-built binary
CCL_LIB_PATH=../../core/build/native/nativeCompile cargo run --example account
```

The [`examples/`](examples/) directory contains:

| `--example` | What it shows |
|-------------|---------------|
| [`account`](examples/account.rs) | Create an account, restore from mnemonic, derive keys and a DRep ID |
| [`primitives`](examples/primitives.rs) | Mnemonics, Blake2b hashing, Ed25519 signing, address parsing/validation |
| [`transaction`](examples/transaction.rs) | Build an unsigned payment **offline** (QuickTx) and sign it — no node/DevKit needed |

## Quick start

```rust
use ccl::{Bridge, Network};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bridge = Bridge::new()?; // loads libccl, starts a GraalVM isolate

    // Managed account handle (ADR-0016): info is public data only.
    let account = bridge.accounts().create(Network::Testnet)?;
    println!("{}", account.info()?["base_address"]); // addr_test1...
    println!("{}", account.export_recovery_phrase()?); // 24-word phrase — one-shot
    Ok(())
} // Bridge's Drop tears down the isolate
```

## API surface

A `Bridge` exposes namespaced accessors (all offline operations):
`bridge.accounts()`, `.address()`, `.crypto()`, `.tx()`, `.plutus()`, `.script()`,
`.quicktx()`.

Most methods return `Result<String>` where the `String` is JSON — parse it with
`serde_json`.

Transactions are defined as a [TxPlan](https://github.com/bloxbean/cardano-client-lib)
**YAML** document and built fully offline — you supply the UTXOs and protocol parameters
(as `serde_json::Value`):

```rust
let result = bridge.quicktx().build(&yaml, &utxos, &protocol_params)?; // -> TxResult { tx_cbor, tx_hash, fee }
```

Methods that need a network take the `Network` enum — `Network::Mainnet` or `Network::Testnet` — so a transposed argument is a compile error rather than a
key silently derived on the wrong network. Errors are `ccl::CclError`.

> **`Network` is not Cardano's on-chain network id.** Its discriminants are CCL's own enum ordinals
> (`Mainnet = 0`, `Testnet = 1`). Cardano's on-chain network id is the
> other way round — **mainnet = 1, testnet = 0** — so an account created with `Network::Mainnet` has
> an address whose `network_id` is `1`. The `network_id` field returned by `bridge.address().info()`
> is that genuine on-chain value, not an ordinal from this enum.

## Chain-data providers (optional)

`build` is offline — you supply the UTXOs and protocol parameters. Enable the `providers` feature for
optional HTTP helpers (via `ureq`) that fetch those for you, keeping the native library offline and
provider-free:

```toml
# Published as `cardano-client-lib`; imported as `ccl` (see below).
cardano-client-lib = { version = "0.1", features = ["providers"] }
```

```rust
use ccl::providers::BlockfrostProvider; // or YaciProvider

let provider = BlockfrostProvider::new("proj_id", "preprod")?; // or YaciProvider::default()
let result = bridge.quicktx().build_with(&yaml, &provider, &[sender], 0, None)?;
```

Plug in any backend (Koios, Ogmios, …) by implementing the `ChainDataProvider` trait (`utxos`,
`protocol_params`). UTXO *selection* is handled inside the bridge — a provider only returns all
UTXOs at the address.

## Transaction evaluators (optional)

A Plutus build needs each redeemer's execution units. The bridge computes them **offline** with
Scalus when you supply none — so a script build just works, no evaluation step (pass `None`):

```rust
let result = bridge.quicktx().build_with(&yaml, &provider, &[sender], 0, None)?; // Scalus computes the units
```

To use a **remote** evaluator instead (e.g. an authoritative fallback), pass a
`TransactionEvaluator`; `build_with` runs a two-pass (draft → evaluate → rebuild). libccl never
makes HTTP calls ([ADR-0013](../../docs/adr/0013-transaction-evaluators.md)), so remote evaluation
lives here in the wrapper (also behind the `providers` feature):

```rust
use ccl::providers::BlockfrostEvaluator;

let evaluator = BlockfrostEvaluator::new("proj_id", "preprod")?;
let result = bridge.quicktx().build_with(&yaml, &provider, &[sender], 0, Some(&evaluator))?;
```

Plug in any evaluator (Ogmios, …) by implementing the `TransactionEvaluator` trait (`evaluate`). To
supply units you computed yourself, call `build` directly. See `examples/evaluator.rs`.
