# Cardano Client Lib for JavaScript (Bun)

`@bloxbean/cardano-client-lib` brings [Cardano Client Lib (CCL)](https://github.com/bloxbean/cardano-client-lib)'s offline Cardano operations — key derivation, address handling, transaction building and signing, Plutus data, governance keys — to JavaScript as a native library. No JVM, no remote service: the heavy lifting happens inside `libccl`, a GraalVM native-image build of CCL that ships with the package.

> **Bun only.** The wrapper uses `bun:ffi` and requires [Bun](https://bun.sh) ≥ 1.0. Node.js is not supported: Node FFI bridges (ffi-napi, koffi) crash against a GraalVM native library due to its stack-boundary detection.

## Documentation

| Document | Contents |
|---|---|
| [API reference](api.md) | Every class and method: `CclBridge`, account, address, crypto, tx, plutus, script, gov, wallet, quicktx |
| [Building transactions](transactions.md) | The full workflow with worked examples: payments, staking, governance, minting, Plutus |
| [Providers & evaluators](providers.md) | Fetching UTXOs/protocol params from Yaci DevKit or Blockfrost; remote script-cost evaluation |
| [Troubleshooting](troubleshooting.md) | Native library resolution, platform support, common errors |
| [TxPlan (YAML) reference](../quicktx.md) | The transaction description format used by `quicktx.build` — shared by all four language wrappers |

## Installation

```bash
bun add @bloxbean/cardano-client-lib
```

The package pulls in a platform-specific package (via `optionalDependencies`) that bundles the prebuilt native library — nothing else to install:

| Platform | Package |
|---|---|
| Linux x86_64 (glibc ≥ 2.17) | `@bloxbean/cardano-client-lib-linux-x86_64` |
| Linux aarch64 (glibc ≥ 2.17) | `@bloxbean/cardano-client-lib-linux-aarch64` |
| Linux x86_64 (musl / Alpine) | `@bloxbean/cardano-client-lib-linux-musl-x86_64` |
| macOS Apple Silicon | `@bloxbean/cardano-client-lib-macos-aarch64` |
| Windows x86_64 | `@bloxbean/cardano-client-lib-windows-x86_64` |

macOS Intel is not supported with prebuilt binaries (Oracle GraalVM dropped Intel Macs); musl is x86_64-only. On those platforms, [build the library from source](troubleshooting.md#building-the-native-library-from-source) and point `CCL_LIB_PATH` at it.

## Quick start

```js
import { CclBridge, TESTNET } from "@bloxbean/cardano-client-lib";

const bridge = new CclBridge();
try {
  // Create a new managed account (testnet). Its info never contains the phrase;
  // export the recovery phrase once, deliberately.
  using account = bridge.accounts.create(TESTNET);
  console.log(account.info.base_address);   // addr_test1...
  console.log(account.info.stake_address);  // stake_test1...
  const mnemonic = account.exportRecoveryPhrase();

  // Restore it later from the phrase.
  using restored = bridge.accounts.fromMnemonic(mnemonic, TESTNET, 0, 0);
} finally {
  bridge.close();
}
```

Or let `using` handle the lifecycle:

```js
using bridge = new CclBridge();
using account = bridge.accounts.create(TESTNET);
```

### Build, sign, and inspect a transaction — fully offline

Transactions are described as a [TxPlan YAML document](../quicktx.md). You supply the UTXOs and protocol parameters (from any source — see [providers](providers.md) for ready-made ones), and get back an unsigned transaction:

```js
const yaml = `
version: 1.0
transaction:
  - tx:
      from: ${account.base_address}
      intents:
        - type: payment
          address: addr_test1qz3...
          amounts:
            - unit: lovelace
              quantity: "5000000"
`;

const result = bridge.quicktx.build(yaml, utxos, protocolParams);
// result = { tx_cbor, tx_hash, fee }

const signed = sender.signTx(result.tx_cbor);   // sender = bridge.accounts.fromMnemonic(...)
// submit `signed` with any HTTP client — the library never talks to the network
```

With a provider, fetching the chain data is one call:

```js
import { YaciProvider } from "@bloxbean/cardano-client-lib";

const provider = new YaciProvider();  // local Yaci DevKit
const result = await bridge.quicktx.buildWith(yaml, provider, [account.base_address]);
```

## Design in one paragraph

The native library is **offline and stateless** — it derives, builds, signs, hashes, and serializes, but never performs I/O. Anything that touches the network (fetching UTXOs, protocol parameters, submitting transactions, remote script evaluation) lives in the wrapper or in your code, where you control HTTP. Plutus execution units are computed offline in-process (via Scalus) by default, so even script transactions build without a network connection.

## Networks

```js
import { MAINNET, TESTNET } from "@bloxbean/cardano-client-lib";
```

Every key-derivation method requires an explicit network argument — there is no default. Always pass one of these constants, never a bare number: they are CCL enum ordinals (`MAINNET = 0`, `TESTNET = 1`), which are the **inverse** of Cardano's on-chain network id (on-chain mainnet = 1). See [API reference → Networks](api.md#networks).

## Examples

Runnable examples live in [`wrappers/js/examples/`](../../wrappers/js/examples):

- `account.js` — create/restore accounts, derive keys and DRep id
- `primitives.js` — mnemonics, Blake2b hashing, Ed25519 sign/verify, address parsing
- `transaction.js` — offline QuickTx build + sign
- `evaluator.js` — Plutus mint with offline Scalus units vs. remote Blockfrost evaluation
