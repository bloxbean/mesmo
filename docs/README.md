# Documentation

User documentation for the four language wrappers, plus shared references.

## Per-language user guides

Each guide covers installation, a quick start, the full API reference, a transaction-building guide with worked examples, chain-data providers/evaluators, and troubleshooting:

| Language | Guide | Package |
|---|---|---|
| JavaScript (Bun) | [docs/js](js/README.md) | `@bloxbean/mesmo` (npm) |
| Go | [docs/golang](golang/README.md) | `github.com/bloxbean/mesmo/wrappers/go` |
| Rust | [docs/rust](rust/README.md) | `cardano-client-lib` (crate, imported as `mesmo`) |
| Python | [docs/python](python/README.md) | `cardano-client-lib` (PyPI, imported as `mesmo`) |

The four wrappers expose the same functionality with the same semantics — same API groups (account, address, crypto, tx, plutus, script, gov, wallet, quicktx), same error codes, same [TxPlan YAML](quicktx.md) transaction format — differing only in language idiom (see [ADR-0015](adr/0015-no-reference-wrapper-parity.md)).

## Shared references

- [QuickTx / TxPlan (YAML)](quicktx.md) — the transaction description format used by every wrapper's `quicktx` build API: structure, chain-data shapes, worked examples, and the full intent catalog (staking, governance, pools, minting, Plutus) with verified YAML shapes.
- [Architecture Decision Records](adr/) — why things are the way they are: native shared library over FFI, offline/stateless design, Bun-only JS, provider design, Plutus evaluation, platform baselines, and more.

## For contributors

Building the native library itself, running wrapper test suites, and the release process are covered in the repository root: [README](../README.md), [RELEASING](../RELEASING.md), and [devkit notes](../devkit.md) for the integration-test devnet.
