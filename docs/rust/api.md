# Rust API Reference

```rust
use ccl::{Bridge, Network, CclError, Result};
```

Most methods return `ccl::Result<String>` where the string is either a JSON document (parse with `serde_json`) or a bare hex/bech32 value — noted per method below.

## Bridge

```rust
impl Bridge {
    pub fn new() -> Result<Self>;
    pub fn version(&self) -> Result<String>;

    pub fn accounts(&self) -> AccountsApi<'_>;
    pub fn address(&self)  -> AddressApi<'_>;
    pub fn crypto(&self)   -> CryptoApi<'_>;
    pub fn tx(&self)       -> TxApi<'_>;
    pub fn plutus(&self)   -> PlutusApi<'_>;
    pub fn script(&self)   -> ScriptApi<'_>;
    pub fn quicktx(&self)  -> QuickTxApi<'_>;
}
```

`Bridge::new()` creates a GraalVM isolate and verifies the native library version matches the crate.

**Lifecycle.** Teardown is RAII: `Drop` tears down the isolate. The namespace handles (`AddressApi<'_>` etc.) borrow the bridge, so the borrow checker statically prevents use-after-free; managed `Account`s are owned values that a bridge drop hard-invalidates (typed -11 errors).

**Threading.** `Bridge` is **`!Send` and `!Sync`** — moving it to another thread is a compile error. The GraalVM isolate thread is bound to the OS thread that created it; create one `Bridge` per thread.

## Networks

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Network { Mainnet, Testnet }

impl Network { pub fn as_i32(self) -> i32 }  // Mainnet=0, Testnet=1
```

> **Gotcha:** the ordinals are CCL enum values, **not** Cardano's on-chain network id — the two are inverted for mainnet/testnet (`Mainnet` = 0, but a mainnet address's on-chain `network_id` is `1`). The `network_id` field returned by `address().info()` is the genuine on-chain value; never map it back to a `Network`.

## Errors

```rust
pub struct CclError { pub code: i32, pub message: String }  // Display: "CCL Error {code}: {message}"
pub type Result<T> = std::result::Result<T, CclError>;
```

Error codes (`ccl::error_codes`):

| Constant | Code | Meaning |
|---|---|---|
| `CCL_ERROR_GENERAL` | -1 | Unspecified failure (also: version mismatch, HTTP provider errors) |
| `CCL_ERROR_INVALID_ARGUMENT` | -2 | Bad argument (also: interior NUL in a string) |
| `CCL_ERROR_SERIALIZATION` | -3 | (De)serialization failure |
| `CCL_ERROR_CRYPTO` | -4 | Cryptographic failure |
| `CCL_ERROR_INVALID_NETWORK` | -5 | Bad network value |
| `CCL_ERROR_INVALID_MNEMONIC` | -6 | Bad mnemonic |
| `CCL_ERROR_INVALID_ADDRESS` | -7 | Bad address |
| `CCL_ERROR_INSUFFICIENT_FUNDS` | -8 | UTXOs can't cover outputs + fee |
| `CCL_ERROR_INVALID_TRANSACTION` | -9 | Bad transaction |
| `CCL_ERROR_TX_BUILD` | -10 | TxPlan build failure (most common `quicktx().build` error — usually a malformed plan) |
| `CCL_ERROR_INVALID_HANDLE` | -11 | Unknown or closed account handle, or a Bridge that was dropped |

Predicate methods (`validate`, `validate_mnemonic`, `verify`) return `bool` and never error.

## bridge.accounts() — managed accounts

Handle-based accounts (ADR-0016): open once, then operate without the mnemonic — the only
account API. The account object retains only the hardened account-level key
(`m/1852'/1815'/account'`) — never your recovery phrase.

```rust
use ccl::accounts::SigningRole;

let acct = bridge.accounts().from_mnemonic(&mnemonic, Network::Testnet, 0, 0)?;
let info = acct.info()?;                          // serde_json::Value — never the mnemonic
let signed = acct.sign_tx(&tx_cbor, SigningRole::PAYMENT | SigningRole::STAKE)?;
// Drop closes the handle; acct.close() is the explicit, idempotent form
```

