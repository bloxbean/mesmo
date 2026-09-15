//! Optional chain-data provider helpers (enabled by the `providers` feature).
//!
//! [`QuickTxApi::build`](crate::QuickTxApi::build) is offline by design: the caller supplies UTXOs
//! and protocol parameters (and, for Plutus, execution units). These helpers are an *optional*
//! convenience that fetch those inputs from a chain-data backend over HTTP (via `ureq`), returning
//! them as the `serde_json::Value`s `build` accepts — so the native library stays offline and
//! provider-free.
//!
//! A provider implements [`ChainDataProvider`]. Use one directly, or via
//! [`QuickTxApi::build_with`](crate::QuickTxApi::build_with):
//!
//! ```no_run
//! use mesmo::Bridge;
//! use mesmo::providers::BlockfrostProvider;
//! # let yaml = "version: 1.0";
//! # let sender = "addr_test1...";
//! let bridge = Bridge::new()?;
//! let provider = BlockfrostProvider::new("proj_id", "preprod")?; // or YaciProvider::default()
//! let result = bridge.quicktx().build_with(yaml, &provider, &[sender], 0, None)?;
//! # Ok::<(), mesmo::MesmoError>(())
//! ```

use crate::{error_codes, MesmoError, QuickTxApi, Result, TxResult};
use serde_json::Value;

fn http_err(ctx: &str, e: impl std::fmt::Display) -> MesmoError {
    MesmoError {
        code: error_codes::MESMO_ERROR_GENERAL,
        message: format!("{}: {}", ctx, e),
    }
}

fn http_get_json(url: &str, project_id: Option<&str>) -> Result<Value> {
    let mut req = ureq::get(url);
    if let Some(pid) = project_id {
        req = req.set("project_id", pid);
    }
    req.call()
        .map_err(|e| http_err(&format!("GET {}", url), e))?
        .into_json::<Value>()
        .map_err(|e| http_err(&format!("decode {}", url), e))
}

fn http_post_cbor(url: &str, body: &[u8], project_id: Option<&str>) -> Result<Value> {
    let mut req = ureq::post(url).set("Content-Type", "application/cbor");
    if let Some(pid) = project_id {
        req = req.set("project_id", pid);
    }
    req.send_bytes(body)
        .map_err(|e| http_err(&format!("POST {}", url), e))?
        .into_json::<Value>()
        .map_err(|e| http_err(&format!("decode {}", url), e))
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        return Err(http_err("hex decode", "odd-length hex string"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| http_err("hex decode", e)))
        .collect()
}

/// Fetches the chain data [`QuickTxApi::build`](crate::QuickTxApi::build) needs. Implement to plug in
/// any backend (Blockfrost, Koios, Ogmios, Yaci DevKit, ...).
pub trait ChainDataProvider {
    /// All UTXOs at `address` (no selection — the bridge selects internally), as a JSON array.
    fn utxos(&self, address: &str) -> Result<Value>;
    /// Current protocol parameters, as a JSON object.
    fn protocol_params(&self) -> Result<Value>;
}

/// Chain-data provider backed by Yaci DevKit / yaci-store (Blockfrost-style REST). Its responses are
/// already in the shape `build` expects.
pub struct YaciProvider {
    base_url: String,
}

impl YaciProvider {
    pub const DEFAULT_URL: &'static str = "http://localhost:10000/local-cluster/api";

    /// Provider for the given base URL.
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }
}

impl Default for YaciProvider {
    /// The local DevKit cluster used by the integration tests.
    fn default() -> Self {
        Self::new(Self::DEFAULT_URL)
    }
}

impl ChainDataProvider for YaciProvider {
    fn utxos(&self, address: &str) -> Result<Value> {
        http_get_json(&format!("{}/addresses/{}/utxos", self.base_url, address), None)
    }

    fn protocol_params(&self) -> Result<Value> {
        http_get_json(&format!("{}/epochs/parameters", self.base_url), None)
    }
}

/// Chain-data provider backed by the Blockfrost API. UTXOs are paginated 100 per page, and Blockfrost
/// omits the owning address on each UTXO so it is injected.
pub struct BlockfrostProvider {
    base_url: String,
    project_id: String,
}

impl BlockfrostProvider {
    pub(crate) fn network_url(network: &str) -> Option<&'static str> {
        match network {
            "mainnet" => Some("https://cardano-mainnet.blockfrost.io/api/v0"),
            "preprod" => Some("https://cardano-preprod.blockfrost.io/api/v0"),
            "preview" => Some("https://cardano-preview.blockfrost.io/api/v0"),
            _ => None,
        }
    }

    /// Provider for the given network (`"mainnet"` / `"preprod"` / `"preview"`).
    pub fn new(project_id: &str, network: &str) -> Result<Self> {
        let base_url = Self::network_url(network).ok_or_else(|| MesmoError {
            code: error_codes::MESMO_ERROR_INVALID_ARGUMENT,
            message: format!("unknown network {:?}; use BlockfrostProvider::with_url", network),
        })?;
        Ok(Self::with_url(project_id, base_url))
    }

    /// Provider pointed at an explicit base URL (e.g. self-hosted Blockfrost).
    pub fn with_url(project_id: &str, base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            project_id: project_id.to_string(),
        }
    }
}

