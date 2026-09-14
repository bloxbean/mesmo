//! Shared Yaci DevKit test harness for the integration test binaries.
//!
//! Integration tests in `tests/` each compile to their own crate, so shared plumbing lives here and
//! is pulled in with `mod common;`. This mirrors the Go `ccl` package's shared DevKit helpers
//! (devkitReset / devkitTopup / devkitGetUtxos / signSubmit / ...), so the Rust and Go integration
//! suites cover the same on-chain scenarios with the same key-role signing and ledger substitutions.
//!
//! Everything here is HTTP-over-`ureq` (a dev-dependency) plus the offline `Bridge` build/sign, so the
//! harness needs no cargo feature. Tests SKIP (return early) when DevKit is not reachable.
#![allow(dead_code)]

use ccl::Bridge;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

pub const DEVKIT_URL: &str = "http://localhost:10000/local-cluster/api";

// The fixed test account the quicktx-intents fixtures are derived from (account 0/0). Signing the
// fixtures requires this exact key set — payment/stake/drep — since the certificates encode its
// credentials.
pub const INTENT_MNEMONIC: &str =
    "test walk nut penalty hip pave soap entry language right filter choice";
pub const INTENT_SENDER: &str = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";

// The address the mint fixtures pay the minted asset to (account.enterpriseAddress).
pub const MINT_RECEIVER: &str = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";

// Plutus script address, its datum hash, and the placeholder tx hash baked into the spend fixture.
pub const SCRIPT_ADDR: &str = "addr_test1wpunlryvl7aqsxe22erzlsseej87v5kk5vutvtrmzdy8dect48z0w";
pub const SCRIPT_DATUM_HASH: &str =
    "9e1199a988ba72ffd6e9c269cadb3b53b5f360ff99f112d9b2ee30c4d74ad88b";
pub const SCRIPT_TX_HASH: &str =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// The gov_action_tx_hash baked into voting.yaml; the voting test repoints it at the real proposal it
// submits.
pub const GOV_ACTION_PLACEHOLDER: &str =
    "12745f09b138d4d0a11a560b4591ebb830cf12336347606d2edbbf1893d395c6";

// The pool id baked into stake_delegation.yaml, and the real id of the pool keyed to the account's
// stake key in pool_registration.yaml. The delegation test repoints the placeholder at it.
pub const POOL_PLACEHOLDER: &str = "pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy";
pub const ACCOUNT_POOL_ID: &str = "pool1xtrj35uxrctye2egew8sqezgzwwg796ql7uw02572gedcpgmwck";

// Plutus execution units used by the script mint / spend fixtures (one redeemer each).
pub fn plutus_exec_units() -> Value {
    json!([{"mem": 2000000, "steps": 500000000}])
}

// --- DevKit HTTP helpers ---

pub fn devkit_available() -> bool {
    ureq::get(&format!("{}/admin/devnet", DEVKIT_URL))
        .timeout(Duration::from_secs(3))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

// devkit_reset restarts the devnet and returns only once it serves chain data again.
//
// DevKit 0.12 (companion mode) re-bootstraps the whole cluster on reset, and that bootstrap can
// wedge (e.g. the relay never syncs from the companion within its window), leaving the node socket
// dead until the NEXT reset POST kicks the cluster back to life. So: POST the reset, poll until the
// chain-data API answers, and if the devnet stays dead re-POST the reset. On total failure it just
// returns — the caller's topup/build will then panic with its own error.
pub fn devkit_reset() {
    for attempt in 1..=3 {
        // The reset handler blocks while the cluster re-bootstraps (~20-30s when healthy). A client
        // timeout is fine: the bootstrap keeps running server-side and the health poll decides.
        let _ = ureq::post(&format!("{}/admin/devnet/reset", DEVKIT_URL))
            .timeout(Duration::from_secs(60))
            .call();
        if devkit_wait_healthy(Duration::from_secs(60)) {
            return;
        }
        println!(
            "devkit reset attempt {}/3: devnet still down, re-posting reset",
            attempt
        );
    }
    println!("devkit reset: devnet did not serve chain data after 3 attempts");
}

// Polls until the chain-data API (yaci-store, fed by the node) answers with protocol parameters
// AND the submit path reaches the backend submit-api. /admin/devnet alone is no proof: it stays
// 200 while the node socket is dead. The submit probe matters because a reset's bootstrap can fail
// to start the submit-api entirely ("Network.Socket.bind: resource busy" — the previous instance
// hadn't released port 8090); chain data then works but every submit gets "Connection refused"
// until the next reset. Probing with a garbage body: any deserialization/ledger 400 proves the
// submit-api is alive; a body wrapping "Connection refused" does not.
fn devkit_wait_healthy(budget: Duration) -> bool {
    let deadline = std::time::Instant::now() + budget;
    while std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_secs(3));
        let chain_data_ok = ureq::get(&format!("{}/epochs/parameters", DEVKIT_URL))
            .timeout(Duration::from_secs(5))
            .call()
            .map(|r| r.status() == 200)
            .unwrap_or(false);
        if chain_data_ok && devkit_submit_path_alive() {
            return true;
        }
    }
    false
}

