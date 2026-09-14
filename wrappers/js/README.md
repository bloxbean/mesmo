# Cardano Client Bindings — JavaScript (Bun)

JavaScript bindings for [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib)
via the Cardano Client Bindings native library, using Bun's built-in FFI.

> Part of the [Cardano Client Bindings](../../README.md) project. See the
> [top-level README](../../README.md) for the full API reference and
> [`docs/quicktx.md`](../../docs/quicktx.md) for transaction building.

## Requirements

- [Bun](https://bun.sh/) 1.0+.

The native library is **bundled inside the platform package** — no separate download or
`CCL_LIB_PATH` needed for an installed package.

> **Node.js is not supported.** Node's FFI libraries (ffi-napi, koffi) crash against the
> GraalVM native library due to stack-boundary detection. Use Bun, whose built-in FFI
> works correctly. See the project [`TODO.md`](../../TODO.md) Non-Goals.

## Installing

**Recommended — a package that bundles the native library:**

```bash
bun add @bloxbean/cardano-client-lib                 # once published
# or, a locally built tarball:
bun add ./bloxbean-cardano-client-lib-0.1.0.tgz
```

The package ships the matching `libccl.*` under `libs/`, so `new CclBridge()` just works — nothing
else to set. Build the tarball locally with:

```bash
./gradlew :wrappers:js:pack           # -> wrappers/js/bloxbean-cardano-client-lib-*.tgz
```

At load time the bindings look for the library in this order: an explicit `new CclBridge(libPath)`,
the `CCL_LIB_PATH` env var, then the bundled `libs/` copy.

**Development — against a locally built library** (no package): point `CCL_LIB_PATH` at a directory
containing `libccl.{dylib,so,dll}`:

```bash
./gradlew :core:nativeCompile         # build from source (needs Oracle GraalVM 25.0.3), or
make download-lib                     # download a pre-built binary
export CCL_LIB_PATH=core/build/native/nativeCompile
```

At **runtime** the OS loader also needs it via `DYLD_LIBRARY_PATH` (macOS) /
`LD_LIBRARY_PATH` (Linux).

## Running the examples

From `wrappers/js`:

```bash
LIB_DIR=../../core/build/native/nativeCompile

CCL_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
  bun examples/account.js
```

The [`examples/`](examples/) directory contains:

| File | What it shows |
|------|---------------|
| [`account.js`](examples/account.js) | Create an account, restore from mnemonic, derive keys and a DRep ID |
| [`primitives.js`](examples/primitives.js) | Mnemonics, Blake2b hashing, Ed25519 signing, address parsing/validation |
| [`transaction.js`](examples/transaction.js) | Build an unsigned payment **offline** (QuickTx) and sign it — no node/DevKit needed |

## Quick start

```javascript
import { CclBridge, TESTNET } from './src/index.js';

const bridge = new CclBridge();      // loads libccl, starts a GraalVM isolate
try {
  using account = bridge.accounts.create(TESTNET); // managed handle (ADR-0016)
  console.log(account.info.base_address);        // addr_test1...
  console.log(account.exportRecoveryPhrase());   // 24-word phrase — one-shot, deliberate
} finally {
  bridge.close();                    // tears down the isolate
}
```

## API namespaces

A `CclBridge` instance exposes these namespaces (all offline operations):
`bridge.accounts`, `bridge.address`, `bridge.crypto`, `bridge.tx`, `bridge.plutus`,
`bridge.script`, `bridge.quicktx`.

Errors throw `CclError`; using a bridge after `close()` throws `CclClosedError`.

### Networks — read this before passing a number

Every `network` parameter takes one of the exported constants:

| Constant | Value (CCL enum ordinal) |
|---|---|
| `MAINNET` | `0` |
| `TESTNET` | `1` |

> **⚠️ These are CCL's `Network` enum ordinals, NOT Cardano's on-chain network id — and they are
> inverted with respect to it.** On-chain, `0 = testnet` and `1 = mainnet`; here `MAINNET = 0` and
> `TESTNET = 1`. So `bridge.accounts.create(0)` derives a **mainnet** key, not a testnet one.
> **Never pass a raw number — always pass a constant.**

`network` is **required** (there is no mainnet default), an out-of-range value throws, and the
TypeScript type is closed (`type Network = 0 | 1`), so `create(99)` will not compile:

```js
import { CclBridge, TESTNET, MAINNET } from '@bloxbean/cardano-client-lib';

bridge.accounts.create(TESTNET);           // addr_test1… — on-chain network_id 0
bridge.accounts.create();                  // TypeError: network is required
bridge.accounts.create(99);                // RangeError: invalid network
```

The **genuine on-chain network id** is the `network_id` field returned by `address.info()` — it is
*not* a `Network` ordinal and must not be fed back into `create()`:

```js
using acct = bridge.accounts.create(MAINNET);           // MAINNET is the ordinal 0 …
bridge.address.info(acct.info.base_address).network_id; // … but the on-chain id is 1
```

### TypeScript

The package ships `src/index.d.ts`, typed against the namespaced runtime API. `bun run typecheck`
compiles `test/types.test-d.ts` against it (part of the Gradle `test` task), so the declarations
cannot drift from the runtime.

Transactions are defined as a [TxPlan](https://github.com/bloxbean/cardano-client-lib)
**YAML** document and built fully offline — you supply the UTXOs and protocol parameters:

```js
const result = bridge.quicktx.build(yaml, utxos, protocolParams); // { tx_cbor, tx_hash, fee }
```

See [`examples/transaction.js`](examples/transaction.js).

## Chain-data providers (optional)

`build()` is offline — you supply the UTXOs and protocol parameters. The optional providers fetch
those for you over HTTP (Bun's built-in `fetch`), so the native library stays offline and
provider-free:

```js
import { CclBridge, YaciProvider, BlockfrostProvider } from "@bloxbean/cardano-client-lib";

const bridge = new CclBridge();
const provider = new BlockfrostProvider(projectId, { network: "preprod" }); // or new YaciProvider()
const result = await bridge.quicktx.buildWith(yaml, provider, [senderAddress]);
```

Plug in any backend (Koios, Ogmios, …) by supplying an object with `utxos(address)` and
`protocolParams()`. UTXO *selection* is handled inside the bridge — a provider only returns all
UTXOs at the address.

## Transaction evaluators (optional)

A Plutus build needs each redeemer's execution units. The bridge computes them **offline** with
Scalus when you supply none — so a script build just works, no evaluation step:

```javascript
const result = await bridge.quicktx.buildWith(yaml, provider, [senderAddress]); // Scalus computes the units
```

To use a **remote** evaluator instead (e.g. an authoritative fallback), pass a
`TransactionEvaluator`; `buildWith` runs a two-pass (draft → evaluate → rebuild). libccl never makes
HTTP calls ([ADR-0013](../../docs/adr/0013-transaction-evaluators.md)), so remote evaluation lives
here in the wrapper:

```javascript
import { BlockfrostEvaluator } from "@bloxbean/cardano-client-lib";

const evaluator = new BlockfrostEvaluator(projectId, { network: "preprod" });
const result = await bridge.quicktx.buildWith(yaml, provider, [senderAddress], evaluator);
```

Plug in any evaluator (Ogmios, …) by supplying an object with `evaluate(txCbor, utxos)`. To supply
units you computed yourself, call `build(…, execUnits)` directly. See `examples/evaluator.js`.