impl ChainDataProvider for BlockfrostProvider {
    fn utxos(&self, address: &str) -> Result<Value> {
        let mut out: Vec<Value> = Vec::new();
        let mut page = 1;
        loop {
            let url = format!(
                "{}/addresses/{}/utxos?count=100&page={}",
                self.base_url, address, page
            );
            let items = http_get_json(&url, Some(&self.project_id))?;
            let arr = items.as_array().cloned().unwrap_or_default();
            if arr.is_empty() {
                break;
            }
            let n = arr.len();
            for mut u in arr {
                // Blockfrost omits the owning address on each UTXO; build() needs it.
                if let Value::Object(ref mut map) = u {
                    map.entry("address")
                        .or_insert_with(|| Value::String(address.to_string()));
                }
                out.push(u);
            }
            if n < 100 {
                break;
            }
            page += 1;
        }
        Ok(Value::Array(out))
    }

    fn protocol_params(&self) -> Result<Value> {
        // Blockfrost's parameters are a superset of CCL's ProtocolParams; the native lib ignores
        // unknown fields, so the response passes through unchanged.
        http_get_json(
            &format!("{}/epochs/latest/parameters", self.base_url),
            Some(&self.project_id),
        )
    }
}

/// Computes a Plutus transaction's redeemer execution units. Implement to plug in any evaluator
/// (Blockfrost, Ogmios, ...). The bridge computes them offline with Scalus when you supply none
/// (ADR-0013); an evaluator lets you use a remote one instead. HTTP is a wrapper concern — libmesmo
/// never makes network calls (ADR-0002).
pub trait TransactionEvaluator {
    /// `[{mem, steps}]`, one per redeemer in transaction order, for the draft `tx_cbor` (hex).
    fn evaluate(&self, tx_cbor: &str, utxos: &Value) -> Result<Value>;
}

// Cardano redeemer tag order (spend < mint < cert < reward < voting < proposing); orders an
// evaluator's purpose-keyed results to match the transaction's redeemer order.
fn redeemer_tag_order(purpose: &str) -> u8 {
    match purpose {
        "spend" => 0,
        "mint" => 1,
        "cert" => 2,
        "reward" => 3,
        "vote" => 4,
        "propose" => 5,
        _ => 99,
    }
}

fn split_purpose(key: &str) -> (&str, i64) {
    match key.split_once(':') {
        Some((p, i)) => (p, i.parse().unwrap_or(0)),
        None => (key, 0),
    }
}

fn budget_of(val: &Value) -> Value {
    let b = val.get("budget").unwrap_or(val);
    let pick = |a: &str, c: &str| b.get(a).or_else(|| b.get(c)).cloned().unwrap_or(Value::Null);
    serde_json::json!({ "mem": pick("memory", "mem"), "steps": pick("steps", "cpu") })
}

/// Parse an Ogmios/Blockfrost EvaluateTx response into `[{mem, steps}]` in redeemer order. Tolerates
/// the purpose-keyed map form and the Ogmios v6 list form.
fn parse_evaluation(resp: &Value) -> Result<Value> {
    let mut result = resp.get("result").unwrap_or(resp);
    if let Some(er) = result.get("EvaluationResult") {
        result = er;
    }
    let mut ordered: Vec<(u8, i64, Value)> = Vec::new();
    if let Some(map) = result.as_object() {
        for (key, val) in map {
            let (purpose, idx) = split_purpose(key);
            ordered.push((redeemer_tag_order(purpose), idx, budget_of(val)));
        }
    } else if let Some(arr) = result.as_array() {
        for item in arr {
            let v = item.get("validator").or_else(|| item.get("redeemer"));
            let (purpose, idx): (String, i64) = match v {
                Some(Value::Object(o)) => (
                    o.get("purpose").and_then(Value::as_str).unwrap_or("").to_string(),
                    o.get("index").and_then(Value::as_i64).unwrap_or(0),
                ),
                Some(Value::String(s)) => {
                    let (p, i) = split_purpose(s);
                    (p.to_string(), i)
                }
                _ => (String::new(), 0),
            };
            ordered.push((redeemer_tag_order(&purpose), idx, budget_of(item)));
        }
    } else {
        return Err(http_err("evaluate", "unrecognized evaluation response"));
    }
    ordered.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(Value::Array(ordered.into_iter().map(|(_, _, u)| u).collect()))
}

/// Remote evaluator via a Blockfrost-compatible `/utils/txs/evaluate` endpoint. Its response shape
/// varies across versions; [`parse_evaluation`] handles the common forms.
pub struct BlockfrostEvaluator {
    base_url: String,
    project_id: String,
}

