//! End-to-end submit tests for every TxPlan intent against a Yaci DevKit devnet.
//!
//! Each test builds an intent's TxPlan offline (from the shared `test-fixtures/quicktx-intents`
//! fixtures, with the devnet's real UTXOs + protocol parameters), signs it with the right key roles,
//! submits it to the devnet, and asserts the node accepted it (and, where meaningful, that the
//! intended on-chain effect landed). This proves the bridge produces node-acceptable transactions —
//! not just buildable CBOR.
//!
//! Mirrors the Go `intents_integration_test.go` suite one-for-one, using the fixed intent account the
//! fixtures are derived from (INTENT_MNEMONIC / INTENT_SENDER), funded fresh per test for isolation.
//! Tests SKIP when DevKit is not reachable, so they are exercised only by the CI
//! "Integration Tests (DevKit)" job, not locally.
//!
//! Requires:
//! - Yaci DevKit running on port 10000
//! - Native library built: ./gradlew :core:nativeCompile
//!
//! Run from wrappers/rust:
//!   CCL_LIB_PATH=../../core/build/native/nativeCompile \
//!     cargo test --features providers --test intents_integration_test -- --test-threads=1

mod common;

use ccl::Bridge;
use common::*;
use serde_json::json;

// ADR-0016 end-to-end: build offline, sign with a managed Account (typed role mask, no mnemonic
// in the signing call), and have the node accept the transaction.
#[test]
fn test_integration_managed_account_handle_sign_submit() {
    if skip_if_no_devkit() {
        return;
    }
    use ccl::accounts::SigningRole;
    let bridge = Bridge::new().expect("create bridge");
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let utxos = devkit_get_utxos(INTENT_SENDER);
    let pp = devnet_pp();
    let built = bridge
        .quicktx()
        .build(&read_fixture("stake_registration.yaml"), &utxos, &pp, None, 1)
        .expect("build");
    let acct = bridge
        .accounts()
        .from_mnemonic(INTENT_MNEMONIC, ccl::Network::Testnet, 0, 0)
        .expect("open account");
    let signed = acct
        .sign_tx(&built.tx_cbor, SigningRole::PAYMENT | SigningRole::STAKE)
        .expect("handle sign");
    devkit_try_submit(&signed).expect("submit");
}

// Register a stake address (payment + stake witness). Mirrors TestIntegrationStakeRegistration.
#[test]
fn test_integration_stake_registration() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    build_sign_submit(&bridge, "stake_registration.yaml", None, &["payment", "stake"]);
}

// Register a DRep (payment + drep witness). Mirrors TestIntegrationDRepRegistration.
#[test]
fn test_integration_drep_registration() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    build_sign_submit(&bridge, "drep_registration.yaml", None, &["payment", "drep"]);
}

// Negative test: a DRep registration certificate must be witnessed by the DRep key, so signing with
// the payment key alone must be rejected by the node (MissingVKeyWitnessesUTXOW). This proves the
// extra witness the stake role adds is genuinely required — not cosmetic — and complements the
// positive drep_registration test above. Mirrors TestIntegrationDRepKeyRequired.
#[test]
fn test_integration_drep_key_required() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");
    let u = devkit_get_utxos(INTENT_SENDER);
    let built = bridge
        .quicktx()
        .build(&read_fixture("drep_registration.yaml"), &u, &pp, None, 1)
        .expect("build");

    // Sign with the payment key ONLY (sign_tx), omitting the DRep-key witness.
    let signed_payment_only = intent_sign(&bridge, &built.tx_cbor, &["payment"]);
    if devkit_try_submit(&signed_payment_only).is_ok() {
        panic!(
            "the node accepted a DRep registration signed with the payment key only; \
             expected rejection (MissingVKeyWitnessesUTXOW)"
        );
    }
}

