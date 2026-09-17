# Providers & Evaluators (JavaScript)

The native library is offline by design — it never makes a network call. Providers and evaluators are small wrapper-side HTTP conveniences for feeding `quicktx.buildWith` with chain data. If you already have UTXOs and protocol parameters from your own infrastructure, you don't need them: call `quicktx.build` directly.

## ChainDataProvider

```ts
class ChainDataProvider {
  async utxos(address: string): Promise<Utxo[]>          // ALL utxos at the address; selection happens in the native lib
  async protocolParams(): Promise<ProtocolParams>
}
```

Providers are structural — any object with these two async methods works, so plugging in Koios, Ogmios, or your own indexer is a few lines.

### YaciProvider

Talks to a local [Yaci DevKit](https://github.com/bloxbean/yaci-devkit) devnet (or any yaci-store instance exposing the Blockfrost-style REST API).

```ts
new YaciProvider(baseUrl?: string)   // default: "http://localhost:10000/local-cluster/api"
```

```js
const provider = new YaciProvider();
const result = await lib.quicktx.buildWith(yaml, provider, [senderAddress]);
```

### BlockfrostProvider

```ts
new BlockfrostProvider(projectId: string, options?: { network?: "mainnet" | "preprod" | "preview", baseUrl?: string })
```

- `network` picks the public Blockfrost endpoint (default `"mainnet"`); pass `baseUrl` instead for a self-hosted instance. An unknown `network` without `baseUrl` throws.
- UTXO fetches paginate (100 per page) until exhausted, and each UTXO gets the owning `address` injected (Blockfrost omits it, but the builder needs it).
- Protocol parameters come from `/epochs/latest/parameters`; the native library ignores the extra Blockfrost fields.

```js
const provider = new BlockfrostProvider(process.env.BF_PROJECT_ID, { network: "preprod" });
const result = await lib.quicktx.buildWith(yaml, provider, [senderAddress]);
```

## Evaluators

For Plutus transactions, execution units are computed **offline by default** — the native library embeds the Scalus UPLC evaluator, so no evaluator is needed for a script transaction to build. Use a remote evaluator when you want node-backed costing instead:

```ts
class TransactionEvaluator {
  async evaluate(txCbor: string, utxos: Utxo[]): Promise<ExecUnits[]>   // [{ mem, steps }] in redeemer order
}
```

### BlockfrostEvaluator

```ts
new BlockfrostEvaluator(projectId: string, options?: { network?: "mainnet" | "preprod" | "preview", baseUrl?: string })
```

POSTs the draft transaction CBOR to `/utils/txs/evaluate` (Blockfrost / Ogmios-compatible) and parses the response into `[{ mem, steps }]` in Cardano redeemer order (`spend < mint < cert < reward < vote < propose`).

```js
const evaluator = new BlockfrostEvaluator(projectId, { network: "preprod" });
const result = await lib.quicktx.buildWith(yaml, provider, [sender], evaluator);
// two-pass: draft build (offline units) → remote evaluate → rebuild with returned units
```

The standalone `parseEvaluation(resp)` export handles both the purpose-keyed map form (`{"spend:0": {memory, steps}}`) and the Ogmios v6 list form, if you want to wire up your own evaluator.

## Numbers: LosslessNumber

Provider responses are parsed with [`lossless-json`](https://github.com/josdejong/lossless-json), not `JSON.parse`. A UTXO's lovelace amount or a token quantity can exceed `Number.MAX_SAFE_INTEGER` (2^53), which plain `JSON.parse` would silently round — corrupting UTXO selection and change outputs.

Practical consequences:

- Passing provider results straight into `build`/`buildWith` is exact — nothing to do.
- If you *inspect* a provider-returned quantity yourself, it is a string-backed `LosslessNumber`, not a `number`. Use `.toString()` for exactness, or `Number(x)` / `.valueOf()` when you know the value is small.

```js
const utxos = await provider.utxos(address);
const lovelace = utxos[0].amount[0].quantity.toString();  // exact, arbitrary size
```

## Timeouts & errors

Every provider/evaluator request is bounded by a 60-second timeout (`AbortSignal.timeout`); a hung endpoint rejects with a `TimeoutError` instead of hanging forever. Non-2xx responses throw `Error("GET/POST <url> failed: HTTP <status>: <body>")`.
