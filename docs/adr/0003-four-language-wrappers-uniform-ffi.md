# ADR-0003: One FFI, four language wrappers — a uniform, thin contract with explicit inputs

- **Status:** Accepted
- **Date:** 2026-02-11
- **Deciders:** bloxbean maintainers

## Context

The native library ([ADR-0001](0001-native-shared-library-ffi.md)) exposes a C ABI. We want first-class
support in **Python, Go, Rust, and JavaScript**, with consistent behavior and minimal maintenance.
Early wrappers carried large per-language *fluent builders* (~10k LOC across the four) whose only job
was emitting Mesmo's transaction format; these drifted and duplicated logic.

## Decision

Support exactly **four language wrappers** — Python (ctypes), Go (cgo), Rust, JavaScript (Bun FFI —
[ADR-0004](0004-bun-only-javascript-runtime.md)) — all binding the **same** C ABI. Keep wrappers
**thin**: they marshal inputs to the FFI and parse results; all logic lives once in the core. Chain
data (UTxOs, protocol params, Plutus exec units) is passed **explicitly** to the build call rather than
fetched ([ADR-0002](0002-offline-stateless-no-provider.md)).

We accept that explicit inputs are slightly more work for users today, and **plan an optional
convenience layer** (provider/evaluator helpers) per wrapper to make it easier — without moving logic
out of the core or breaking the offline contract. *(Since shipped: chain-data providers in
[ADR-0011](0011-wrapper-side-chain-data-providers.md), evaluators in
[ADR-0013](0013-transaction-evaluators.md).)*

## Consequences

- Consistent semantics across languages; a new feature = one core change + thin wrapper plumbing.
- The thin contract became concrete with the TxPlan migration
  ([ADR-0006](0006-txplan-yaml-transaction-format.md)), which deleted the fluent builders.
- Four FFI integrations to maintain, each with quirks (e.g. Go threading —
  [ADR-0010](0010-go-isolate-thread-affinity.md)).
- Users may still fetch chain data themselves; the optional convenience layer
  ([ADR-0011](0011-wrapper-side-chain-data-providers.md) /
  [ADR-0013](0013-transaction-evaluators.md)) removes the need to in the common case.

## Alternatives considered

- **Fat per-language builders** — drift and duplication; removed in ADR-0006.
- **Fewer languages / one blessed language** — less ecosystem reach.
- **Fetching inputs inside the wrappers by default** — kept optional, to preserve the explicit,
  offline contract and let users bring their own data source.
