# Mesmo — AI Starter Pack

> **Read this entire document before generating code that uses these bindings.** It distills the offline contract, the API surface, the TxPlan YAML transaction format, error codes, signing rules, and the known limitations that AI agents most commonly get wrong. This pack is optimized for AI ingestion; the human-friendly guides are on the docsite.

## 1. What this is

Mesmo compiles the Java [Cardano Client Lib (CCL)](https://github.com/bloxbean/cardano-client-lib) into a native shared library (`libccl`) via GraalVM native-image, with four wrappers exposing the same functionality:

| Language | Package | Entry object | Naming |
|---|---|---|---|
| Python ≥ 3.8 | `pip install mesmo`, `from ccl import CclLib` | `CclLib()` | `snake_case` |
| Go ≥ 1.21 | `go get github.com/bloxbean/mesmo/wrappers/go` | `ccl.New()` → `Bridge` | `PascalCase` |
| Rust ≥ 1.70 | crate `mesmo` (import as `ccl`) | `ccl::Bridge::new()` | `snake_case`, methods return `Result` |
| JavaScript | `bun add @bloxbean/mesmo` — **Bun only, never Node.js** | `new CclBridge()` | `camelCase` |

All four have the same nine API groups — `account`, `address`, `crypto`, `tx`, `plutus`, `script`, `gov`, `wallet`, `quicktx` — the same error codes, and the same TxPlan YAML format. Semantics are identical; only naming idiom differs.

## 2. The offline contract (never violate this)

- The library makes **no network calls** and **never submits transactions**. Do not invent fetch/submit methods on it.
- Chain data (UTXOs, protocol parameters) is an **input** you pass to `quicktx.build`. Optional wrapper-side `Provider` objects (YaciProvider, BlockfrostProvider) fetch it for `quicktx.build_with` — those are plain HTTP helpers in the wrapper, not the native library.
- Submission: POST the signed CBOR hex (as bytes) to any Blockfrost-compatible `/tx/submit` with `Content-Type: application/cbor`, using the language's own HTTP client.
- Accounts are **managed handles** (ADR-0016): open once (`accounts.from_mnemonic`/`accounts.create`), then sign by handle with typed roles — the mnemonic never travels with per-operation calls, and the account object retains only the hardened account-level key, never the recovery phrase.

## 3. Core workflow (build → sign → submit)

```python
from ccl import CclLib, Network, SigningRole, YaciProvider

with CclLib() as lib, lib.accounts.create(Network.TESTNET) as account:
    address = account.info["base_address"]           # info is public data — never the mnemonic
    provider = YaciProvider()                        # or BlockfrostProvider(project_id, network="preprod")

    yaml = f"""
    version: 1.0
    transaction:
      - tx:
          from: {address}
          intents:
            - type: payment
              address: addr_test1qz...
              amounts:
                - unit: lovelace
                  quantity: "5000000"
    """
    result = lib.quicktx.build_with(yaml, provider, address)
    # or fully offline: lib.quicktx.build(yaml, utxos, protocol_params, exec_units=None, additional_signers=0)
    # result = {"tx_cbor": str, "tx_hash": str, "fee": str}

    signed = account.sign_tx(result["tx_cbor"])      # payment role; combine SigningRole flags for certs
    # submit `signed` yourself (bytes.fromhex → POST /tx/submit)
```

To restore an existing account: `lib.accounts.from_mnemonic(mnemonic, Network.TESTNET)` — the mnemonic
crosses the boundary once, there. A created account's phrase is exported once, deliberately, with
`account.export_recovery_phrase()`.

Go: `acct, _ := bridge.Accounts.Create(ccl.Testnet)` / `acct.SignTx(result.TxCbor, ccl.RolePayment)`.
JS: `using acct = bridge.accounts.create(TESTNET)` / `acct.signTx(result.tx_cbor)`.
Rust: `let acct = bridge.accounts().create(Network::Testnet)?` / `acct.sign_tx(&result.tx_cbor, SigningRole::PAYMENT)?`.
The `additional_signers` build count is **positional** in Go/Rust; keyword/options elsewhere.

**Uniform signatures:** `sign_tx(tx_cbor, roles)` has the same shape in all four languages — no
per-language argument-order quirks (the legacy mnemonic-per-call API that had them is gone).

## 4. Networks

`MAINNET = 0`, `TESTNET = 1`. Required for every key-deriving call; validated before the FFI call.

**These are CCL enum ordinals, NOT on-chain network ids** — inverted for mainnet: `Network.MAINNET == 0` but a mainnet address's on-chain `network_id` is `1`. Never feed `address.info()["network_id"]` into a `network` parameter.

## 5. Chain-data shapes

UTXOs (list; quantities are **strings**):

```json
[{ "tx_hash": "…64hex", "output_index": 0, "address": "addr_test1…",
   "amount": [ { "unit": "lovelace", "quantity": "100000000" },
               { "unit": "<policyIdHex><assetNameHex>", "quantity": "500" } ] }]
```

Protocol parameters: the standard Blockfrost-style object (`min_fee_a`, `min_fee_b`, `max_tx_size`, `key_deposit`, `pool_deposit`, `coins_per_utxo_size`, `price_mem`, `price_step`, `collateral_percent`, cost models, …). Unknown fields are ignored. Keep quantities as strings end-to-end (JS: avoid parsing them into `number`).

## 6. TxPlan YAML — transaction format

One format for all wrappers. Skeleton:

```yaml
version: 1.0
variables:            # optional ${name} substitution
  to: addr_test1...
context:              # optional; for multi-sender compose
  fee_payer: addr_test1...
transaction:
  - tx:
      from: addr_test1...        # sender / default fee payer
      intents:
        - type: payment
          address: ${to}
          amounts:
            - unit: lovelace
              quantity: "5000000"
      # inputs:  — collect_from / reference_input / script_collect_from
      # scripts: — native_script / validator
```

Verified intent shapes (field names matter — do not guess):

```yaml
# Staking (sign with payment+stake)
- type: stake_registration
  stake_address: stake_test1uq...
- type: stake_deregistration
  stake_address: stake_test1uq...
  refund_address: addr_test1qz...
- type: stake_delegation
  stake_address: stake_test1uq...
  pool_id: pool1...
- type: stake_withdrawal
  reward_address: stake_test1uq...
  amount: 0                        # full balance must be withdrawn; 0 when empty

# DRep lifecycle (sign with payment+drep); credential = gov API verification_key_hash
- type: drep_registration          # drep_update identical; drep_deregistration drops anchors
  drep_credential_hex: <56hex>
  drep_credential_type: key_hash
  anchor_url: https://example.com/meta.json
  anchor_hash: <64hex>

# Voting
- type: voting_delegation          # sign payment+stake
  address: stake_test1uq...
  drep_hex: "8102"                 # serialized DRep
  drep_type: abstain               # abstain | no_confidence | key DRep
- type: governance_proposal        # sign payment
  gov_action_hex: "8106"           # serialized GovAction (8106 = info)
  return_address: stake_test1uq...
  anchor_url: ...
  anchor_hash: <64hex>
- type: voting                     # sign payment+drep
  voter_hex: 8202581c<28bytehex>   # serialized Voter
  gov_action_tx_hash: <64hex>
  gov_action_index: 0
  vote: "YES"                      # YES | NO | ABSTAIN

# Native-script mint (sign payment; plus policy key if sig-keyed)
- type: minting
  assets: [{ name: TestNFT, value: 1 }]   # negative value burns
  receiver: addr_test1vz...
  script_hex: "820180"
  script_type: 0

# Metadata (value is a JSON string; labels are top-level keys)
- type: metadata
  metadata: '{"674": {"msg": "hello"}}'

# Treasury donation
- type: donation
  current_treasury_value: 0
  donation_amount: 1000000

# Explicit inputs (under `inputs:`, beside `intents:`)
- type: collect_from
  utxo_refs: [{ tx_hash: <64hex>, output_index: 0 }]
- type: reference_input
  refs: [{ tx_hash: <64hex>, output_index: 0 }]

# Plutus spend (inputs + validator under scripts:)
inputs:
  - type: script_collect_from
    utxo_refs: [{ tx_hash: <64hex>, output_index: 0 }]
    redeemer: { int: 0 }           # PlutusData in JSON form
    datum: { int: 42 }             # must hash to the locked output's datum_hash
scripts:
  - type: validator
    role: spend                    # or: mint (with script_minting intent + policyId)
    cbor_hex: <script cbor>
    version: v2
```

Multiple `- tx:` entries compose into one transaction (set `context.fee_payer`; supply UTXOs for every sender).

**Plutus execution units:** omit them — the embedded Scalus evaluator computes them offline. Supply `exec_units=[{"mem": …, "steps": …}]` (one per redeemer, transaction order) only to override, or pass a remote `Evaluator` for node-backed costing. For a script spend, supply the locked UTXO (with its `data_hash`) plus a separate UTXO for fee/collateral.

## 7. Signing rules (agents get this wrong most)

`account.sign_tx(tx_cbor)` adds the **payment key witness only**. Certificates need more — combine `SigningRole` flags with `|` (witnesses apply in canonical order, so combination order never matters):

| Transaction contains | roles |
|---|---|
| payment / metadata / minting / Plutus ops | `SigningRole.PAYMENT` (the default) |
| stake_registration / deregistration / delegation / withdrawal / voting_delegation | `PAYMENT \| STAKE` |
| drep_registration / drep_update / drep_deregistration / voting | `PAYMENT \| DREP` |
| governance_proposal | `PAYMENT` |
| pool operations (keyed to the account's stake key) | `PAYMENT \| STAKE` |

Missing witness ⇒ node rejects with `MissingVKeyWitnessesUTXOW`. Available roles: `PAYMENT`, `STAKE`, `DREP`, `COMMITTEE_COLD`, `COMMITTEE_HOT` (Go: `RolePayment|RoleStake`; Rust: `SigningRole::PAYMENT | SigningRole::STAKE`).

**The same table gives the fee's witness budget (`additional_signers`) — ALWAYS pass it on cert/script builds:** `additional_signers = <number of roles> − 1` (the input UTXOs already cover the payment key). So: `0` payment-only, `1` one certificate role, `2` stake+DRep in one tx. Two exceptions: a native-script spend whose only inputs sit at the script address needs the script's `sig`-key count (payment key isn't input-implied there), and each plan-level `required_signer` adds one. Undercounting → node rejects with `FeeTooSmallUTxO`; overcounting only overpays ~4,400 lovelace per witness.

## 8. API groups (complete surface)

- **accounts** (managed handles, ADR-0016): `create(network)` / `from_mnemonic(mnemonic, network, account_index=0, address_index=0)` → `Account` with `info` (base/enterprise/stake/change addresses, `drep_id`, committee ids + credentials — **never the mnemonic**), `sign_tx(tx_cbor, roles=SigningRole.PAYMENT)`, one-shot `export_recovery_phrase()` (created accounts only), idempotent `close()` (context manager / `using` / `defer` / `Drop`). One handle = one CIP-1852 payment leaf; open more handles for more address indices.
- **address**: `info(bech32)` → `{type, network_id, payment_credential_hash, …}`; `validate` (bool, never raises), `to_bytes`, `from_bytes`.
- **crypto**: `blake2b_256(hex)`, `blake2b_224(hex)`, `generate_mnemonic(word_count=24)`, `validate_mnemonic`, `sign(message_hex, sk_hex)` (32-byte seed **or** 64-byte extended key, detected by length — pass `derive_key`'s `private_key` whole, never sliced), `verify`, `derive_key(mnemonic, account_index=0, address_index=0, role="payment")` — the stateless raw-key utility (roles payment/change/stake/drep/committee_cold/committee_hot; governance roles also return CIP-105 `bech32_verification_key`/`bech32_verification_key_hash`).
- **tx**: `hash(tx_cbor)`, `to_json`, `deserialize`. ⚠️ `from_json` and `sign_with_secret_key` are **broken in the current release** — use `account.sign_tx`.
- **plutus**: `data_hash(cbor_hex)`. ⚠️ `data_to_json` / `data_from_json` are **broken in the current release** — keep PlutusData as CBOR hex.
- **script**: `native_from_json(json)` → `{policy_id, script_hash, cbor_hex}`; `hash(cbor_hex, script_type)` (0=native, 1..3=PlutusV1..V3).
- **quicktx**: `build(yaml, utxos, protocol_params, exec_units=None, additional_signers=0)`, `build_with(yaml, provider, sender, evaluator=None, additional_signers=0)` → `{tx_cbor, tx_hash, fee}` (unsigned). Go/Rust take the count positionally.

There is **no separate gov or wallet group**: governance identity (DRep id, committee ids/credentials) is on `account.info`, governance signing uses the `DREP`/`COMMITTEE_*` roles, raw governance keys come from `crypto.derive_key`, and an HD wallet is one recovery phrase with one handle per payment leaf (`address_index`).

## 9. Errors

Native errors carry a code (Python raises `CclError` with `.code`/`.message`; Go/Rust return errors; JS throws):

| Code | Meaning | Typical fix |
|---|---|---|
| -1 | general | — |
| -2 | invalid argument | check required inputs |
| -3 | serialization | malformed CBOR/JSON |
| -4 | crypto failure | check key material |
| -5 | invalid network | use enum 0–3 |
| -6 | invalid mnemonic | validate first |
| -7 | invalid address | |
| -8 | insufficient funds | UTXOs can't cover outputs + fee |
| -9 | invalid transaction | |
| -10 | tx build failure | malformed TxPlan — check intent field names against §6 |

Predicates (`validate`, `validate_mnemonic`, `verify`) return false instead of raising. Calling after `close()` raises a catchable closed-error (never reuse a closed instance).

## 10. Hard limitations — do not fight these

1. **No networking in the library.** Never generate code expecting `lib.submit(...)` or `lib.fetch_utxos(...)` on the core API.
2. **Broken functions** (GraalVM reflection gaps, all languages): `tx.from_json`, `tx.sign_with_secret_key`, `plutus.data_to_json`, `plutus.data_from_json`.
3. **JS = Bun only.** Never scaffold the JS wrapper with Node.js/`npm run` — use `bun`.
4. **Go calls are serialized** per `Bridge` (one OS thread owns the isolate). For parallelism use multiple `Bridge` instances.
5. **Version lock**: wrapper and native lib must match base semver; local dev uses `CCL_LIB_PATH` to point at a built library.
6. **Pre-1.0** against CCL `0.8.0-pre4` — APIs may change.
7. **Platforms**: no macOS Intel, no Windows ARM64; Alpine Python is source-install for now.

## 11. Doc links (for deeper retrieval)

- Full docsite dump: `/llms-full.txt` · Index: `/llms.txt`
- TxPlan reference with the complete verified intent catalog: `/reference/txplan/`
- Per-language API references: `/python/api/`, `/go/api/`, `/rust/api/`, `/js/api/`
- Caveats: `/reference/limitations/` · Platform matrix: `/reference/platforms/`