// Submit a treasury donation. Conway validates the tx's declared current_treasury_value against the
// node's live ledger treasury exactly (ConwayTreasuryValueMismatch otherwise), so we learn the
// required value from the ledger's own rejection: submit, read "expected: Coin N" out of the error,
// rebuild with N, and resubmit. Retrying also absorbs an epoch boundary between attempts. Mirrors
// TestIntegrationDonation.
#[test]
fn test_integration_donation() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();

    let bridge = Bridge::new().expect("create bridge");
    let utxos = devkit_get_utxos(INTENT_SENDER);
    let pp = devnet_pp();
    let base_yaml = read_fixture("donation.yaml");

    let mut treasury = String::from("0");
    let mut last_err = String::new();
    for _ in 0..5 {
        let yaml = base_yaml.replace(
            "current_treasury_value: 0",
            &format!("current_treasury_value: {}", treasury),
        );
        let result = bridge.quicktx().build(&yaml, &utxos, &pp, None, 0).expect("build");
        let signed = intent_sign(&bridge, &result.tx_cbor, &["payment"]);
        match devkit_try_submit(&signed) {
            Ok(tx_hash) => {
                assert!(!tx_hash.is_empty(), "empty tx hash from submit");
                return; // accepted
            }
            Err(e) => {
                last_err = e;
                match parse_expected_treasury(&last_err) {
                    Some(v) => treasury = v,
                    None => panic!("unexpected submit error: {}", last_err),
                }
            }
        }
    }
    panic!("donation submit failed after retries: {}", last_err);
}

// An info governance proposal. A Conway proposal's deposit-return account must be a registered stake
// address, so register it first, then submit the proposal in the next block. Mirrors
// TestIntegrationInfoProposal.
#[test]
fn test_integration_info_proposal() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");
    let utxos = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("stake_registration.yaml"), &utxos, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let utxos2 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("governance_proposal.yaml"), &utxos2, &pp, None, &["payment"]);
}

// A transaction carrying transaction metadata. Mirrors TestIntegrationMetadata.
#[test]
fn test_integration_metadata() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    build_sign_submit(&bridge, "metadata.yaml", None, &["payment"]);
}

// Mint under an empty-ScriptAll native policy that needs no signature, so the fee payer alone can
// submit it. Confirms the minted asset landed at the receiver. Mirrors TestIntegrationNativeMint.
#[test]
fn test_integration_native_mint() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    build_sign_submit(&bridge, "minting.yaml", None, &["payment"]);
    assert_minted_asset_at(MINT_RECEIVER);
}

// Mint under a Plutus policy (execution units supplied). Confirms the minted asset landed. Mirrors
// TestIntegrationPlutusMint.
#[test]
fn test_integration_plutus_mint() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    let exec = plutus_exec_units();
    build_sign_submit(&bridge, "plutus/script_minting.yaml", Some(&exec), &["payment"]);
    assert_minted_asset_at(MINT_RECEIVER);
}

// Delegate voting power (target abstain). Requires the stake address to be registered first. Mirrors
// TestIntegrationVotingDelegation.
#[test]
fn test_integration_voting_delegation() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    setup_then_submit(
        &bridge,
        "stake_registration.yaml",
        &["payment", "stake"],
        "voting_delegation.yaml",
        &["payment", "stake"],
    );
}

// Update a DRep's anchor. Requires the DRep to be registered first. Mirrors TestIntegrationDRepUpdate.
#[test]
fn test_integration_drep_update() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    setup_then_submit(
        &bridge,
        "drep_registration.yaml",
        &["payment", "drep"],
        "drep_update.yaml",
        &["payment", "drep"],
    );
}

// Deregister a DRep. Requires the DRep to be registered first. Mirrors
// TestIntegrationDRepDeregistration.
#[test]
fn test_integration_drep_deregistration() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    setup_then_submit(
        &bridge,
        "drep_registration.yaml",
        &["payment", "drep"],
        "drep_deregistration.yaml",
        &["payment", "drep"],
    );
}

