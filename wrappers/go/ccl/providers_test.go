package ccl

// Unit tests for the optional chain-data provider helpers: the HTTP-shaping logic (URLs, headers,
// pagination, address injection) via httptest, plus an offline BuildWith round-trip that
// serves the known-good static params/UTXOs (no DevKit). The live Yaci round-trip is covered by the
// DevKit integration tests.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestYaciProviderEndpoints(t *testing.T) {
	var gotUtxoPath, gotParamsPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/utxos") {
			gotUtxoPath = r.URL.Path
			json.NewEncoder(w).Encode([]map[string]interface{}{})
		} else {
			gotParamsPath = r.URL.Path
			json.NewEncoder(w).Encode(map[string]interface{}{})
		}
	}))
	defer srv.Close()

	p := NewYaciProvider(srv.URL + "/") // trailing slash should be trimmed
	if _, err := p.Utxos("addr_test1xyz"); err != nil {
		t.Fatalf("utxos: %v", err)
	}
	if _, err := p.ProtocolParams(); err != nil {
		t.Fatalf("params: %v", err)
	}
	if gotUtxoPath != "/addresses/addr_test1xyz/utxos" {
		t.Errorf("utxo path = %q", gotUtxoPath)
	}
	if gotParamsPath != "/epochs/parameters" {
		t.Errorf("params path = %q", gotParamsPath)
	}
}

func TestBlockfrostProviderPaginationAndAddressInjection(t *testing.T) {
	var sawProjectID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawProjectID = r.Header.Get("project_id")
		page := r.URL.Query().Get("page")
		var items []map[string]interface{}
		if page == "1" {
			for i := 0; i < 100; i++ {
				items = append(items, map[string]interface{}{
					"tx_hash": fmt.Sprintf("%064x", i), "output_index": 0,
					"amount": []map[string]interface{}{{"unit": "lovelace", "quantity": "1000000"}},
				})
			}
		} else if page == "2" {
			items = []map[string]interface{}{{
				"tx_hash": strings.Repeat("ff", 32), "output_index": 1,
				"amount": []map[string]interface{}{{"unit": "lovelace", "quantity": "2000000"}},
			}}
		}
		json.NewEncoder(w).Encode(items)
	}))
	defer srv.Close()

	p := NewBlockfrostProviderURL("proj123", srv.URL)
	utxos, err := p.Utxos("addr_test1abc")
	if err != nil {
		t.Fatalf("utxos: %v", err)
	}
	if len(utxos) != 101 { // paged until a short page
		t.Errorf("expected 101 utxos, got %d", len(utxos))
	}
	for _, u := range utxos {
		if u["address"] != "addr_test1abc" { // address injected on every UTXO
			t.Fatalf("address not injected: %v", u["address"])
		}
	}
	if sawProjectID != "proj123" {
		t.Errorf("project_id header = %q", sawProjectID)
	}
}

func TestBlockfrostUnknownNetwork(t *testing.T) {
	if _, err := NewBlockfrostProvider("p", "nope"); err == nil {
		t.Error("expected error for unknown network")
	}
}

// BuildWith end-to-end, offline: a local server returns the known-good static protocol
// params and UTXOs, and the bridge builds a real payment from them — no DevKit required.
func TestBuildWithOffline(t *testing.T) {
	sender := intentSender
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/utxos") {
			json.NewEncoder(w).Encode(makeUtxos(sender, 2000000000))
		} else {
			json.NewEncoder(w).Encode(testProtocolParams())
		}
	}))
	defer srv.Close()

	provider := NewYaciProvider(srv.URL)
	yaml := quickTxYaml(sender, intentSender2, "5000000")
	res, err := bridge.QuickTx.BuildWith(yaml, provider, []string{sender}, 0)
	if err != nil {
		t.Fatalf("BuildWith: %v", err)
	}
	if len(res.TxHash) != 64 {
		t.Errorf("expected 64-char tx hash, got %d", len(res.TxHash))
	}
	if len(res.TxCbor) == 0 {
		t.Error("expected non-empty tx cbor")
	}
}

// Multi-sender fetch: UTXOs are merged per sender and de-duplicated by (tx_hash, output_index).
// With the shared UTXO duplicated by naive concatenation, the build would double-count or emit
// duplicate inputs — so a successful build with exactly-once funding is the regression pin.
func TestBuildWithMergesAndDedupesAcrossSenders(t *testing.T) {
	senderA := intentSender
	senderB := intentSender2
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/utxos") {
			// Both senders report the same funding UTXO (owned by senderA) plus B's own.
			if strings.Contains(r.URL.Path, senderB) {
				utxos := makeUtxos(senderA, 2000000000)
				utxos = append(utxos, map[string]interface{}{
					"tx_hash": strings.Repeat("b", 64), "output_index": 1, "address": senderB,
					"amount": []map[string]interface{}{{"unit": "lovelace", "quantity": "7000000"}},
				})
				json.NewEncoder(w).Encode(utxos)
			} else {
				json.NewEncoder(w).Encode(makeUtxos(senderA, 2000000000))
			}
		} else {
			json.NewEncoder(w).Encode(testProtocolParams())
		}
	}))
	defer srv.Close()

	provider := NewYaciProvider(srv.URL)
	yaml := quickTxYaml(senderA, senderB, "5000000")
	res, err := bridge.QuickTx.BuildWith(yaml, provider, []string{senderA, senderB}, 0)
	if err != nil {
		t.Fatalf("BuildWith(two senders): %v", err)
	}
	if len(res.TxHash) != 64 {
		t.Errorf("expected 64-char tx hash, got %d", len(res.TxHash))
	}
}
