# QuickTx — TxPlan (YAML) Transaction Builder

QuickTx builds unsigned Cardano transactions **fully offline** from a CCL
[**TxPlan**](https://github.com/bloxbean/cardano-client-lib) — a YAML document describing what the
transaction should do. You pass the TxPlan YAML plus the chain data the build needs (UTXOs and
protocol parameters), and get back an unsigned transaction in CBOR hex.

The whole interface is YAML: **TxPlan YAML in → YAML result out**.

## Overview

- **Single function**: `ccl_quicktx_build(thread, yaml, utxos_json, protocol_params_json, exec_units_json, additional_signers)` → returns `0` on success.
- **Result**: a YAML document with `tx_cbor` (unsigned transaction), `tx_hash`, and `fee`.
- **Fully offline**: the caller supplies UTXOs and protocol parameters — the native library makes no
  HTTP calls and never submits. (The native entry point has no provider mode; each wrapper offers a
  `build_with` convenience that fetches the chain data from a [wrapper-side provider](adr/0011-wrapper-side-chain-data-providers.md) first.)
- **Client-side chain data**: UTXOs and protocol parameters are passed as JSON (the standard CCL
  `Utxo` / `ProtocolParams` models).

### Entry point

```c
int ccl_quicktx_build(
    graal_isolatethread_t* thread,
    const char* yaml,                  // TxPlan YAML
    const char* utxos_json,            // JSON array of UTXOs
    const char* protocol_params_json,  // JSON protocol parameters
    const char* exec_units_json,       // JSON [{mem, steps}] per redeemer, or null (Plutus only; null = compute offline with the embedded Scalus evaluator)
    int additional_signers             // vkey witnesses to budget for fee estimation, beyond those the input UTXOs imply (>= 0)
);
```

### Return codes

| Code | Meaning |
|------|---------|
| `0`  | Success — retrieve the result via `ccl_get_result(thread)` |
| `-2` | Invalid argument (e.g. missing YAML or protocol parameters) |
| `-8` | Insufficient funds (UTXOs can't cover outputs + fees) |
| `-10`| Transaction build failure (e.g. malformed TxPlan) |

### Success result (YAML)

```yaml
tx_cbor: 84a400...
tx_hash: abcd1234...
fee: "173333"
```

---

## TxPlan — YAML structure

A TxPlan is a YAML document with an optional `version`, optional `variables` for substitution, and a
`transaction` list. Each list entry has a `tx` block with the sender (`from`) and a list of `intents`.

```yaml
version: 1.0

# Optional: ${name} placeholders are substituted before the plan is parsed.
variables:
  to: addr_test1...
  amount: "5000000"

transaction:
  - tx:
      from: addr_test1...            # sender / default fee payer
      intents:
        - type: payment
          address: ${to}
          amounts:
            - unit: lovelace
              quantity: ${amount}
```

Multiple entries in `transaction` are **composed** into a single transaction (each `tx` may have a
different `from`). The `tx` block also accepts context such as a fee payer and a validity interval;
those fields follow CCL's TxPlan serialization (see the reference link above).

### Intents

Each intent has a `type` discriminator. The full set supported by CCL's TxPlan:

| `type` | Purpose |
|--------|---------|
| `payment` | Pay ADA / native tokens to an address |
| `minting` | Mint/burn with a native script |
| `metadata` | Attach transaction metadata |
| `donation` | Treasury donation |
| `stake_registration` | Register a stake address |
| `stake_deregistration` | Deregister a stake address |
| `stake_delegation` | Delegate to a stake pool |
| `stake_withdrawal` | Withdraw staking rewards |
| `drep_registration` / `drep_deregistration` / `drep_update` | DRep lifecycle |
| `voting` | Cast a governance vote |
| `voting_delegation` | Delegate voting power to a DRep |
| `governance_proposal` | Submit a governance action |
| `pool_registration` / `pool_update` / `pool_retirement` | Stake-pool lifecycle |
| `collect_from` | Explicitly select input UTXOs |
| `reference_input` | Add read-only reference inputs |
| `native_script` | Attach a native script |
| `script_collect_from` / `script_minting` / `validator` | Plutus script operations |

> The exact YAML fields for each intent come from CCL's TxPlan serialization. This bridge passes the
> YAML through unchanged, so the authoritative field reference is the CCL `quicktx` module
> (`intent/*Intent.java` and the TxPlan tests at `v0.8.0-pre4`). Known-good shapes for every intent
> are cataloged in [Intent catalog — verified shapes](#intent-catalog--verified-shapes) below.

> **Plutus script transactions** build fully offline with no extra input: when `exec_units_json` is
> null, the native library computes the redeemers' **execution units** itself with the embedded
> [Scalus](https://scalus.org) UPLC evaluator (see [ADR-0013](adr/0013-transaction-evaluators.md)).
> To supply your own units instead — from Ogmios, Blockfrost, Aiken, or any other evaluator — pass
> `exec_units_json`, a JSON array of `[{mem, steps}]`, one per redeemer in transaction order; the
> bridge then wires CCL's `StaticTransactionEvaluator` to stamp them on without running the script.
> Explicit units always take precedence over the Scalus default.

> **Witness budgeting is caller-supplied.** `additional_signers` budgets vkey witnesses for fee estimation, **beyond those the input UTXOs imply** (one per sender). You know how many keys will sign: `0` for a plain payment, `1` for a stake or DRep certificate (`payment`+`stake` signing), `2` for both in one tx, the number of `sig` keys for a native-script spend, plus one per plan-level required signer. Undercounting yields a fee the node rejects with `FeeTooSmallUTxO`; overcounting only overpays (~4,400 lovelace per extra witness).

---

## Chain data (caller-supplied)

### UTXO format

`utxos_json` is a JSON array in the standard Blockfrost/Koios/DevKit shape:

```json
[
  {
    "tx_hash": "aaaa...64hex",
    "output_index": 0,
    "address": "addr_test1...",
    "amount": [
      { "unit": "lovelace", "quantity": "100000000" },
      { "unit": "policy_hex+asset_name_hex", "quantity": "500" }
    ]
  }
]
```

### Protocol parameters

`protocol_params_json` is a JSON object in the standard protocol-parameters shape (`min_fee_a`,
`min_fee_b`, `key_deposit`, `pool_deposit`, `coins_per_utxo_size`, the Conway governance deposits,
etc.). The CCL `ProtocolParams` model deserializes it directly.

---

## Examples

### 1. Simple ADA payment

```yaml
version: 1.0
transaction:
  - tx:
      from: addr_test1qp...
      intents:
        - type: payment
          address: addr_test1qz...
          amounts:
            - unit: lovelace
              quantity: "5000000"
```

### 2. Multiple payments (one sender)

```yaml
version: 1.0
transaction:
  - tx:
      from: addr_test1qp...
      intents:
        - type: payment
          address: addr_test1_receiver1...
          amounts:
            - unit: lovelace
              quantity: "5000000"
        - type: payment
          address: addr_test1_receiver2...
          amounts:
            - unit: lovelace
              quantity: "3000000"
```

### 3. Variable substitution

```yaml
version: 1.0
variables:
  to: addr_test1qz...
  amount: "4000000"
transaction:
  - tx:
      from: addr_test1qp...
      intents:
        - type: payment
          address: ${to}
          amounts:
            - unit: lovelace
              quantity: ${amount}
```

### 4. Payment with metadata

The `metadata` intent's value is a **scalar string** that the deserializer auto-detects — pass it as
a JSON string (it may also be CBOR hex). Labels are the top-level keys:

```yaml
version: 1.0
transaction:
  - tx:
      from: addr_test1qp...
      intents:
        - type: payment
          address: addr_test1qz...
          amounts:
            - unit: lovelace
              quantity: "2000000"
        - type: metadata
          metadata: '{"674": {"msg": "Hello from Cardano Client Bindings"}}'
```

### 5. Plutus mint (with caller-supplied execution units)

A script intent goes under `scripts:` (the validator) with the operation in `intents:`. Execution
units are optional — omitted, the embedded Scalus evaluator computes them offline; this example
supplies them explicitly, in which case the bridge stamps them on without running the script.

```yaml
version: 1.0
transaction:
  - tx:
      from: addr_test1qp...
      intents:
        - type: script_minting
          policyId: 793f8c8cffba081b2a56462fc219cc8fe652d6a338b62c7b134876e7
          assets:
            - name: TestToken
              value: 1
          receiver: addr_test1qp...
          redeemer:
            int: 0
      scripts:
        - type: validator
          role: mint
          cbor_hex: 4e4d01000033222220051200120011
          version: v2
```

…built with `exec_units_json = [{"mem": 2000000, "steps": 500000000}]` (one entry for the single
mint redeemer), or with `exec_units_json = null` to let Scalus compute the units.

### 6. Compose (multiple senders into one transaction)

The `transaction` list can hold more than one `tx`, each with its own `from`; they are composed into
a single transaction. The `context.fee_payer` pays the fee. Supply UTXOs for every sender.

```yaml
version: 1.0
context:
  fee_payer: addr_test1_sender1...
transaction:
  - tx:
      from: addr_test1_sender1...
      intents:
        - type: payment
          address: addr_test1_receiver...
          amounts:
            - unit: lovelace
              quantity: "5000000"
  - tx:
      from: addr_test1_sender2...
      intents:
        - type: payment
          address: addr_test1_receiver...
          amounts:
            - unit: lovelace
              quantity: "3000000"
```

---

## Intent catalog — verified shapes

The shapes below are taken from the repository's integration-test fixtures
(`test-fixtures/quicktx-intents/`), which every wrapper submits against a real devnet in CI — they
are known-good. Each snippet shows the `intents:` (and where relevant `inputs:`/`scripts:`) block;
the surrounding skeleton (`version`, `context.fee_payer`, `tx.from`, `tx.change_address`) is the
same as in the examples above. The **Sign with** column lists the signing roles for the managed
account's `sign_tx` (combine `SigningRole` flags with `|`) — certificates must be witnessed by
their key or the node rejects the transaction with `MissingVKeyWitnessesUTXOW`.

### Staking

| Intent | Sign with |
|---|---|
| `stake_registration`, `stake_deregistration`, `stake_delegation`, `stake_withdrawal` | `payment`, `stake` |

```yaml
intents:
  - type: stake_registration
    stake_address: stake_test1uq...

  - type: stake_deregistration
    stake_address: stake_test1uq...
    refund_address: addr_test1qz...     # receives the key deposit back

  - type: stake_delegation
    stake_address: stake_test1uq...
    pool_id: pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy

  - type: stake_withdrawal
    reward_address: stake_test1uq...
    amount: 0                            # the full reward balance must be withdrawn; 0 when empty
```

(One intent per transaction in the fixtures; registration must be on-chain before delegation/withdrawal. Conway requires the stake address to be vote-delegated before a withdrawal.)

### Governance — DRep lifecycle

| Intent | Sign with |
|---|---|
| `drep_registration`, `drep_update`, `drep_deregistration` | `payment`, `drep` |

```yaml
intents:
  - type: drep_registration
    drep_credential_hex: a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa  # verification_key_hash from the gov API
    drep_credential_type: key_hash
    anchor_url: https://example.com/meta.json
    anchor_hash: aaaa...64hex

  - type: drep_update
    drep_credential_hex: a5b4...
    drep_credential_type: key_hash
    anchor_url: https://example.com/meta.json
    anchor_hash: aaaa...64hex

  - type: drep_deregistration
    drep_credential_hex: a5b4...
    drep_credential_type: key_hash
```

The credential hex is the DRep `public_key_hash` from the stateless key utility (`crypto.derive_key(mnemonic, role="drep")`).

### Governance — voting

| Intent | Sign with |
|---|---|
| `voting_delegation` | `payment`, `stake` |
| `governance_proposal` | `payment` |
| `voting` | `payment`, `drep` |

```yaml
intents:
  # Delegate a stake address's voting power to a DRep (or abstain / no-confidence):
  - type: voting_delegation
    address: stake_test1uq...
    drep_hex: "8102"          # serialized DRep; for a key DRep use its credential form
    drep_type: abstain        # abstain | no_confidence | key DRep

  # Submit a governance action (the return_address gets the deposit back):
  - type: governance_proposal
    gov_action_hex: "8106"    # serialized GovAction (8106 = info action)
    return_address: stake_test1uq...
    anchor_url: https://example.com/meta.json
    anchor_hash: aaaa...64hex

  # Vote on a governance action; the action id is the proposal's tx hash + index:
  - type: voting
    voter_hex: 8202581ca5b4...   # serialized Voter (DRep key-hash form)
    gov_action_tx_hash: 1274...64hex
    gov_action_index: 0
    vote: "YES"                  # YES | NO | ABSTAIN
    anchor_url: https://example.com/meta.json
    anchor_hash: aaaa...64hex
```

### Stake pools

| Intent | Sign with |
|---|---|
| `pool_registration`, `pool_update`, `pool_retirement` | `payment`, `stake` (pool keyed to the account's stake key; a real pool uses its operator cold key) |

```yaml
intents:
  - type: pool_registration
    update: false
    is_update: false
    pool_registration:
      type: POOL_REGISTRATION
      operator: 32c7...28hex            # pool operator key hash
      vrfKeyHash: b95a...64hex
      pledge: 100000000
      cost: 340000000
      margin: { numerator: 1, denominator: 100 }
      rewardAccount: e032...            # reward account (header byte + stake key hash)
      poolOwners:
        - 32c7...28hex
      relays:
        - relay_type: single_host_addr
          port: 3001

  # pool_update is identical with `update: true` / `is_update: true`

  - type: pool_retirement
    pool_id: pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy
    retirement_epoch: 500
```

### Treasury donation

```yaml
intents:
  - type: donation
    current_treasury_value: 0     # must match the ledger's current value at submission
    donation_amount: 1000000
```

### Explicit inputs

`inputs:` sits alongside `intents:` in the `tx` block:

```yaml
inputs:
  # Spend exactly these UTXOs instead of automatic selection:
  - type: collect_from
    utxo_refs:
      - tx_hash: aaaa...64hex
        output_index: 0

  # Read-only reference inputs (CIP-31):
  - type: reference_input
    refs:
      - tx_hash: cccc...64hex
        output_index: 0
```

### Native scripts

```yaml
# Mint/burn under a native script policy:
intents:
  - type: minting
    assets:
      - name: TestNFT
        value: 1                 # negative to burn
    receiver: addr_test1vz...
    script_hex: "820180"         # serialized native script (empty ScriptAll here)
    script_type: 0

# Attach a native script witness to the transaction:
scripts:
  - type: native_script
    script_hex: 8201818200581ca101...
```

### Plutus scripts

Lock at a script address (a plain payment with a datum hash):

```yaml
intents:
  - type: payment
    address: addr_test1wp...     # script address
    amounts:
      - unit: lovelace
        quantity: "10000000"
    datum_hash: 9e11...64hex
```

Spend a script UTXO (`script_collect_from` input + the validator under `scripts:`):

```yaml
inputs:
  - type: script_collect_from
    utxo_refs:
      - tx_hash: bbbb...64hex     # the locked UTXO
        output_index: 0
    redeemer:
      int: 0                      # PlutusData in JSON form
    datum:
      int: 42                     # must hash to the locked output's datum_hash
intents:
  - type: payment
    address: addr_test1vz...
    amounts:
      - unit: lovelace
        quantity: "5000000"
scripts:
  - type: validator
    role: spend
    cbor_hex: 4e4d01000033222220051200120011
    version: v2
```

Mint under a Plutus policy (`script_minting`, shown in [example 5](#5-plutus-mint-with-caller-supplied-execution-units)). For any Plutus transaction, supply the UTXO being spent (with its `data_hash`) **plus** a separate UTXO for fee/collateral, and either pass `exec_units` or let the offline Scalus evaluator compute them.

---

## Using it from the wrappers

Each wrapper exposes a thin `build(yaml, utxos, protocolParams, execUnits?, additionalSigners)` that
marshals the chain data to JSON, calls `ccl_quicktx_build`, and parses the YAML result — plus a
`build_with(yaml, provider, senders, additionalSigners, evaluator?)` convenience that fetches the
chain data from a provider first (see
each wrapper's providers guide). The result is an object/dict/struct with `tx_cbor`, `tx_hash`, and
`fee`. Both return an **unsigned** transaction — sign `tx_cbor` with the account sign API, then
submit it yourself.

> **Signing stake/governance transactions.** `sign_tx` adds only the **payment** key. Certificates
> in stake registration/deregistration/delegation, reward withdrawal, and DRep/vote operations must
> also be witnessed by the **stake** (or **DRep**) key, or the node rejects the tx with
> `MissingVKeyWitnessesUTXOW`. Sign through a managed account handle with the roles you need,
> e.g. `SigningRole.PAYMENT | SigningRole.STAKE` or `PAYMENT | DREP`
> (roles: `PAYMENT`, `STAKE`, `DREP`, `COMMITTEE_COLD`, `COMMITTEE_HOT`).

### Python

```python
from ccl import CclLib, Network, SigningRole

lib = CclLib()
# additional_signers: witnesses beyond the input-implied payment key(s) — here 1 (a stake cert)
result = lib.quicktx.build(txplan_yaml, utxos, protocol_params, additional_signers=1)
with lib.accounts.from_mnemonic(mnemonic, Network.TESTNET) as acct:
    signed = acct.sign_tx(result["tx_cbor"], SigningRole.PAYMENT | SigningRole.STAKE)
```

### JavaScript (Bun)

```javascript
import { CclBridge, TESTNET, SigningRole } from '@bloxbean/cardano-client-lib';

const bridge = new CclBridge();
const result = bridge.quicktx.build(txplanYaml, utxos, protocolParams, null, 1);
using acct = bridge.accounts.fromMnemonic(mnemonic, TESTNET);
const signed = acct.signTx(result.tx_cbor, SigningRole.PAYMENT | SigningRole.STAKE);
```

### Go

```go
bridge, _ := ccl.New()
defer bridge.Close()

result, _ := bridge.QuickTx.Build(txplanYaml, utxos, protocolParams, 1)
acct, _ := bridge.Accounts.FromMnemonic(mnemonic, ccl.Testnet, 0, 0)
defer acct.Close()
signed, _ := acct.SignTx(result.TxCbor, ccl.RolePayment|ccl.RoleStake)
```

### Rust

```rust
let bridge = ccl::Bridge::new().unwrap();

use ccl::accounts::SigningRole;

let result = bridge.quicktx().build(&txplan_yaml, &utxos, &protocol_params, None, 1).unwrap();
let acct = bridge.accounts()
    .from_mnemonic(&mnemonic, ccl::Network::Testnet, 0, 0)
    .unwrap();
let signed = acct
    .sign_tx(&result.tx_cbor, SigningRole::PAYMENT | SigningRole::STAKE)
    .unwrap();
```

See each wrapper's `examples/transaction.*` for a complete build-and-sign program.