// Withdraw the (zero) reward balance. Conway requires a stake address to be vote-delegated to a DRep
// before it can withdraw, so the sequence is: register stake -> delegate voting power -> withdraw.
// Mirrors TestIntegrationStakeWithdrawal.
#[test]
fn test_integration_stake_withdrawal() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");
    let u = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("stake_registration.yaml"), &u, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("voting_delegation.yaml"), &u2, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u3 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("stake_withdrawal.yaml"), &u3, &pp, None, &["payment", "stake"]);
}

// Cast a vote. A vote needs a registered DRep (the voter), a registered stake address (the proposal's
// return account), a live gov action to vote on, and the vote referencing it. The proposal's tx hash
// (from the offline build result, not the submit response) is the gov action id we vote on. Mirrors
// TestIntegrationVoting.
#[test]
fn test_integration_voting() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");
    let u = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("drep_registration.yaml"), &u, &pp, None, &["payment", "drep"]);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("stake_registration.yaml"), &u2, &pp, None, &["payment", "stake"]);
    wait_for_block();

    // Submit an info proposal; its build-result tx hash is the gov action id we vote on.
    let u3 = devkit_get_utxos(INTENT_SENDER);
    let proposal = bridge
        .quicktx()
        .build(&read_fixture("governance_proposal.yaml"), &u3, &pp, None, 0)
        .expect("build proposal");
    let action_tx_hash = proposal.tx_hash.clone();
    let signed_proposal = intent_sign(&bridge, &proposal.tx_cbor, &["payment"]);
    if let Err(e) = devkit_try_submit(&signed_proposal) {
        panic!("submit proposal: {}", e);
    }
    wait_for_block();

    // Vote on the proposal we just submitted.
    let u4 = devkit_get_utxos(INTENT_SENDER);
    let vote_yaml = read_fixture("voting.yaml").replace(GOV_ACTION_PLACEHOLDER, &action_tx_hash);
    sign_submit(&bridge, &vote_yaml, &u4, &pp, None, &["payment", "drep"]);
}

// Delegate stake to a pool. Register the stake address, register a pool keyed to the account, then
// delegate to that pool. (DevKit exposes no pool-list endpoint, so we delegate to a pool we create
// rather than discover, repointing the fixture's placeholder pool id at it.) Mirrors
// TestIntegrationStakeDelegation.
#[test]
fn test_integration_stake_delegation() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");
    let u = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("stake_registration.yaml"), &u, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("pool_registration.yaml"), &u2, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u3 = devkit_get_utxos(INTENT_SENDER);
    let deleg_yaml = read_fixture("stake_delegation.yaml").replace(POOL_PLACEHOLDER, ACCOUNT_POOL_ID);
    sign_submit(&bridge, &deleg_yaml, &u3, &pp, None, &["payment", "stake"]);
}

// Register a stake pool. The fixture keys the pool to the account's stake key (operator, owner,
// reward account), so signing with the stake key witnesses it. The reward account must be a
// registered stake address, so register it first. Mirrors TestIntegrationPoolRegistration.
#[test]
fn test_integration_pool_registration() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    setup_then_submit(
        &bridge,
        "stake_registration.yaml",
        &["payment", "stake"],
        "pool_registration.yaml",
        &["payment", "stake"],
    );
}

