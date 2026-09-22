# Mesmo

JavaScript bindings for [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib)
via the Mesmo native library, using Bun's built-in FFI.

> Part of the [Mesmo](https://github.com/bloxbean/mesmo) project. See the
> [top-level README](https://github.com/bloxbean/mesmo#readme) for the full API reference and
> [`docs/quicktx.md`](https://github.com/bloxbean/mesmo/blob/main/docs/quicktx.md) for transaction building.

## Requirements

- [Bun](https://bun.sh/) 1.0+.

The native library is **bundled inside the platform package** — no separate download or
`MESMO_LIB_PATH` needed for an installed package.

> **Node.js is not supported.** Node's FFI libraries (ffi-napi, koffi) crash against the
> GraalVM native library due to stack-boundary detection. Use Bun, whose built-in FFI
> works correctly. See the project [`TODO.md`](https://github.com/bloxbean/mesmo/blob/main/TODO.md) Non-Goals.

## Installing

**Recommended — a package that bundles the native library:**

```bash
bun add @bloxbean/mesmo
```

The package ships the matching `libmesmo.*` under `libs/`, so `new Mesmo()` just works — nothing
else to set. At load time the bindings look for the library in this order: an explicit
`new Mesmo(libPath)`, the `MESMO_LIB_PATH` env var, then the bundled `libs/` copy.

Building the tarball yourself, or developing against a locally built `libmesmo`:
see [BUILD_FROM_SOURCE.md](https://github.com/bloxbean/mesmo/blob/main/wrappers/js/BUILD_FROM_SOURCE.md).

## Examples

The [`examples/`](https://github.com/bloxbean/mesmo/tree/main/wrappers/js/examples) directory contains:

| File | What it shows |
|------|---------------|
| [`account.js`](https://github.com/bloxbean/mesmo/blob/main/wrappers/js/examples/account.js) | Create an account, restore from mnemonic, derive keys and a DRep ID |
| [`primitives.js`](https://github.com/bloxbean/mesmo/blob/main/wrappers/js/examples/primitives.js) | Mnemonics, Blake2b hashing, Ed25519 signing, address parsing/validation |
| [`transaction.js`](https://github.com/bloxbean/mesmo/blob/main/wrappers/js/examples/transaction.js) | Build an unsigned payment **offline** (QuickTx) and sign it — no node/DevKit needed |

## Quick start

```javascript
import { Mesmo, TESTNET } from './src/index.js';

const lib = new Mesmo();      // loads libmesmo, starts a GraalVM isolate
try {
  using account = lib.accounts.create(TESTNET); // managed handle (ADR-0016)
  console.log(account.info.base_address);        // addr_test1...
  console.log(account.exportRecoveryPhrase());   // 24-word phrase — one-shot, deliberate
} finally {
  lib.close();                    // tears down the isolate
}
```

## API namespaces

A `Mesmo` instance exposes these namespaces (all offline operations):
`lib.accounts`, `lib.address`, `lib.crypto`, `lib.tx`, `lib.plutus`,
`lib.script`, `lib.quicktx`.

Errors throw `MesmoError`; using a Mesmo after `close()` throws `MesmoClosedError`.

### Networks — read this before passing a number

Every `network` parameter takes one of the exported constants:

| Constant | Value (CCL enum ordinal) |
|---|---|
| `MAINNET` | `0` |
| `TESTNET` | `1` |

> **⚠️ These are CCL's `Network` enum ordinals, NOT Cardano's on-chain network id — and they are
> inverted with respect to it.** On-chain, `0 = testnet` and `1 = mainnet`; here `MAINNET = 0` and
> `TESTNET = 1`. So `lib.accounts.create(0)` derives a **mainnet** key, not a testnet one.
> **Never pass a raw number — always pass a constant.**

`network` is **required** (there is no mainnet default), an out-of-range value throws, and the
TypeScript type is closed (`type Network = 0 | 1`), so `create(99)` will not compile:

```js
import { Mesmo, TESTNET, MAINNET } from '@bloxbean/mesmo';

lib.accounts.create(TESTNET);           // addr_test1… — on-chain network_id 0
lib.accounts.create();                  // TypeError: network is required
lib.accounts.create(99);                // RangeError: invalid network
```

The **genuine on-chain network id** is the `network_id` field returned by `address.info()` — it is
*not* a `Network` ordinal and must not be fed back into `create()`:

```js
using acct = lib.accounts.create(MAINNET);           // MAINNET is the ordinal 0 …
lib.address.info(acct.info.base_address).network_id; // … but the on-chain id is 1
```

### TypeScript

The package ships `src/index.d.ts`, typed against the namespaced runtime API. `bun run typecheck`
compiles `test/types.test-d.ts` against it (part of the Gradle `test` task), so the declarations
cannot drift from the runtime.

Transactions are defined as a [TxPlan](https://github.com/bloxbean/cardano-client-lib)
**YAML** document and built fully offline — you supply the UTXOs and protocol parameters:

```js
const result = lib.quicktx.build(yaml, utxos, protocolParams); // { tx_cbor, tx_hash, fee }
```

See [`examples/transaction.js`](https://github.com/bloxbean/mesmo/blob/main/wrappers/js/examples/transaction.js).

## Chain-data providers (optional)

`build()` is offline — you supply the UTXOs and protocol parameters. The optional providers fetch
those for you over HTTP (Bun's built-in `fetch`), so the native library stays offline and
provider-free:

```js
import { Mesmo, YaciProvider, BlockfrostProvider } from "@bloxbean/mesmo";

const lib = new Mesmo();
const provider = new BlockfrostProvider(projectId, { network: "preprod" }); // or new YaciProvider()
const result = await lib.quicktx.buildWith(yaml, provider, [senderAddress]);
```

Plug in any backend (Koios, Ogmios, …) by supplying an object with `utxos(address)` and
`protocolParams()`. UTXO *selection* is handled inside Mesmo — a provider only returns all
UTXOs at the address.

## Transaction evaluators (optional)

A Plutus build needs each redeemer's execution units. Mesmo computes them **offline** with
Scalus when you supply none — so a script build just works, no evaluation step:

```javascript
const result = await lib.quicktx.buildWith(yaml, provider, [senderAddress]); // Scalus computes the units
```

To use a **remote** evaluator instead (e.g. an authoritative fallback), pass a
`TransactionEvaluator`; `buildWith` runs a two-pass (draft → evaluate → rebuild). libmesmo never makes
HTTP calls ([ADR-0013](https://github.com/bloxbean/mesmo/blob/main/docs/adr/0013-transaction-evaluators.md)), so remote evaluation lives
here in the wrapper:

```javascript
import { BlockfrostEvaluator } from "@bloxbean/mesmo";

const evaluator = new BlockfrostEvaluator(projectId, { network: "preprod" });
const result = await lib.quicktx.buildWith(yaml, provider, [senderAddress], evaluator);
```

Plug in any evaluator (Ogmios, …) by supplying an object with `evaluate(txCbor, utxos)`. To supply
units you computed yourself, call `build(…, execUnits)` directly. See `examples/evaluator.js`.
