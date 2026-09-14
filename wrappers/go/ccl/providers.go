package ccl

// Optional chain-data provider helpers.
//
// QuickTx.Build is offline by design: the caller supplies UTXOs and protocol parameters (and, for
// Plutus, execution units). These helpers are an optional convenience that fetch those inputs from a
// chain-data backend over HTTP, returning them in the shape Build already accepts — so the native
// library stays offline and provider-free, and the helpers are pure wrapper-side code using the
// standard net/http client.
//
// A provider implements two methods:
//
//	Utxos(address)     -> all UTXOs at the address (no selection — the bridge selects)
//	ProtocolParams()   -> protocol parameters
//
// Use one directly, or via QuickTxApi.BuildWith:
//
//	provider := ccl.NewBlockfrostProvider(projectID, "preprod") // or ccl.NewYaciProvider("")
//	result, err := bridge.QuickTx.BuildWith(yaml, provider, []string{senderAddress}, 0)

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// httpClient bounds provider requests so a hung or unresponsive endpoint can't pin a goroutine and
// its connection forever (the default http.Client has no timeout). Matches the Python wrapper's 60s
// ceiling; generous enough for a large paginated UTxO fetch. A fuller context.Context-based API is
// tracked in TODO.md §8.
var httpClient = &http.Client{Timeout: 60 * time.Second}

// ChainDataProvider fetches the chain data QuickTx.Build needs. Implement it to plug in any backend
// (Blockfrost, Koios, Ogmios, Yaci DevKit, ...).
type ChainDataProvider interface {
	// Utxos returns all UTXOs at the address (the bridge selects internally; no selection needed).
	Utxos(address string) ([]map[string]interface{}, error)
	// ProtocolParams returns the current protocol parameters.
	ProtocolParams() (map[string]interface{}, error)
}

func httpGetJSON(url string, headers map[string]string, out interface{}) error {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GET %s failed: HTTP %d: %s", url, resp.StatusCode, string(body))
	}
	// UseNumber is not optional here. Decoding into map[string]interface{} turns every JSON number
	// into a float64, which silently rounds any integer above 2^53 — and a UTxO's lovelace amount or
	// native-token quantity routinely exceeds that. That corrupted value would then flow into Build's
	// UTxO selection and change calculation, producing a wrong (or unbuildable) transaction. UseNumber
	// keeps numbers as string-backed json.Number, so they re-marshal into Build losslessly.
	dec := json.NewDecoder(resp.Body)
	dec.UseNumber()
	return dec.Decode(out)
}