// Plutus spend: lock a UTXO at the script address (with the datum hash), then spend it. The spend
// fixture references a placeholder UTXO; we repoint it at the real on-chain locked UTXO. Mirrors
// TestIntegrationPlutusSpend.
#[test]
fn test_integration_plutus_spend() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");

    // Step 1: lock 10 ADA at the script address with the datum hash.
    let utxos = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("plutus/plutus_lock.yaml"), &utxos, &pp, None, &["payment"]);
    wait_for_block();

    // Step 2: find the locked UTXO at the script address.
    let script_utxos = devkit_get_utxos(SCRIPT_ADDR);
    let locked = script_utxos
        .as_array()
        .and_then(|a| a.first())
        .unwrap_or_else(|| panic!("no locked UTXO at script address"));
    let lock_hash = locked["tx_hash"].as_str().expect("locked tx_hash").to_string();
    let lock_idx = locked["output_index"].as_u64().unwrap_or(0);

    // Step 3: repoint the spend fixture's utxo_ref at the real locked UTXO.
    let mut spend_yaml = read_fixture("plutus/script_collect_from.yaml").replace(SCRIPT_TX_HASH, &lock_hash);
    if lock_idx != 0 {
        spend_yaml = spend_yaml.replacen("output_index: 0", &format!("output_index: {}", lock_idx), 1);
    }

    // Step 4: spend it — supply the locked UTXO (with its datum hash) + fee/collateral UTXOs.
    let fee_utxos = devkit_get_utxos(INTENT_SENDER);
    let mut spend_utxos = json!([{
        "tx_hash": lock_hash,
        "output_index": lock_idx,
        "address": SCRIPT_ADDR,
        "amount": [{"unit": "lovelace", "quantity": "10000000"}],
        "data_hash": SCRIPT_DATUM_HASH,
    }]);
    if let (Some(arr), Some(fees)) = (spend_utxos.as_array_mut(), fee_utxos.as_array()) {
        for f in fees {
            arr.push(f.clone());
        }
    }

    let exec = plutus_exec_units();
    sign_submit(&bridge, &spend_yaml, &spend_utxos, &pp, Some(&exec), &["payment"]);

    // Confirm the spend actually consumed the locked script UTXO.
    assert_utxo_consumed(SCRIPT_ADDR, &lock_hash);
}

// Register the stake address, then deregister it. The deregistration certificate is witnessed by
// the stake key (the refund address receives the deposit back). Mirrors the JS suite's
// register-then-deregister test.
#[test]
fn test_integration_stake_deregistration() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    setup_then_submit(
        &bridge,
        "stake_registration.yaml",
        &["payment", "stake"],
        "stake_deregistration.yaml",
        &["payment", "stake"],
    );
}

// Register the account-keyed pool, then retire it. The retirement certificate is witnessed by the
// pool's operator key — which pool_registration.yaml keys to the account's stake key. Conway bounds
// the retirement epoch to (current, current+e_max]; the fixture's hardcoded 500 is out of range on
// a young devnet, so repoint it at current+2.
#[test]
fn test_integration_pool_retirement() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");
    let u = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("stake_registration.yaml"), &u, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("pool_registration.yaml"), &u2, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let epoch = devkit_current_epoch();
    let retire_yaml = read_fixture("pool_retirement.yaml")
        .replace(POOL_PLACEHOLDER, ACCOUNT_POOL_ID)
        .replace("retirement_epoch: 500", &format!("retirement_epoch: {}", epoch + 2));

    let u3 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &retire_yaml, &u3, &pp, None, &["payment", "stake"]);
}

// The Aiken redeemer_check validator (test-fixtures/aiken/redeemer-check) passes iff the redeemer
// is the integer 42. Happy path: redeemer 42 → the node accepts and the asset lands.
#[test]
fn test_integration_aiken_mint_accepts() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    let exec = plutus_exec_units();
    build_sign_submit(&bridge, "plutus/aiken_mint_pass.yaml", Some(&exec), &["payment"]);
    assert_minted_asset_at(MINT_RECEIVER);
}

// Negative validation: redeemer 0 makes the same validator evaluate to false, so phase-2 validation
// fails and the node must reject the tx. Exec units are supplied manually — the bridge's
// StaticTransactionEvaluator stamps them without running the script, which is exactly what lets a
// validation-failing tx reach the node.
#[test]
fn test_integration_aiken_mint_rejects() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let bridge = Bridge::new().expect("create bridge");
    let utxos = devkit_get_utxos(INTENT_SENDER);
    let exec = plutus_exec_units();
    let result = bridge
        .quicktx()
        .build(&read_fixture("plutus/aiken_mint_fail.yaml"), &utxos, &pp, Some(&exec), 0)
        .expect("build");
    let signed = intent_sign(&bridge, &result.tx_cbor, &["payment"]);
    assert!(
        devkit_try_submit(&signed).is_err(),
        "the node accepted a mint whose validator must reject (redeemer 0); \
         expected a phase-2 script validation failure"
    );
}