- The `Account` is an **owned value**, not a borrow: it can live in the same struct as its
  `Bridge`. Dropping the `Bridge` hard-invalidates outstanding accounts — their calls fail with
  `CCL_ERROR_INVALID_HANDLE` (-11), never by touching a dead isolate. Like the `Bridge`, an
  `Account` is `!Send`.
- `create(network)` — fresh 24-word account; **no secret in the result**. Retrieve the phrase once,
  deliberately, with `export_recovery_phrase()` — a second call fails, as does export on a
  mnemonic-opened account.
- `sign_tx(&tx_cbor, roles)` — typed `SigningRole` combined with `|`; witnesses apply in canonical
  order. An empty mask is rejected.
- The `Debug` representation shows only the handle.
- `info()` returns public data only: the base/enterprise/stake/change addresses, network and
  derivation indices, `drep_id`, and the committee identifiers (`committee_cold_id`/`committee_hot_id`,
  bech32, plus `committee_cold_credential`/`committee_hot_credential` — hex blake2b-224
  verification-key hashes, as used in committee certificates).

An account is bound to **one CIP-1852 payment leaf** (`m/1852'/1815'/account'/0/address_index`): one handle, one payment address — open further accounts for further address indices. The stake/DRep/committee keys sit at their standard role indices *independent of* `address_index`, so accounts at different address indices of one account index **share a single stake/DRep identity**.

## bridge.address()

```rust
pub fn info(&self, bech32: &str) -> Result<String>;       // JSON
pub fn validate(&self, bech32: &str) -> bool;
pub fn to_bytes(&self, bech32: &str) -> Result<String>;   // hex
pub fn from_bytes(&self, hex_bytes: &str) -> Result<String>; // bech32
```

`info` JSON fields: `type` (`"Base"`, `"Enterprise"`, `"Pointer"`, `"Reward"`), `network_id` (on-chain: 1 = mainnet), `payment_credential_hash`, `delegation_credential_hash`, `is_pubkey_payment`, `is_script_payment`.

## bridge.crypto()

```rust
pub fn blake2b_256(&self, data_hex: &str) -> Result<String>;
pub fn blake2b_224(&self, data_hex: &str) -> Result<String>;
pub fn generate_mnemonic(&self, word_count: i32) -> Result<String>;  // 12 or 24
pub fn validate_mnemonic(&self, mnemonic: &str) -> bool;
pub fn sign(&self, message_hex: &str, sk_hex: &str) -> Result<String>;  // Ed25519; 32-byte seed or 64-byte extended key (by length)
pub fn verify(&self, signature_hex: &str, message_hex: &str, pk_hex: &str) -> bool;
pub fn derive_key(&self, mnemonic: &str, account_index: i32, address_index: i32, role: &str) -> Result<String>;
```

`derive_key` is the stateless CIP-1852 "raw key material" utility — `role` is one of `"payment"`,
`"change"`, `"stake"`, `"drep"`, `"committee_cold"`, `"committee_hot"`; it returns the JSON
`{"path","private_key","public_key","public_key_hash"}`, plus — for the governance roles — the
CIP-105 bech32 encodings `bech32_verification_key`/`bech32_verification_key_hash` (what
cardano-cli and GovTool accept for registration). Key derivation is network-independent.
Prefer managed accounts for signing — handles never expose key bytes.

```rust
let digest = bridge.crypto().blake2b_256("48656c6c6f")?; // "Hello"
let key: serde_json::Value =
    serde_json::from_str(&bridge.crypto().derive_key(&mnemonic, 0, 0, "payment")?)?;
let sk = key["private_key"].as_str().unwrap();
let sig = bridge.crypto().sign(msg_hex, &sk)?;           // pass the extended key whole
```

## bridge.tx()

```rust
pub fn hash(&self, tx_cbor_hex: &str) -> Result<String>;   // 64-hex tx id
pub fn sign_with_secret_key(&self, tx_cbor_hex: &str, sk_cbor_hex: &str) -> Result<String>;
pub fn to_json(&self, tx_cbor_hex: &str) -> Result<String>;      // JSON
pub fn from_json(&self, tx_json: &str) -> Result<String>;        // CBOR hex
pub fn deserialize(&self, tx_cbor_hex: &str) -> Result<String>;  // JSON
```

`to_json`/`deserialize` return JSON with a `body` object (inputs/outputs/fee). `sign_with_secret_key` expects a CBOR-encoded secret key, not raw key hex — for mnemonic-based accounts prefer `account().sign_tx`.

