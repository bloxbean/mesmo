// Unit tests for the optional chain-data provider helpers. These exercise the HTTP-shaping logic
// (URLs, headers, pagination, address injection) and the buildWith composition by stubbing
// global fetch — the actual Yaci round-trip is covered by the DevKit integration tests.

import { describe, it, expect, afterEach } from "bun:test";
import { YaciProvider, BlockfrostProvider, TransactionEvaluator, BlockfrostEvaluator, parseEvaluation } from "../src/providers.js";
import { QuickTxApi } from "../src/index.js";
import { stringify as losslessStringify } from "lossless-json";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const body = handler(url, opts);
    // The providers read the body via .text() and parse it losslessly, so text() must return the
    // serialized JSON like a real Response — not an empty string.
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return calls;
}

describe("YaciProvider", () => {
  it("hits the DevKit utxo and parameters endpoints", async () => {
    const calls = stubFetch((url) => (url.includes("/utxos") ? [] : {}));
    const p = new YaciProvider();
    await p.utxos("addr_test1xyz");
    await p.protocolParams();
    expect(calls[0].url).toBe("http://localhost:10000/local-cluster/api/addresses/addr_test1xyz/utxos");
    expect(calls[1].url).toBe("http://localhost:10000/local-cluster/api/epochs/parameters");
  });

  it("strips a trailing slash from a custom base URL", async () => {
    const calls = stubFetch(() => []);
    await new YaciProvider("http://host:9999/api/").utxos("addrX");
    expect(calls[0].url).toBe("http://host:9999/api/addresses/addrX/utxos");
  });
});

describe("BlockfrostProvider", () => {
  it("uses the network base URL and project_id header", async () => {
    const calls = stubFetch(() => ({}));
    await new BlockfrostProvider("proj123", { network: "preprod" }).protocolParams();
    expect(calls[0].url).toBe("https://cardano-preprod.blockfrost.io/api/v0/epochs/latest/parameters");
    expect(calls[0].opts.headers).toEqual({ project_id: "proj123" });
  });

  it("throws on an unknown network", () => {
    expect(() => new BlockfrostProvider("p", { network: "nope" })).toThrow();
  });

  it("paginates utxos and injects the owning address", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      tx_hash: String(i).padStart(64, "0"), output_index: 0,
      amount: [{ unit: "lovelace", quantity: "1000000" }],
    }));
    const page2 = [{ tx_hash: "ff".repeat(32), output_index: 1,
      amount: [{ unit: "lovelace", quantity: "2000000" }] }];
    stubFetch((url) => (url.includes("page=1") ? page1 : url.includes("page=2") ? page2 : []));

    const utxos = await new BlockfrostProvider("p", { network: "preview" }).utxos("addr_test1abc");

    expect(utxos).toHaveLength(101);                                  // paged until a short page
    expect(utxos.every((u) => u.address === "addr_test1abc")).toBe(true); // address injected
  });
});

