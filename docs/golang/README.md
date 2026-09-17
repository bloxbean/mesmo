# Cardano Client Lib for Go

The `mesmo` Go package brings [Cardano Client Lib (CCL)](https://github.com/bloxbean/cardano-client-lib)'s offline Cardano operations — key derivation, address handling, transaction building and signing, Plutus data, governance keys — to Go as a native library. No JVM, **no cgo, no C toolchain**: the shared library is loaded at runtime with [purego](https://github.com/ebitengine/purego).

## Documentation

| Document | Contents |
|---|---|
| [API reference](api.md) | Every type and method: `Mesmo`, Account, Address, Crypto, Tx, Plutus, Script, Gov, Wallet, QuickTx |
| [Building transactions](transactions.md) | The full workflow with worked examples: payments, staking, governance, minting, Plutus |
| [Providers & evaluators](providers.md) | Fetching UTXOs/protocol params from Yaci DevKit or Blockfrost; remote script-cost evaluation |
| [Troubleshooting](troubleshooting.md) | Native library download & resolution, platform support, common errors |
| [TxPlan (YAML) reference](../quicktx.md) | The transaction description format used by `QuickTx.Build` — shared by all four language wrappers |

## Installation

```bash
go get github.com/bloxbean/mesmo/wrappers/go
```

```go
import "github.com/bloxbean/mesmo/wrappers/go/mesmo"
```

Requires Go ≥ 1.21. On first use, the package downloads the prebuilt native library (`libmesmo`) for your platform from the project's GitHub releases into your user cache directory (`os.UserCacheDir()/mesmo/<version>/`) — a one-time, per-version download. No environment variables or build flags are needed.

To use a locally built library instead (or on a platform without prebuilt binaries), set `MESMO_LIB_PATH` — see [troubleshooting](troubleshooting.md#how-the-native-library-is-found).

## Quick start

```go
package main

import (
	"fmt"
	"log"

	"github.com/bloxbean/mesmo/wrappers/go/mesmo"
)

func main() {
	lib, err := mesmo.New()
	if err != nil {
		log.Fatal(err)
	}
	defer lib.Close()

	// Create a new managed account (testnet). Its Info never contains the phrase;
	// export the recovery phrase once, deliberately.
	account, err := lib.Accounts.Create(mesmo.Testnet)
	if err != nil {
		log.Fatal(err)
	}
	defer account.Close()
	info, _ := account.Info()
	fmt.Println(info.BaseAddress)  // addr_test1...
	fmt.Println(info.StakeAddress) // stake_test1...
	mnemonic, _ := account.ExportRecoveryPhrase()

	// Restore it later from the phrase.
	restored, _ := lib.Accounts.FromMnemonic(mnemonic, mesmo.Testnet, 0, 0)
	defer restored.Close()
}
```

### Build, sign, and inspect a transaction — fully offline

Transactions are described as a [TxPlan YAML document](../quicktx.md). You supply the UTXOs and protocol parameters (from any source — see [providers](providers.md) for ready-made ones), and get back an unsigned transaction:

```go
yaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: payment
          address: %s
          amounts:
            - unit: lovelace
              quantity: "5000000"
`, sender.BaseAddress, receiver)

result, err := lib.QuickTx.Build(yaml, utxos, protocolParams)
// result.TxCbor, result.TxHash, result.Fee

signed, err := sender.SignTx(result.TxCbor, mesmo.RolePayment) // sender = lib.Accounts.FromMnemonic(...)
// submit `signed` with any HTTP client — the library never talks to the network
```

With a provider, fetching the chain data is one call:

```go
provider := mesmo.NewYaciProvider("") // local Yaci DevKit ("" = default URL)
result, err := lib.QuickTx.BuildWith(yaml, provider, []string{sender.BaseAddress}, 0)
```

## Design in one paragraph

The native library is **offline and stateless** — it derives, builds, signs, hashes, and serializes, but never performs I/O. Anything that touches the network (fetching UTXOs, protocol parameters, submitting transactions, remote script evaluation) lives in the wrapper or in your code, where you control HTTP. Plutus execution units are computed offline in-process (via Scalus) by default, so even script transactions build without a network connection.

## Concurrency

A `*Mesmo` is safe to share across goroutines: all native calls are funneled to one dedicated, pinned OS thread (a GraalVM isolate thread is bound to the OS thread that created it), so calls are serialized. For parallel native work, create multiple `Mesmo` instances. Always `defer lib.Close()`; calls after `Close` return `mesmo.ErrClosed` rather than crashing.

## Networks

```go
mesmo.Mainnet // 0
mesmo.Testnet // 1
```

Every key-derivation method takes a typed `mesmo.Network` — passing a bare `int` is a compile error. Note the values are CCL enum ordinals, which are the **inverse** of Cardano's on-chain network id for mainnet/testnet (`Mainnet = 0`, but a mainnet address's on-chain `network_id` is `1`). See [API reference → Networks](api.md#networks).

## Examples

Runnable examples live in [`wrappers/go/examples/`](../../wrappers/go/examples):

- `examples/account` — create/restore accounts, derive keys and DRep id
- `examples/primitives` — mnemonics, Blake2b hashing, Ed25519 sign/verify, address parsing
- `examples/transaction` — offline QuickTx build + sign
- `examples/evaluator` — Plutus mint with offline Scalus units vs. remote Blockfrost evaluation

```bash
go run ./examples/account
```
