---
title: Caveats & Limitations
description: What the bindings deliberately do not do, what does not work yet, and the sharp edges to know about before building on them.
---

An honest list — read this before building on the bindings. Items are marked **by design** (a deliberate architectural decision, see the [ADRs](../architecture/)) or **current limitation** (expected to improve).

## Offline by design

**By design.** The native library is offline, stateless, and side-effect-free: it makes **no network calls and never submits a transaction**. You supply chain data (UTXOs, protocol parameters) and submit the signed CBOR yourself with any HTTP client. Optional wrapper-side providers (Yaci DevKit, Blockfrost) and remote evaluators exist as conveniences — networking lives in the wrappers, never in `libccl`. Backend modules like Blockfrost/Koios/Ogmios clients are intentionally out of scope.

## JavaScript runs on Bun only

**By design (for now).** Node.js FFI libraries (`ffi-napi`, `koffi`) crash against GraalVM native-image libraries; Bun's built-in `bun:ffi` works. Node support is wanted-but-blocked, not committed — revisit if Node FFI stabilizes.

## Functions not usable yet

**Current limitation.** A few native-library functions hit GraalVM reflection-configuration gaps and fail at runtime in **all four wrappers**:

| Broken | Use instead |
|---|---|
| `tx.from_json` / `tx.sign_with_secret_key` | `account.sign_tx` (mnemonic-based signing) |
| `plutus.data_to_json` / `plutus.data_from_json` | `plutus.data_hash` works; keep PlutusData as CBOR hex |

## Plutus execution units

Plutus transactions build fully offline: when you supply no execution units, the embedded **Scalus** UPLC evaluator computes them in-process. Caveats:

- Scalus needs **cost models** in the protocol parameters; when absent, reference parameters are used as a fallback.
- For node-authoritative costing, pass a remote evaluator (e.g. Blockfrost `/utils/txs/evaluate`) — the wrapper then does a two-pass build. Explicit units always take precedence.
- Script/ledger evolution may outpace the embedded evaluator; the remote path is the escape hatch.

## Threading models differ per language

- **Python**: one `CclLib` may be shared across threads — each OS thread attaches to the isolate lazily.
- **Go**: all native calls are **serialized** onto one dedicated OS thread per `Bridge` (GraalVM isolates are thread-affine and goroutines migrate). Correctness over raw concurrency; use multiple `Bridge` instances for parallelism.
- After `close()`, calls fail with a catchable error (e.g. Python's `CclClosedError`) — this guards against passing a stale isolate handle to the native side, which would abort the whole process.

## Format & versioning caveats

- **Pre-1.0, tracking a preview CCL.** The bindings target CCL `0.8.0-pre4`; the TxPlan schema is CCL's and will be re-pinned when CCL `0.8.0` stabilizes. Expect breaking changes before 1.0.
- **Wrapper ↔ library version lock.** The wrapper and native library must match on base semver; a mismatch fails fast at load (`CCL_SKIP_VERSION_CHECK=1` overrides at your own risk).
- **Network enum ≠ on-chain network id.** `Network.MAINNET == 0` but a mainnet address's on-chain `network_id` is `1`. Never feed `address.info()["network_id"]` back into an API that takes a `network`.
- **Quantities are strings.** Chain data carries amounts as strings (`"quantity": "5000000"`) to avoid 2^53 float truncation — mind this in JavaScript especially.

## Signing needs the right key roles

`account.sign_tx(tx_cbor)` witnesses with the **payment key only**. Stake, DRep, and committee certificates need their own witnesses — combine `SigningRole` flags (`PAYMENT`, `STAKE`, `DREP`, `COMMITTEE_COLD`, `COMMITTEE_HOT`) with `|`; otherwise the node rejects with `MissingVKeyWitnessesUTXOW`. Each language's *Building Transactions* page has the intent → roles table.

## Platform gaps

macOS Intel and Windows ARM64 have no prebuilt library; Alpine Python installs from source until musllinux wheels publish. Full matrix: [Platforms & Packages](../platforms/).
