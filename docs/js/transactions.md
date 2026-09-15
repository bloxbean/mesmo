# Building Transactions (JavaScript)

This guide walks the full life of a transaction: describe it in [TxPlan YAML](../quicktx.md), build it offline, sign it with the right keys, and submit it with your own HTTP client. The YAML shapes for every intent — staking, governance, pools, minting, Plutus — are cataloged in the [TxPlan reference](../quicktx.md#intent-catalog--verified-shapes); this page shows how to drive them from JavaScript.

## The workflow

Every transaction follows the same four steps:

```js
import { Mesmo, TESTNET, YaciProvider } from "@bloxbean/mesmo";

using lib = new Mesmo();
const provider = new YaciProvider();          // or BlockfrostProvider, or your own

// 1. Describe — TxPlan YAML (see the intent catalog)
const yaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender}
      intents:
        - type: payment
          address: ${receiver}
          amounts:
            - unit: lovelace
              quantity: "5000000"
`;

// 2. Build — offline; UTXO selection, fee, and change happen in the native lib
const result = await lib.quicktx.buildWith(yaml, provider, [sender]);
// (or lib.quicktx.build(yaml, utxos, protocolParams) with your own chain data)

// 3. Sign — with the key roles the transaction's certificates require
using acct = lib.accounts.fromMnemonic(mnemonic, TESTNET);
const signed = acct.signTx(result.tx_cbor);

// 4. Submit — any Blockfrost-compatible endpoint; the library never submits
const resp = await fetch(`${submitUrl}/tx/submit`, {
  method: "POST",
  headers: { "Content-Type": "application/cbor" },
  body: Buffer.from(signed, "hex"),
});
if (!resp.ok) throw new Error(`rejected: ${await resp.text()}`);
const txHash = (await resp.text()).trim().replace(/"/g, "");
```

## Which keys sign what

`acct.signTx(txCbor)` witnesses with the payment key only. Certificates need their own witness —
combine `SigningRole` flags with `|` (witnesses apply in canonical order):

| Transaction contains | roles |
|---|---|
| Payments, metadata, minting, Plutus operations | `SigningRole.PAYMENT` (the default) |
| `stake_registration` / `stake_deregistration` / `stake_delegation` / `stake_withdrawal` / `voting_delegation` | `PAYMENT \| STAKE` |
| `drep_registration` / `drep_update` / `drep_deregistration` / `voting` | `PAYMENT \| DREP` |
| `governance_proposal` | `PAYMENT` |
| `pool_registration` / `pool_update` / `pool_retirement` | `PAYMENT \| STAKE` when the pool is keyed to the account's stake key |

The examples below assume an open handle: `using acct = lib.accounts.fromMnemonic(mnemonic, TESTNET)` (with `SigningRole` imported).

A missing witness is rejected by the node with `MissingVKeyWitnessesUTXOW`.
The same table gives the fee's witness budget: pass `additional_signers = len(keys) - 1` to the build (the input UTXOs already cover the payment key). For a native-script spend whose only inputs sit at the script address, pass the number of the script's `sig` keys instead.


## Worked example: register and delegate stake

Two transactions — the registration must be on-chain before the delegation:

```js
const stakeYaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender}
      intents:
        - type: stake_registration
          stake_address: ${account.stake_address}
`;
const reg = await lib.quicktx.buildWith(stakeYaml, provider, [sender], null, 1);
const signedReg = acct.signTx(reg.tx_cbor, SigningRole.PAYMENT | SigningRole.STAKE);
await submit(signedReg);          // wait for inclusion before the next step

const delegYaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender}
      intents:
        - type: stake_delegation
          stake_address: ${account.stake_address}
          pool_id: pool1...
`;
const deleg = await lib.quicktx.buildWith(delegYaml, provider, [sender], null, 1);
const signedDeleg = acct.signTx(deleg.tx_cbor, SigningRole.PAYMENT | SigningRole.STAKE);
await submit(signedDeleg);
```

## Worked example: DRep registration, then vote

The DRep credential comes from the governance API:

```js
const drep = lib.crypto.deriveKey(mnemonic, 0, 0, 'drep');

const drepYaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender}
      intents:
        - type: drep_registration
          drep_credential_hex: ${drep.public_key_hash}
          drep_credential_type: key_hash
          anchor_url: https://example.com/meta.json
          anchor_hash: ${anchorHash}
`;
const reg = await lib.quicktx.buildWith(drepYaml, provider, [sender], null, 1);
const signedReg = acct.signTx(reg.tx_cbor, SigningRole.PAYMENT | SigningRole.DREP);
await submit(signedReg);
```

To vote on a governance action, the action id is the proposal transaction's hash plus its index (a proposal you submit yourself returns its hash from `build` — `result.tx_hash`):

```js
const voteYaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender}
      intents:
        - type: voting
          voter_hex: ${voterHex}
          gov_action_tx_hash: ${proposalTxHash}
          gov_action_index: 0
          vote: "YES"
          anchor_url: https://example.com/meta.json
          anchor_hash: ${anchorHash}
`;
const vote = await lib.quicktx.buildWith(voteYaml, provider, [sender], null, 1);
const signedVote = acct.signTx(vote.tx_cbor, SigningRole.PAYMENT | SigningRole.DREP);
```

## Worked example: mint under a native script

An asset policy is a native script; derive it with the script API, then mint with `signTx` (an empty `ScriptAll` policy needs no extra signature; a `sig`-keyed policy needs the corresponding key's witness):

```js
const mintYaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender}
      intents:
        - type: minting
          assets:
            - name: TestNFT
              value: 1
          receiver: ${receiver}
          script_hex: "820180"
          script_type: 0
`;
const mint = await lib.quicktx.buildWith(mintYaml, provider, [sender]);
const signedMint = acct.signTx(mint.tx_cbor);
```

## Worked example: Plutus mint

By default execution units are computed **offline** (embedded Scalus evaluator) — a Plutus transaction is a normal build:

```js
const result = await lib.quicktx.buildWith(plutusMintYaml, provider, [sender]);
```

To cost against a real node instead, pass an evaluator — `buildWith` then runs the two-pass flow (draft → remote evaluate → rebuild):

```js
import { BlockfrostEvaluator } from "@bloxbean/mesmo";

const evaluator = new BlockfrostEvaluator(projectId, { network: "preprod" });
const result = await lib.quicktx.buildWith(plutusMintYaml, provider, [sender], evaluator);
```

Or supply units yourself with the offline `build`:

```js
const result = lib.quicktx.build(plutusMintYaml, utxos, params, [{ mem: 2000000, steps: 500000000 }]);
```

For spending a script UTXO (`script_collect_from`), supply the locked UTXO (with its `data_hash`) **plus** a separate UTXO for fee/collateral in `utxos` — see the [catalog entry](../quicktx.md#plutus-scripts) and the end-to-end lock-then-spend flow in [`wrappers/js/test/intents.integration.test.js`](../../wrappers/js/test/intents.integration.test.js).

## Errors you'll meet

- `Mesmo error -10` — the plan didn't build: malformed YAML, wrong intent field, or a Plutus costing problem. Compare against the [catalog](../quicktx.md#intent-catalog--verified-shapes).
- `Mesmo error -8` — the supplied UTXOs can't cover outputs + fee.
- Node rejection `MissingVKeyWitnessesUTXOW` — a certificate wasn't witnessed; check the roles table above.
