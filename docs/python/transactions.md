# Building Transactions (Python)

This guide walks the full life of a transaction: describe it in [TxPlan YAML](../quicktx.md), build it offline, sign it with the right keys, and submit it with your own HTTP client. The YAML shapes for every intent — staking, governance, pools, minting, Plutus — are cataloged in the [TxPlan reference](../quicktx.md#intent-catalog--verified-shapes); this page shows how to drive them from Python.

## The workflow

Every transaction follows the same four steps:

```python
from mesmo import Mesmo, Network, SigningRole, YaciProvider
import urllib.request

with Mesmo() as lib:
    provider = YaciProvider()   # or BlockfrostProvider, or your own

    # 1. Describe — TxPlan YAML (see the intent catalog)
    yaml = f"""
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
    """

    # 2. Build — offline; UTXO selection, fee, and change happen in the native lib
    result = lib.quicktx.build_with(yaml, provider, [sender])
    # (or lib.quicktx.build(yaml, utxos, protocol_params) with your own chain data)

    # 3. Sign — with the key roles the transaction's certificates require
    with lib.accounts.from_mnemonic(mnemonic, Network.TESTNET) as acct:
        signed = acct.sign_tx(result["tx_cbor"])

    # 4. Submit — any Blockfrost-compatible endpoint; the library never submits
    req = urllib.request.Request(f"{submit_url}/tx/submit", method="POST",
                                 data=bytes.fromhex(signed),
                                 headers={"Content-Type": "application/cbor"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        tx_hash = resp.read().decode().strip().strip('"')
```

## Which keys sign what

`acct.sign_tx(tx_cbor)` witnesses with the payment key only. Certificates need their own
witness — combine `SigningRole` flags with `|` (witnesses apply in canonical order):

| Transaction contains | roles |
|---|---|
| Payments, metadata, minting, Plutus operations | `SigningRole.PAYMENT` (the default) |
| `stake_registration` / `stake_deregistration` / `stake_delegation` / `stake_withdrawal` / `voting_delegation` | `PAYMENT \| STAKE` |
| `drep_registration` / `drep_update` / `drep_deregistration` / `voting` | `PAYMENT \| DREP` |
| `governance_proposal` | `PAYMENT` |
| `pool_registration` / `pool_update` / `pool_retirement` | `["payment", "stake"]` when the pool is keyed to the account's stake key |

A missing witness is rejected by the node with `MissingVKeyWitnessesUTXOW`.

The examples below assume an open handle: `acct = lib.accounts.from_mnemonic(mnemonic, Network.TESTNET)` (with `from mesmo import SigningRole`).
The same table gives the fee's witness budget: pass `additional_signers = len(keys) - 1` to the build (the input UTXOs already cover the payment key). For a native-script spend whose only inputs sit at the script address, pass the number of the script's `sig` keys instead.


## Worked example: register and delegate stake

Two transactions — the registration must be on-chain before the delegation:

```python
stake_yaml = f"""
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: stake_registration
          stake_address: {account["stake_address"]}
"""
reg = lib.quicktx.build_with(stake_yaml, provider, [sender], additional_signers=1)
signed_reg = acct.sign_tx(reg["tx_cbor"], SigningRole.PAYMENT | SigningRole.STAKE)
# submit signed_reg; wait for inclusion before the next step

deleg_yaml = f"""
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: stake_delegation
          stake_address: {account["stake_address"]}
          pool_id: pool1...
"""
deleg = lib.quicktx.build_with(deleg_yaml, provider, [sender], additional_signers=1)
signed_deleg = acct.sign_tx(deleg["tx_cbor"], SigningRole.PAYMENT | SigningRole.STAKE)
```

## Worked example: DRep registration, then vote

The DRep credential is derivable with the stateless key utility (`account.info["drep_id"]`
carries the bech32 id; the raw credential hash comes from `crypto.derive_key`):

```python
drep = lib.crypto.derive_key(mnemonic, role="drep")

drep_yaml = f"""
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: drep_registration
          drep_credential_hex: {drep["public_key_hash"]}
          drep_credential_type: key_hash
          anchor_url: https://example.com/meta.json
          anchor_hash: {anchor_hash}
"""
reg = lib.quicktx.build_with(drep_yaml, provider, [sender], additional_signers=1)
signed = acct.sign_tx(reg["tx_cbor"], SigningRole.PAYMENT | SigningRole.DREP)
```

To vote on a governance action, the action id is the proposal transaction's hash plus its index (a proposal you submit yourself returns its hash from `build` — `result["tx_hash"]`). Sign the `voting` transaction with `SigningRole.PAYMENT | SigningRole.DREP`.

## Worked example: mint under a native script

```python
mint_yaml = f"""
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
"""
mint = lib.quicktx.build_with(mint_yaml, provider, [sender])
signed = acct.sign_tx(mint["tx_cbor"])
```

An empty `ScriptAll` policy (`820180`) needs no extra signature; a `sig`-keyed policy needs the corresponding key's witness.

## Worked example: Plutus mint

By default execution units are computed **offline** (embedded Scalus evaluator) — a Plutus transaction is a normal build:

```python
result = lib.quicktx.build_with(plutus_mint_yaml, provider, [sender])
```

To cost against a real node instead, pass an evaluator — `build_with` then runs the two-pass flow (draft → remote evaluate → rebuild):

```python
from mesmo import BlockfrostEvaluator

evaluator = BlockfrostEvaluator(project_id, network="preprod")
result = lib.quicktx.build_with(plutus_mint_yaml, provider, [sender], evaluator)
```

Or supply units yourself with the offline `build`:

```python
result = lib.quicktx.build(plutus_mint_yaml, utxos, params,
                           exec_units=[{"mem": 2000000, "steps": 500000000}])
```

For spending a script UTXO (`script_collect_from`), supply the locked UTXO (with its `data_hash`) **plus** a separate UTXO for fee/collateral in `utxos` — see the [catalog entry](../quicktx.md#plutus-scripts).

## Errors you'll meet

- `CCL Error -10` (`MESMO_ERROR_TX_BUILD`) — the plan didn't build: malformed YAML, wrong intent field, or a Plutus costing problem. Compare against the [catalog](../quicktx.md#intent-catalog--verified-shapes).
- `CCL Error -8` (`MESMO_ERROR_INSUFFICIENT_FUNDS`) — the supplied UTXOs can't cover outputs + fee.
- Node rejection `MissingVKeyWitnessesUTXOW` — a certificate wasn't witnessed; check the roles table above.
