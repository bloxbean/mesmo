// Optional chain-data provider helpers.
//
// quicktx.build() is offline by design: the caller supplies UTXOs and protocol parameters (and, for
// Plutus, execution units). These helpers are an *optional* convenience that fetch those inputs from
// a chain-data backend over HTTP, returning them in the exact shape build() already accepts — so the
// native library stays offline and provider-free, and the helpers are pure wrapper-side code using
// Bun's built-in fetch.
//
// A provider implements two async methods:
//   utxos(address)      -> array of UTXO objects at the address (no selection — the bridge selects)
//   protocolParams()    -> protocol parameters object
//
// Use one directly, or via quicktx.buildWith:
//
//   import { MesmoBridge, BlockfrostProvider } from "@bloxbean/mesmo";
//   const bridge = new MesmoBridge();
//   const provider = new BlockfrostProvider(projectId, { network: "preprod" }); // or new YaciProvider()
//   const result = await bridge.quicktx.buildWith(txplanYaml, provider, senderAddress);

import { parse as losslessParse } from "lossless-json";

// Bound provider requests so a hung endpoint can't leave the returned promise pending forever
// (fetch has no default timeout). 60s matches the Python/Go wrappers; generous for a large paginated
// UTxO fetch.
const HTTP_TIMEOUT_MS = 60_000;

// Parse with lossless-json, not resp.json(): a UTxO amount / native-token quantity can exceed 2^53,
// and JSON.parse (what resp.json() uses) would round it through a float64 before it ever reaches
// build(). lossless-json keeps such numbers as string-backed LosslessNumber; build() serializes them
// back losslessly. Strings and in-range numbers are unaffected.
function parseBody(text) {
  return losslessParse(text);
}