impl BlockfrostEvaluator {
    /// Evaluator for the given network (`"mainnet"` / `"preprod"` / `"preview"`).
    pub fn new(project_id: &str, network: &str) -> Result<Self> {
        let base_url = BlockfrostProvider::network_url(network).ok_or_else(|| MesmoError {
            code: error_codes::MESMO_ERROR_INVALID_ARGUMENT,
            message: format!("unknown network {:?}; use BlockfrostEvaluator::with_url", network),
        })?;
        Ok(Self::with_url(project_id, base_url))
    }

    /// Evaluator pointed at an explicit base URL (e.g. self-hosted Blockfrost).
    pub fn with_url(project_id: &str, base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            project_id: project_id.to_string(),
        }
    }
}

impl TransactionEvaluator for BlockfrostEvaluator {
    fn evaluate(&self, tx_cbor: &str, _utxos: &Value) -> Result<Value> {
        let bytes = hex_decode(tx_cbor)?;
        let resp = http_post_cbor(
            &format!("{}/utils/txs/evaluate", self.base_url),
            &bytes,
            Some(&self.project_id),
        )?;
        parse_evaluation(&resp)
    }
}

impl<'a> QuickTxApi<'a> {
    /// Fetch chain data from `provider` (and, optionally, execution units from `evaluator`), then
    /// build — in one call. Composes `provider.utxos(sender)` + `provider.protocol_params()` with
    /// [`build`](QuickTxApi::build). With an `evaluator`, runs a two-pass (draft -> evaluate ->
    /// rebuild); without one, the native library's offline Scalus default computes any script units.
    /// To supply units yourself, call [`build`](QuickTxApi::build) directly.
    /// `additional_signers` budgets fee witnesses beyond those implied by the input UTXOs — see
    /// [`build`](QuickTxApi::build).
    pub fn build_with(
        &self,
        yaml: &str,
        provider: &dyn ChainDataProvider,
        senders: &[&str],
        additional_signers: u32,
        evaluator: Option<&dyn TransactionEvaluator>,
    ) -> Result<TxResult> {
        // UTXOs are fetched per sender and de-duplicated by (tx_hash, output_index), so
        // overlapping senders can't double-fund the build. For multi-sender transactions,
        // TxPlan's context.fee_payer decides who pays the fee.
        let mut merged = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for sender in senders {
            if let Some(arr) = provider.utxos(sender)?.as_array() {
                for u in arr {
                    let key = format!("{}#{}", u["tx_hash"], u["output_index"]);
                    if seen.insert(key) {
                        merged.push(u.clone());
                    }
                }
            }
        }
        let utxos = serde_json::Value::Array(merged);
        let protocol_params = provider.protocol_params()?;
        let exec_units = match evaluator {
            Some(ev) => {
                // Two-pass: draft (units computed offline by Scalus) -> remote evaluate -> rebuild.
                let draft = self.build(yaml, &utxos, &protocol_params, None, additional_signers)?;
                Some(ev.evaluate(&draft.tx_cbor, &utxos)?)
            }
            None => None,
        };
        self.build(yaml, &utxos, &protocol_params, exec_units.as_ref(), additional_signers)
    }
}

#[cfg(test)]
mod evaluator_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_map_form_orders_by_redeemer() {
        // spend (0) must come before mint (1) regardless of map order.
        let resp = json!({"result": {"EvaluationResult": {
            "mint:0": {"memory": 1400, "steps": 208100},
            "spend:0": {"memory": 700, "steps": 100000},
        }}});
        assert_eq!(
            parse_evaluation(&resp).unwrap(),
            json!([{"mem": 700, "steps": 100000}, {"mem": 1400, "steps": 208100}])
        );
    }

    #[test]
    fn parse_ogmios_v6_list_form() {
        let resp = json!({"result": [
            {"validator": {"index": 0, "purpose": "mint"}, "budget": {"memory": 1400, "cpu": 208100}},
            {"validator": "spend:0", "budget": {"memory": 700, "cpu": 100000}},
        ]});
        assert_eq!(
            parse_evaluation(&resp).unwrap(),
            json!([{"mem": 700, "steps": 100000}, {"mem": 1400, "steps": 208100}])
        );
    }

    #[test]
    fn blockfrost_evaluator_rejects_unknown_network() {
        assert!(BlockfrostEvaluator::new("proj", "does-not-exist").is_err());
    }

    #[test]
    fn blockfrost_evaluator_setup_uses_network_url_and_project_id() {
        // Mirrors Python's test_blockfrost_evaluator_setup: a known network resolves to the right
        // base URL and carries the project_id.
        let ev = BlockfrostEvaluator::new("proj_id", "preprod").expect("known network");
        assert!(ev.base_url.ends_with("cardano-preprod.blockfrost.io/api/v0"));
        assert_eq!(ev.project_id, "proj_id");
    }

    #[test]
    fn parse_evaluation_rejects_unrecognized_shape() {
        // A scalar result is neither the map form nor the list form -> error.
        let resp = json!({"result": 42});
        assert!(parse_evaluation(&resp).is_err());
    }
}
