// Integration tests for QuickTx (TxPlan YAML) with Yaci DevKit.
//
// Requires:
// - Yaci DevKit running on port 10000
// - Native library built: ./gradlew :core:nativeCompile
//
// Run with:
//   cd wrappers/js && MESMO_LIB_PATH=../../core/build/native/nativeCompile \
//     DYLD_LIBRARY_PATH=../../core/build/native/nativeCompile bun test test/quicktx.integration.test.js

import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { MesmoBridge, TESTNET, SigningRole, YaciProvider } from "../src/index.js";
import { DevKitHelper } from "./devkit-helper.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Headroom includes devkit.reset() re-posting itself when the devnet bootstrap wedges (up to
// ~2 minutes of self-healing before the test's own work starts).
setDefaultTimeout(300_000);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/quicktx-intents");

// The fixed test account the quicktx-intents fixtures are derived from (account 0/0). A Plutus
// fixture bakes this address in as the fee payer, so submitting it means funding and signing with
// this exact account rather than a freshly-created one.
const INTENT_MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice";
const INTENT_SENDER = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";
// The enterprise address the mint fixtures pay the freshly minted asset to.
const MINT_RECEIVER = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";

function createManaged(bridge, network) {
  const acct = bridge.accounts.create(network);
  const info = acct.info;
  const mnemonic = acct.exportRecoveryPhrase();
  acct.close();
  return { ...info, mnemonic };
}

function signPayment(bridge, mnemonic, txCbor) {
  using acct = bridge.accounts.fromMnemonic(mnemonic, TESTNET);
  return acct.signTx(txCbor);
}

function paymentYaml(from, to, quantity) {
  return `
version: 1.0
transaction:
  - tx:
      from: ${from}
      intents:
        - type: payment
          address: ${to}
          amounts:
            - unit: lovelace
              quantity: "${quantity}"
`;
}

function totalLovelace(utxos) {
  return utxos.reduce((sum, u) => {
    const lovelace = u.amount.find((a) => a.unit === "lovelace");
    return sum + (lovelace ? Number(lovelace.quantity) : 0);
  }, 0);
}

