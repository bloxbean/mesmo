# Providers & Evaluators (Go)

The native library is offline by design — it never makes a network call. Providers and evaluators are small wrapper-side HTTP conveniences for feeding `QuickTx.BuildWith` with chain data. If you already have UTXOs and protocol parameters from your own infrastructure, you don't need them: call `QuickTx.Build` directly.

## ChainDataProvider

```go
type ChainDataProvider interface {
	Utxos(address string) ([]map[string]interface{}, error) // ALL utxos at the address; selection happens in the native lib
	ProtocolParams() (map[string]interface{}, error)
}
```

Any implementation works — plugging in Koios, Ogmios, or your own indexer is a small adapter.

### YaciProvider

Talks to a local [Yaci DevKit](https://github.com/bloxbean/yaci-devkit) devnet (or any yaci-store instance exposing the Blockfrost-style REST API).

```go
func NewYaciProvider(baseURL string) *YaciProvider // "" → "http://localhost:10000/local-cluster/api"
```

```go
provider := mesmo.NewYaciProvider("")
result, err := lib.QuickTx.BuildWith(yaml, provider, []string{senderAddress}, 0)
```

### BlockfrostProvider

```go
func NewBlockfrostProvider(projectID, network string) (*BlockfrostProvider, error) // network: "mainnet" | "preprod" | "preview"
func NewBlockfrostProviderURL(projectID, baseURL string) *BlockfrostProvider       // self-hosted / custom endpoint
```

- `NewBlockfrostProvider` returns an error for an unknown network name; use the `...URL` constructor for custom endpoints.
- UTXO fetches paginate (100 per page) until exhausted, and each UTXO gets the owning `address` injected (Blockfrost omits it, but the builder needs it).
- Protocol parameters come from `/epochs/latest/parameters`; the native library ignores the extra Blockfrost fields.

```go
provider, err := mesmo.NewBlockfrostProvider(os.Getenv("BF_PROJECT_ID"), "preprod")
result, err := lib.QuickTx.BuildWith(yaml, provider, []string{senderAddress}, 0)
```

## Evaluators

For Plutus transactions, execution units are computed **offline by default** — the native library embeds the Scalus UPLC evaluator, so no evaluator is needed for a script transaction to build. Use a remote evaluator when you want node-backed costing instead:

```go
type TransactionEvaluator interface {
	Evaluate(txCbor string, utxos []map[string]interface{}) ([]map[string]interface{}, error) // [{mem, steps}] in redeemer order
}
```

### BlockfrostEvaluator

```go
func NewBlockfrostEvaluator(projectID, network string) (*BlockfrostEvaluator, error)
func NewBlockfrostEvaluatorURL(projectID, baseURL string) *BlockfrostEvaluator
```

POSTs the draft transaction CBOR to `/utils/txs/evaluate` (Blockfrost / Ogmios-compatible) and parses the response into `[{mem, steps}]` in Cardano redeemer order (`spend < mint < cert < reward < vote < propose`). Both the purpose-keyed map form and the Ogmios v6 list form are handled.

```go
evaluator, _ := mesmo.NewBlockfrostEvaluator(projectID, "preprod")
result, err := lib.QuickTx.BuildWith(yaml, provider, []string{sender}, 0, evaluator)
// two-pass: draft build (offline units) → remote evaluate → rebuild with returned units
```

## Numbers are decoded losslessly

Provider responses are decoded with `json.Decoder.UseNumber()`, so JSON integers arrive as string-backed `json.Number` instead of `float64`. This matters: a UTXO's lovelace amount or a token quantity can exceed 2^53, which a `float64` would silently round — corrupting UTXO selection and change outputs. Passing provider results straight into `Build`/`BuildWith` is exact.

If you inspect a quantity yourself, convert explicitly:

```go
q := utxos[0]["amount"].([]interface{})[0].(map[string]interface{})["quantity"]
switch v := q.(type) {
case string:      // Blockfrost/DevKit canonical form
	fmt.Println(v)
case json.Number: // numeric JSON form, still exact
	fmt.Println(v.String())
}
```

## Timeouts & errors

Every provider/evaluator request is bounded by a 60-second HTTP client timeout; a hung endpoint fails the call instead of pinning a goroutine forever. Non-200 responses return `"GET/POST <url> failed: HTTP <code>: <body>"`.