fn devkit_submit_path_alive() -> bool {
    match ureq::post(&format!("{}/tx/submit", DEVKIT_URL))
        .timeout(Duration::from_secs(5))
        .set("Content-Type", "application/cbor")
        .send_bytes(&[0x00])
    {
        Ok(_) => true, // a 2xx would mean it is certainly alive
        Err(ureq::Error::Status(_, resp)) => !resp
            .into_string()
            .unwrap_or_default()
            .contains("Connection refused"),
        Err(_) => false,
    }
}

pub fn devkit_topup(address: &str, ada_amount: u64) {
    // devkit_reset already health-gates the devnet, but the faucet can still transiently fail
    // right after the hand-over to the node. Retry with backoff.
    let body = json!({"address": address, "adaAmount": ada_amount}).to_string();
    for attempt in 1..=8 {
        let resp = ureq::post(&format!("{}/addresses/topup", DEVKIT_URL))
            .timeout(Duration::from_secs(30))
            .set("Content-Type", "application/json")
            .send_string(&body);
        match resp {
            Ok(r) => {
                let text = r.into_string().unwrap_or_default();
                if !text.contains("\"status\":false") {
                    return;
                }
            }
            Err(e) if attempt == 8 => panic!("topup failed after retries: {}", e),
            Err(_) => {}
        }
        thread::sleep(Duration::from_secs(4));
    }
    panic!("topup failed after retries");
}

pub fn devkit_get_utxos(address: &str) -> Value {
    let resp = ureq::get(&format!("{}/addresses/{}/utxos", DEVKIT_URL, address))
        .timeout(Duration::from_secs(30))
        .call()
        .expect("Failed to get utxos");
    resp.into_json::<Value>().expect("Invalid utxo JSON")
}

pub fn devkit_get_protocol_params() -> Value {
    let resp = ureq::get(&format!("{}/epochs/parameters", DEVKIT_URL))
        .timeout(Duration::from_secs(30))
        .call()
        .expect("Failed to get protocol params");
    resp.into_json::<Value>().expect("Invalid PP JSON")
}

// Fetch the devnet protocol parameters and fill in the Conway deposits DevKit returns as null (the
// node validates the actual values on submit). Mirrors Go's devnetPP.
pub fn devnet_pp() -> Value {
    let mut pp = devkit_get_protocol_params();
    pp["drep_deposit"] = json!("500000000");
    pp["gov_action_deposit"] = json!("1000000000");
    pp["pool_deposit"] = json!("500000000");
    pp
}

pub fn devkit_submit_tx(tx_cbor_hex: &str) -> String {
    devkit_try_submit(tx_cbor_hex).expect("Failed to submit tx")
}