func httpPostCBOR(url string, body []byte, headers map[string]string, out interface{}) error {
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/cbor")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("POST %s failed: HTTP %d: %s", url, resp.StatusCode, string(b))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// YaciProvider is a ChainDataProvider backed by Yaci DevKit / yaci-store (Blockfrost-style REST).
// Its UTXO and protocol-parameter responses are already in the shape Build expects.
type YaciProvider struct {
	BaseURL string
}

const defaultYaciURL = "http://localhost:10000/local-cluster/api"

// NewYaciProvider returns a YaciProvider for the given base URL; pass "" for the local DevKit cluster.
func NewYaciProvider(baseURL string) *YaciProvider {
	if baseURL == "" {
		baseURL = defaultYaciURL
	}
	return &YaciProvider{BaseURL: strings.TrimRight(baseURL, "/")}
}

func (p *YaciProvider) Utxos(address string) ([]map[string]interface{}, error) {
	var utxos []map[string]interface{}
	err := httpGetJSON(fmt.Sprintf("%s/addresses/%s/utxos", p.BaseURL, address), nil, &utxos)
	return utxos, err
}

func (p *YaciProvider) ProtocolParams() (map[string]interface{}, error) {
	var pp map[string]interface{}
	err := httpGetJSON(p.BaseURL+"/epochs/parameters", nil, &pp)
	return pp, err
}

var blockfrostNetworkURLs = map[string]string{
	"mainnet": "https://cardano-mainnet.blockfrost.io/api/v0",
	"preprod": "https://cardano-preprod.blockfrost.io/api/v0",
	"preview": "https://cardano-preview.blockfrost.io/api/v0",
}

// BlockfrostProvider is a ChainDataProvider backed by the Blockfrost API. UTXOs are paginated 100 per
// page, and Blockfrost omits the owning address on each UTXO so it is injected.
type BlockfrostProvider struct {
	BaseURL   string
	ProjectID string
}

// NewBlockfrostProvider returns a provider for the given network ("mainnet"/"preprod"/"preview").
// Use NewBlockfrostProviderURL to point at a custom base URL.
func NewBlockfrostProvider(projectID, network string) (*BlockfrostProvider, error) {
	baseURL, ok := blockfrostNetworkURLs[network]
	if !ok {
		return nil, fmt.Errorf("unknown network %q; use NewBlockfrostProviderURL", network)
	}
	return NewBlockfrostProviderURL(projectID, baseURL), nil
}

// NewBlockfrostProviderURL returns a provider pointed at an explicit base URL (e.g. self-hosted).
func NewBlockfrostProviderURL(projectID, baseURL string) *BlockfrostProvider {
	return &BlockfrostProvider{BaseURL: strings.TrimRight(baseURL, "/"), ProjectID: projectID}
}

func (p *BlockfrostProvider) headers() map[string]string {
	return map[string]string{"project_id": p.ProjectID}
}

func (p *BlockfrostProvider) Utxos(address string) ([]map[string]interface{}, error) {
	var out []map[string]interface{}
	for page := 1; ; page++ {
		var items []map[string]interface{}
		url := fmt.Sprintf("%s/addresses/%s/utxos?count=100&page=%d", p.BaseURL, address, page)
		if err := httpGetJSON(url, p.headers(), &items); err != nil {
			return nil, err
		}
		if len(items) == 0 {
			break
		}
		for _, u := range items {
			// Blockfrost omits the owning address on each UTXO; Build needs it.
			if _, ok := u["address"]; !ok {
				u["address"] = address
			}
			out = append(out, u)
		}
		if len(items) < 100 {
			break
		}
	}
	return out, nil
}

func (p *BlockfrostProvider) ProtocolParams() (map[string]interface{}, error) {
	// Blockfrost's parameters are a superset of CCL's ProtocolParams; the native lib ignores
	// unknown fields, so the response passes through unchanged.
	var pp map[string]interface{}
	err := httpGetJSON(p.BaseURL+"/epochs/latest/parameters", p.headers(), &pp)
	return pp, err
}

// TransactionEvaluator computes a Plutus transaction's redeemer execution units. Implement it to plug
// in any evaluator (Blockfrost, Ogmios, ...). The bridge computes them offline with Scalus when you
// supply none (ADR-0013); an evaluator lets you use a remote one instead. HTTP is a wrapper concern —
// libccl never makes network calls (ADR-0002).
type TransactionEvaluator interface {
	// Evaluate returns [{mem, steps}], one per redeemer in transaction order, for the draft txCbor (hex).
	Evaluate(txCbor string, utxos []map[string]interface{}) ([]map[string]interface{}, error)
}

// Cardano redeemer tag order (spend < mint < cert < reward < voting < proposing); orders an
// evaluator's purpose-keyed results to match the transaction's redeemer order.
var redeemerTagOrder = map[string]int{"spend": 0, "mint": 1, "cert": 2, "reward": 3, "vote": 4, "propose": 5}

func tagOrder(purpose string) int {
	if o, ok := redeemerTagOrder[purpose]; ok {
		return o
	}
	return 99
}

func splitPurpose(key string) (string, int) {
	if i := strings.IndexByte(key, ':'); i >= 0 {
		idx, _ := strconv.Atoi(key[i+1:])
		return key[:i], idx
	}
	return key, 0
}

func budgetOf(val map[string]interface{}) map[string]interface{} {
	b := val
	if bud, ok := val["budget"].(map[string]interface{}); ok {
		b = bud
	}
	pick := func(a, c string) interface{} {
		if v, ok := b[a]; ok {
			return v
		}
		return b[c]
	}
	return map[string]interface{}{"mem": pick("memory", "mem"), "steps": pick("steps", "cpu")}
}

// parseEvaluation turns an Ogmios/Blockfrost EvaluateTx response into [{mem, steps}] in redeemer
// order. Tolerates the purpose-keyed map form and the Ogmios v6 list form.
func parseEvaluation(resp map[string]interface{}) ([]map[string]interface{}, error) {
	var result interface{} = resp
	if r, ok := resp["result"]; ok {
		result = r
	}
	if m, ok := result.(map[string]interface{}); ok {
		if er, ok := m["EvaluationResult"]; ok {
			result = er
		}
	}

	type entry struct {
		tag, idx int
		unit     map[string]interface{}
	}
	var entries []entry
	switch r := result.(type) {
	case map[string]interface{}:
		for key, val := range r {
			purpose, idx := splitPurpose(key)
			vm, _ := val.(map[string]interface{})
			entries = append(entries, entry{tagOrder(purpose), idx, budgetOf(vm)})
		}
	case []interface{}:
		for _, item := range r {
			im, _ := item.(map[string]interface{})
			v := im["validator"]
			if v == nil {
				v = im["redeemer"]
			}
			var purpose string
			var idx int
			switch vv := v.(type) {
			case map[string]interface{}:
				purpose, _ = vv["purpose"].(string)
				if f, ok := vv["index"].(float64); ok {
					idx = int(f)
				}
			case string:
				purpose, idx = splitPurpose(vv)
			}
			entries = append(entries, entry{tagOrder(purpose), idx, budgetOf(im)})
		}
	default:
		return nil, fmt.Errorf("unrecognized evaluation response")
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].tag != entries[j].tag {
			return entries[i].tag < entries[j].tag
		}
		return entries[i].idx < entries[j].idx
	})
	out := make([]map[string]interface{}, len(entries))
	for i, e := range entries {
		out[i] = e.unit
	}
	return out, nil
}