// --- Ledger-effect tests: certificate deposits must move the sender's balance exactly ---

// The stake-key deposit must leave on registration and come back on deregistration.
#[test]
fn test_integration_stake_deposit_round_trip() {
    if skip_if_no_devkit() {
        return;
    }
    let pp = reset_and_fund(6000);
    let key_deposit = pp_lovelace(&pp, "key_deposit");
    let bridge = Bridge::new().expect("create bridge");
    let start = balance_at(INTENT_SENDER);

    let u = devkit_get_utxos(INTENT_SENDER);
    let fee1 = sign_submit_fee(&bridge, &read_fixture("stake_registration.yaml"), &u, &pp, None, &["payment", "stake"]);
    wait_for_block();
    assert_eq!(balance_at(INTENT_SENDER), start - fee1 - key_deposit);

    let u2 = devkit_get_utxos(INTENT_SENDER);
    let fee2 = sign_submit_fee(&bridge, &read_fixture("stake_deregistration.yaml"), &u2, &pp, None, &["payment", "stake"]);
    wait_for_block();
    assert_eq!(balance_at(INTENT_SENDER), start - fee1 - fee2); // deposit refunded
}

// A DRep registration must take exactly fee + drep_deposit from the sender.
#[test]
fn test_integration_drep_deposit_effect() {
    if skip_if_no_devkit() {
        return;
    }
    let pp = reset_and_fund(6000);
    let drep_deposit = pp_lovelace(&pp, "drep_deposit");
    let bridge = Bridge::new().expect("create bridge");
    let start = balance_at(INTENT_SENDER);

    let u = devkit_get_utxos(INTENT_SENDER);
    let fee = sign_submit_fee(&bridge, &read_fixture("drep_registration.yaml"), &u, &pp, None, &["payment", "drep"]);
    wait_for_block();
    assert_eq!(balance_at(INTENT_SENDER), start - fee - drep_deposit);
}

// A governance proposal must take exactly fee + gov_action_deposit (after the stake registration
// takes fee + key_deposit for the deposit-return account).
#[test]
fn test_integration_proposal_deposit_effect() {
    if skip_if_no_devkit() {
        return;
    }
    let pp = reset_and_fund(6000);
    let key_deposit = pp_lovelace(&pp, "key_deposit");
    let gov_deposit = pp_lovelace(&pp, "gov_action_deposit");
    let bridge = Bridge::new().expect("create bridge");
    let start = balance_at(INTENT_SENDER);

    let u = devkit_get_utxos(INTENT_SENDER);
    let fee1 = sign_submit_fee(&bridge, &read_fixture("stake_registration.yaml"), &u, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    let fee2 = sign_submit_fee(&bridge, &read_fixture("governance_proposal.yaml"), &u2, &pp, None, &["payment"]);
    wait_for_block();

    assert_eq!(balance_at(INTENT_SENDER), start - fee1 - key_deposit - fee2 - gov_deposit);
}

// A pool registration must take exactly fee + pool_deposit (after the stake registration).
#[test]
fn test_integration_pool_deposit_effect() {
    if skip_if_no_devkit() {
        return;
    }
    let pp = reset_and_fund(6000);
    let key_deposit = pp_lovelace(&pp, "key_deposit");
    let pool_deposit = pp_lovelace(&pp, "pool_deposit");
    let bridge = Bridge::new().expect("create bridge");
    let start = balance_at(INTENT_SENDER);

    let u = devkit_get_utxos(INTENT_SENDER);
    let fee1 = sign_submit_fee(&bridge, &read_fixture("stake_registration.yaml"), &u, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    let fee2 = sign_submit_fee(&bridge, &read_fixture("pool_registration.yaml"), &u2, &pp, None, &["payment", "stake"]);
    wait_for_block();

    assert_eq!(balance_at(INTENT_SENDER), start - fee1 - key_deposit - fee2 - pool_deposit);
}

// --- Never-submitted intents from the coverage audit ---

// collect_from: spend exactly the named UTXO instead of automatic selection.
#[test]
fn test_integration_collect_from() {
    if skip_if_no_devkit() {
        return;
    }
    let pp = reset_and_fund(6000);
    let bridge = Bridge::new().expect("create bridge");

    let utxos = devkit_get_utxos(INTENT_SENDER);
    let target_hash = utxos[0]["tx_hash"].as_str().expect("utxo tx_hash").to_string();
    let target_idx = utxos[0]["output_index"].as_i64().unwrap_or(0);

    let mut yaml = read_fixture("collect_from.yaml").replace(&"a".repeat(64), &target_hash);
    if target_idx != 0 {
        yaml = yaml.replacen("output_index: 0", &format!("output_index: {}", target_idx), 1);
    }
    sign_submit(&bridge, &yaml, &utxos, &pp, None, &["payment"]);
}

// reference_input: a read-only reference input (CIP-31) must resolve to a real UTXO; fund the
// second intent address and reference its UTXO (it is not spent — its balance must not change).
#[test]
fn test_integration_reference_input() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    devkit_topup(INTENT_SENDER2, 5);
    wait_for_block();
    let pp = devnet_pp();
    let bridge = Bridge::new().expect("create bridge");

    let ref_utxos = devkit_get_utxos(INTENT_SENDER2);
    let ref_hash = ref_utxos[0]["tx_hash"].as_str().expect("ref tx_hash").to_string();
    let ref_balance = total_lovelace(&ref_utxos);
    let yaml = read_fixture("reference_input.yaml").replace(&"c".repeat(64), &ref_hash);

    let utxos = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &yaml, &utxos, &pp, None, &["payment"]);
    wait_for_block();

    assert_eq!(balance_at(INTENT_SENDER2), ref_balance); // referenced, not spent
}

