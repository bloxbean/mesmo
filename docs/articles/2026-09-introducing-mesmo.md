# Mesmo: one mature Cardano codebase, exported to four language ecosystems

*A technical introduction to Mesmo — Cardano Client Lib compiled to a native shared library, with first-class wrappers for Python, Go, Rust, and JavaScript.*

---

Cardano's developer ecosystem is genuinely multilingual. Python teams build on [pycardano](https://github.com/Python-Cardano/pycardano), TypeScript teams on [MeshJS](https://meshjs.dev) or [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution), Rust teams on [pallas](https://github.com/txpipe/pallas), Go teams on [gOuroboros](https://github.com/blinklabs-io/gouroboros) or [Apollo](https://github.com/Salvionied/apollo). These are good libraries, and if one of them serves your needs, you should use it.

**Mesmo is not a competitor to any of them.** It is a fallback: a way to reach for specific functionality your library of choice doesn't have yet — a governance operation, offline Plutus costing, a key-derivation path — without leaving that library, and without waiting for a feature request to reach the top of a maintainer's queue.

It works by taking [Cardano Client Lib (CCL)](https://github.com/bloxbean/cardano-client-lib) — the mature Java SDK — and compiling it with GraalVM Native Image into an ordinary shared library (`libmesmo.so` / `libmesmo.dylib` / `libmesmo.dll`) with a plain C ABI. No JVM is involved at runtime. On top of that library sit four hand-built wrappers that make the whole thing feel native in each language.

## The motivation: features arrive faster than volunteer time

Most Cardano SDKs outside the JVM are maintained by individuals or small teams, frequently in their spare time. That is a remarkable achievement — and also a structural constraint. Every hard fork lands new functionality: the Conway era alone brought DRep registration and delegation, governance actions and voting, committee operations, treasury donations, new certificate types. Each of those has to be understood, implemented, tested, and released — in every SDK, in every language, by whoever has the hours.

The result is a familiar experience: your library covers 95% of what you need, and the missing 5% is precisely the new thing your product roadmap depends on. Your options have traditionally been to implement the primitive yourself, switch SDKs, or wait.

Cardano Client Lib sits in a different position. Its maintenance is supported by the Cardano Foundation — and will continue to be — which means new protocol functionality is implemented and tested in step with hard forks rather than as spare-time permitting. Mesmo takes that continuously maintained feature surface and exports it to the four ecosystems where the gaps are most often felt.

That leads to the intended usage pattern, and it's worth being explicit about it:

> **Keep your library. Add Mesmo for the pieces that are missing.** Mesmo's core is stateless — it holds no connections, runs no node protocols, and syncs no chain — so it slots in alongside pycardano, MeshJS, pallas, or gOuroboros for exactly the operations you need, with no rip-and-replace and no architectural commitment. If your library later gains the feature, you can drop Mesmo for that path just as easily.

## What's inside

Mesmo's native core performs the **local** operations — building, signing, hashing, derivation. Transaction building is not a purely offline affair, of course: you cannot select inputs without knowing which UTXOs are actually spendable, or compute fees without current protocol parameters. That chain data enters through a small **`ChainDataProvider`** interface in each wrapper, with two implementations included — **Yaci-Store** and **Blockfrost** — and a shape simple enough (fetch UTXOs, fetch parameters) that plugging in your own indexer is a few lines.

Plutus script costing follows the same pluggable pattern: the **`TransactionEvaluator`** interface decides how execution units are computed. Supply nothing and the default applies — the **Scalus** UPLC virtual machine embedded in the native core evaluates the script in-process, so script transactions cost themselves without any external service. Prefer node-backed costing? A **`BlockfrostEvaluator`** implementation ships too, and the interface accepts your own.

Transaction *submission* stays in your code, where every language already has good HTTP clients. What Mesmo exposes:

- **Accounts** — managed account handles: open an account once, sign with typed roles (payment, stake, DRep, committee); secrets never leave the handle
- **Transaction building** — the declarative TxPlan model (below): payments, staking, Conway governance, native and Plutus scripts, multi-party composition
- **Plutus** — datum hashing, PlutusData CBOR/JSON conversion, and **offline execution-unit costing** via the embedded Scalus evaluator — script transactions build with no node access
- **Keys and crypto** — CIP-1852 derivation for any role, Blake2b, Ed25519, mnemonics
- **Addresses and scripts** — parsing, validation, byte/bech32 conversion, native-script hashing

Transactions are described declaratively as a **TxPlan** — say what should happen; UTXO selection, fees, and change are handled by the library. TxPlan is a capability of CCL's 0.8 line, which is why Mesmo builds on it: the current pin is **CCL 0.8.0-pre5**, and Mesmo tracks upstream releases closely.

```yaml
version: 1.0
transaction:
  - tx:
      from: addr_test1qz2fxv…
      intents:
        - type: payment
          address: addr_test1qp9khl…
          amounts:
            - unit: lovelace
              quantity: "5000000"
        - type: stake_delegation
          stake_address: stake_test1uq…
          pool_id: pool1pu5jlj…
```

The same document, byte-for-byte, produces the same transaction from every wrapper — because it is the same code building it. Every intent shape is verified in CI by submitting it to a real devnet from all four languages, including negative cases (a purpose-built Aiken validator that must reject on-chain).

## The four wrappers

Each wrapper is a thin, idiomatic layer over the same 32-function C ABI — thin enough that behavior can't drift between languages (a parity check in CI enforces that all four bind the identical entry-point set), idiomatic enough that nothing feels foreign. The native library ships inside the package or is fetched on first build; there is nothing to install separately.

### Python

```bash
pip install mesmo
```

```python
from mesmo import Mesmo, Network

lib = Mesmo()

with lib.accounts.create(Network.MAINNET) as account:
    print(account.info["base_address"])      # public data only — never the mnemonic

result = lib.quicktx.build(txplan_yaml, utxos, protocol_params)
datum_hash = lib.plutus.data_hash("182a")
lib.close()
```

Pure `ctypes` — no compiled extension module — and a single `Mesmo` instance is safe to share across threads, so it drops into Flask, FastAPI, or a worker pool without ceremony.

### Go

```bash
go get github.com/bloxbean/mesmo/wrappers/go
```

```go
import "github.com/bloxbean/mesmo/wrappers/go/mesmo"

lib, _ := mesmo.New()
defer lib.Close()

account, _ := lib.Accounts.Create(mesmo.Mainnet)
defer account.Close()

result, _ := lib.QuickTx.Build(txplanYAML, utxos, protocolParams)
```

No cgo and no C toolchain: the library is loaded at runtime with purego, so cross-compilation workflows stay simple. A `*Mesmo` is safe to share across goroutines.

### Rust

```toml
[dependencies]
mesmo = "0.1"
```

```rust
use mesmo::{Mesmo, Network};

let lib = Mesmo::new()?;
let account = lib.accounts().create(Network::Mainnet)?;

let result = lib.quicktx().build(&txplan_yaml, &utxos, &protocol_params, None)?;
// teardown is RAII — no close() to forget
```

The build script fetches the platform's native library once and sets the rpath — no environment variables at runtime. Thread affinity is enforced at compile time by the type system rather than documented and hoped for.

### JavaScript (Bun)

```bash
bun add @bloxbean/mesmo
```

```javascript
import { Mesmo, MAINNET } from '@bloxbean/mesmo';

const lib = new Mesmo();

using account = lib.accounts.create(MAINNET);
console.log(account.info.base_address);

const result = lib.quicktx.build(txplanYaml, utxos, protocolParams);
lib.close();
```

The JavaScript wrapper targets Bun's built-in FFI and ships full TypeScript definitions. Amounts survive `2^53` intact — provider responses are parsed losslessly, because a UTXO's token quantity routinely exceeds what a JavaScript `number` can hold.

## Supported platforms

Prebuilt native libraries ship for:

| Platform | Notes |
|---|---|
| Linux x86_64 (glibc ≥ 2.17) | built against a deliberately old glibc baseline, so it runs on RHEL/CentOS 7+, Amazon Linux 2, Ubuntu 18.04+, Debian 9+, and everything newer |
| Linux aarch64 (glibc ≥ 2.17) | same baseline |
| Alpine Linux x86_64 (musl) | detected automatically at runtime — no configuration |
| macOS Apple Silicon | |
| Windows x86_64 | |

Two gaps, stated plainly: **macOS Intel** (Oracle GraalVM no longer ships Intel-Mac builds) and **Alpine on ARM** (GraalVM's musl support is x86_64-only). On those platforms, building the library from source with GraalVM is documented and supported.

## Being honest about the costs

A fallback is only trustworthy if its costs are stated plainly:

- **Binary size.** You are adding a ~50 MB platform-specific native library to your dependency tree.
- **Not a node client.** No node protocols, no chain sync, no submission — by design. Chain data for building comes through the `ChainDataProvider` interface (Yaci-Store and Blockfrost implementations included, or your own); submission is your HTTP stack's job.
- **Platform coverage.** See the matrix above — a pure-language library has no such constraints.

If none of the gaps Mesmo fills apply to you, the honest advice remains: use your ecosystem's native library.

## What's next

Four things are on the roadmap:

- **More chain-data providers.** The `ChainDataProvider` seam is deliberately small, and today it ships with Yaci-Store and Blockfrost implementations. Additional out-of-the-box providers are planned — **Ogmios**, **Koios**, and **Dolos** — so UTXO selection works against whichever data backend your infrastructure already runs.

- **Beta, in step with upstream.** Mesmo currently builds on CCL **0.8.0-pre5** — a pre-release, because Mesmo's transaction model relies on TxPlan, which became available in Cardano Client Lib only with the 0.8 line. When cardano-client-lib graduates out of pre-release, Mesmo moves to a beta designation on the stable pin.
- **A programmatic QuickTx builder in all four languages.** Today transactions are described as TxPlan YAML documents. A code-first QuickTx builder — expressed in each wrapper's own idiom, on top of the same core — is planned, so teams that prefer constructing transactions in code get the same single-implementation semantics.
- **A WebAssembly target.** Alongside the existing native platform builds, compiling the core to WebAssembly would bring Mesmo to the browser — and to the server *without native-library bindings at all*, for runtimes that can host wasm. Server-side wasm support varies across language ecosystems, so this lands as an **additional** target next to the native ones, not a replacement for them.

## Where this comes from

Mesmo is built on Cardano Client Lib, whose maintenance the Cardano Foundation supports and will continue to support. In practice that means the functionality exposed through Mesmo — including what arrives with future hard forks — tracks the protocol closely, is covered by CCL's extensive test suite, and is additionally verified end-to-end in Mesmo's own CI: every wrapper builds, signs, and submits every supported transaction type against a live devnet on every change.

- **Documentation and guides**: https://pages.bloxbean.com/mesmo/
- **Source**: https://github.com/bloxbean/mesmo
- **Cardano Client Lib**: https://github.com/bloxbean/cardano-client-lib

If your SDK has a gap, Mesmo is there to fill it — and to step aside again when it doesn't need to be.