describe("QuickTx Integration (DevKit)", () => {
  let bridge;
  let devkit;
  let skip = false;

  beforeAll(async () => {
    devkit = new DevKitHelper();
    const available = await devkit.isAvailable();
    if (!available) {
      skip = true;
      console.log("Skipping: Yaci DevKit not available on port 10000");
      return;
    }
    bridge = new MesmoBridge();
    await devkit.reset();
    await devkit.waitForBlock(3000);
  });

  afterAll(() => {
    if (bridge) bridge.close();
  });

  async function fundSender(ada = 150) {
    const account = createManaged(bridge, TESTNET);
    await devkit.topup(account.base_address, ada);
    await devkit.waitForBlock(2000);
    return account;
  }

  it("should build, sign, and submit a simple ADA transfer", async () => {
    if (skip) return;

    const sender = await fundSender();
    const receiver = createManaged(bridge, TESTNET);

    const utxos = await devkit.getUtxos(sender.base_address);
    const pp = await devkit.getProtocolParams();

    const yaml = paymentYaml(sender.base_address, receiver.base_address, "5000000");
    const result = bridge.quicktx.build(yaml, utxos, pp);
    expect(result.tx_cbor.length).toBeGreaterThan(0);
    expect(result.tx_hash.length).toBe(64);
    expect(Number(result.fee)).toBeGreaterThan(0);

    const signedTx = signPayment(bridge, sender.mnemonic, result.tx_cbor);
    const txHash = await devkit.submitTx(signedTx);
    expect(txHash).toBeTruthy();

    await devkit.waitForBlock(3000);
    const receiverUtxos = await devkit.getUtxos(receiver.base_address);
    expect(totalLovelace(receiverUtxos)).toBe(5_000_000);
  });

  it("should send to multiple receivers", async () => {
    if (skip) return;

    const sender = await fundSender();
    const r1 = createManaged(bridge, TESTNET);
    const r2 = createManaged(bridge, TESTNET);

    const utxos = await devkit.getUtxos(sender.base_address);
    const pp = await devkit.getProtocolParams();

    const yaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender.base_address}
      intents:
        - type: payment
          address: ${r1.base_address}
          amounts:
            - unit: lovelace
              quantity: "3000000"
        - type: payment
          address: ${r2.base_address}
          amounts:
            - unit: lovelace
              quantity: "2000000"
`;
    const result = bridge.quicktx.build(yaml, utxos, pp);
    const signedTx = signPayment(bridge, sender.mnemonic, result.tx_cbor);
    await devkit.submitTx(signedTx);

    await devkit.waitForBlock(3000);
    const r1Utxos = await devkit.getUtxos(r1.base_address);
    expect(totalLovelace(r1Utxos)).toBe(3_000_000);
    const r2Utxos = await devkit.getUtxos(r2.base_address);
    expect(totalLovelace(r2Utxos)).toBe(2_000_000);
  });

  it("builds via a YaciProvider (buildWith) against the live devnet", async () => {
    if (skip) return;

    const sender = await fundSender();
    const receiver = createManaged(bridge, TESTNET);

    // The shipped provider fetches the devnet's real UTXOs + protocol params and feeds build().
    const provider = new YaciProvider();
    const yaml = paymentYaml(sender.base_address, receiver.base_address, "5000000");
    const result = await bridge.quicktx.buildWith(yaml, provider, [sender.base_address]);

    expect(result.tx_cbor.length).toBeGreaterThan(0);
    expect(result.tx_hash.length).toBe(64);
    expect(Number(result.fee)).toBeGreaterThan(0);
  });

  // Submit a treasury donation.
  //
  // Conway validates the tx's declared current_treasury_value against the node's live ledger treasury
  // *exactly* (ConwayTreasuryValueMismatch otherwise), so the donation.yaml fixture's hardcoded
  // current_treasury_value: 0 no longer works on Yaci DevKit 0.12 (non-zero, epoch-varying treasury).
  //
  // We deliberately do NOT read the treasury from an endpoint and declare it — and not for lack of
  // trying. The obvious "clean" design was to read yaci-store's /network endpoint
  // (http://localhost:8080/api/v1/network -> supply.treasury) and submit that exact value. It does
  // not work reliably: yaci-store computes the treasury off-chain and its value drifts from the
  // node's ledger — in CI it returned 21,599,698,134,578 while the node held 43,186,776,312,112 (an
  // epoch of indexing lag), so the fetched value was rejected. The node is the sole authority on its
  // own treasury, and the only channel that reports its exact current value is the rejection itself.
  //
  // So: submit, read "expected: Coin N" out of the ConwayTreasuryValueMismatch, rebuild with N, and
  // resubmit. Retrying also absorbs an epoch boundary landing between attempts. The offline donation
  // build is covered separately by the intents build tests.
  it("should build, sign, and submit a treasury donation", async () => {
    if (skip) return;

    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);

    const utxos = await devkit.getUtxos(INTENT_SENDER);
    const pp = await devkit.getProtocolParams();
    const baseYaml = readFileSync(join(FIXTURES, "donation.yaml"), "utf8");

    let treasury = "0";
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const yaml = baseYaml.replace("current_treasury_value: 0", `current_treasury_value: ${treasury}`);
      const result = bridge.quicktx.build(yaml, utxos, pp);
      const signed = signPayment(bridge, INTENT_MNEMONIC, result.tx_cbor);
      const submitResult = await devkit.submitTx(signed);
      if (/^[0-9a-f]{64}$/.test(submitResult)) return; // accepted
      lastErr = submitResult;
      const m = String(submitResult).match(/expected:\s*Coin\s*(\d+)/);
      if (!m) throw new Error(`submit: ${submitResult}`);
      treasury = m[1];
    }
    throw new Error(`donation submit failed after retries: ${lastErr}`);
  });

  it("should throw on insufficient funds", async () => {
    if (skip) return;

    const sender = await fundSender(2);
    const receiver = createManaged(bridge, TESTNET);

    const utxos = await devkit.getUtxos(sender.base_address);
    const pp = await devkit.getProtocolParams();

    const yaml = paymentYaml(sender.base_address, receiver.base_address, "100000000");
    expect(() => bridge.quicktx.build(yaml, utxos, pp)).toThrow();
  });

  // Plutus round-trip: build the script_minting fixture with caller-supplied exec units, sign with
  // the fee payer's payment key, submit, and assert the minted asset landed on-chain. "Submit
  // accepted" alone doesn't prove the script ran and minted — the receiver holding a non-lovelace
  // asset does. Mirrors the Go TestIntegrationPlutusMint.
  //
  // This passes the devnet's fetched protocol parameters *including* its cost models, exercising the
  // wrapper's cost-model ordering fix (normalizeCostModels): the devnet returns cost models keyed by
  // numeric indices, and without the fix JS reorders those keys and the node rejects the tx with
  // PPViewHashesDontMatch (a script-integrity hash mismatch).
  it("should build, sign, and submit a Plutus mint", async () => {
    if (skip) return;

    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);

    const utxos = await devkit.getUtxos(INTENT_SENDER);
    const pp = await devkit.getProtocolParams();
    // DIAG: does this DevKit version emit the preferred cost_models_raw form?
    console.log("DIAG has cost_models_raw:", !!pp.cost_models_raw,
      pp.cost_models_raw ? Object.keys(pp.cost_models_raw).join("+") : "");
    const yaml = readFileSync(join(FIXTURES, "plutus", "script_minting.yaml"), "utf8");

    const result = bridge.quicktx.build(yaml, utxos, pp, [{ mem: 2000000, steps: 500000000 }]);
    expect(result.tx_hash.length).toBe(64);

    const signedTx = (() => {
      using acct = bridge.accounts.fromMnemonic(INTENT_MNEMONIC, TESTNET);
      const map = { payment: SigningRole.PAYMENT, stake: SigningRole.STAKE, drep: SigningRole.DREP };
      return acct.signTx(result.tx_cbor, ["payment"].reduce((m, k) => m | map[k], 0));
    })();
    // A successful submit returns the 64-char tx hash; a rejection returns an error body. Assert the
    // hash so a failed Plutus validation surfaces here, not as a missing asset further down.
    const submitResult = await devkit.submitTx(signedTx);
    expect(submitResult).toMatch(/^[0-9a-f]{64}$/);

    await devkit.waitForBlock(3000);
    const receiverUtxos = await devkit.getUtxos(MINT_RECEIVER);
    const hasMintedAsset = receiverUtxos.some((u) => u.amount.some((a) => a.unit !== "lovelace"));
    expect(hasMintedAsset).toBe(true);
  });
});
