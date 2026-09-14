# Building Transactions (Go)

This guide walks the full life of a transaction: describe it in [TxPlan YAML](../quicktx.md), build it offline, sign it with the right keys, and submit it with your own HTTP client. The YAML shapes for every intent — staking, governance, pools, minting, Plutus — are cataloged in the [TxPlan reference](../quicktx.md#intent-catalog--verified-shapes); this page shows how to drive them from Go.

## The workflow

Every transaction follows the same four steps:

```go
bridge, err := ccl.New()
if err != nil { log.Fatal(err) }
defer bridge.Close()

provider := ccl.NewYaciProvider("")   // or a BlockfrostProvider, or your own

// 1. Describe — TxPlan YAML (see the intent catalog)
yaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: payment
          address: %s
          amounts:
            - unit: lovelace
              quantity: "5000000"
`, sender, receiver)

// 2. Build — offline; UTXO selection, fee, and change happen in the native lib
result, err := bridge.QuickTx.BuildWith(yaml, provider, []string{sender}, 0)
// (or bridge.QuickTx.Build(yaml, utxos, protocolParams, additionalSigners) with your own chain data)

// 3. Sign — with the key roles the transaction's certificates require
acct, _ := bridge.Accounts.FromMnemonic(mnemonic, ccl.Testnet, 0, 0)
defer acct.Close()
signed, err := acct.SignTx(result.TxCbor, ccl.RolePayment)

// 4. Submit — any Blockfrost-compatible endpoint; the library never submits
txBytes, _ := hex.DecodeString(signed)
resp, err := http.Post(submitURL+"/tx/submit", "application/cbor", bytes.NewReader(txBytes))
```

## Which keys sign what

`SignTx` witnesses with the payment key only. Certificates need their own witness — combine `SigningRole` flags with `|` (witnesses apply in canonical order):

| Transaction contains | Roles |
|---|---|
| Payments, metadata, minting, Plutus operations | `ccl.RolePayment` |
| `stake_registration` / `stake_deregistration` / `stake_delegation` / `stake_withdrawal` / `voting_delegation` | `RolePayment\|RoleStake` |
| `drep_registration` / `drep_update` / `drep_deregistration` / `voting` | `RolePayment\|RoleDRep` |
| `governance_proposal` | `RolePayment` |
| `pool_registration` / `pool_update` / `pool_retirement` | `RolePayment\|RoleStake` when the pool is keyed to the account's stake key |

A missing witness is rejected by the node with `MissingVKeyWitnessesUTXOW`.
The same table gives the fee's witness budget: pass `additional_signers = len(keys) - 1` to the build (the input UTXOs already cover the payment key). For a native-script spend whose only inputs sit at the script address, pass the number of the script's `sig` keys instead.


## Worked example: register and delegate stake

Two transactions — the registration must be on-chain before the delegation:

```go
stakeYaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: stake_registration
          stake_address: %s
`, sender, account.StakeAddress)

reg, err := bridge.QuickTx.BuildWith(stakeYaml, provider, []string{sender}, 1)
signedReg, err := acct.SignTx(reg.TxCbor, ccl.RolePayment|ccl.RoleStake)
// submit signedReg; wait for inclusion before the next step

delegYaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: stake_delegation
          stake_address: %s
          pool_id: pool1...
`, sender, account.StakeAddress)

deleg, err := bridge.QuickTx.BuildWith(delegYaml, provider, []string{sender}, 1)
signedDeleg, err := acct.SignTx(deleg.TxCbor, ccl.RolePayment|ccl.RoleStake)
```

## Worked example: DRep registration, then vote

The DRep credential comes from the governance API:

```go
drep, err := bridge.Crypto.DeriveKey(mnemonic, 0, 0, "drep")

drepYaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: drep_registration
          drep_credential_hex: %s
          drep_credential_type: key_hash
          anchor_url: https://example.com/meta.json
          anchor_hash: %s
`, sender, drep.PublicKeyHash, anchorHash)

reg, err := bridge.QuickTx.BuildWith(drepYaml, provider, []string{sender}, 1)
signedReg, err := acct.SignTx(reg.TxCbor, ccl.RolePayment|ccl.RoleDRep)
```

To vote on a governance action, the action id is the proposal transaction's hash plus its index (a proposal you submit yourself returns its hash from `Build` — `result.TxHash`). Sign the `voting` transaction with `RolePayment\|RoleDRep`.

## Worked example: mint under a native script

```go
mintYaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: minting
          assets:
            - name: TestNFT
              value: 1
          receiver: %s
          script_hex: "820180"
          script_type: 0
`, sender, receiver)

mint, err := bridge.QuickTx.BuildWith(mintYaml, provider, []string{sender}, 0)
signedMint, err := acct.SignTx(mint.TxCbor, ccl.RolePayment)
```

An empty `ScriptAll` policy (`820180`) needs no extra signature; a `sig`-keyed policy needs the corresponding key's witness.

## Worked example: Plutus mint

By default execution units are computed **offline** (embedded Scalus evaluator) — a Plutus transaction is a normal build:

```go
result, err := bridge.QuickTx.BuildWith(plutusMintYaml, provider, []string{sender}, 0)
```

To cost against a real node instead, pass an evaluator — `BuildWith` then runs the two-pass flow (draft → remote evaluate → rebuild):

```go
evaluator, _ := ccl.NewBlockfrostEvaluator(projectID, "preprod")
result, err := bridge.QuickTx.BuildWith(plutusMintYaml, provider, []string{sender}, 0, evaluator)
```

Or supply units yourself with the offline `Build`:

```go
result, err := bridge.QuickTx.Build(plutusMintYaml, utxos, params, 0,
	[]map[string]interface{}{{"mem": 2000000, "steps": 500000000}})
```

For spending a script UTXO (`script_collect_from`), supply the locked UTXO (with its `data_hash`) **plus** a separate UTXO for fee/collateral in `utxos` — see the [catalog entry](../quicktx.md#plutus-scripts) and the end-to-end lock-then-spend flow in [`wrappers/go/ccl/script_spend_test.go`](../../wrappers/go/ccl/script_spend_test.go).

## Errors you'll meet

- `CCL Error -10` (`ErrTxBuild`) — the plan didn't build: malformed YAML, wrong intent field, or a Plutus costing problem. Compare against the [catalog](../quicktx.md#intent-catalog--verified-shapes).
- `CCL Error -8` (`ErrInsufficientFunds`) — the supplied UTXOs can't cover outputs + fee.
- Node rejection `MissingVKeyWitnessesUTXOW` — a certificate wasn't witnessed; check the roles table above.