// BlockfrostEvaluator is a remote evaluator via a Blockfrost-compatible /utils/txs/evaluate endpoint.
type BlockfrostEvaluator struct {
	BaseURL   string
	ProjectID string
}

// NewBlockfrostEvaluator returns an evaluator for the given network ("mainnet"/"preprod"/"preview").
func NewBlockfrostEvaluator(projectID, network string) (*BlockfrostEvaluator, error) {
	baseURL, ok := blockfrostNetworkURLs[network]
	if !ok {
		return nil, fmt.Errorf("unknown network %q; use NewBlockfrostEvaluatorURL", network)
	}
	return NewBlockfrostEvaluatorURL(projectID, baseURL), nil
}

// NewBlockfrostEvaluatorURL returns an evaluator pointed at an explicit base URL (e.g. self-hosted).
func NewBlockfrostEvaluatorURL(projectID, baseURL string) *BlockfrostEvaluator {
	return &BlockfrostEvaluator{BaseURL: strings.TrimRight(baseURL, "/"), ProjectID: projectID}
}

// Evaluate posts the draft transaction to /utils/txs/evaluate and returns the redeemer units.
func (e *BlockfrostEvaluator) Evaluate(txCbor string, _ []map[string]interface{}) ([]map[string]interface{}, error) {
	body, err := hex.DecodeString(txCbor)
	if err != nil {
		return nil, fmt.Errorf("hex decode: %w", err)
	}
	var resp map[string]interface{}
	err = httpPostCBOR(e.BaseURL+"/utils/txs/evaluate", body,
		map[string]string{"project_id": e.ProjectID}, &resp)
	if err != nil {
		return nil, err
	}
	return parseEvaluation(resp)
}

// BuildWith fetches chain data from the provider (and, optionally, execution units from an evaluator),
// then builds — in one call. With an evaluator it runs a two-pass (draft -> evaluate -> rebuild);
// without one the native library's offline Scalus default computes any script units. To supply units
// yourself, call Build directly.
//
// additionalSigners budgets fee witnesses beyond those implied by the input UTXOs — see
// QuickTxApi.Build.
func (q *QuickTxApi) BuildWith(yaml string, provider ChainDataProvider, senders []string, additionalSigners int, evaluator ...TransactionEvaluator) (*TxResult, error) {
	// UTXOs are fetched per sender and de-duplicated by (tx_hash, output_index), so overlapping
	// senders can't double-fund the build. For multi-sender transactions, TxPlan's
	// context.fee_payer decides who pays the fee.
	var utxos []map[string]interface{}
	seen := make(map[string]bool)
	for _, sender := range senders {
		us, err := provider.Utxos(sender)
		if err != nil {
			return nil, fmt.Errorf("provider utxos: %w", err)
		}
		for _, u := range us {
			key := fmt.Sprintf("%v#%v", u["tx_hash"], u["output_index"])
			if !seen[key] {
				seen[key] = true
				utxos = append(utxos, u)
			}
		}
	}
	pp, err := provider.ProtocolParams()
	if err != nil {
		return nil, fmt.Errorf("provider protocol params: %w", err)
	}
	if len(evaluator) > 0 && evaluator[0] != nil {
		// Two-pass: draft (units computed offline by Scalus) -> remote evaluate -> rebuild.
		draft, err := q.Build(yaml, utxos, pp, additionalSigners)
		if err != nil {
			return nil, err
		}
		units, err := evaluator[0].Evaluate(draft.TxCbor, utxos)
		if err != nil {
			return nil, fmt.Errorf("evaluate: %w", err)
		}
		return q.Build(yaml, utxos, pp, additionalSigners, units)
	}
	return q.Build(yaml, utxos, pp, additionalSigners)
}
