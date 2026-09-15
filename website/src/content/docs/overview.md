---
title: Overview
description: Cardano Client Lib as a native shared library, callable from Python, Go, Rust, and JavaScript — no JVM required.
---

Mesmo compiles [Cardano Client Lib (CCL)](https://github.com/bloxbean/cardano-client-lib) into a native shared library (`libmesmo.so` / `libmesmo.dylib` / `libmesmo.dll`) using GraalVM native-image. Any language can call CCL's offline Cardano operations via FFI — **no JVM required at runtime**.

## Where this fits in the ecosystem

To be clear about what this is *not*: Cardano has excellent native libraries in all four of these languages — [pycardano](https://github.com/Python-Cardano/pycardano) (Python), [MeshJS](https://meshjs.dev) and [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution) (TypeScript), [pallas](https://github.com/txpipe/pallas) (Rust), [gOuroboros](https://github.com/blinklabs-io/gouroboros) and [Apollo](https://github.com/Salvionied/apollo) (Go), among others. If one of them serves your needs, use it — these bindings are not trying to replace them.

The bindings exist for the cases where a native library doesn't quite fit:

- **Filling functionality gaps.** When your library is missing a capability — Conway-era governance operations, offline Plutus execution-unit costing, DRep/committee key derivation, HD wallets — the bindings give you CCL's full offline surface for exactly those pieces. Because they're offline and stateless, they slot in *alongside* your existing library; no rip-and-replace.
- **A different API model.** If you're not happy with an imperative builder API, CCL's declarative [TxPlan YAML](../reference/txplan/) — describe the transaction, let the library select UTXOs, compute fees, and handle change — may fit you better.
- **One behavior, four languages.** When the same transaction-building semantics must hold across polyglot services, a single core beats four independent implementations that can drift.
- **CCL semantics outside the JVM.** Teams already using Cardano Client Lib get the same behavior — same test suite, same edge cases — in their non-JVM code.
- **A maintained fallback.** Native libraries have occasionally gone unmaintained; these bindings ride on CCL's active maintenance.

The honest costs of this approach: a ~50 MB platform-specific native binary in your dependency tree, no node-protocol/chain-sync support (offline operations only, by design), and [platform gaps](../reference/platforms/) a pure-language library wouldn't have.

## Why?

Cardano Client Lib is a mature, feature-rich Cardano SDK covering key derivation, transaction building, Plutus data handling, governance, and more. Mesmo makes selected CCL modules available as a **native shared library with a C ABI**, so Python, Go, Rust, and JavaScript reuse CCL's exact, well-tested behavior — whether as the foundation for a wrapper library, a transaction builder, or for individual functions like crypto, address parsing, and CBOR serialization.

## What's included

The bindings expose CCL's **offline/local** operations:

| Area | Operations |
|---|---|
| **Account** | Create accounts, derive keys, export public/private keys, sign transactions |
| **Address** | Parse, validate, convert between bech32 and bytes |
| **Crypto** | Blake2b hashing, mnemonic generation/validation, Ed25519 sign/verify |
| **Transaction** | Serialize, deserialize, hash, sign transactions |
| **Plutus** | PlutusData CBOR/JSON conversion, datum hashing |
| **Script** | Native script parsing, script hashing |
| **Governance** | DRep, committee cold/hot key derivation |
| **HD Wallet** | Create wallets, derive addresses |
| **QuickTx** | [TxPlan YAML](../reference/txplan/)-driven offline transaction builder: payments, staking, governance, Plutus scripts, multi-party compose |

Backend/HTTP modules (Blockfrost, Koios, Ogmios) are **intentionally excluded** from the native library — every language has good HTTP clients, and each wrapper ships optional [provider helpers](../reference/limitations/#offline-by-design) instead.

## The four wrappers

All four wrappers are first-class and kept at strict parity — same API groups, same error codes, same TxPlan format — differing only in language idiom:

| Language | Guide | Package |
|---|---|---|
| JavaScript (Bun) | [docs](../js/) | `@bloxbean/mesmo` (npm) |
| Go | [docs](../go/) | `github.com/bloxbean/mesmo/wrappers/go` |
| Rust | [docs](../rust/) | `mesmo` (crate, imported as `ccl`) |
| Python | [docs](../python/) | `mesmo` (PyPI, imported as `ccl`) |

## How big is it?

The native library is a **~50–60 MB** platform-specific binary (the embedded [Scalus](https://scalus.org) UPLC evaluator for offline Plutus costing accounts for ~12 MB of that). Wrapper packages that bundle it (Python wheels, npm platform packages) are correspondingly large; Go and Rust fetch it once and cache it. See [Platforms & Packages](../reference/platforms/) for the full story, and [Caveats & Limitations](../reference/limitations/) before relying on specific functions.

## Where to next

- [Getting Started](../getting-started/) — install and run a first example in your language
- [AI Agents](../ai/) — point Claude Code, Cursor, or any agent at the AI Starter Pack
- [TxPlan (YAML) reference](../reference/txplan/) — the transaction format shared by all wrappers
- [Architecture](../reference/architecture/) — the ADRs behind the design