// native_script: a script witness may only be attached when the transaction actually uses the
// script — Conway rejects unused witnesses (ExtraneousScriptWitnessesUTXOW; the standalone
// "attach" fixture proved that on its first devnet submission, which is why it stays
// offline-build only). So exercise the real thing: lock funds at a sig(payment-key) native script
// address built at test time, then spend them with the script attached, witnessed by the payment
// key. This is the only test of native-script *spending* (minting is covered separately).
#[test]
fn test_integration_native_script_spend() {
    if skip_if_no_devkit() {
        return;
    }
    let pp = reset_and_fund(6000);
    let bridge = Bridge::new().expect("create bridge");

    // Build a native script the sender's payment key satisfies, and its script address.
    let info: serde_json::Value =
        serde_json::from_str(&bridge.address().info(INTENT_SENDER).expect("address info"))
            .expect("parse info");
    let key_hash = info["payment_credential_hash"].as_str().expect("payment cred");
    let script: serde_json::Value = serde_json::from_str(
        &bridge
            .script()
            .native_from_json(&format!(r#"{{"type":"sig","keyHash":"{}"}}"#, key_hash))
            .expect("native script"),
    )
    .expect("parse script");
    let script_hash = script["script_hash"].as_str().expect("script_hash");
    // native_from_json's cbor_hex is the hash preimage (leading 0x00 language tag); the TxPlan
    // native_script block wants the bare script CBOR.
    let cbor_hex = &script["cbor_hex"].as_str().expect("cbor_hex")[2..];
    let script_address = bridge
        .address()
        .from_bytes(&format!("70{}", script_hash)) // testnet script enterprise
        .expect("script address");

    // Step 1: lock 5 ADA at the script address.
    let lock_yaml = format!(
        r#"
version: 1.0
transaction:
  - tx:
      from: {sender}
      change_address: {sender}
      intents:
        - type: payment
          address: {script_address}
          amounts:
            - unit: lovelace
              quantity: "5000000"
"#,
        sender = INTENT_SENDER,
        script_address = script_address
    );
    let u = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &lock_yaml, &u, &pp, None, &["payment"]);
    wait_for_block();

    // Step 2: spend the locked UTXO with the native script attached.
    let script_utxos = devkit_get_utxos(&script_address);
    let lock_hash = script_utxos[0]["tx_hash"].as_str().expect("lock hash").to_string();
    let lock_idx = script_utxos[0]["output_index"].as_i64().unwrap_or(0);

    let spend_yaml = format!(
        r#"
version: 1.0
context:
  fee_payer: {sender}
transaction:
  - tx:
      from: {sender}
      change_address: {sender}
      inputs:
        - type: collect_from
          utxo_refs:
            - tx_hash: {lock_hash}
              output_index: {lock_idx}
      intents:
        - type: payment
          address: {sender}
          amounts:
            - unit: lovelace
              quantity: "3000000"
      scripts:
        - type: native_script
          script_hex: {cbor_hex}
"#,
        sender = INTENT_SENDER,
        lock_hash = lock_hash,
        lock_idx = lock_idx,
        cbor_hex = cbor_hex
    );

    let mut spend_utxos = script_utxos.as_array().expect("utxos array").clone();
    spend_utxos.extend(
        devkit_get_utxos(INTENT_SENDER)
            .as_array()
            .expect("utxos array")
            .clone(),
    );
    let spend_utxos = serde_json::Value::Array(spend_utxos);
    sign_submit_n(&bridge, &spend_yaml, &spend_utxos, &pp, None, &["payment"], 1);

    assert_utxo_consumed(&script_address, &lock_hash);
}

// pool_update: re-submit the pool's registration certificate with update semantics.
#[test]
fn test_integration_pool_update() {
    if skip_if_no_devkit() {
        return;
    }
    let pp = reset_and_fund(6000);
    let bridge = Bridge::new().expect("create bridge");

    let u = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("stake_registration.yaml"), &u, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("pool_registration.yaml"), &u2, &pp, None, &["payment", "stake"]);
    wait_for_block();

    let u3 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(&bridge, &read_fixture("pool_update.yaml"), &u3, &pp, None, &["payment", "stake"]);
}

