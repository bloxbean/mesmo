# JavaScript API Reference

All functionality hangs off a `CclBridge` instance. Import what you need from the package root:

```js
import {
  CclBridge, CclError, CclClosedError,
  MAINNET, TESTNET,
  YaciProvider, BlockfrostProvider, BlockfrostEvaluator,
} from "@bloxbean/cardano-client-lib";
```

The package ships TypeScript definitions (`index.d.ts`) for every class, method, and result shape shown below.

## CclBridge

```ts
constructor(libPath?: string)
version(): string
close(): void
[Symbol.dispose](): void
```

Constructing a bridge loads the native library (see [resolution order](troubleshooting.md#how-the-native-library-is-found)), creates a GraalVM isolate, and verifies the library version matches the wrapper. The API groups are properties: `bridge.accounts`, `bridge.address`, `bridge.crypto`, `bridge.tx`, `bridge.plutus`, `bridge.script`, `bridge.quicktx`.

**Lifecycle.** `close()` tears down the isolate and is idempotent. Any call after `close()` throws `CclClosedError` — this is deliberate: passing a stale isolate handle to the native side would abort the whole process uncatchably, so the wrapper converts it into a catchable error. Use `try/finally` or the `using` declaration:

```js
using bridge = new CclBridge();   // closed automatically at end of scope
```

**Threading.** A bridge is bound to the thread that created it. In Bun's single-threaded model this rarely matters; if you use workers, create one bridge per worker.

## Networks

```ts
type Network = 0 | 1
MAINNET = 0, TESTNET = 1
```

Every method that derives keys (`account.*`, `wallet.*`, `gov.*`) requires a `network` argument. Passing `undefined`/`null` throws `TypeError`; an out-of-range value throws `RangeError`.

> **Gotcha:** these constants are CCL enum ordinals, **not** Cardano's on-chain network id — the two are inverted for mainnet/testnet (`MAINNET = 0`, but a mainnet address's on-chain `network_id` is `1`). Never feed `address.info().network_id` back into an API that takes a network.

## Errors

| Class | When |
|---|---|
| `CclError` | A native call failed. Has `.code` (see table below) and `.message` (the native error text). |
| `CclClosedError` | Any API call after `close()`. |
| `TypeError` / `RangeError` | Missing / out-of-range `network` argument. |
| `Error` | Library load failure, isolate creation failure, version mismatch, provider HTTP failures. |

Error codes on `CclError.code`:

| Constant | Code | Meaning |
|---|---|---|
| `CCL_ERROR_GENERAL` | -1 | Unspecified failure |
| `CCL_ERROR_INVALID_ARGUMENT` | -2 | Bad argument |
| `CCL_ERROR_SERIALIZATION` | -3 | (De)serialization failure |
| `CCL_ERROR_CRYPTO` | -4 | Cryptographic failure |
| `CCL_ERROR_INVALID_NETWORK` | -5 | Bad network value |
| `CCL_ERROR_INVALID_MNEMONIC` | -6 | Bad mnemonic |
| `CCL_ERROR_INVALID_ADDRESS` | -7 | Bad address |
| `CCL_ERROR_INSUFFICIENT_FUNDS` | -8 | UTXOs can't cover outputs + fee |
| `CCL_ERROR_INVALID_TRANSACTION` | -9 | Bad transaction |
| `CCL_ERROR_TX_BUILD` | -10 | TxPlan build failure (most common `quicktx.build` error — usually a malformed plan) |
| `CCL_ERROR_INVALID_HANDLE` | -11 | Unknown or closed account handle |

Validation-style methods (`address.validate`, `crypto.validateMnemonic`, `crypto.verify`) return `false` instead of throwing.

## bridge.accounts — managed accounts

Handle-based accounts (ADR-0016): open once, then operate without the mnemonic — the only
account API. The account object retains only the hardened account-level key
(`m/1852'/1815'/account'`) — never your recovery phrase.

```javascript
import { SigningRole } from '@bloxbean/cardano-client-lib';

const acct = bridge.accounts.fromMnemonic(mnemonic, TESTNET);   // or bridge.accounts.create(...)
try {
  acct.info;                                     // public data only — never the mnemonic
  const signed = acct.signTx(txCbor, SigningRole.PAYMENT | SigningRole.STAKE);
} finally {
  acct.close();                                  // or: using acct = ... (Symbol.dispose)
}
// after close: further use throws CclError with code -11
```

- `fromMnemonic(mnemonic, network, accountIndex = 0, addressIndex = 0)` — the mnemonic crosses the
  FFI boundary once, here.
- `create(network)` — fresh 24-word account; **no secret in the result**. Retrieve the phrase once,
  deliberately, with `acct.exportRecoveryPhrase()` — a second call fails, as does export on a
  mnemonic-opened account.
- `signTx(txCborHex, roles = SigningRole.PAYMENT)` — typed roles combined with `|`; witnesses apply
  in canonical order. An empty mask is rejected.
- `close()` is idempotent; `Symbol.dispose` supports `using`-declarations. A dropped account is
  additionally reclaimed best-effort by a `FinalizationRegistry` (fallback only — close
  deterministically). `String(acct)` shows only the handle.
- `info` returns public data only: the base/enterprise/stake/change addresses, network and
  derivation indices, `drep_id`, and the committee identifiers (`committee_cold_id`/`committee_hot_id`, bech32,
  plus `committee_cold_credential`/`committee_hot_credential` — hex blake2b-224 verification-key
  hashes, as used in committee certificates).

An account is bound to **one CIP-1852 payment leaf** (`m/1852'/1815'/account'/0/address_index`): one handle, one payment address — open further accounts for further address indices. The stake/DRep/committee keys sit at their standard role indices *independent of* `address_index`, so accounts at different address indices of one account index **share a single stake/DRep identity**.

## bridge.address

```ts
info(bech32: string): AddressInfo
validate(bech32: string): boolean
toBytes(bech32: string): string     // hex
fromBytes(hexBytes: string): string // bech32
```

`AddressInfo` = `{ type, network_id, payment_credential_hash?, delegation_credential_hash?, is_pubkey_payment, is_script_payment }`. `type` is e.g. `"Base"`, `"Enterprise"`, `"Pointer"`, `"Reward"`. `network_id` is the genuine on-chain id (mainnet = 1).

## bridge.crypto

```ts
blake2b256(dataHex: string): string
blake2b224(dataHex: string): string
generateMnemonic(wordCount = 24): string
validateMnemonic(mnemonic: string): boolean
sign(messageHex: string, skHex: string): string      // Ed25519; 32-byte seed or 64-byte extended key (by length)
verify(signatureHex: string, messageHex: string, pkHex: string): boolean
deriveKey(mnemonic: string, accountIndex = 0, addressIndex = 0, role: DeriveKeyRole = 'payment'): DerivedKey
```

`deriveKey` is the stateless CIP-1852 "raw key material" utility — `role` is one of `'payment'`,
`'change'`, `'stake'`, `'drep'`, `'committee_cold'`, `'committee_hot'`; it returns `{ path,
private_key, public_key, public_key_hash }`, plus — for the governance roles — the CIP-105 bech32
encodings `bech32_verification_key`/`bech32_verification_key_hash` (what cardano-cli and GovTool
accept for registration). Key derivation is network-independent. Prefer managed
accounts for signing — handles never expose key bytes.

```js
const digest = bridge.crypto.blake2b256("48656c6c6f");          // "Hello"
const sk = bridge.crypto.deriveKey(mnemonic).private_key; // pass the extended key whole
const sig = bridge.crypto.sign("68656c6c6f", sk);
```

## bridge.tx

```ts
hash(txCborHex: string): string
signWithSecretKey(txCborHex: string, skCborHex: string): string
toJson(txCborHex: string): string          // JSON string
fromJson(txJson: string): string           // CBOR hex
deserialize(txCborHex: string): TransactionJson   // parsed object
```

`toJson` returns a JSON **string**; `deserialize` returns the parsed object (with a `body` field holding inputs/outputs/fee). `signWithSecretKey` expects a CBOR-encoded secret key, not raw key hex — for mnemonic-based accounts prefer `account.signTx`.

## bridge.plutus

```ts
dataHash(datumCborHex: string): string    // 64 hex chars
dataToJson(cborHex: string): string       // JSON string
dataFromJson(json: string): string        // CBOR hex
```

```js
bridge.plutus.dataHash("182a");   // hash of PlutusData int 42
```

## bridge.script

```ts
nativeFromJson(json: string): string           // JSON: { policy_id, script_hash, cbor_hex }
hash(scriptCborHex: string, scriptType = 0): string
```

`scriptType`: `0` native, `1` PlutusV1, `2` PlutusV2, `3` PlutusV3.

```js
const script = JSON.parse(bridge.script.nativeFromJson(JSON.stringify({ type: "sig", keyHash })));
// script.policy_id, script.script_hash, script.cbor_hex
```

## Governance identity and HD-wallet flows

There is no separate gov/wallet API. Governance *identity* (DRep id, committee ids and credentials)
is public data on `acct.info`; governance *signing* uses `signTx` with the `DREP`/`COMMITTEE_*`
roles; raw governance key material comes from `bridge.crypto.deriveKey`. An HD wallet is one
recovery phrase with one managed handle per CIP-1852 payment leaf — pass `addressIndex` to
`bridge.accounts.fromMnemonic` to enumerate addresses.

## bridge.quicktx

```ts
build(txplanYaml: string, utxos: Utxo[], protocolParams: ProtocolParams,
      execUnits?: ExecUnits[] | null, additionalSigners = 0): TxResult
buildWith(txplanYaml: string, provider: ChainDataProvider, senders: string[],
          evaluator?: TransactionEvaluator | null, additionalSigners = 0): Promise<TxResult>
```

`TxResult` = `{ tx_cbor, tx_hash, fee }` (all strings).

- **`build`** is fully offline: you describe the transaction as [TxPlan YAML](../quicktx.md) and supply the chain data yourself. UTXO selection, fee calculation, and change handling happen inside the native library. It never submits — sign the returned `tx_cbor` and submit with any HTTP client.
- `utxos` is an array of CCL `Utxo` objects: `{ tx_hash, output_index, address, amount: [{ unit, quantity }], data_hash?, inline_datum?, reference_script_hash? }`. `unit` is `"lovelace"` or `policyId + assetNameHex`.
- `protocolParams` is the CCL `ProtocolParams` JSON model. Cost models in the deprecated numerically-keyed map form are normalized automatically (`normalizeCostModels`), preventing `PPViewHashesDontMatch` on Plutus transactions.
- `additionalSigners` budgets vkey witnesses for fee estimation, **beyond those the input UTXOs imply** (one per sender). You know how many keys will sign: `0` for a plain payment, `1` for a stake or DRep certificate, `2` for both in one tx, the number of `sig` keys for a native-script spend, plus one per plan-level required signer. Undercounting yields a fee the node rejects with `FeeTooSmallUTxO`; overcounting only overpays (~4,400 lovelace per extra witness).
- **Large numbers are safe.** Inputs are serialized with `lossless-json`, so quantities above 2^53 survive exactly.
- `execUnits` — for Plutus transactions, `[{ mem, steps }]`, one entry per redeemer in transaction order. When omitted, the native library computes them **offline** with the embedded Scalus evaluator, so script transactions build with no network access. Supply your own to override, or use an [evaluator](providers.md#evaluators) for node-backed costing.
- **`buildWith`** fetches each sender's UTXOs from a [provider](providers.md) — merged and de-duplicated by `(tx_hash, output_index)` — plus protocol parameters, then builds. With multiple senders, TxPlan's `context.fee_payer` decides who pays the fee. With an evaluator it runs two passes: draft build → remote evaluation → rebuild with the returned units.

```js
const result = bridge.quicktx.build(yaml, utxos, params);
const plutusResult = bridge.quicktx.build(yaml, utxos, params, [{ mem: 2000000, steps: 500000000 }]);
```

## Utility exports

```ts
normalizeCostModels(protocolParams): ProtocolParams  // applied automatically inside build()
parseEvaluation(resp): ExecUnits[]                   // parse Ogmios/Blockfrost evaluate responses
resolveLibFile(libPath?: string): string             // the native library path that would be loaded
platformSuffix(): string                             // e.g. "macos-aarch64", "linux-musl-x86_64"
```
