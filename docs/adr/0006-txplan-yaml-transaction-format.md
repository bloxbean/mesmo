# ADR-0006: TxPlan (YAML) as the transaction-building format, replacing the bespoke JSON spec

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** bloxbean maintainers

## Context

The bridge originally defined transactions with a **bespoke JSON operations spec**, parsed by
hand-written mappers (~1,500 LOC) into CCL `Tx`/`ScriptTx`, plus large per-language fluent builders
(~10k LOC) whose only job was to emit that JSON. CCL `0.8.0-pre4` ships **TxPlan** — a first-class YAML
transaction format that deserializes into CCL's own `AbstractTx` objects and builds offline to CBOR.

The bridge is new and pre-1.0 with, as far as we know, **no production consumers yet**, so we were free
to replace the transaction format outright rather than evolve it — and doing so now, before adoption, is
the point at which it costs nothing.

## Decision

Adopt CCL **TxPlan (YAML)** as the transaction-building input. `mesmo_quicktx_build` takes a TxPlan YAML
document plus caller-supplied chain data ([ADR-0002](0002-offline-stateless-no-provider.md)) and returns
the result as **YAML** (`tx_cbor`, `tx_hash`, `fee`). Delete the bespoke spec, its mappers, the provider
path, and all per-language fluent builders; wrappers become thin pass-throughs
([ADR-0003](0003-four-language-wrappers-uniform-ffi.md)).

## Consequences

- ~−11,300 net LOC; one authoritative format (CCL's own) instead of a custom one to maintain.
- Wrappers reduce to `build(yaml, utxos, protocolParams, execUnits?)`.
- Couples us to CCL's TxPlan schema and to a **preview** release (`0.8.0-pre4`) — re-pin when `0.8.0`
  is stable.
- The input/output format changed completely, but with no known consumers this was a clean swap, not a
  migration — and adopting TxPlan pre-1.0 is what spares us a genuinely breaking change later.

## Alternatives considered

- **Keep/extend the bespoke spec** — perpetual maintenance and divergence from CCL.
- **JSON result output** — chose YAML in *and* out for consistency with the TxPlan format.
