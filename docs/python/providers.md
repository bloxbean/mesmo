# Providers & Evaluators (Python)

The native library is offline by design — it never makes a network call. Providers and evaluators are small wrapper-side HTTP conveniences (stdlib `urllib`, no extra dependencies) for feeding `quicktx.build_with` with chain data. If you already have UTXOs and protocol parameters from your own infrastructure, you don't need them: call `quicktx.build` directly.

```python
from ccl import YaciProvider, BlockfrostProvider, BlockfrostEvaluator
```

## ChainDataProvider

```python
class ChainDataProvider:
    def utxos(self, address) -> list[dict]: ...   # ALL utxos at the address; selection happens in the native lib
    def protocol_params(self) -> dict: ...
```

Providers are duck-typed — any object with these two methods works, so plugging in Koios, Ogmios, or your own indexer is a few lines.

### YaciProvider

Talks to a local [Yaci DevKit](https://github.com/bloxbean/yaci-devkit) devnet (or any yaci-store instance exposing the Blockfrost-style REST API).

```python
YaciProvider(base_url="http://localhost:10000/local-cluster/api")
```

```python
provider = YaciProvider()
result = lib.quicktx.build_with(yaml, provider, [sender_address])
```

### BlockfrostProvider

```python
BlockfrostProvider(project_id, network="mainnet", base_url=None)
```

- `network` picks the public Blockfrost endpoint: `"mainnet"`, `"preprod"`, or `"preview"` (note: there is no `"testnet"`). Pass `base_url` instead for a self-hosted instance; an unknown `network` without `base_url` raises `ValueError`.
- UTXO fetches paginate (100 per page) until exhausted, and each UTXO gets the owning `address` injected (Blockfrost omits it, but the builder needs it).
- Protocol parameters come from `/epochs/latest/parameters`; the native library ignores the extra Blockfrost fields.

```python
import os
provider = BlockfrostProvider(os.environ["BF_PROJECT_ID"], network="preprod")
result = lib.quicktx.build_with(yaml, provider, [sender_address])
```

## Evaluators

For Plutus transactions, execution units are computed **offline by default** — the native library embeds the Scalus UPLC evaluator, so no evaluator is needed for a script transaction to build. Use a remote evaluator when you want node-backed costing instead:

```python
class TransactionEvaluator:
    def evaluate(self, tx_cbor, utxos=None) -> list[dict]: ...   # [{"mem", "steps"}] in redeemer order
```

### BlockfrostEvaluator

```python
BlockfrostEvaluator(project_id, network="mainnet", base_url=None)
```

POSTs the draft transaction CBOR to `/utils/txs/evaluate` (Blockfrost / Ogmios-compatible) and parses the response into `[{"mem", "steps"}]` in Cardano redeemer order (`spend < mint < cert < reward < vote < propose`). Both the purpose-keyed map form and the Ogmios v6 list form are handled.

```python
evaluator = BlockfrostEvaluator(project_id, network="preprod")
result = lib.quicktx.build_with(yaml, provider, [sender], evaluator)
# two-pass: draft build (offline units) → remote evaluate → rebuild with returned units
```

## Numbers

Chain data carries quantities as **strings** in the canonical CCL models (`"quantity": "5000000"`), and Python's `int` is arbitrary precision — there is no 2^53 float-truncation risk anywhere on the Python path. Read the fee back with `int(result["fee"])`.

## Timeouts & errors

Provider GETs are bounded at 30 seconds and evaluator POSTs at 60 seconds; a hung endpoint raises instead of blocking forever. HTTP failures raise `RuntimeError(f"GET/POST <url> failed: HTTP <code>: <body>")`.
