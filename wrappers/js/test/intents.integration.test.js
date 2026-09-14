// End-to-end submit tests for the quicktx-intents fixtures (governance + smart-contract + metadata).
//
// Each test builds an intent's TxPlan offline, signs it with the right key roles, submits it to a
// Yaci DevKit devnet, and asserts the node accepted it (a rejected tx gets a 400 with the ledger
// error, so an accepted 64-char tx hash coming back is the proof). Where "accepted" alone doesn't
// prove the intended effect (mint, spend), we additionally assert the on-chain outcome.
//
// They use the fixed test account the fixtures are derived from (INTENT_MNEMONIC / INTENT_SENDER),
// funded fresh on the devnet per test for isolation. They SKIP when DevKit is not running, so they
// are exercised only by the CI "Integration Tests (DevKit)" job, not locally.
//
// Mirrors wrappers/go/ccl/intents_integration_test.go.
//
// Requires:
// - Yaci DevKit running on port 10000
// - Native library built: ./gradlew :core:nativeCompile
//
// Run with:
//   cd wrappers/js && CCL_LIB_PATH=../../core/build/native/nativeCompile \
//     DYLD_LIBRARY_PATH=../../core/build/native/nativeCompile bun test test/intents.integration.test.js

import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { CclBridge, TESTNET, SigningRole } from "../src/index.js";
import { DevKitHelper } from "./devkit-helper.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// The governance multi-step sequences reset+fund the devnet and submit several txs across blocks, so
// give them plenty of headroom — including for reset() re-posting itself when the devnet bootstrap
// wedges (up to ~2 minutes of self-healing before the test's own work starts). (When DevKit is down
// the tests return immediately, so a high default is harmless.)
setDefaultTimeout(300_000);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/quicktx-intents");

// The fixed test account the quicktx-intents fixtures are derived from (account 0/0). The fixtures
// bake this address in as the fee payer, so submitting them means funding and signing with this
// exact account rather than a freshly-created one.
const INTENT_MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice";
const INTENT_SENDER = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";
// The enterprise address the mint fixtures pay the freshly minted asset to.
const MINT_RECEIVER = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";

// Plutus-spend fixture constants (kept in lockstep with the fixtures + Go script_spend_test.go).
const SCRIPT_ADDR = "addr_test1wpunlryvl7aqsxe22erzlsseej87v5kk5vutvtrmzdy8dect48z0w";
const SCRIPT_DATUM_HASH = "9e1199a988ba72ffd6e9c269cadb3b53b5f360ff99f112d9b2ee30c4d74ad88b";
// The placeholder utxo_ref baked into script_collect_from.yaml; repointed at the real locked UTXO.
const SCRIPT_TX_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// The gov_action_tx_hash baked into voting.yaml; the voting test repoints it at the real proposal.
const GOV_ACTION_PLACEHOLDER = "12745f09b138d4d0a11a560b4591ebb830cf12336347606d2edbbf1893d395c6";

// The pool id baked into stake_delegation.yaml, and the pool id keyed to the account's stake key in
// pool_registration.yaml. The delegation test repoints the placeholder at the account's pool.
const POOL_PLACEHOLDER = "pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy";
const ACCOUNT_POOL_ID = "pool1xtrj35uxrctye2egew8sqezgzwwg796ql7uw02572gedcpgmwck";

const TX_HASH_RE = /^[0-9a-f]{64}$/;

function readFixture(rel) {
  return readFileSync(join(FIXTURES, rel), "utf8");
}

