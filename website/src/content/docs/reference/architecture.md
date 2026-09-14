---
title: Architecture (ADRs)
description: The architecture decision records behind the bindings — why things are the way they are.
---

Significant decisions are recorded as [Architecture Decision Records](https://github.com/bloxbean/mesmo/tree/develop/docs/adr) in the repository — the *why* behind choices that aren't obvious from the code. The short version:

| Decision | ADR |
|---|---|
| CCL compiled to a native shared library with a C ABI (GraalVM native-image); no JVM at runtime | [0001](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0001-native-shared-library-ffi.md) |
| The native lib is offline & stateless — caller-supplied chain data, no HTTP inside `libccl` | [0002](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0002-offline-stateless-no-provider.md) |
| Four thin language wrappers over one uniform FFI | [0003](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0003-four-language-wrappers-uniform-ffi.md) |
| Bun is the only supported JavaScript runtime | [0004](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0004-bun-only-javascript-runtime.md) |
| Toolchain pinned to Oracle GraalVM 25.0.3 | [0005](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0005-oracle-graalvm-25.md) |
| TxPlan (YAML) as the transaction format | [0006](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0006-txplan-yaml-transaction-format.md) |
| Plutus exec units caller-suppliable (evolved by 0013's Scalus default) | [0007](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0007-caller-supplied-plutus-exec-units.md) |
| Linux portability: glibc-2.17 baseline + `-march=compatibility`; musl as a separate artifact | [0008](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0008-linux-glibc-baseline-portability.md) |
| Go pins all FFI to one dedicated OS thread (isolate thread-affinity) | [0010](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0010-go-isolate-thread-affinity.md) |
| Chain-data providers live wrapper-side | [0011](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0011-wrapper-side-chain-data-providers.md) |
| Native lib ships bundled in per-wrapper platform packages | [0012](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0012-native-lib-bundled-in-wrapper-packages.md) |
| Evaluators: Scalus offline default in core, pluggable remote in wrappers | [0013](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0013-transaction-evaluators.md) |
| Go distribution: purego + runtime library resolution | [0014](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0014-go-distribution-purego-runtime-resolution.md) |
| No reference wrapper — all four kept at parity, enforced by CI | [0015](https://github.com/bloxbean/mesmo/blob/develop/docs/adr/0015-no-reference-wrapper-parity.md) |

(ADR-0009 was withdrawn — a release-process workflow, not an architectural decision; the number stays reserved.)

## The architecture in one paragraph

CCL (Java) is compiled by GraalVM native-image into `libccl`, exposing `ccl_*` entry points over a C ABI where data crosses as C strings (JSON/YAML/hex). Four thin wrappers — Python (ctypes), Go (purego), Rust (FFI), JS (Bun FFI) — bind the same entry-point set, verified by a CI parity check. The core is strictly offline; anything that touches the network (chain-data providers, remote evaluators) lives in the wrappers using each language's own HTTP stack. Transactions are described in CCL's TxPlan YAML and built offline, with Plutus execution units computed in-process by the embedded Scalus evaluator unless supplied or delegated to a remote evaluator.
