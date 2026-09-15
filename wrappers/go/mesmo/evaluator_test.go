package mesmo

import (
	"reflect"
	"testing"
)

// The Ogmios/Blockfrost response decodes with numbers as float64; parseEvaluation must order the
// per-redeemer units by tag (spend < mint) regardless of the response's key/element order.

func TestParseEvaluationMapForm(t *testing.T) {
	resp := map[string]interface{}{"result": map[string]interface{}{"EvaluationResult": map[string]interface{}{
		"mint:0":  map[string]interface{}{"memory": float64(1400), "steps": float64(208100)},
		"spend:0": map[string]interface{}{"memory": float64(700), "steps": float64(100000)},
	}}}
	got, err := parseEvaluation(resp)
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]interface{}{
		{"mem": float64(700), "steps": float64(100000)},
		{"mem": float64(1400), "steps": float64(208100)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseEvaluationOgmiosV6List(t *testing.T) {
	resp := map[string]interface{}{"result": []interface{}{
		map[string]interface{}{
			"validator": map[string]interface{}{"index": float64(0), "purpose": "mint"},
			"budget":    map[string]interface{}{"memory": float64(1400), "cpu": float64(208100)},
		},
		map[string]interface{}{
			"validator": "spend:0",
			"budget":    map[string]interface{}{"memory": float64(700), "cpu": float64(100000)},
		},
	}}
	got, err := parseEvaluation(resp)
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]interface{}{
		{"mem": float64(700), "steps": float64(100000)},
		{"mem": float64(1400), "steps": float64(208100)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestNewBlockfrostEvaluatorUnknownNetwork(t *testing.T) {
	if _, err := NewBlockfrostEvaluator("proj", "does-not-exist"); err == nil {
		t.Fatal("expected error for unknown network")
	}
}
