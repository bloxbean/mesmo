# Architecture Decision Records (ADRs)

This directory records the **significant architectural decisions** for Cardano Client Bindings — the *why*
behind choices that aren't obvious from the code, so a future maintainer doesn't unknowingly
undo them.

## Convention

- One decision per file, named `NNNN-kebab-title.md` (zero-padded, e.g. `0001-...`).
- ADRs are **immutable once Accepted**. To change a decision, write a *new* ADR and mark the old
  one `Superseded by ADR-XXXX` — don't rewrite history.
- Numbered in the order they are **recorded**. Several here are *retrospective* — they document
  decisions taken earlier in the project; the **Date** field reflects when the decision was
  actually made, not when it was written down.
- Start from [`template.md`](template.md).

## Status legend

`Proposed` → under discussion · `Accepted` → in effect · `Superseded` → replaced by a later ADR ·
`Deprecated` → no longer relevant · `Withdrawn` → removed as not an architectural decision (number
stays reserved).

## Index

| ADR | Title | Status | Decided |
|-----|-------|--------|---------|
| [0001](0001-native-shared-library-ffi.md) | Native shared library via GraalVM native-image + C FFI | Accepted | 2026-02-11 |
| [0002](0002-offline-stateless-no-provider.md) | Offline, stateless bridge — caller-supplied chain data, no HTTP provider in libccl | Accepted | 2026-02-11 |
| [0003](0003-four-language-wrappers-uniform-ffi.md) | One FFI, four language wrappers — uniform thin contract with explicit inputs | Accepted | 2026-02-11 |
| [0004](0004-bun-only-javascript-runtime.md) | Bun is the only supported JavaScript runtime | Accepted | 2026-02-11 |
| [0005](0005-oracle-graalvm-25.md) | Standardize on Oracle GraalVM 25.0.3 | Accepted | 2026-06-10 |
| [0006](0006-txplan-yaml-transaction-format.md) | TxPlan (YAML) transaction format, replacing the bespoke JSON spec | Accepted | 2026-06-11 |
| [0007](0007-caller-supplied-plutus-exec-units.md) | Plutus execution units are caller-supplied; evaluator-agnostic | Accepted | 2026-06-11 |
| [0008](0008-linux-glibc-baseline-portability.md) | Linux portability — glibc-baseline build + `-march=compatibility` (not static) | Accepted | 2026-06-25 |
| 0009 | *Withdrawn* — branch & release process; a workflow, not an architectural decision (see [RELEASING.md](../../RELEASING.md)). The number stays reserved rather than renumbering. | Withdrawn | — |
| [0010](0010-go-isolate-thread-affinity.md) | Go wrapper isolate thread-affinity — all FFI on one dedicated OS thread | Accepted | 2026-06-10 |
| [0011](0011-wrapper-side-chain-data-providers.md) | Wrapper-side chain-data provider helpers (UTxOs + protocol params) | Accepted | 2026-06-30 |
| [0012](0012-native-lib-bundled-in-wrapper-packages.md) | Distribute the native library bundled in per-wrapper platform packages | Accepted | 2026-07-01 |
| [0013](0013-transaction-evaluators.md) | Transaction evaluators — Scalus default in the core, pluggable remote evaluators in the wrappers | Accepted | 2026-07-03 |
| [0014](0014-go-distribution-purego-runtime-resolution.md) | Go distribution — purego + runtime library resolution (supersedes ADR-0012's Go mechanism) | Accepted | 2026-07-07 |
| [0015](0015-no-reference-wrapper-parity.md) | No reference wrapper — keep the four wrappers at parity | Accepted | 2026-07-10 |
| [0016](0016-managed-account-signing-handles.md) | Encapsulate signing secrets in managed Account handles | Accepted | 2026-08-26 |