## bridge.plutus()

```rust
pub fn data_hash(&self, datum_cbor_hex: &str) -> Result<String>;   // 64 hex chars
pub fn data_to_json(&self, cbor_hex: &str) -> Result<String>;
pub fn data_from_json(&self, json: &str) -> Result<String>;        // CBOR hex
```

```rust
let hash = bridge.plutus().data_hash("182a")?;  // hash of PlutusData int 42
```

## bridge.script()

```rust
pub fn native_from_json(&self, json: &str) -> Result<String>;  // JSON: { policy_id, script_hash, cbor_hex }
pub fn hash(&self, script_cbor_hex: &str, script_type: i32) -> Result<String>;  // 56 hex chars
```

`script_type`: `0` native, `1` PlutusV1, `2` PlutusV2, `3` PlutusV3.

```rust
let script_json = format!(r#"{{"type":"sig","keyHash":"{key_hash}"}}"#);
let parsed: serde_json::Value = serde_json::from_str(&bridge.script().native_from_json(&script_json)?)?;
// parsed["policy_id"], parsed["script_hash"], parsed["cbor_hex"]
```

## Governance identity and HD-wallet flows

There is no separate gov/wallet API. Governance *identity* (DRep id, committee ids and
credentials) is public data on `acct.info()`; governance *signing* uses `sign_tx` with the
`DREP`/`COMMITTEE_*` roles; raw governance key material comes from `crypto().derive_key`.
An HD wallet is one recovery phrase with one managed handle per CIP-1852 payment leaf — pass
`address_index` to `accounts().from_mnemonic` to enumerate addresses.

## bridge.quicktx()

```rust
#[derive(Debug, serde::Deserialize)]
pub struct TxResult { pub tx_cbor: String, pub tx_hash: String, pub fee: String }

pub fn build(&self, yaml: &str, utxos: &serde_json::Value, protocol_params: &serde_json::Value,
             exec_units: Option<&serde_json::Value>, additional_signers: u32) -> Result<TxResult>;

// with `--features providers`:
pub fn build_with(&self, yaml: &str, provider: &dyn ChainDataProvider, senders: &[&str],
                  additional_signers: u32, evaluator: Option<&dyn TransactionEvaluator>) -> Result<TxResult>;
```

- **`build`** is fully offline: you describe the transaction as [TxPlan YAML](../quicktx.md) and supply the chain data yourself as `serde_json::Value`s. UTXO selection, fee calculation, and change handling happen inside the native library. It never submits — sign the returned `tx_cbor` and submit with any HTTP client.
- `utxos` is a JSON array of CCL `Utxo` objects: `{tx_hash, output_index, address, amount: [{unit, quantity}]}`. `unit` is `"lovelace"` or `policyId + assetNameHex`. Quantities are best passed as **strings** (`"quantity": "5000000"`), matching the canonical CCL model.
- `protocol_params` is the CCL `ProtocolParams` JSON model; unknown fields are ignored.
- `exec_units` — for Plutus transactions, `Some(&json!([{"mem": ..., "steps": ...}]))`, one entry per redeemer in transaction order. Pass `None` to let the native library compute them **offline** with the embedded Scalus evaluator.
- `additional_signers` budgets vkey witnesses for fee estimation, **beyond those the input UTXOs imply** (one per sender). You know how many keys will sign: `0` for a plain payment, `1` for a stake or DRep certificate, `2` for both in one tx, the number of `sig` keys for a native-script spend, plus one per plan-level required signer. Undercounting yields a fee the node rejects with `FeeTooSmallUTxO`; overcounting only overpays (~4,400 lovelace per extra witness).
- **`build_with`** fetches each sender's UTXOs from a [provider](providers.md) — merged and de-duplicated by `(tx_hash, output_index)` — plus protocol parameters, then builds. With multiple senders, TxPlan's `context.fee_payer` decides who pays the fee. With an evaluator it runs two passes: draft build → remote evaluation → rebuild with the returned units.

```rust
use serde_json::json;

let result = bridge.quicktx().build(&yaml, &utxos, &params, None)?;

let plutus = bridge.quicktx().build(&yaml, &utxos, &params,
    Some(&json!([{"mem": 2000000, "steps": 500000000}])))?;
```
