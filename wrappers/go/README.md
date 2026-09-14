# Cardano Client Bindings — Go

Go bindings for [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib)
via the Cardano Client Bindings native library. Pure Go — the library is loaded with
[purego](https://github.com/ebitengine/purego), so there is **no cgo and no C toolchain**.

> Part of the [Cardano Client Bindings](../../README.md) project. See the
> [top-level README](../../README.md) for the full API reference and
> [`docs/quicktx.md`](../../docs/quicktx.md) for transaction building.

## Install

```bash
go get github.com/bloxbean/cardano-client-bindings/wrappers/go
```

Requires Go 1.21+. No C toolchain, no `CGO_ENABLED`. On first use the native library
`libccl.{dylib,so,dll}` for your platform is resolved automatically, in order:

1. **`CCL_LIB_PATH`** — a directory or the library file, to supply your own build;
2. a **per-version cache** (`os.UserCacheDir()/cardano-client-bindings/<version>/`);
3. otherwise it is **downloaded once** from the matching GitHub release and cached.

Override the downloaded version with `CCL_LIB_VERSION`. Resolution is fail-hard: a bad
download errors rather than silently using a stale library.

> **Threading:** all FFI calls run on a single dedicated OS thread that the `Bridge`
> pins for its lifetime, so a `Bridge` is safe to share across goroutines and is immune
> to Go's goroutine/OS-thread migration (which otherwise crashes the GraalVM isolate on
> Linux x86_64). Calls are serialized; create multiple `Bridge` instances if you need
> concurrent isolate work.

## Running the examples

From `wrappers/go` (the library is auto-resolved; set `CCL_LIB_PATH` to a local build to
skip the download):

```bash
go run ./examples/account
```

The [`examples/`](examples/) directory contains:

| Program | What it shows |
|---------|---------------|
| [`account`](examples/account/main.go) | Create an account, restore from mnemonic, derive keys and a DRep ID |
| [`primitives`](examples/primitives/main.go) | Mnemonics, Blake2b hashing, Ed25519 signing, address parsing/validation |
| [`transaction`](examples/transaction/main.go) | Build an unsigned payment **offline** (QuickTx) and sign it — no node/DevKit needed |

## Quick start

```go
package main

import (
	"fmt"
	"log"

	"github.com/bloxbean/cardano-client-bindings/wrappers/go/ccl"
)

func main() {
	bridge, err := ccl.New() // loads libccl, starts a GraalVM isolate
	if err != nil {
		log.Fatal(err)
	}
	defer bridge.Close() // tears down the isolate

	account, err := bridge.Accounts.Create(ccl.Testnet) // managed handle (ADR-0016)
	if err != nil {
		log.Fatal(err)
	}
	defer account.Close()
	info, _ := account.Info()
	fmt.Println(info.BaseAddress) // addr_test1...
	phrase, _ := account.ExportRecoveryPhrase() // one-shot, deliberate
	fmt.Println(phrase) // 24-word phrase
}
```

## API namespaces

A `*Bridge` exposes these namespaces (all offline operations):
`bridge.Accounts`, `bridge.Address`, `bridge.Crypto`, `bridge.Tx`, `bridge.Plutus`,
`bridge.Script`, `bridge.QuickTx`.

Networks are the `ccl.Network` type: `ccl.Mainnet` or `ccl.Testnet`.

> **These are CCL's enum ordinals, not Cardano's on-chain network id.** `Mainnet` is 0 and
> `Testnet` is 1, which is the *inverse* of the on-chain encoding (0 = testnet, 1 = mainnet).
> So an account created with `ccl.Mainnet` has an `AddressInfo.NetworkID` of `1` — `NetworkID` on
> the *returned* `AddressInfo` is the genuine on-chain value decoded from the address. Always pass
> a `ccl.Network` constant; passing a raw int for the network is a compile error.

Errors are returned as a `*ccl.CclError`.

Transactions are built from a [TxPlan](https://github.com/bloxbean/cardano-client-lib)
**YAML** document via `bridge.QuickTx.Build(yaml, utxos, protocolParams)`, fully offline —
you supply the UTXOs and protocol parameters. See
[`examples/transaction`](examples/transaction/main.go).

## Chain-data providers (optional)

`Build` is offline — you supply the UTXOs and protocol parameters. The optional providers fetch those
for you over HTTP (stdlib `net/http`), so the native library stays offline and provider-free:

```go
provider, _ := ccl.NewBlockfrostProvider(projectID, "preprod") // or ccl.NewYaciProvider("")
result, err := bridge.QuickTx.BuildWith(yaml, provider, []string{senderAddress}, 0)
```

Plug in any backend (Koios, Ogmios, …) by implementing the `ccl.ChainDataProvider` interface
(`Utxos(address)`, `ProtocolParams()`). UTXO *selection* is handled inside the bridge — a provider
only returns all UTXOs at the address.

## Transaction evaluators (optional)

A Plutus build needs each redeemer's execution units. The bridge computes them **offline** with
Scalus when you supply none — so a script build just works, no evaluation step:

```go
result, err := bridge.QuickTx.BuildWith(yaml, provider, []string{senderAddress}, 0) // Scalus computes the units
```

To use a **remote** evaluator instead (e.g. an authoritative fallback), pass a
`TransactionEvaluator`; `BuildWith` runs a two-pass (draft → evaluate → rebuild). libccl never makes
HTTP calls ([ADR-0013](../../docs/adr/0013-transaction-evaluators.md)), so remote evaluation lives
here in the wrapper:

```go
evaluator, _ := ccl.NewBlockfrostEvaluator(projectID, "preprod")
result, err := bridge.QuickTx.BuildWith(yaml, provider, []string{senderAddress}, 0, evaluator)
```

Plug in any evaluator (Ogmios, …) by implementing the `ccl.TransactionEvaluator` interface
(`Evaluate`). To supply units you computed yourself, call `Build` directly. See
`examples/evaluator`.