describe("Intents Integration (DevKit)", () => {
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
    bridge = new CclBridge();
  });

  afterAll(() => {
    if (bridge) bridge.close();
  });

  // --- helpers (mirror the Go test harness) ---

  // devnetPP fetches the devnet protocol parameters and fills in the Conway deposits DevKit returns
  // as null (the node validates the actual values on submit).
  async function devnetPP() {
    const pp = await devkit.getProtocolParams();
    pp.drep_deposit = "500000000";
    pp.gov_action_deposit = "1000000000";
    pp.pool_deposit = "500000000";
    return pp;
  }

  // submitExpectHash submits and requires the node to have accepted the tx. The devnet's /tx/submit
  // returns the 64-char tx hash only after the node validated and accepted it; a rejection returns
  // the ledger error body instead — which we surface as a thrown error.
  async function submitExpectHash(signed) {
    const res = await devkit.submitTx(signed);
    if (!TX_HASH_RE.test(res)) throw new Error(`submit rejected: ${res}`);
    return res;
  }

  // signSubmit builds the YAML with the given UTXOs + params, signs with the key roles, and submits.
  // The fee's witness budget defaults to keys.length - 1 (the signer count is known here, exactly as
  // it is for a real caller); pass additionalSigners explicitly where the inputs imply no payment
  // key (e.g. a script-only-input spend).
  function rolesMask(keys) {
    const map = { payment: SigningRole.PAYMENT, stake: SigningRole.STAKE, drep: SigningRole.DREP };
    return keys.reduce((mask, k) => mask | map[k], 0);
  }

  function intentSign(txCbor, keys, addressIndex = 0) {
    using acct = bridge.accounts.fromMnemonic(INTENT_MNEMONIC, TESTNET, 0, addressIndex);
    return acct.signTx(txCbor, rolesMask(keys));
  }

  async function signSubmit(yaml, utxos, pp, execUnits, keys, additionalSigners = null) {
    const budget = additionalSigners ?? Math.max(0, keys.length - 1);
    const result = bridge.quicktx.build(yaml, utxos, pp, execUnits ?? null, budget);
    const signed = intentSign(result.tx_cbor, keys);
    return submitExpectHash(signed);
  }

  // buildSignSubmit resets the devnet, funds the fixed account, builds the fixture with its real
  // UTXOs, signs with the given key roles, submits, and verifies the tx landed on-chain.
  async function buildSignSubmit(fixture, execUnits, keys) {
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const utxos = await devkit.getUtxos(INTENT_SENDER);
    const pp = await devnetPP();
    return signSubmit(readFixture(fixture), utxos, pp, execUnits, keys);
  }

  // setupThenSubmit resets+funds the devnet, submits a prerequisite fixture (e.g. registering a stake
  // address or DRep), then submits the target fixture in the next block. Used for intents whose
  // certificate depends on prior on-chain state.
  async function setupThenSubmit(setupFixture, setupKeys, fixture, keys) {
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();
    const u = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture(setupFixture), u, pp, null, setupKeys);
    await devkit.waitForBlock(3000);
    const u2 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture(fixture), u2, pp, null, keys);
  }

  // assertMintedAssetAt confirms a mint actually landed on-chain: the receiver holds a non-lovelace
  // asset. ("Submit accepted" alone doesn't prove the intended effect; this does.)
  async function assertMintedAssetAt(address) {
    await devkit.waitForBlock(3000);
    const utxos = await devkit.getUtxos(address);
    const hasMintedAsset = utxos.some((u) => u.amount.some((a) => a.unit && a.unit !== "lovelace"));
    expect(hasMintedAsset).toBe(true);
  }

  // assertUtxoConsumed confirms the given UTXO is no longer present at an address (it was spent).
  async function assertUtxoConsumed(address, txHash) {
    await devkit.waitForBlock(3000);
    const utxos = await devkit.getUtxos(address);
    const stillPresent = utxos.some((u) => u.tx_hash === txHash);
    expect(stillPresent).toBe(false);
  }

  // --- Stake certificates ---

  // ADR-0016 end-to-end: build offline, sign with a managed Account handle (typed role mask, no
  // mnemonic in the signing call), and have the node accept the transaction.
  it("submits a transaction signed via a managed Account handle", async () => {
    if (skip) return;
    await resetAndFund();
    const utxos = await devkit.getUtxos(INTENT_SENDER);
    const built = bridge.quicktx.build(
      readFixture("stake_registration.yaml"), utxos, await devnetPP(), null, 1);
    const acct = bridge.accounts.fromMnemonic(INTENT_MNEMONIC, TESTNET);
    let signed;
    try {
      signed = acct.signTx(built.tx_cbor, SigningRole.PAYMENT | SigningRole.STAKE);
    } finally {
      acct.close();
    }
    await submitExpectHash(signed);
  });

  // Mirrors Go TestIntegrationStakeRegistration. The stake-registration certificate is witnessed by
  // the stake key, so sign with payment+stake.
  it("registers a stake address", async () => {
    if (skip) return;
    await buildSignSubmit("stake_registration.yaml", null, ["payment", "stake"]);
  });

  // Mirrors Go TestIntegrationStakeDelegation. DevKit exposes no pool-list endpoint, so we register a
  // pool keyed to the account and delegate to it (rather than discover an existing pool): register
  // stake -> register pool -> delegate to that pool (repointing the fixture's placeholder pool id).
  it("delegates a stake address to a pool it registers", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const u = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("stake_registration.yaml"), u, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("pool_registration.yaml"), u2, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u3 = await devkit.getUtxos(INTENT_SENDER);
    const delegYaml = readFixture("stake_delegation.yaml").replaceAll(POOL_PLACEHOLDER, ACCOUNT_POOL_ID);
    await signSubmit(delegYaml, u3, pp, null, ["payment", "stake"]);
  });

  // Extends the Go suite (which covers registration, delegation, and withdrawal) with an explicit
  // deregistration: register the stake address, then deregister it. The deregistration certificate is
  // witnessed by the stake key, so sign with payment+stake.
  it("deregisters a stake address it registered", async () => {
    if (skip) return;
    await setupThenSubmit(
      "stake_registration.yaml", ["payment", "stake"],
      "stake_deregistration.yaml", ["payment", "stake"],
    );
  });

  // Register the account-keyed pool, then retire it. The retirement certificate is witnessed by
  // the pool's operator key — which pool_registration.yaml keys to the account's stake key.
  // Conway bounds the retirement epoch to (current, current+e_max]; the fixture's hardcoded 500
  // is out of range on a young devnet, so repoint it at current+2.
  it("retires a stake pool it registers", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const u = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("stake_registration.yaml"), u, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("pool_registration.yaml"), u2, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const epoch = await devkit.getLatestEpoch();
    const retireYaml = readFixture("pool_retirement.yaml")
      .replaceAll(POOL_PLACEHOLDER, ACCOUNT_POOL_ID)
      .replace("retirement_epoch: 500", `retirement_epoch: ${epoch + 2}`);

    const u3 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(retireYaml, u3, pp, null, ["payment", "stake"]);
  });

  // Mirrors Go TestIntegrationStakeWithdrawal. Conway requires a stake address to be vote-delegated to
  // a DRep before it can withdraw, so the sequence is: register stake -> delegate voting power ->
  // withdraw the (zero) reward balance.
  it("withdraws a (zero) reward balance after vote-delegating", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const u = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("stake_registration.yaml"), u, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("voting_delegation.yaml"), u2, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u3 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("stake_withdrawal.yaml"), u3, pp, null, ["payment", "stake"]);
  });

  // --- DRep + governance ---

  // Mirrors Go TestIntegrationDRepRegistration. The DRep-registration certificate is witnessed by the
  // DRep key, so sign with payment+drep.
  it("registers a DRep", async () => {
    if (skip) return;
    await buildSignSubmit("drep_registration.yaml", null, ["payment", "drep"]);
  });

  // Mirrors Go TestIntegrationDRepUpdate. Register the DRep first, then update it.
  it("updates a DRep it registered", async () => {
    if (skip) return;
    await setupThenSubmit(
      "drep_registration.yaml", ["payment", "drep"],
      "drep_update.yaml", ["payment", "drep"],
    );
  });

  // Mirrors Go TestIntegrationDRepDeregistration. Register the DRep first, then deregister it.
  it("deregisters a DRep it registered", async () => {
    if (skip) return;
    await setupThenSubmit(
      "drep_registration.yaml", ["payment", "drep"],
      "drep_deregistration.yaml", ["payment", "drep"],
    );
  });

  // Mirrors Go TestIntegrationDRepKeyRequired (negative). A DRep-registration certificate must be
  // witnessed by the DRep key, so signing with the payment key alone (SigningRole.PAYMENT only, no drep
  // witness) must be rejected by the node (MissingVKeyWitnessesUTXOW). This proves the extra witness
  // the stake role adds is genuinely required — not cosmetic — complementing the positive
  // registration test above.
  it("rejects a DRep registration signed with the payment key only", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const utxos = await devkit.getUtxos(INTENT_SENDER);
    const built = bridge.quicktx.build(readFixture("drep_registration.yaml"), utxos, pp, null, 1);

    // Sign with the payment key ONLY, omitting the DRep-key witness.
    const signedPaymentOnly = intentSign(built.tx_cbor, ['payment']);
    const res = await devkit.submitTx(signedPaymentOnly);
    // The node must reject it — so no 64-char tx hash comes back, only the ledger error body.
    expect(res).not.toMatch(TX_HASH_RE);
  });

  // Mirrors Go TestIntegrationVotingDelegation. Delegating voting power requires the stake address to
  // be registered; the fixture's vote target is abstain.
  it("delegates voting power after registering the stake address", async () => {
    if (skip) return;
    await setupThenSubmit(
      "stake_registration.yaml", ["payment", "stake"],
      "voting_delegation.yaml", ["payment", "stake"],
    );
  });

  // Mirrors Go TestIntegrationInfoProposal. A Conway proposal's deposit-return account must be a
  // registered stake address, so register it first, then submit the proposal in the next block.
  it("submits an info governance proposal after registering the return account", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const utxos = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("stake_registration.yaml"), utxos, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const utxos2 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("governance_proposal.yaml"), utxos2, pp, null, ["payment"]);
  });

  // Mirrors Go TestIntegrationVoting. A vote needs a registered DRep (the voter), a registered stake
  // address (the proposal's return account), a live gov action to vote on, and the vote referencing
  // it. We submit an info proposal and use its build-result tx hash (not the submit response) as the
  // gov action id, repointing the voting fixture's placeholder at it.
  it("votes on an info proposal it submits", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const u = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("drep_registration.yaml"), u, pp, null, ["payment", "drep"]);
    await devkit.waitForBlock(3000);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("stake_registration.yaml"), u2, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    // Submit an info proposal. Its build-result tx hash is the gov action id we vote on.
    const u3 = await devkit.getUtxos(INTENT_SENDER);
    const proposal = bridge.quicktx.build(readFixture("governance_proposal.yaml"), u3, pp);
    const actionTxHash = proposal.tx_hash;
    const signedProposal = intentSign(proposal.tx_cbor, ["payment"]);
    await submitExpectHash(signedProposal);
    await devkit.waitForBlock(3000);

    // Vote on the proposal we just submitted.
    const u4 = await devkit.getUtxos(INTENT_SENDER);
    const voteYaml = readFixture("voting.yaml").replaceAll(GOV_ACTION_PLACEHOLDER, actionTxHash);
    await signSubmit(voteYaml, u4, pp, null, ["payment", "drep"]);
  });

  // --- Pool ---

  // Mirrors Go TestIntegrationPoolRegistration. The fixture keys the pool to the account's stake key
  // (operator, owner, reward account), so signing with the stake key witnesses it. The reward account
  // must be a registered stake address, so register it first.
  it("registers a stake pool", async () => {
    if (skip) return;
    await setupThenSubmit(
      "stake_registration.yaml", ["payment", "stake"],
      "pool_registration.yaml", ["payment", "stake"],
    );
  });

  // --- Metadata + native / Plutus scripts ---

  // Mirrors Go TestIntegrationMetadata. Attaching metadata needs only the fee payer's signature.
  it("submits a transaction with metadata", async () => {
    if (skip) return;
    await buildSignSubmit("metadata.yaml", null, ["payment"]);
  });

  // Mirrors Go TestIntegrationNativeMint. The fixture mints under an empty-ScriptAll policy that needs
  // no signature, so the fee payer alone can submit it; assert the asset landed on-chain.
  it("mints an asset under a native script", async () => {
    if (skip) return;
    await buildSignSubmit("minting.yaml", null, ["payment"]);
    await assertMintedAssetAt(MINT_RECEIVER);
  });

  // Mirrors Go TestIntegrationPlutusMint. Build with caller-supplied exec units, sign with the fee
  // payer's payment key, submit, and assert the minted asset landed on-chain.
  it("mints an asset under a Plutus script", async () => {
    if (skip) return;
    await buildSignSubmit("plutus/script_minting.yaml",
      [{ mem: 2000000, steps: 500000000 }], ["payment"]);
    await assertMintedAssetAt(MINT_RECEIVER);
  });

  // The offline Scalus evaluator is the DEFAULT costing path: when a caller supplies no execution
  // units, libccl computes them in-process (ADR-0013). Every other Plutus test supplies units
  // manually (they must, to submit a failing script), so this is the only test proving the node
  // accepts Scalus-computed budgets end-to-end — the path out-of-the-box users are on.
  it("mints under a Plutus script with Scalus-computed units (no exec units supplied)", async () => {
    if (skip) return;
    await buildSignSubmit("plutus/script_minting.yaml", null, ["payment"]);
    await assertMintedAssetAt(MINT_RECEIVER);
  });

  // The Aiken redeemer_check validator (test-fixtures/aiken/redeemer-check) passes iff the
  // redeemer is the integer 42 — a real validator that can genuinely reject, unlike the
  // always-succeeds blob the other Plutus fixtures use.
  it("mints with the Aiken redeemer-check validator (redeemer 42 accepted)", async () => {
    if (skip) return;
    await buildSignSubmit("plutus/aiken_mint_pass.yaml",
      [{ mem: 2000000, steps: 500000000 }], ["payment"]);
    await assertMintedAssetAt(MINT_RECEIVER);
  });

  // Negative validation: redeemer 0 makes the same validator evaluate to false, so phase-2
  // validation fails and the node must reject the tx. Exec units are supplied manually — the
  // bridge's StaticTransactionEvaluator stamps them without running the script, which is exactly
  // what lets a validation-failing tx reach the node.
  it("rejects the Aiken redeemer-check mint with a wrong redeemer", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);

    const utxos = await devkit.getUtxos(INTENT_SENDER);
    const result = bridge.quicktx.build(readFixture("plutus/aiken_mint_fail.yaml"),
      utxos, await devnetPP(), [{ mem: 2000000, steps: 500000000 }]);
    const signed = intentSign(result.tx_cbor, ["payment"]);
    const res = await devkit.submitTx(signed);
    expect(TX_HASH_RE.test(res)).toBe(false); // the node must reject, not return a tx hash
  });

  // Mirrors Go TestIntegrationPlutusSpend. Lock a UTXO at the script address (with the datum hash),
  // find it on-chain, repoint the spend fixture's placeholder utxo_ref at the real locked UTXO, then
  // spend it — supplying the locked UTXO (with its datum hash) + a fee/collateral UTXO. Confirm the
  // spend consumed the locked script UTXO.
  it("locks a UTXO at a Plutus script and then spends it", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    // Step 1: lock 10 ADA at the script address with the datum hash.
    const utxos = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("plutus/plutus_lock.yaml"), utxos, pp, null, ["payment"]);
    await devkit.waitForBlock(3000);

    // Step 2: find the locked UTXO at the script address.
    const scriptUtxos = await devkit.getUtxos(SCRIPT_ADDR);
    expect(scriptUtxos.length).toBeGreaterThan(0);
    const locked = scriptUtxos[0];
    const lockHash = locked.tx_hash;
    const lockIdx = Number(locked.output_index ?? 0);

    // Step 3: repoint the spend fixture's utxo_ref at the real locked UTXO.
    let spendYaml = readFixture("plutus/script_collect_from.yaml").replaceAll(SCRIPT_TX_HASH, lockHash);
    if (lockIdx !== 0) spendYaml = spendYaml.replace("output_index: 0", `output_index: ${lockIdx}`);

    // Step 4: spend it — supply the locked UTXO (with its datum hash) + a fee/collateral UTXO.
    const feeUtxos = await devkit.getUtxos(INTENT_SENDER);
    const spendUtxos = [
      {
        tx_hash: lockHash,
        output_index: lockIdx,
        address: SCRIPT_ADDR,
        amount: [{ unit: "lovelace", quantity: "10000000" }],
        data_hash: SCRIPT_DATUM_HASH,
      },
      ...feeUtxos,
    ];

    await signSubmit(spendYaml, spendUtxos, pp,
      [{ mem: 2000000, steps: 500000000 }], ["payment"]);

    // Confirm the spend actually consumed the locked script UTXO.
    await assertUtxoConsumed(SCRIPT_ADDR, lockHash);
  });

  // --- Ledger-effect helpers (balance-delta read-backs) ---

  function totalLovelace(utxos) {
    return utxos.reduce((sum, u) =>
      sum + u.amount.reduce((s, a) => (a.unit === "lovelace" ? s + Number(a.quantity) : s), 0), 0);
  }

  async function balanceAt(address) {
    return totalLovelace(await devkit.getUtxos(address));
  }

  // signSubmit, additionally returning the tx fee so callers can assert the sender's exact
  // balance change (the ledger read-back "submit accepted" alone can't give).
  async function signSubmitFee(yaml, utxos, pp, execUnits, keys) {
    const result = bridge.quicktx.build(yaml, utxos, pp, execUnits ?? null,
      Math.max(0, keys.length - 1));
    const signed = intentSign(result.tx_cbor, keys);
    await submitExpectHash(signed);
    return Number(result.fee);
  }

  async function resetAndFund(ada = 6000) {
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, ada);
    await devkit.waitForBlock(3000);
    return devnetPP();
  }

  // --- Ledger-effect tests: certificate deposits must move the sender's balance exactly ---

  // The stake-key deposit must leave on registration and come back on deregistration.
  it("moves the stake-key deposit out and back (registration → deregistration)", async () => {
    if (skip) return;
    const pp = await resetAndFund();
    const keyDeposit = Number(pp.key_deposit);
    const start = await balanceAt(INTENT_SENDER);

    const u = await devkit.getUtxos(INTENT_SENDER);
    const fee1 = await signSubmitFee(readFixture("stake_registration.yaml"), u, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);
    expect(await balanceAt(INTENT_SENDER)).toBe(start - fee1 - keyDeposit);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    const fee2 = await signSubmitFee(readFixture("stake_deregistration.yaml"), u2, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);
    expect(await balanceAt(INTENT_SENDER)).toBe(start - fee1 - fee2); // deposit refunded
  });

  // A DRep registration must take exactly fee + drep_deposit from the sender.
  it("takes exactly fee + drep_deposit on DRep registration", async () => {
    if (skip) return;
    const pp = await resetAndFund();
    const drepDeposit = Number(pp.drep_deposit);
    const start = await balanceAt(INTENT_SENDER);

    const u = await devkit.getUtxos(INTENT_SENDER);
    const fee = await signSubmitFee(readFixture("drep_registration.yaml"), u, pp, null, ["payment", "drep"]);
    await devkit.waitForBlock(3000);
    expect(await balanceAt(INTENT_SENDER)).toBe(start - fee - drepDeposit);
  });

  // A governance proposal must take exactly fee + gov_action_deposit (after the stake
  // registration takes fee + key_deposit for the deposit-return account).
  it("takes exactly fee + gov_action_deposit on a proposal", async () => {
    if (skip) return;
    const pp = await resetAndFund();
    const keyDeposit = Number(pp.key_deposit);
    const govDeposit = Number(pp.gov_action_deposit);
    const start = await balanceAt(INTENT_SENDER);

    const u = await devkit.getUtxos(INTENT_SENDER);
    const fee1 = await signSubmitFee(readFixture("stake_registration.yaml"), u, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    const fee2 = await signSubmitFee(readFixture("governance_proposal.yaml"), u2, pp, null, ["payment"]);
    await devkit.waitForBlock(3000);

    expect(await balanceAt(INTENT_SENDER)).toBe(start - fee1 - keyDeposit - fee2 - govDeposit);
  });

  // A pool registration must take exactly fee + pool_deposit (after the stake registration).
  it("takes exactly fee + pool_deposit on pool registration", async () => {
    if (skip) return;
    const pp = await resetAndFund();
    const keyDeposit = Number(pp.key_deposit);
    const poolDeposit = Number(pp.pool_deposit);
    const start = await balanceAt(INTENT_SENDER);

    const u = await devkit.getUtxos(INTENT_SENDER);
    const fee1 = await signSubmitFee(readFixture("stake_registration.yaml"), u, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    const fee2 = await signSubmitFee(readFixture("pool_registration.yaml"), u2, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    expect(await balanceAt(INTENT_SENDER)).toBe(start - fee1 - keyDeposit - fee2 - poolDeposit);
  });

  // --- Never-submitted intents from the coverage audit ---

  // The compose fixture's second sender: same mnemonic, address_index 1.
  const INTENT_SENDER2 = "addr_test1qz7svwszky8gcmhrfza7a89z9u0dfzd3l7h23sqlc5yml7ejcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwqcqrvr0";

  // collect_from: spend exactly the named UTXO instead of automatic selection.
  it("spends an explicitly selected UTXO (collect_from)", async () => {
    if (skip) return;
    const pp = await resetAndFund();

    const utxos = await devkit.getUtxos(INTENT_SENDER);
    expect(utxos.length).toBeGreaterThan(0);
    const target = utxos[0];
    let yaml = readFixture("collect_from.yaml").replaceAll("a".repeat(64), target.tx_hash);
    const idx = Number(target.output_index ?? 0);
    if (idx !== 0) yaml = yaml.replace("output_index: 0", `output_index: ${idx}`);

    await signSubmit(yaml, utxos, pp, null, ["payment"]);
  });

  // reference_input: a read-only reference input (CIP-31) must resolve to a real UTXO; fund the
  // second intent address and reference its UTXO (it is not spent — its balance must not change).
  it("adds a read-only reference input without spending it", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.topup(INTENT_SENDER2, 5);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const refUtxos = await devkit.getUtxos(INTENT_SENDER2);
    expect(refUtxos.length).toBeGreaterThan(0);
    const refBalance = totalLovelace(refUtxos);
    const yaml = readFixture("reference_input.yaml").replaceAll("c".repeat(64), refUtxos[0].tx_hash);

    const utxos = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(yaml, utxos, pp, null, ["payment"]);
    await devkit.waitForBlock(3000);

    expect(await balanceAt(INTENT_SENDER2)).toBe(refBalance); // referenced, not spent
  });

  // native_script: a script witness may only be attached when the transaction actually uses the
  // script — Conway rejects unused witnesses (ExtraneousScriptWitnessesUTXOW; the standalone
  // "attach" fixture proved that on its first devnet submission, which is why it stays
  // offline-build only). So exercise the real thing: lock funds at a sig(payment-key) native
  // script address built at test time, then spend them with the script attached, witnessed by the
  // payment key. This is the only test of native-script *spending* (minting is covered separately).
  it("locks at and spends from a native script address (script attached)", async () => {
    if (skip) return;
    const pp = await resetAndFund();

    // Build a native script the sender's payment key satisfies, and its script address.
    const info = bridge.address.info(INTENT_SENDER);
    const script = JSON.parse(bridge.script.nativeFromJson(
      JSON.stringify({ type: "sig", keyHash: info.payment_credential_hash })));
    // nativeFromJson's cbor_hex is the hash preimage (leading 0x00 language tag); the TxPlan
    // native_script block wants the bare script CBOR.
    const scriptHex = script.cbor_hex.slice(2);
    const scriptAddress = bridge.address.fromBytes("70" + script.script_hash); // testnet script enterprise

    // Step 1: lock 5 ADA at the script address.
    const lockYaml = `
version: 1.0
transaction:
  - tx:
      from: ${INTENT_SENDER}
      change_address: ${INTENT_SENDER}
      intents:
        - type: payment
          address: ${scriptAddress}
          amounts:
            - unit: lovelace
              quantity: "5000000"
`;
    const u = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(lockYaml, u, pp, null, ["payment"]);
    await devkit.waitForBlock(3000);

    // Step 2: spend the locked UTXO with the native script attached.
    const scriptUtxos = await devkit.getUtxos(scriptAddress);
    expect(scriptUtxos.length).toBeGreaterThan(0);
    const lockHash = scriptUtxos[0].tx_hash;
    const lockIdx = Number(scriptUtxos[0].output_index ?? 0);

    const spendYaml = `
version: 1.0
context:
  fee_payer: ${INTENT_SENDER}
transaction:
  - tx:
      from: ${INTENT_SENDER}
      change_address: ${INTENT_SENDER}
      inputs:
        - type: collect_from
          utxo_refs:
            - tx_hash: ${lockHash}
              output_index: ${lockIdx}
      intents:
        - type: payment
          address: ${INTENT_SENDER}
          amounts:
            - unit: lovelace
              quantity: "3000000"
      scripts:
        - type: native_script
          script_hex: ${scriptHex}
`;
    const feeUtxos = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(spendYaml, [...scriptUtxos, ...feeUtxos], pp, null, ["payment"], 1);

    await assertUtxoConsumed(scriptAddress, lockHash);
  });

  // pool_update: re-submit the pool's registration certificate with update semantics.
  it("updates a stake pool it registers", async () => {
    if (skip) return;
    const pp = await resetAndFund();

    const u = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("stake_registration.yaml"), u, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u2 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("pool_registration.yaml"), u2, pp, null, ["payment", "stake"]);
    await devkit.waitForBlock(3000);

    const u3 = await devkit.getUtxos(INTENT_SENDER);
    await signSubmit(readFixture("pool_update.yaml"), u3, pp, null, ["payment", "stake"]);
  });

  // compose: two senders' intents composed into ONE transaction, signed once per sender's payment
  // key; both payments must land at the receiver.
  it("composes two senders into one transaction (signed by both)", async () => {
    if (skip) return;
    await devkit.reset();
    await devkit.waitForBlock(3000);
    await devkit.topup(INTENT_SENDER, 6000);
    await devkit.topup(INTENT_SENDER2, 6000);
    await devkit.waitForBlock(3000);
    const pp = await devnetPP();

    const utxos = [
      ...(await devkit.getUtxos(INTENT_SENDER)),
      ...(await devkit.getUtxos(INTENT_SENDER2)),
    ];
    const result = bridge.quicktx.build(readFixture("compose.yaml"), utxos, pp);
    const once = intentSign(result.tx_cbor, ['payment']);
    const twice = intentSign(once, ['payment'], 1);
    await submitExpectHash(twice);
    await devkit.waitForBlock(3000);

    // 5 ADA from sender1 + 3 ADA from sender2, both to the same receiver.
    expect(await balanceAt(MINT_RECEIVER)).toBe(8_000_000);
  });
});