// Submit that returns the error body instead of panicking, so callers can inspect a rejection (ureq
// treats 4xx/5xx as Err by default).
//
// Retries when the devkit wraps a backend "Connection refused": after a reset, the devkit's
// submit-api (port 8090) can lag behind the chain-data API that devkit_reset health-gates on.
// That's the devnet still booting, not a ledger rejection — genuine rejections surface immediately.
pub fn devkit_try_submit(tx_cbor_hex: &str) -> Result<String, String> {
    let mut last_err = String::new();
    for _ in 0..8 {
        match devkit_try_submit_once(tx_cbor_hex) {
            Err(e) if e.contains("Connection refused") => last_err = e,
            other => return other,
        }
        thread::sleep(Duration::from_secs(4));
    }
    Err(last_err)
}

fn devkit_try_submit_once(tx_cbor_hex: &str) -> Result<String, String> {
    let tx_bytes = hex_decode(tx_cbor_hex).map_err(|e| e.to_string())?;
    match ureq::post(&format!("{}/tx/submit", DEVKIT_URL))
        .timeout(Duration::from_secs(30))
        .set("Content-Type", "application/cbor")
        .send_bytes(&tx_bytes)
    {
        Ok(resp) => Ok(resp
            .into_string()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .to_string()),
        Err(ureq::Error::Status(code, resp)) => Err(format!(
            "submit failed ({}): {}",
            code,
            resp.into_string().unwrap_or_default()
        )),
        Err(e) => Err(e.to_string()),
    }
}

