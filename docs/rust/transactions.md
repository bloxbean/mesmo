# Building Transactions (Rust)

This guide walks the full life of a transaction: describe it in [TxPlan YAML](../quicktx.md), build it offline, sign it with the right keys, and submit it with your own HTTP client. The YAML shapes for every intent — staking, governance, pools, minting, Plutus — are cataloged in the [TxPlan reference](../quicktx.md#intent-catalog--verified-shapes); this page shows how to drive them from Rust.

## The workflow

Every transaction follows the same four steps (providers need `--features providers`):

```rust
use mesmo::{Mesmo, Network};
use mesmo::providers::YaciProvider;

let lib = Mesmo::new()?;
let provider = YaciProvider::default();   // or BlockfrostProvider, or your own impl

// 1. Describe — TxPlan YAML (see the intent catalog)
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

// 2. Build — offline; UTXO selection, fee, and change happen in the native lib
let result = lib.quicktx().build_with(&yaml, &provider, &[sender.as_str()], 0, None)?;
// (or lib.quicktx().build(&yaml, &utxos, &protocol_params, None, additional_signers) with your own chain data)

// 3. Sign — with the key roles the transaction's certificates require
let acct = lib.accounts().from_mnemonic(&mnemonic, Network::Testnet, 0, 0)?;
let signed = acct.sign_tx(&result.tx_cbor, SigningRole::PAYMENT)?;

// 4. Submit — any Blockfrost-compatible endpoint; the library never submits
// e.g. with ureq: POST {url}/tx/submit, Content-Type: application/cbor, body = hex-decoded `signed`
```

## Which keys sign what

`acct.sign_tx(&tx_cbor, SigningRole::PAYMENT)` witnesses with the payment key only. Certificates
need their own witness — combine `SigningRole` flags with `|` (witnesses apply in canonical order):

| Transaction contains | roles |
|---|---|
| Payments, metadata, minting, Plutus operations | `SigningRole::PAYMENT` |
| `stake_registration` / `stake_deregistration` / `stake_delegation` / `stake_withdrawal` / `voting_delegation` | `PAYMENT \| STAKE` |
| `drep_registration` / `drep_update` / `drep_deregistration` / `voting` | `PAYMENT \| DREP` |
| `governance_proposal` | `PAYMENT` |

The examples below assume an open handle: `let acct = lib.accounts().from_mnemonic(&mnemonic, Network::Testnet, 0, 0)?;` (with `use mesmo::accounts::SigningRole;`).
| `pool_registration` / `pool_update` / `pool_retirement` | `&["payment", "stake"]` when the pool is keyed to the account's stake key |

A missing witness is rejected by the node with `MissingVKeyWitnessesUTXOW`.
The same table gives the fee's witness budget: pass `additional_signers = len(keys) - 1` to the build (the input UTXOs already cover the payment key). For a native-script spend whose only inputs sit at the script address, pass the number of the script's `sig` keys instead.


## Worked example: register and delegate stake

Two transactions — the registration must be on-chain before the delegation:

```rust
let stake_yaml = format!(r#"
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: stake_registration
          stake_address: {stake_address}
"#);

let reg = lib.quicktx().build_with(&stake_yaml, &provider, &[sender.as_str()], 1, None)?;
let signed_reg = acct.sign_tx(&reg.tx_cbor, SigningRole::PAYMENT | SigningRole::STAKE)?;
// submit signed_reg; wait for inclusion before the next step

let deleg_yaml = format!(r#"
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: stake_delegation
          stake_address: {stake_address}
          pool_id: pool1...
"#);

let deleg = lib.quicktx().build_with(&deleg_yaml, &provider, &[sender.as_str()], 1, None)?;
let signed_deleg = acct.sign_tx(&deleg.tx_cbor, SigningRole::PAYMENT | SigningRole::STAKE)?;
```

## Worked example: DRep registration, then vote

The DRep credential comes from the stateless key-derivation utility:

```rust
let drep: serde_json::Value =
    serde_json::from_str(&lib.crypto().derive_key(&mnemonic, 0, 0, "drep")?)?;
let credential = drep["public_key_hash"].as_str().unwrap();

let drep_yaml = format!(r#"
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: drep_registration
          drep_credential_hex: {credential}
          drep_credential_type: key_hash
          anchor_url: https://example.com/meta.json
          anchor_hash: {anchor_hash}
"#);

let reg = lib.quicktx().build_with(&drep_yaml, &provider, &[sender.as_str()], 1, None)?;
let signed = acct.sign_tx(&reg.tx_cbor, SigningRole::PAYMENT | SigningRole::DREP)?;
```

To vote on a governance action, the action id is the proposal transaction's hash plus its index (a proposal you submit yourself returns its hash from `build` — `result.tx_hash`). Sign the `voting` transaction with `SigningRole::PAYMENT | SigningRole::DREP`.

## Worked example: mint under a native script

```rust
let mint_yaml = format!(r#"
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: minting
          assets:
            - name: TestNFT
              value: 1
          receiver: {receiver}
          script_hex: "820180"
          script_type: 0
"#);

let mint = lib.quicktx().build_with(&mint_yaml, &provider, &[sender.as_str()], 0, None)?;
let signed = acct.sign_tx(&mint.tx_cbor, SigningRole::PAYMENT)?;
```

An empty `ScriptAll` policy (`820180`) needs no extra signature; a `sig`-keyed policy needs the corresponding key's witness.

## Worked example: Plutus mint

By default execution units are computed **offline** (embedded Scalus evaluator) — a Plutus transaction is a normal build:

```rust
let result = lib.quicktx().build_with(&plutus_mint_yaml, &provider, &[sender.as_str()], 0, None)?;
```

To cost against a real node instead, pass an evaluator — `build_with` then runs the two-pass flow (draft → remote evaluate → rebuild):

```rust
use mesmo::providers::BlockfrostEvaluator;

let evaluator = BlockfrostEvaluator::new(&project_id, "preprod")?;
let result = lib.quicktx().build_with(&plutus_mint_yaml, &provider, &[sender.as_str()], 0, Some(&evaluator))?;
```

Or supply units yourself with the offline `build`:

```rust
use serde_json::json;

let result = lib.quicktx().build(&plutus_mint_yaml, &utxos, &params, 0,
    Some(&json!([{"mem": 2000000, "steps": 500000000}])))?;
```

For spending a script UTXO (`script_collect_from`), supply the locked UTXO (with its `data_hash`) **plus** a separate UTXO for fee/collateral in `utxos` — see the [catalog entry](../quicktx.md#plutus-scripts) and the end-to-end lock-then-spend flow in [`wrappers/rust/tests/quicktx_integration_test.rs`](../../wrappers/rust/tests/quicktx_integration_test.rs).

## Errors you'll meet

- `CCL Error -10` (`MESMO_ERROR_TX_BUILD`) — the plan didn't build: malformed YAML, wrong intent field, or a Plutus costing problem. Compare against the [catalog](../quicktx.md#intent-catalog--verified-shapes).
- `CCL Error -8` (`MESMO_ERROR_INSUFFICIENT_FUNDS`) — the supplied UTXOs can't cover outputs + fee.
- Node rejection `MissingVKeyWitnessesUTXOW` — a certificate wasn't witnessed; check the roles table above.