describe("buildWith", () => {
  const utxos = [{ tx_hash: "a".repeat(64), output_index: 0, address: "addrX",
    amount: [{ unit: "lovelace", quantity: "9" }] }];
  const pp = { min_fee_a: 44 };
  const provider = {
    utxos: async (addr) => { expect(addr).toBe("addrX"); return utxos; },
    protocolParams: async () => pp,
  };

  // buildWith only calls provider.* then this.build, so test the real method against a stub
  // `build` via the prototype — no native library needed.
  function stubQuickTx() {
    const quicktx = Object.create(QuickTxApi.prototype);
    const calls = [];
    quicktx.build = (y, u, p, e = null) => { calls.push([y, u, p, e]); return { tx_cbor: "DRAFT" }; };
    return { quicktx, calls };
  }

  it("with no evaluator, fetches then builds once (offline Scalus default)", async () => {
    const { quicktx, calls } = stubQuickTx();
    await quicktx.buildWith("YAML", provider, ["addrX"]);
    expect(calls).toEqual([["YAML", utxos, pp, null]]);
  });

  it("with an evaluator, runs the two-pass (draft → evaluate → rebuild)", async () => {
    const { quicktx, calls } = stubQuickTx();
    const evaluator = {
      evaluate: async (txCbor, u) => {
        expect(txCbor).toBe("DRAFT");
        expect(u).toEqual(utxos);
        return [{ mem: 1, steps: 2 }];
      },
    };
    await quicktx.buildWith("YAML", provider, ["addrX"], evaluator);
    expect(calls).toEqual([
      ["YAML", utxos, pp, null],                    // draft
      ["YAML", utxos, pp, [{ mem: 1, steps: 2 }]],  // rebuild
    ]);
  });
  it("merges and de-dupes UTXOs across senders by (tx_hash, output_index)", async () => {
    const shared = { tx_hash: "a".repeat(64), output_index: 0, address: "addrA",
      amount: [{ unit: "lovelace", quantity: "9" }] };
    const onlyB = { tx_hash: "b".repeat(64), output_index: 1, address: "addrB",
      amount: [{ unit: "lovelace", quantity: "7" }] };
    const twoSender = {
      utxos: async (addr) => (addr === "addrA" ? [shared] : [shared, onlyB]),
      protocolParams: async () => pp,
    };
    const { quicktx, calls } = stubQuickTx();
    await quicktx.buildWith("YAML", twoSender, ["addrA", "addrB"]);
    // The shared UTXO must appear exactly once — overlapping senders must not double-fund.
    expect(calls).toEqual([["YAML", [shared, onlyB], pp, null]]);
  });

});

describe("parseEvaluation", () => {
  it("orders map-form results by redeemer (spend before mint)", () => {
    const resp = { result: { EvaluationResult: {
      "mint:0": { memory: 1400, steps: 208100 },
      "spend:0": { memory: 700, steps: 100000 },
    } } };
    expect(parseEvaluation(resp)).toEqual([
      { mem: 700, steps: 100000 },
      { mem: 1400, steps: 208100 },
    ]);
  });

  it("parses the Ogmios v6 list form", () => {
    const resp = { result: [
      { validator: { index: 0, purpose: "mint" }, budget: { memory: 1400, cpu: 208100 } },
      { validator: "spend:0", budget: { memory: 700, cpu: 100000 } },
    ] };
    expect(parseEvaluation(resp)).toEqual([
      { mem: 700, steps: 100000 },
      { mem: 1400, steps: 208100 },
    ]);
  });
});

describe("BlockfrostEvaluator", () => {
  it("sets base url + headers", () => {
    const ev = new BlockfrostEvaluator("proj", { network: "preprod" });
    expect(ev instanceof TransactionEvaluator).toBe(true);
    expect(ev.baseUrl.endsWith("cardano-preprod.blockfrost.io/api/v0")).toBe(true);
    expect(ev._headers.project_id).toBe("proj");
    expect(ev._headers["Content-Type"]).toBe("application/cbor");
  });

  it("throws on an unknown network without baseUrl", () => {
    expect(() => new BlockfrostEvaluator("proj", { network: "nope" })).toThrow();
  });


});

describe("numeric precision", () => {
  it("preserves a UTxO quantity above 2^53 through the provider and into build's serialization", async () => {
    // 2^53 + 1 is not representable exactly as a float64; a native-token quantity (and lovelace on a
    // large UTxO) routinely exceeds 2^53. The response must be fed as raw JSON *text* — writing the
    // value as a JS number literal would already round it to ...992 (which is exactly why the
    // provider must not go through resp.json()/JSON.parse). The provider parses losslessly and
    // build() serializes with lossless-json, so the exact digits survive.
    const big = "9007199254740993";
    const rawBody = `[{"tx_hash":"aa","output_index":0,"amount":[{"unit":"lovelace","quantity":${big}}]}]`;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => rawBody });

    const utxos = await new YaciProvider("http://x").utxos("addr_test1abc");

    // Serialize exactly as build() does (lossless-json), and assert the digits survived intact.
    const serialized = losslessStringify(utxos);
    expect(serialized).toContain(big);
    expect(serialized).not.toContain("9007199254740992"); // the rounded value
  });
});
