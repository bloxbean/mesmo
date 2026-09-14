# ADR-0007: Plutus execution units are caller-supplied; the bridge stays evaluator-agnostic

- **Status:** Accepted — evolved by [ADR-0013](0013-transaction-evaluators.md)
- **Date:** 2026-06-11
- **Deciders:** bloxbean maintainers

[ADR-0013](0013-transaction-evaluators.md) builds on this decision: the bridge also ships a
**default** evaluator (Scalus, offline in the native image) used when the caller supplies no units,
plus a wrapper-side pluggable `Evaluator` for remote evaluation. Caller-supplied units always take
precedence, so the contract described here remains valid; it is not the *only* path.

## Context

Building Plutus script transactions requires **execution units** (memory + CPU steps) per redeemer,
normally produced by a UPLC evaluator. CCL `0.8.0-pre4` has no offline UPLC evaluator usable inside a
GraalVM native image; running scripts in-library would mean bundling an evaluator (e.g.
`aiken-java-binding`), which is not feasible/initializable in a native image today.

## Decision

Treat exec units like UTxOs and protocol params — a **caller-supplied input** (`exec_units_json`, one
`{mem, steps}` per redeemer in transaction order). The bridge wires CCL's `StaticTransactionEvaluator`
to stamp them onto the transaction and **never runs the script**. Callers compute units with whatever
evaluator they prefer (Blockfrost / Ogmios / Aiken / Scalus). A script build with no units fails with a
clear error.

## Consequences

- Offline Plutus building works today, consistent with the offline contract
  ([ADR-0002](0002-offline-stateless-no-provider.md)).
- The bridge stays evaluator-agnostic; users pick and choose.
- Users need an external evaluator to *obtain* the units — planned wrapper helpers (TODO §2b).
- Self-contained in-library evaluation is deferred (spike: `aiken-java-binding` inside the native image).

## Alternatives considered

- **Bundle a UPLC evaluator inside libccl** — not feasible in a native image today; revisit later.
- **Refuse Plutus entirely** — too limiting; scripts are core to Cardano use.
