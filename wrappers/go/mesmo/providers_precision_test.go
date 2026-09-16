package mesmo

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A UTxO amount can exceed 2^53 — a native-token quantity routinely does, and lovelace does on large
// UTxOs. Decoding a provider response into map[string]interface{} with the default JSON decoder turns
// every number into a float64, silently rounding those amounts; the corrupted value would then flow
// into Build's UTxO selection and change calculation. httpGetJSON uses UseNumber to prevent that.
// This test fails (off-by-one on the quantity) without the fix.
func TestProviderPreservesLargeIntegerQuantity(t *testing.T) {
	const big = "9007199254740993" // 2^53 + 1; not representable exactly as float64

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A provider that returns the quantity as a JSON *number* (not a string).
		_, _ = w.Write([]byte(`[{"tx_hash":"aa","output_index":0,` +
			`"amount":[{"unit":"lovelace","quantity":` + big + `}]}]`))
	}))
	defer srv.Close()

	utxos, err := NewYaciProvider(srv.URL).Utxos("addr_test1xyz")
	if err != nil {
		t.Fatalf("Utxos: %v", err)
	}

	// Re-marshal exactly as Build does before handing UTxOs to the native lib.
	out, err := json.Marshal(utxos)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := extractQuantity(t, utxos)
	if got != big {
		t.Errorf("quantity corrupted by JSON decode: got %s, want %s\nmarshaled: %s", got, big, out)
	}
}

func extractQuantity(t *testing.T, utxos []map[string]interface{}) string {
	t.Helper()
	amounts, ok := utxos[0]["amount"].([]interface{})
	if !ok || len(amounts) == 0 {
		t.Fatalf("unexpected amount shape: %#v", utxos[0]["amount"])
	}
	amt := amounts[0].(map[string]interface{})
	// With UseNumber the quantity is a json.Number whose String() is the exact literal.
	switch q := amt["quantity"].(type) {
	case json.Number:
		return q.String()
	default:
		// float64 (the bug) or anything else — render it the way it would reach the native lib.
		b, _ := json.Marshal(q)
		return string(b)
	}
}
