# ADR-0013: Transaction evaluators — Scalus default in the core, pluggable remote evaluators in the wrappers

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** bloxbean maintainers

## Context

Building a Plutus-script transaction needs each redeemer's **execution units** (`{mem, steps}`).
[ADR-0007](0007-caller-supplied-plutus-exec-units.md) made these **caller-supplied**: the bridge wired
CCL's `StaticTransactionEvaluator` and stayed evaluator-agnostic, so the user had to obtain the units
themselves (Ogmios, Blockfrost, Aiken, Scalus, …) and pass them in. That is correct but unfriendly —
the common case ("just build my Plutus tx") requires an out-of-band evaluation step.

Two facts change the calculus:

1. **Scalus can now run inside `libmesmo`.** Scalus's UPLC evaluator (`ScalusTransactionEvaluator`,
   Scala 3 + a secp256k1 JNI lib) **compiles into the GraalVM native image and computes real units**
   (proven end-to-end: a PoC built an always-succeeds mint with no supplied units and got
   `mem=1400, steps=208100`, both on the JVM and over FFI against `libmesmo`). So the bridge can compute
   units **offline, in-process, with no network**.
2. **We must not assume Scalus stays sufficient.** It is powerful today, but script/ledger evolution
   may outpace it. A **remote evaluator must always be available as a fallback** — and the obvious one
   is a Blockfrost-compatible `/utils/txs/evaluate` endpoint.

The hard constraint that shapes everything: **`libmesmo` cannot make HTTP calls.**
[ADR-0002](0002-offline-stateless-no-provider.md) makes the native library offline and stateless — it
never opens a socket. So a *remote* evaluator cannot live in the core; it must live in the wrappers,
exactly like the chain-data [providers](0011-wrapper-side-chain-data-providers.md).

## Decision

**Two tiers of evaluation, split along the offline/online line:**

1. **Core default — Scalus (offline, in the native image).** When the caller supplies no execution
   units for a script tx, `QuickTxService` falls back to `ScalusTransactionEvaluator`, which runs the
   validator in-process and computes the units. No network, no extra input beyond the protocol params'
   cost models. Explicit caller-supplied units still take precedence (`StaticTransactionEvaluator`).

2. **Wrapper-side pluggable `Evaluator` interface (online).** A thin interface, the exact counterpart
   of `Provider`:

   ```
   Evaluator.evaluate(tx_cbor, resolved_utxos) -> [{mem, steps}]   # one per redeemer, in order
   ```

   with a `BlockfrostEvaluator` implementation (`/utils/txs/evaluate`). When a wrapper caller passes an
   `Evaluator`, the wrapper runs the **two-pass** flow — build a draft tx, call `evaluate()` over HTTP,
   rebuild with the returned units — and hands the real units to the offline core. The core never sees
   the network.

**Precedence (highest wins):** explicit units → wrapper `Evaluator` → core Scalus default.
A **null/absent `Evaluator` means "use the Scalus default"** (null-object pattern) — the caller opts
*out* of the default by passing a remote evaluator, never has to opt *in*.

As with providers, a single backend may implement **both** interfaces: one `BlockfrostBackend` object
can be the `Provider` (utxos/params) *and* the `Evaluator` (evaluate) — separate interfaces, composable.

Rust keeps the HTTP evaluator behind the existing `providers` feature (no HTTP dep in the offline core
build). This ADR **evolves ADR-0007**: the bridge is no longer purely "caller-supplied / evaluator-
agnostic" — it now ships a default (Scalus) and a pluggable remote path, while still accepting
caller-supplied units.

## Consequences

- The common case works with **no evaluation step**: a Plutus build with no units computes them via
  Scalus offline. Users who want a remote/authoritative evaluator pass a wrapper `Evaluator`.
- Scalus adds **~12 MB** and Scala 3 + a secp256k1 JNI lib to `libmesmo` (60 MB total). Validated to
  compile + run in the native image across CI platforms.
- Scalus **needs cost models** in the protocol params; when absent we fall back to Scalus's reference
  params (`MachineParams.defaultPlutusV2PostConwayParams`) rather than failing.
- The remote path needs **network at build time** (the two-pass HTTP call) — that cost is opt-in, only
  when a caller passes a remote `Evaluator`.
- `Evaluator` is symmetric to `Provider`, so the wrapper surface stays consistent (same "supply an
  object with these methods, or use ours" shape), and one object can serve both roles.
- Each wrapper implements the interface + `BlockfrostEvaluator` itself (four small, parallel additions).

## Alternatives considered

- **Fold execution units into the `Provider` interface** (a `provider.evaluate()` method). Rejected:
  the backends don't line up 1:1 — Scalus/Aiken/Ogmios are *evaluate-only* with no data-fetch, and a
  data-only indexer (Koios) can't evaluate. Folding forces evaluate-only backends to stub `utxos()`.
- **A remote evaluator inside the core.** Rejected: `libmesmo` is offline by [ADR-0002]; it cannot do
  HTTP. Remote evaluation is inherently a wrapper concern.
- **Scalus-only, no remote fallback.** Rejected on the second premise above — we cannot assume Scalus
  stays sufficient, so a remote fallback must always be reachable.
- **Keep caller-supplied-only ([ADR-0007] as-is).** Rejected: it leaves the common "just build it" case
  requiring an out-of-band step, now that we can evaluate offline for free.
