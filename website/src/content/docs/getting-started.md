---
title: Getting Started
description: Install a wrapper package and build your first offline Cardano transaction in Python, Go, Rust, or JavaScript.
---

Pick your language, install the package, and you're building transactions offline in minutes — the native library comes bundled or is fetched automatically; there is nothing else to install and **no JVM**.

## Install

### JavaScript (Bun)

```bash
bun add @bloxbean/mesmo
```

Requires [Bun](https://bun.sh) 1.0+ — Node.js is [not supported](../reference/limitations/#javascript-runs-on-bun-only). The platform-specific native library arrives via `optionalDependencies`.

### Go

```bash
go get github.com/bloxbean/mesmo/wrappers/go
```

Go 1.21+. Pure Go (no cgo, no C toolchain): the module loads `libmesmo` with purego and downloads it once on first use (then cached). Set `MESMO_LIB_PATH` to use a local build instead.

### Rust

```toml
[dependencies]
mesmo = { package = "mesmo", version = "0.1" }
```

Rust 1.70+. `build.rs` fetches the matching native library at first build. Add `features = ["providers"]` for the HTTP provider/evaluator helpers.

### Python

```bash
pip install mesmo
```

Python 3.8+. Platform wheels bundle the native library; the only dependency is `pyyaml`.

## First program

Create an account and build a payment, fully offline (Python shown — the [other guides](../overview/#the-four-wrappers) have the same example idiomatically):

```python
from mesmo import Mesmo, Network

with Mesmo() as lib, lib.accounts.create(Network.TESTNET) as account:
    address = account.info["base_address"]
    print(address)                   # addr_test1... (info is public data — never the mnemonic)

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
    # Supply UTXOs + protocol params yourself, or use a provider (see below)
    result = lib.quicktx.build(yaml, utxos, protocol_params)
    signed = account.sign_tx(result["tx_cbor"])
    # Submit `signed` with any HTTP client — the library never submits.
    # To keep the account: account.export_recovery_phrase() returns the phrase once, deliberately.
```

The transaction is described as [TxPlan YAML](../reference/txplan/); the library selects UTXOs, calculates the fee, and handles change. For fetching UTXOs and protocol parameters conveniently, each wrapper ships optional providers (Yaci DevKit, Blockfrost) — see the per-language *Providers & Evaluators* pages.

## Next steps

- Your language's guide: [JavaScript](../js/) · [Go](../go/) · [Rust](../rust/) · [Python](../python/)
- [Building transactions](../python/transactions/) — payments, staking, governance, minting, Plutus, and which keys sign what
- [Platforms & Packages](../reference/platforms/) — supported OS/arch matrix
- [Using with AI agents](../ai/) — make your AI assistant productive with the bindings immediately
