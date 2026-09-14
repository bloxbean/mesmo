# ADR-0002: Offline, stateless bridge — caller-supplied chain data, no HTTP provider in libccl

- **Status:** Accepted
- **Date:** 2026-02-11
- **Deciders:** bloxbean maintainers

## Context

Transaction building needs chain data — UTxOs and protocol parameters (and, for scripts, execution
units — [ADR-0007](0007-caller-supplied-plutus-exec-units.md)). CCL can fetch these via providers
(Blockfrost/Koios/Ogmios). Baking HTTP providers into the native library would pull networking, retry
state, configuration, and secret handling into what is otherwise a side-effect-free FFI boundary — and
every host language already has excellent HTTP clients.

## Decision

`libccl` is **offline, stateless, and side-effect-free**: it makes no network calls and never submits.
The **caller supplies all chain data** as explicit inputs (UTxOs, protocol parameters; exec units for
Plutus). One deliberate, narrow exception to statelessness exists — managed Account handles
([ADR-0016](0016-managed-account-signing-handles.md)): `libccl` may hold caller-created, in-memory
signing capabilities (account-level keys) behind opaque handles, scoped to one isolate and released
by an explicit `close`. Everything else stands: no network calls, no providers, no configuration,
caller-supplied chain data, no submission. HTTP provider modules are **out of scope for the native
lib**. Optional convenience helpers
that *fetch* this data may live in the **wrappers** ([ADR-0003](0003-four-language-wrappers-uniform-ffi.md)),
using each language's own HTTP client — never inside `libccl`.

## Consequences

- Deterministic, easily testable; no secrets or keys inside the library beyond the ADR-0016 handle registry.
- Submission/broadcast is the caller's responsibility, with their own client.
- Callers must obtain UTxOs / params / exec units themselves — friction, mitigated by wrapper-side
  helpers: chain-data providers (UTxOs + protocol params) are **implemented** in all four wrappers
  ([ADR-0011](0011-wrapper-side-chain-data-providers.md)), and exec-unit evaluators are too — an
  offline Scalus default in the core plus pluggable remote evaluators in the wrappers
  ([ADR-0013](0013-transaction-evaluators.md)). The native lib remains offline: Scalus runs
  in-process, and the remote path lives wrapper-side.
- No lazy fetching; integration tests pass static data in.

## Alternatives considered

- **Built-in HTTP provider in libccl** — rejected: state, networking, and secrets inside an FFI lib.
- **Provider as a separate native module** — possible future, but wrapper-side helpers are preferred
  to keep the core pure.