// Pull the expected treasury value out of a Conway ConwayTreasuryValueMismatch rejection, e.g.
// "... expected: Coin 43186776312112}".
pub fn parse_expected_treasury(submit_err: &str) -> Option<String> {
    let idx = submit_err.find("expected: Coin ")?;
    let rest = &submit_err[idx + "expected: Coin ".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

pub fn wait_for_block() {
    thread::sleep(Duration::from_secs(3));
}

pub fn skip_if_no_devkit() -> bool {
    if !devkit_available() {
        eprintln!("SKIP: Yaci DevKit not available on port 10000");
        return true;
    }
    false
}

// --- Account / fixture helpers ---

pub fn get_testnet_account(bridge: &Bridge) -> (String, String, String) {
    let acct = bridge
        .accounts()
        .create(ccl::Network::Testnet)
        .expect("create account");
    let json = acct.info().expect("account info");
    let addr = json["base_address"].as_str().unwrap().to_string();
    let mnemonic = acct.export_recovery_phrase().expect("export recovery phrase");
    let stake = json["stake_address"].as_str().unwrap_or("").to_string();
    (addr, mnemonic, stake)
}

/// Map fixture role names onto the typed mask.
pub fn roles_from_keys(keys: &[&str]) -> ccl::accounts::SigningRole {
    use ccl::accounts::SigningRole;
    let mut mask = 0u32;
    for k in keys {
        mask |= match *k {
            "payment" => SigningRole::PAYMENT.0,
            "stake" => SigningRole::STAKE.0,
            "drep" => SigningRole::DREP.0,
            other => panic!("unknown signing role {other}"),
        };
    }
    SigningRole(mask)
}

/// Sign with the intent mnemonic through a managed handle at the given address index.
pub fn intent_sign_at(bridge: &Bridge, address_index: u32, tx_cbor: &str, keys: &[&str]) -> String {
    let acct = bridge
        .accounts()
        .from_mnemonic(INTENT_MNEMONIC, ccl::Network::Testnet, 0, address_index)
        .expect("open intent account");
    acct.sign_tx(tx_cbor, roles_from_keys(keys)).expect("sign")
}

pub fn intent_sign(bridge: &Bridge, tx_cbor: &str, keys: &[&str]) -> String {
    intent_sign_at(bridge, 0, tx_cbor, keys)
}

pub fn fund_sender(bridge: &Bridge, ada: u64) -> (String, String) {
    let (addr, mnemonic, _) = get_testnet_account(bridge);
    devkit_topup(&addr, ada);
    wait_for_block();
    (addr, mnemonic)
}

pub fn total_lovelace(utxos: &Value) -> u64 {
    let arr = match utxos.as_array() {
        Some(a) => a,
        None => return 0,
    };
    let mut total: u64 = 0;
    for u in arr {
        if let Some(amounts) = u["amount"].as_array() {
            for a in amounts {
                if a["unit"].as_str() == Some("lovelace") {
                    if let Some(q) = a["quantity"].as_str() {
                        total += q.parse::<u64>().unwrap_or(0);
                    } else if let Some(q) = a["quantity"].as_u64() {
                        total += q;
                    } else if let Some(q) = a["quantity"].as_f64() {
                        total += q as u64;
                    }
                }
            }
        }
    }
    total
}

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/quicktx-intents")
}

// Read a quicktx-intents fixture by path relative to test-fixtures/quicktx-intents/ (e.g.
// "stake_registration.yaml" or "plutus/plutus_lock.yaml").
pub fn read_fixture(rel: &str) -> String {
    let path = fixtures_dir().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read fixture {}: {}", rel, e))
}

// --- High-level build/sign/submit sequences (mirror Go's signSubmit / buildSignSubmit / ...) ---

// Build the YAML with the given UTXOs + params, sign it with the intent account's key roles, and
// submit. Returns the tx hash. The devnet's /tx/submit returns 200/202 only after the node has
// validated and accepted the tx, so a returned hash is proof of on-chain acceptance.
pub fn sign_submit(
    bridge: &Bridge,
    yaml: &str,
    utxos: &Value,
    pp: &Value,
    exec_units: Option<&Value>,
    keys: &[&str],
) -> String {
    // The signer count is known here, exactly as it is for a real caller: one witness per key
    // role beyond the input-implied payment key.
    sign_submit_n(bridge, yaml, utxos, pp, exec_units, keys, keys.len().saturating_sub(1) as u32)
}

// sign_submit with an explicit additional-signers budget, for transactions whose inputs imply no
// payment key (e.g. a script-only-input spend).
pub fn sign_submit_n(
    bridge: &Bridge,
    yaml: &str,
    utxos: &Value,
    pp: &Value,
    exec_units: Option<&Value>,
    keys: &[&str],
    additional_signers: u32,
) -> String {
    let result = bridge
        .quicktx()
        .build(yaml, utxos, pp, exec_units, additional_signers)
        .expect("build");
    let signed = intent_sign(bridge, &result.tx_cbor, keys);
    match devkit_try_submit(&signed) {
        Ok(hash) => hash,
        Err(e) => panic!("submit: {}", e),
    }
}

// Reset the devnet, fund the fixed account, build the fixture with its real UTXOs, sign with the
// given key roles, submit, and return the tx hash. Mirrors Go's buildSignSubmit.
pub fn build_sign_submit(
    bridge: &Bridge,
    fixture: &str,
    exec_units: Option<&Value>,
    keys: &[&str],
) -> String {
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let utxos = devkit_get_utxos(INTENT_SENDER);
    let pp = devnet_pp();
    sign_submit(bridge, &read_fixture(fixture), &utxos, &pp, exec_units, keys)
}

// Reset+fund the devnet, submit a prerequisite fixture (e.g. registering a stake address or DRep),
// then submit the target fixture in the next block. Mirrors Go's setupThenSubmit.
pub fn setup_then_submit(
    bridge: &Bridge,
    setup_fixture: &str,
    setup_keys: &[&str],
    fixture: &str,
    keys: &[&str],
) {
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, 6000);
    wait_for_block();
    let pp = devnet_pp();

    let u = devkit_get_utxos(INTENT_SENDER);
    sign_submit(bridge, &read_fixture(setup_fixture), &u, &pp, None, setup_keys);
    wait_for_block();

    let u2 = devkit_get_utxos(INTENT_SENDER);
    sign_submit(bridge, &read_fixture(fixture), &u2, &pp, None, keys);
}