async function httpGetJson(url, headers) {
  const resp = await fetch(url, { headers: headers ?? {}, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GET ${url} failed: HTTP ${resp.status}: ${body}`);
  }
  return parseBody(await resp.text());
}

async function httpPostJson(url, body, headers) {
  const resp = await fetch(url, {
    method: "POST",
    headers: headers ?? {},
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`POST ${url} failed: HTTP ${resp.status}: ${detail}`);
  }
  return parseBody(await resp.text());
}

// Interface marker: a provider exposes `utxos(address)` and `protocolParams()`. Extend it or just
// supply any object with those two methods.
export class ChainDataProvider {
  async utxos(address) { throw new Error("not implemented"); }
  async protocolParams() { throw new Error("not implemented"); }
}

// Chain-data provider backed by Yaci DevKit / yaci-store (Blockfrost-style REST). Defaults to the
// local DevKit cluster the integration tests use; its responses are already in build() shape.
export class YaciProvider extends ChainDataProvider {
  static DEFAULT_URL = "http://localhost:10000/local-cluster/api";

  constructor(baseUrl = YaciProvider.DEFAULT_URL) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async utxos(address) {
    return httpGetJson(`${this.baseUrl}/addresses/${address}/utxos`);
  }

  async protocolParams() {
    return httpGetJson(`${this.baseUrl}/epochs/parameters`);
  }
}

const BLOCKFROST_NETWORK_URLS = {
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  preview: "https://cardano-preview.blockfrost.io/api/v0",
};

// Chain-data provider backed by the Blockfrost API. `network` selects the default base URL
// (mainnet/preprod/preview); pass `baseUrl` to override. UTXOs are paginated 100 per page, and
// Blockfrost omits the owning address on each UTXO so it is injected.
export class BlockfrostProvider extends ChainDataProvider {
  constructor(projectId, { network = "mainnet", baseUrl } = {}) {
    super();
    if (!baseUrl) {
      baseUrl = BLOCKFROST_NETWORK_URLS[network];
      if (!baseUrl) throw new Error(`unknown network '${network}'; pass baseUrl explicitly`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this._headers = { project_id: projectId };
  }

  async utxos(address) {
    const out = [];
    for (let page = 1; ; page++) {
      const items = await httpGetJson(
        `${this.baseUrl}/addresses/${address}/utxos?count=100&page=${page}`, this._headers);
      if (!items || items.length === 0) break;
      for (const u of items) {
        // Blockfrost omits the owning address on each UTXO; build() needs it.
        if (u.address === undefined) u.address = address;
        out.push(u);
      }
      if (items.length < 100) break;
    }
    return out;
  }

  async protocolParams() {
    // Blockfrost's parameters are a superset of CCL's ProtocolParams; the native lib ignores
    // unknown fields, so the response passes through unchanged.
    return httpGetJson(`${this.baseUrl}/epochs/latest/parameters`, this._headers);
  }
}

// --- Transaction evaluators (execution units) ---------------------------------------------------
//
// The native library computes execution units offline with Scalus when you supply none (ADR-0013).
// A TransactionEvaluator lets you compute them with a *remote* evaluator instead. HTTP is a wrapper
// concern — libmesmo never makes network calls (ADR-0002). Use one via
// `quicktx.buildWith(yaml, provider, sender, evaluator)`.

// Interface marker: an evaluator exposes `evaluate(txCbor, utxos)` returning `[{ mem, steps }]`,
// one per redeemer in transaction order. Extend this or supply any object with that method.
export class TransactionEvaluator {
  async evaluate(txCbor, utxos) { throw new Error("not implemented"); }
}

// Cardano redeemer tag order (spend < mint < cert < reward < voting < proposing); orders an
// evaluator's purpose-keyed results to match the transaction's redeemer order.
const REDEEMER_TAG_ORDER = { spend: 0, mint: 1, cert: 2, reward: 3, vote: 4, propose: 5 };

function budgetOf(val) {
  const b = val.budget ?? val;
  return { mem: b.memory ?? b.mem, steps: b.steps ?? b.cpu };
}

// Parse an Ogmios/Blockfrost EvaluateTx response into `[{ mem, steps }]` in redeemer order. Tolerates
// the purpose-keyed map form and the Ogmios v6 list form.
export function parseEvaluation(resp) {
  let result = resp && resp.result !== undefined ? resp.result : resp;
  if (result && typeof result === "object" && result.EvaluationResult) result = result.EvaluationResult;

  const ordered = [];
  if (Array.isArray(result)) {
    for (const item of result) {
      const v = item.validator ?? item.redeemer ?? {};
      let purpose, idx;
      if (v && typeof v === "object") { purpose = v.purpose ?? ""; idx = Number(v.index ?? 0); }
      else { const parts = String(v).split(":"); purpose = parts[0]; idx = Number(parts[1] ?? 0); }
      ordered.push([REDEEMER_TAG_ORDER[purpose] ?? 99, idx, budgetOf(item)]);
    }
  } else if (result && typeof result === "object") {
    for (const [key, val] of Object.entries(result)) {
      const parts = String(key).split(":");
      ordered.push([REDEEMER_TAG_ORDER[parts[0]] ?? 99, Number(parts[1] ?? 0), budgetOf(val)]);
    }
  } else {
    throw new Error(`unrecognized evaluation response: ${typeof result}`);
  }
  ordered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return ordered.map(([, , u]) => u);
}

// Remote evaluator via a Blockfrost-compatible `/utils/txs/evaluate` endpoint. Not exercised in CI
// (needs a project id); the offline Scalus default is.
export class BlockfrostEvaluator extends TransactionEvaluator {
  constructor(projectId, { network = "mainnet", baseUrl } = {}) {
    super();
    if (!baseUrl) {
      baseUrl = BLOCKFROST_NETWORK_URLS[network];
      if (!baseUrl) throw new Error(`unknown network ${network}; pass baseUrl explicitly`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this._headers = { project_id: projectId, "Content-Type": "application/cbor" };
  }

  async evaluate(txCbor, utxos) {
    const body = Buffer.from(txCbor, "hex");
    const resp = await httpPostJson(`${this.baseUrl}/utils/txs/evaluate`, body, this._headers);
    return parseEvaluation(resp);
  }
}
