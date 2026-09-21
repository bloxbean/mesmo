# Cardano Client Lib for Python

The `mesmo` Python package (distribution name: `cardano-client-lib`) brings [Cardano Client Lib (CCL)](https://github.com/bloxbean/cardano-client-lib)'s offline Cardano operations — key derivation, address handling, transaction building and signing, Plutus data, governance keys — to Python as a native library. No JVM, no C extension: pure `ctypes` over `libmesmo`, a GraalVM native-image build of CCL.

Requires Python ≥ 3.8. The only runtime dependency is `pyyaml`.

## Documentation

| Document | Contents |
|---|---|
| [API reference](api.md) | Every class and method: `Mesmo`, accounts, address, crypto, tx, plutus, script, gov, wallet, quicktx |
| [Building transactions](transactions.md) | The full workflow with worked examples: payments, staking, governance, minting, Plutus |
| [Providers & evaluators](providers.md) | Fetching UTXOs/protocol params from Yaci DevKit or Blockfrost; remote script-cost evaluation |
| [Troubleshooting](troubleshooting.md) | Native library resolution, platform support, common errors |
| [TxPlan (YAML) reference](../quicktx.md) | The transaction description format used by `quicktx.build` — shared by all four language wrappers |

## Installation

```bash
pip install --pre mesmo
```

> `--pre` is required until 1.0: `0.1.0-preN` normalizes to `0.1.0rcN` under PEP 440, and pip skips
> pre-releases unless asked.

> If the package is not yet available on PyPI for your platform, install a wheel from the project's [GitHub releases](https://github.com/bloxbean/mesmo/releases), or build one locally: `./gradlew :wrappers:python:wheel` (produces `wrappers/python/dist/*.whl`). Wheels bundle the native library — nothing else to install.

For development against a locally built native library, skip the wheel and point the package at it:

```bash
export PYTHONPATH=/path/to/mesmo/wrappers/python
export MESMO_LIB_PATH=/path/to/mesmo/core/build/native/nativeCompile
```

## Quick start

```python
from mesmo import Mesmo, Network

with Mesmo() as lib:
    # Create a new managed account (testnet). Its info never contains the phrase;
    # export the recovery phrase once, deliberately.
    with lib.accounts.create(Network.TESTNET) as account:
        print(account.info["base_address"])   # addr_test1...
        print(account.info["stake_address"])  # stake_test1...
        mnemonic = account.export_recovery_phrase()

    # Restore it later from the phrase.
    with lib.accounts.from_mnemonic(mnemonic, Network.TESTNET) as restored:
        assert restored.info["base_address"] == account.info["base_address"]
```

The context manager tears down the native isolate on exit; equivalently, call `lib.close()` in a `finally` block.

### Build, sign, and inspect a transaction — fully offline

Transactions are described as a [TxPlan YAML document](../quicktx.md). You supply the UTXOs and protocol parameters (from any source — see [providers](providers.md) for ready-made ones), and get back an unsigned transaction:

```python
yaml = f"""
version: 1.0
transaction:
  - tx:
      from: {sender.info["base_address"]}
      intents:
        - type: payment
          address: {receiver}
          amounts:
            - unit: lovelace
              quantity: "5000000"
"""

result = lib.quicktx.build(yaml, utxos, protocol_params)
# result = {"tx_cbor": ..., "tx_hash": ..., "fee": ...}

signed = sender.sign_tx(result["tx_cbor"])   # sender = lib.accounts.from_mnemonic(...)
# submit `signed` with any HTTP client — the library never talks to the network
```

With a provider, fetching the chain data is one call:

```python
from mesmo import YaciProvider

provider = YaciProvider()  # local Yaci DevKit
result = lib.quicktx.build_with(yaml, provider, [account["base_address"]])
```

## Design in one paragraph

The native library is **offline and stateless** — it derives, builds, signs, hashes, and serializes, but never performs I/O. Anything that touches the network (fetching UTXOs, protocol parameters, submitting transactions, remote script evaluation) lives in the wrapper or in your code, where you control HTTP. Plutus execution units are computed offline in-process (via Scalus) by default, so even script transactions build without a network connection.

## Threading

A single `Mesmo` instance is **safe to share across threads** — each OS thread is attached to the GraalVM isolate lazily and gets its own native call state, so it works naturally in threaded web servers (Flask/FastAPI/gunicorn, `ThreadPoolExecutor`). Just never use an instance after `close()`; that raises `MesmoClosedError`.

## Networks

```python
from mesmo import Network

Network.MAINNET  # 0
Network.TESTNET  # 1
```

Every key-derivation method requires an explicit `network` argument — there is no default; omitting it raises `TypeError`. `Network` is an `IntEnum`, and out-of-range ints raise `ValueError` at the wrapper boundary. Note the values are CCL enum ordinals, which are the **inverse** of Cardano's on-chain network id for mainnet/testnet (`Network.MAINNET == 0`, but a mainnet address's on-chain `network_id` is `1`). See [API reference → Networks](api.md#networks).

## Examples

Runnable examples live in [`wrappers/python/examples/`](../../wrappers/python/examples):

- `01_account_and_keys.py` — create/restore accounts, derive keys and DRep id
- `02_primitives.py` — mnemonics, Blake2b hashing, Ed25519 sign/verify, address parsing
- `03_build_and_sign_tx.py` — offline QuickTx build + sign
- `04_plutus_evaluator.py` — Plutus mint with offline Scalus units vs. remote Blockfrost evaluation