// Confirm a mint actually landed on-chain: the receiver holds a non-lovelace asset. ("Submit
// accepted" alone doesn't prove the intended effect; this does.) Mirrors Go's assertMintedAssetAt.
pub fn assert_minted_asset_at(address: &str) {
    wait_for_block();
    let utxos = devkit_get_utxos(address);
    if let Some(arr) = utxos.as_array() {
        for u in arr {
            if let Some(amounts) = u["amount"].as_array() {
                for a in amounts {
                    if let Some(unit) = a["unit"].as_str() {
                        if !unit.is_empty() && unit != "lovelace" {
                            return; // a minted asset is present
                        }
                    }
                }
            }
        }
    }
    panic!("expected a minted asset at {}, found none", address);
}

// Confirm the given UTXO is no longer present at an address (it was spent). Mirrors
// Go's assertUtxoConsumed.
pub fn assert_utxo_consumed(address: &str, tx_hash: &str) {
    wait_for_block();
    let utxos = devkit_get_utxos(address);
    if let Some(arr) = utxos.as_array() {
        for u in arr {
            if u["tx_hash"].as_str() == Some(tx_hash) {
                panic!("UTXO {} at {} was not consumed", tx_hash, address);
            }
        }
    }
}

// --- misc ---

// hex decode helper (avoid adding another dep).
pub fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd length".to_string());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

// Current epoch, for intents whose certificates carry epoch bounds (e.g. pool retirement).
// Prefers the protocol-params response (Blockfrost-style params carry "epoch"), falls back to the
// Blockfrost-compatible /epochs/latest.
pub fn devkit_current_epoch() -> i64 {
    let pp = devkit_get_protocol_params();
    if let Some(e) = pp["epoch"].as_i64() {
        return e;
    }
    if let Some(s) = pp["epoch"].as_str() {
        if let Ok(e) = s.parse() {
            return e;
        }
    }
    let latest: Value = ureq::get(&format!("{}/epochs/latest", DEVKIT_URL))
        .timeout(Duration::from_secs(30))
        .call()
        .expect("get /epochs/latest")
        .into_json()
        .expect("parse /epochs/latest");
    latest["epoch"].as_i64().expect("epoch in /epochs/latest")
}

// --- Ledger-effect helpers (balance-delta read-backs) ---

// The compose fixture's second sender: same mnemonic, address_index 1.
pub const INTENT_SENDER2: &str = "addr_test1qz7svwszky8gcmhrfza7a89z9u0dfzd3l7h23sqlc5yml7ejcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwqcqrvr0";

pub fn balance_at(address: &str) -> u64 {
    total_lovelace(&devkit_get_utxos(address))
}

pub fn pp_lovelace(pp: &Value, key: &str) -> u64 {
    if let Some(n) = pp[key].as_u64() {
        return n;
    }
    pp[key]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no lovelace value for pp[{}] ({:?})", key, pp[key]))
}

// sign_submit, additionally returning the tx fee so callers can assert the sender's exact balance
// change (the ledger read-back "submit accepted" alone can't give).
pub fn sign_submit_fee(
    bridge: &Bridge,
    yaml: &str,
    utxos: &Value,
    pp: &Value,
    exec_units: Option<&Value>,
    keys: &[&str],
) -> u64 {
    // The signer count is known here, exactly as it is for a real caller: one witness per key
    // role beyond the input-implied payment key.
    let additional_signers = keys.len().saturating_sub(1) as u32;
    let result = bridge
        .quicktx()
        .build(yaml, utxos, pp, exec_units, additional_signers)
        .expect("build");
    let signed = intent_sign(bridge, &result.tx_cbor, keys);
    match devkit_try_submit(&signed) {
        Ok(_) => result.fee.parse().expect("parse fee"),
        Err(e) => panic!("submit: {}", e),
    }
}

pub fn reset_and_fund(ada: u64) -> Value {
    devkit_reset();
    wait_for_block();
    devkit_topup(INTENT_SENDER, ada);
    wait_for_block();
    devnet_pp()
}
