# Python API Reference

```python
from mesmo import Mesmo, Network, MesmoError, MesmoClosedError
```

All functionality hangs off a `Mesmo` instance. JSON-returning methods give you plain `dict`s / `list`s; key and hash methods return `str`.

## Mesmo

```python
Mesmo(lib_path=None)          # lib_path: directory containing libmesmo, overrides auto-resolution
lib.version() -> str
lib.close() -> None            # idempotent
# context manager: with Mesmo() as lib: ...
```

Constructing loads the native library (see [resolution order](troubleshooting.md#how-the-native-library-is-found)), creates a GraalVM isolate, and verifies the library version matches the wrapper. The API groups are attributes: `lib.accounts`, `lib.address`, `lib.crypto`, `lib.tx`, `lib.plutus`, `lib.script`, `lib.quicktx`.

**Lifecycle.** `close()` detaches all attached threads and tears down the isolate; it is idempotent and also runs on `__exit__`/`__del__`. Any call after `close()` raises `MesmoClosedError` — this is deliberate: passing a stale isolate handle to the native side would abort the whole process uncatchably, so the wrapper converts it into a catchable exception.

**Threading.** One `Mesmo` may be shared across threads: each OS thread is attached to the isolate lazily on first use and gets its own native call state, so concurrent calls from a thread pool are safe.

## Networks

```python
class Network(IntEnum):
    MAINNET = 0
    TESTNET = 1
```

Every method that derives keys or signs requires a `network` argument. Omitting it raises `TypeError`; an out-of-range value raises `ValueError` before any native call. Being an `IntEnum`, plain ints 0 or 1 are accepted too, but prefer the enum.

> **Gotcha:** these values are CCL enum ordinals, **not** Cardano's on-chain network id — the two are inverted for mainnet/testnet (`Network.MAINNET == 0`, but a mainnet address's on-chain `network_id` is `1`). `address.info()["network_id"]` is the genuine on-chain value; never feed it back into an API that takes a `network`.

## Errors

| Exception | When |
|---|---|
| `MesmoError` | A native call failed. Has `.code` (see table below) and `.message`. `str(e)` = `"CCL Error <code>: <message>"`. |
| `MesmoClosedError` (a `RuntimeError`) | Any API call after `close()`. |
| `TypeError` / `ValueError` | Missing / out-of-range `network` argument. |
| `OSError` | Native library could not be loaded. |
| `RuntimeError` | Isolate creation failure or wrapper/native version mismatch. |

Error codes on `MesmoError.code` (also available as `Mesmo.MESMO_ERROR_*` constants):

| Constant | Code | Meaning |
|---|---|---|
| `MESMO_ERROR_GENERAL` | -1 | Unspecified failure |
| `MESMO_ERROR_INVALID_ARGUMENT` | -2 | Bad argument |
| `MESMO_ERROR_SERIALIZATION` | -3 | (De)serialization failure |
| `MESMO_ERROR_CRYPTO` | -4 | Cryptographic failure |
| `MESMO_ERROR_INVALID_NETWORK` | -5 | Bad network value |
| `MESMO_ERROR_INVALID_MNEMONIC` | -6 | Bad mnemonic |
| `MESMO_ERROR_INVALID_ADDRESS` | -7 | Bad address |
| `MESMO_ERROR_INSUFFICIENT_FUNDS` | -8 | UTXOs can't cover outputs + fee |
| `MESMO_ERROR_INVALID_TRANSACTION` | -9 | Bad transaction |
| `MESMO_ERROR_TX_BUILD` | -10 | TxPlan build failure (most common `quicktx.build` error — usually a malformed plan) |
| `MESMO_ERROR_INVALID_HANDLE` | -11 | Unknown or closed account handle (raised as `CclInvalidHandleError`) |

Predicate methods (`address.validate`, `crypto.validate_mnemonic`, `crypto.verify`) return `False` instead of raising.

## lib.accounts — managed accounts

Handle-based accounts (ADR-0016): open once, then operate without the mnemonic — the only
account API.

```python
from mesmo import SigningRole, CclInvalidHandleError

with lib.accounts.from_mnemonic(mnemonic, Network.TESTNET) as acct:   # or lib.accounts.create(...)
    acct.info                                    # public data only — never the mnemonic
    signed = acct.sign_tx(tx_cbor, SigningRole.PAYMENT | SigningRole.STAKE)
# closed: further use raises CclInvalidHandleError (-11)
```

- `from_mnemonic(mnemonic, network, account_index=0, address_index=0) -> Account` — the mnemonic
  crosses the FFI boundary once, here.
- `create(network) -> Account` — fresh 24-word account; **no secret in the result**. Retrieve the
  phrase once, deliberately, with `account.export_recovery_phrase()` — a second call fails, as does
  export on a mnemonic-opened account.
- `sign_tx(tx_cbor_hex, roles=SigningRole.PAYMENT)` — typed roles (`PAYMENT`, `STAKE`, `DREP`,
  `COMMITTEE_COLD`, `COMMITTEE_HOT`), combined with `|`; witnesses apply in canonical order, so the
  witnesses apply in canonical order. An empty mask is rejected.
- `close()` is idempotent; the context manager calls it. `repr(account)` shows only the handle.
- `info` returns public data only: the base/enterprise/stake/change addresses, network and
  derivation indices, `drep_id`, and the committee identifiers (`committee_cold_id`/`committee_hot_id`,
  bech32, plus `committee_cold_credential`/`committee_hot_credential` — the hex blake2b-224
  verification-key hashes used in committee certificates).

An account is bound to **one CIP-1852 payment leaf** (`m/1852'/1815'/account'/0/address_index`): one handle, one payment address — open further accounts for further address indices. The stake/DRep/committee keys sit at their standard role indices *independent of* `address_index`, so accounts at different address indices of one account index **share a single stake/DRep identity**.

## lib.address

```python
info(bech32_address) -> dict
validate(bech32_address) -> bool
to_bytes(bech32_address) -> str    # hex
from_bytes(hex_bytes) -> str       # bech32
```

`info` returns `{"type", "network_id", "payment_credential_hash", ...}`. `type` is e.g. `"Base"`, `"Enterprise"`, `"Pointer"`, `"Reward"`; `network_id` is the genuine on-chain id (mainnet = 1).

## lib.crypto

```python
blake2b_256(data_hex) -> str       # 64 hex chars
blake2b_224(data_hex) -> str       # 56 hex chars
generate_mnemonic(word_count=24) -> str
validate_mnemonic(mnemonic) -> bool
sign(message_hex, sk_hex) -> str   # Ed25519; 32-byte seed or 64-byte extended key (by length)
verify(signature_hex, message_hex, pk_hex) -> bool
derive_key(mnemonic, account_index=0, address_index=0, role="payment") -> dict
```

`derive_key` is the stateless CIP-1852 "raw key material" utility — `role` is one of `"payment"`,
`"change"`, `"stake"`, `"drep"`, `"committee_cold"`, `"committee_hot"`; it returns `{"path",
"private_key", "public_key", "public_key_hash"}`. The governance roles additionally carry the
CIP-105 bech32 encodings `bech32_verification_key`/`bech32_verification_key_hash`
(`drep_vk1…`/`cc_cold_vk1…`/`cc_hot_vk1…` and the `…_vkh1…` hash forms) — what cardano-cli and
GovTool accept for registration. Key derivation is network-independent. Prefer
managed accounts for signing — handles never expose key bytes.

```python
digest = lib.crypto.blake2b_256("48656c6c6f")            # "Hello"
sk = lib.crypto.derive_key(mnemonic)["private_key"]   # pass the extended key whole
sig = lib.crypto.sign("68656c6c6f", sk)
```

## lib.tx

```python
hash(tx_cbor_hex) -> str            # 64 hex chars
sign_with_secret_key(tx_cbor_hex, sk_cbor_hex) -> str
to_json(tx_cbor_hex) -> dict
from_json(tx_json) -> str           # accepts dict or JSON string; returns CBOR hex
deserialize(tx_cbor_hex) -> dict
```

`to_json`/`deserialize` return a dict with a `body` key (inputs/outputs/fee).

> **Known limitations (current release):** `tx.from_json` and `tx.sign_with_secret_key` hit GraalVM reflection gaps in the native library and are not usable yet. For signing, use `account.sign_tx` (mnemonic-based), which covers the common path.

## lib.plutus

```python
data_hash(datum_cbor_hex) -> str    # 64 hex chars
data_to_json(cbor_hex) -> str
data_from_json(json_str) -> str     # accepts dict or JSON string; returns CBOR hex
```

```python
h = lib.plutus.data_hash("182a")    # hash of PlutusData int 42
```

> **Known limitation (current release):** `data_to_json`/`data_from_json` hit a GraalVM reflection gap and are not usable yet; `data_hash` works.

## lib.script

```python
native_from_json(json_str) -> str          # JSON string: {"policy_id", "script_hash", "cbor_hex"}
hash(script_cbor_hex, script_type=0) -> str  # 56 hex chars
```

`script_type`: `0` native, `1` PlutusV1, `2` PlutusV2, `3` PlutusV3.

```python
import json
script = json.loads(lib.script.native_from_json(json.dumps({"type": "sig", "keyHash": key_hash})))
# script["policy_id"], script["script_hash"], script["cbor_hex"]
```

## Governance identity and HD-wallet flows

There is no separate gov/wallet API. Governance *identity* (DRep id, committee ids and
credentials) is public data on `account.info`; governance *signing* uses `sign_tx` with the
`DREP`/`COMMITTEE_*` roles; raw governance key material comes from `lib.crypto.derive_key`.
An HD wallet is one recovery phrase with one managed handle per CIP-1852 payment leaf — pass
`address_index` to `lib.accounts.from_mnemonic` to enumerate addresses.

## lib.quicktx

```python
build(txplan_yaml, utxos, protocol_params, exec_units=None, additional_signers=0) -> dict
build_with(txplan_yaml, provider, senders, evaluator=None, additional_signers=0) -> dict
```

Both return `{"tx_cbor": str, "tx_hash": str, "fee": str}`.

- **`build`** is fully offline: you describe the transaction as [TxPlan YAML](../quicktx.md) and supply the chain data yourself. UTXO selection, fee calculation, and change handling happen inside the native library. It never submits — sign the returned `tx_cbor` and submit with any HTTP client.
- `utxos` is a list of CCL `Utxo` dicts: `{"tx_hash", "output_index", "address", "amount": [{"unit", "quantity"}]}`. `unit` is `"lovelace"` or `policyId + assetNameHex`. Pass quantities as **strings** (`"quantity": "100000000"`); Python ints are arbitrary precision, so reading values back (e.g. `int(result["fee"])`) is always exact.
- `protocol_params` is the CCL `ProtocolParams` dict; unknown fields are ignored.
- `exec_units` — for Plutus transactions, `[{"mem": ..., "steps": ...}]`, one entry per redeemer in transaction order. When omitted, the native library computes them **offline** with the embedded Scalus evaluator.
- `additional_signers` budgets vkey witnesses for fee estimation, **beyond those the input UTXOs imply** (one per sender). You know how many keys will sign: `0` for a plain payment, `1` for a stake or DRep certificate (`payment`+`stake` signing), `2` for both in one tx, the number of `sig` keys for a native-script spend, plus one per plan-level required signer. Undercounting yields a fee the node rejects with `FeeTooSmallUTxO`; overcounting only overpays (~4,400 lovelace per extra witness).
- **`build_with`** fetches each sender's UTXOs from a [provider](providers.md) — merged and de-duplicated by `(tx_hash, output_index)` — plus protocol parameters, then builds. With multiple senders, TxPlan's `context.fee_payer` decides who pays the fee. With an evaluator it runs two passes: draft build → remote evaluation → rebuild with the returned units.

```python
result = lib.quicktx.build(yaml, utxos, params)                      # plain payment: 0 extra signers

stake_result = lib.quicktx.build(yaml, utxos, params,
                                 additional_signers=1)               # payment+stake signing

plutus_result = lib.quicktx.build(yaml, utxos, params,
                                  exec_units=[{"mem": 2000000, "steps": 500000000}])
```
