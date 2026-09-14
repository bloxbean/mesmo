# Providers & Evaluators (Rust)

The native library is offline by design — it never makes a network call. The optional `providers` module contains small HTTP conveniences for feeding `quicktx().build_with` with chain data. If you already have UTXOs and protocol parameters from your own infrastructure, you don't need it: call `quicktx().build` directly and skip the feature.

```toml
[dependencies]
cardano-client-lib = { version = "0.1", features = ["providers"] }
```

```rust
use ccl::providers::{ChainDataProvider, YaciProvider, BlockfrostProvider, BlockfrostEvaluator};
```

## ChainDataProvider

```rust
pub trait ChainDataProvider {
    fn utxos(&self, address: &str) -> Result<serde_json::Value>;  // ALL utxos at the address; selection happens in the native lib
    fn protocol_params(&self) -> Result<serde_json::Value>;
}
```

Implement the trait to plug in Koios, Ogmios, or your own indexer.

### YaciProvider

Talks to a local [Yaci DevKit](https://github.com/bloxbean/yaci-devkit) devnet (or any yaci-store instance exposing the Blockfrost-style REST API).

```rust
impl YaciProvider {
    pub const DEFAULT_URL: &'static str = "http://localhost:10000/local-cluster/api";
    pub fn new(base_url: &str) -> Self;
}
impl Default for YaciProvider;  // = new(DEFAULT_URL)
```

```rust
let provider = YaciProvider::default();
let result = bridge.quicktx().build_with(&yaml, &provider, &[sender.as_str()], 0, None)?;
```

### BlockfrostProvider

```rust
impl BlockfrostProvider {
    pub fn new(project_id: &str, network: &str) -> Result<Self>;   // "mainnet" | "preprod" | "preview"
    pub fn with_url(project_id: &str, base_url: &str) -> Self;     // self-hosted / custom endpoint
}
```

- `new` returns an error for an unknown network name; use `with_url` for custom endpoints.
- UTXO fetches paginate (100 per page) until exhausted, and each UTXO gets the owning `address` injected (Blockfrost omits it, but the builder needs it).
- Protocol parameters come from `/epochs/latest/parameters`; the native library ignores the extra Blockfrost fields.

```rust
let provider = BlockfrostProvider::new(&std::env::var("BF_PROJECT_ID")?, "preprod")?;
let result = bridge.quicktx().build_with(&yaml, &provider, &[sender.as_str()], 0, None)?;
```

## Evaluators

For Plutus transactions, execution units are computed **offline by default** — the native library embeds the Scalus UPLC evaluator, so no evaluator is needed for a script transaction to build. Use a remote evaluator when you want node-backed costing instead:

```rust
pub trait TransactionEvaluator {
    fn evaluate(&self, tx_cbor: &str, utxos: &serde_json::Value) -> Result<serde_json::Value>;
    // returns [{mem, steps}] in redeemer order
}
```

### BlockfrostEvaluator

```rust
impl BlockfrostEvaluator {
    pub fn new(project_id: &str, network: &str) -> Result<Self>;
    pub fn with_url(project_id: &str, base_url: &str) -> Self;
}
```

POSTs the draft transaction CBOR to `/utils/txs/evaluate` (Blockfrost / Ogmios-compatible) and parses the response into `[{mem, steps}]` in Cardano redeemer order (`spend < mint < cert < reward < vote < propose`). Both the purpose-keyed map form and the Ogmios v6 list form are handled.

```rust
let evaluator = BlockfrostEvaluator::new(&project_id, "preprod")?;
let result = bridge.quicktx().build_with(&yaml, &provider, &[sender.as_str()], 0, Some(&evaluator))?;
// two-pass: draft build (offline units) → remote evaluate → rebuild with returned units
```

## Numbers

Chain data flows through `serde_json::Value`, which keeps JSON integers exact (`i64`/`u64` — no float truncation), and the canonical CCL models carry quantities as **strings** (`"quantity": "5000000"`) anyway. Passing provider results straight into `build`/`build_with` is exact.

## Timeouts & errors

HTTP failures surface as `CclError { code: CCL_ERROR_GENERAL, message: "<context>: <cause>" }`.

> **Caveat:** the provider HTTP calls currently set no explicit request timeout, so a hung endpoint can block the calling thread indefinitely. If your application can't tolerate that, wrap provider calls in your own timeout mechanism or implement the `ChainDataProvider` trait over an HTTP client you configure.
