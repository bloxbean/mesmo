# ADR-0011: Wrapper-side chain-data provider helpers

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** bloxbean maintainers

## Context

[ADR-0002](0002-offline-stateless-no-provider.md) keeps `libccl` offline and provider-free: the
caller supplies UTxOs and protocol parameters (and, for Plutus, execution units —
[ADR-0007](0007-caller-supplied-plutus-exec-units.md)) as explicit inputs to `build`. That ADR also
recorded the intended mitigation for the resulting friction: *optional* convenience helpers that
*fetch* this data should live in the wrappers, using each language's own HTTP client. This ADR
records the concrete design of those helpers (the chain-data half: UTxOs + protocol params), now that
they are implemented in all four wrappers ([ADR-0003](0003-four-language-wrappers-uniform-ffi.md)).

## Decision

Each wrapper ships an **optional** `ChainDataProvider` abstraction with exactly two operations —
`utxos(address)` and `protocol_params()` — returning data in the shape `build` already accepts. We
will:

- Ship two reference implementations: **`YaciProvider`** (Yaci DevKit / yaci-store, Blockfrost-style
  REST; the CI-tested one) and **`BlockfrostProvider`** (project-id header, 100/page pagination,
  owning-address injection on each UTxO, `/epochs/latest/parameters`).
- Expose a **`build_with(yaml, provider, senders)`** convenience on the QuickTx
  API that composes per-sender `provider.utxos` calls (merged and de-duplicated by `(tx_hash, output_index)`) + `provider.protocol_params()` with the offline `build`.
  (Renamed from `build_with_provider`; it gained an optional `evaluator` argument in
  [ADR-0013](0013-transaction-evaluators.md) — execution units are no longer passed here.)
  The offline core imports no networking; the provider is duck-typed/interface-typed and only the
  convenience method touches it.
- Do **no UTxO selection** in the helper — the bridge selects internally (it hands all of the
  sender's UTxOs to CCL). A provider only answers "all UTxOs at address X".
- Use each language's own HTTP client and **add no mandatory dependency** to the offline core: Python
  `urllib` (stdlib), Go `net/http` (stdlib), JS Bun `fetch` (built-in), Rust `ureq` **behind an
  optional `providers` Cargo feature** so the default crate pulls in no HTTP/TLS stack.

Out of scope: provider modules inside `libccl` (forbidden by ADR-0002); UTxO-selection strategies;
exec-unit evaluators (the §2b sibling — since shipped in
[ADR-0013](0013-transaction-evaluators.md), which also gave `build_with` its optional `evaluator`
argument).

## Consequences

- A first-time user reaches a built transaction without hand-rolling HTTP calls, in every language,
  while the native lib stays offline, deterministic, and secret-free.
- Adding a backend (Koios, Ogmios, …) is a wrapper-only change: implement the two methods.
- Cost models fetched from a provider flow through the JS wrapper's `normalizeCostModels`, which
  prefers the ordered `cost_models_raw` form and converts the deprecated numeric-keyed `cost_models`
  map only as a fallback. This is a JavaScript-only concern (JS reorders numeric-string object keys,
  unlike Go/Python). Providers that already emit `cost_models_raw` (real Blockfrost, yaci-store's own
  API) pass through untouched; the DevKit `:10000` proxy currently emits the numeric form, so the
  conversion is still load-bearing. Removal once every endpoint we fetch from returns `cost_models_raw`
  is tracked in [cardano-client-bindings#11](https://github.com/bloxbean/cardano-client-bindings/issues/11).
- Rust consumers must opt in with `features = ["providers"]`; the helpers are absent otherwise.
- `BlockfrostProvider` is validated against mocked responses, not live in CI (a Blockfrost key would
  be required); `YaciProvider` is exercised live by the DevKit integration suites.

## Alternatives considered

- **Bake providers into `libccl`** — rejected by ADR-0002 (networking, retries, secrets in the FFI
  core).
- **A separate native provider module** — noted as a possible future in ADR-0002, but wrapper-side
  helpers keep the core pure and reuse each language's mature HTTP ecosystem.
- **Make Rust's `ureq` a hard dependency** — rejected: it would force an HTTP/TLS stack on every
  consumer of the offline core; an optional feature keeps the default build lean.
- **Do UTxO selection in the helper** — unnecessary and duplicative; CCL already selects from the
  full UTxO set, so the helper stays a thin fetch.