// compose: two senders' intents composed into ONE transaction, signed once per sender's payment
// key (same mnemonic, address_index 0 and 1); both payments must land at the receiver.
#[test]
fn test_integration_compose_two_senders() {
    if skip_if_no_devkit() {
        return;
    }
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    devkit_topup(INTENT_SENDER2, 6000);
    wait_for_block();
    let pp = devnet_pp();
    let bridge = Bridge::new().expect("create bridge");

    let mut utxos = devkit_get_utxos(INTENT_SENDER)
        .as_array()
        .expect("utxos array")
        .clone();
    utxos.extend(
        devkit_get_utxos(INTENT_SENDER2)
            .as_array()
            .expect("utxos array")
            .clone(),
    );
    let utxos = serde_json::Value::Array(utxos);

    let result = bridge
        .quicktx()
        .build(&read_fixture("compose.yaml"), &utxos, &pp, None, 0)
        .expect("build");
    let once = intent_sign(&bridge, &result.tx_cbor, &["payment"]);
    let twice = intent_sign_at(&bridge, 1, &once, &["payment"]);
    devkit_try_submit(&twice).expect("submit");
    wait_for_block();

    // 5 ADA from sender1 + 3 ADA from sender2, both to the same receiver.
    assert_eq!(balance_at(MINT_RECEIVER), 8_000_000);
}

// The offline Scalus evaluator is the DEFAULT costing path: when a caller supplies no execution
// units, libccl computes them in-process (ADR-0013). Every other Plutus test supplies units
// manually (they must, to submit a failing script), so this is the only test proving the node
// accepts Scalus-computed budgets end-to-end — the path out-of-the-box users are on.
#[test]
fn test_integration_scalus_computed_units() {
    if skip_if_no_devkit() {
        return;
    }
    let bridge = Bridge::new().expect("create bridge");
    build_sign_submit(&bridge, "plutus/script_minting.yaml", None, &["payment"]);
    assert_minted_asset_at(MINT_RECEIVER);
}
