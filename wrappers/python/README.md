# Mesmo

Python bindings for [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib)
via the Mesmo native library. Pure `ctypes` — no compiler, no C extension.

> Part of the [Mesmo](https://github.com/bloxbean/mesmo) project. See the
> [top-level README](https://github.com/bloxbean/mesmo#readme) for the full API reference and
> [`docs/quicktx.md`](https://github.com/bloxbean/mesmo/blob/main/docs/quicktx.md) for transaction building.

## Requirements

- Python 3.8+

The native library is **bundled inside the platform wheel** — no separate download or
`MESMO_LIB_PATH` needed for an installed package.

## Installing

**Recommended — a platform wheel that bundles the native library:**

```bash
pip install --pre mesmo
# or, a locally built wheel:
pip install path/to/mesmo-*.whl
```

`--pre` is required while every release is a pre-release: `0.1.0-preN` normalizes to `0.1.0rcN`
under PEP 440, and pip skips pre-releases unless asked. It becomes unnecessary at 1.0.

Wheels are published for `linux-x86_64`, `linux-aarch64`, `linux-musl-x86_64` (Alpine),
`macos-aarch64`, and `windows-x86_64`. There is no source distribution — on any other platform,
build `libmesmo` from source and point `MESMO_LIB_PATH` at it (see below).

The wheel ships the matching `libmesmo.*` inside the package (`mesmo/_libs/`), so `import mesmo`
just works — nothing else to set. At load time the bindings look for the library in this order: an
explicit `Mesmo(lib_path=...)`, the `MESMO_LIB_PATH` env var, then the bundled `mesmo/_libs/` copy.

Building the wheel yourself, or developing against a locally built `libmesmo`:
see [BUILD_FROM_SOURCE.md](https://github.com/bloxbean/mesmo/blob/main/wrappers/python/BUILD_FROM_SOURCE.md).

## Examples

The [`examples/`](https://github.com/bloxbean/mesmo/tree/main/wrappers/python/examples) directory contains:

| File | What it shows |
|------|---------------|
| [`01_account_and_keys.py`](https://github.com/bloxbean/mesmo/blob/main/wrappers/python/examples/01_account_and_keys.py) | Create an account, restore from mnemonic, derive keys and a DRep ID |
| [`02_primitives.py`](https://github.com/bloxbean/mesmo/blob/main/wrappers/python/examples/02_primitives.py) | Mnemonics, Blake2b hashing, Ed25519 signing, address parsing/validation |
| [`03_build_and_sign_tx.py`](https://github.com/bloxbean/mesmo/blob/main/wrappers/python/examples/03_build_and_sign_tx.py) | Build an unsigned payment **offline** (QuickTx) and sign it — no node/DevKit needed |

## Quick start

```python
from mesmo import Mesmo, Network

lib = Mesmo()                      # loads libmesmo, starts a GraalVM isolate
try:
    with lib.accounts.create(Network.TESTNET) as account:  # managed handle (ADR-0016)
        print(account.info["base_address"])       # addr_test1...
        print(account.export_recovery_phrase())   # 24-word phrase — one-shot, deliberate
finally:
    lib.close()                     # tears down the isolate
```

## API namespaces

A `Mesmo` instance exposes these namespaces (all offline operations):

| Namespace | Examples |
|-----------|----------|
| `lib.accounts` | managed accounts: `create`, `from_mnemonic` → `Account` (`info`, `sign_tx`, `export_recovery_phrase`, `close`) |
| `lib.address` | `info`, `validate`, `to_bytes`, `from_bytes` |
| `lib.crypto` | `blake2b_256`, `blake2b_224`, `generate_mnemonic`, `validate_mnemonic`, `sign`, `verify`, `derive_key` |
| `lib.tx` | `hash`, `sign_with_secret_key`, `to_json`, `from_json`, `deserialize` |
| `lib.plutus` | `data_hash`, `data_to_json`, `data_from_json` |
| `lib.script` | `native_from_json`, `hash` |
| `lib.quicktx` | `build(yaml, utxos, protocol_params)` — build an unsigned tx from a TxPlan YAML document |

### Networks

Every key-derivation and signing call takes a **required** `network` — `Network.MAINNET` or
`Network.TESTNET`. There is no default: a library that
derives keys must not guess, least of all guess mainnet.

> **`Network` is CCL's enum ordinal, not Cardano's on-chain network id.** The two differ, and for
> mainnet/testnet they are **inverted**:
>
> | Member | Value you pass | On-chain `network_id` of the address |
> |---|---|---|
> | `Network.MAINNET` | 0 | **1** |
> | `Network.TESTNET` | 1 | **0** |
>
> So do **not** pass a `network_id` you read off an address back into these APIs — you would flip
> mainnet and testnet. `lib.address.info(addr)["network_id"]` is the real on-chain id and is a
> different thing from the `Network` you passed in.

`Network` is an `IntEnum`, so a plain int 0 or 1 still works, and an out-of-range value raises
`ValueError` at the call rather than failing obscurely inside the native library.

Errors raise `mesmo.MesmoError`.

Transactions are defined as a [TxPlan](https://github.com/bloxbean/cardano-client-lib)
**YAML** document and built fully offline — you supply the UTXOs and protocol parameters:

```python
result = lib.quicktx.build(txplan_yaml, utxos, protocol_params)  # -> {"tx_cbor","tx_hash","fee"}
```

See [`examples/03_build_and_sign_tx.py`](https://github.com/bloxbean/mesmo/blob/main/wrappers/python/examples/03_build_and_sign_tx.py).

## Chain-data providers (optional)

`build()` is offline — you supply the UTXOs and protocol parameters. The optional providers fetch
those for you over HTTP (stdlib `urllib`), so the native library stays offline and provider-free:

```python
from mesmo import Mesmo, YaciProvider, BlockfrostProvider

lib = Mesmo()
provider = BlockfrostProvider(project_id, network="preprod")  # or YaciProvider()
result = lib.quicktx.build_with(txplan_yaml, provider, [sender_address])
```

Plug in any backend (Koios, Ogmios, …) by supplying an object with `utxos(address)` and
`protocol_params()`. UTXO *selection* is handled inside Mesmo — a provider only returns all
UTXOs at the address.

## Transaction evaluators (optional)

A Plutus build needs each redeemer's execution units. Mesmo computes them **offline** with
Scalus when you supply none — so a script build just works, no evaluation step:

```python
result = lib.quicktx.build_with(txplan_yaml, provider, [sender_address])  # Scalus computes the units
```

To use a **remote** evaluator instead (e.g. an authoritative fallback), pass a
`TransactionEvaluator`; `build_with` runs a two-pass (draft → evaluate → rebuild). libmesmo never
makes HTTP calls ([ADR-0013](https://github.com/bloxbean/mesmo/blob/main/docs/adr/0013-transaction-evaluators.md)), so remote evaluation
lives here in the wrapper:

```python
from mesmo import BlockfrostEvaluator

evaluator = BlockfrostEvaluator(project_id, network="preprod")
result = lib.quicktx.build_with(txplan_yaml, provider, [sender_address], evaluator=evaluator)
```

Plug in any evaluator (Ogmios, …) by supplying an object with `evaluate(tx_cbor, utxos)`. To supply
units you computed yourself, call `build(..., exec_units=…)` directly. See
`examples/04_plutus_evaluator.py`.
