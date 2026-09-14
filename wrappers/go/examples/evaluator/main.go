// Build a Plutus-script transaction and get its execution units two ways.
//
// A Plutus build needs each redeemer's execution units. This example mints a token with an
// always-succeeds validator and shows both ways to obtain them:
//  1. the offline default — the bridge computes the units in-process with Scalus (no network); and
//  2. a remote TransactionEvaluator (Blockfrost) — illustrative, requires a project id.
//
// libccl never makes HTTP calls (ADR-0013 / ADR-0002), so a remote evaluator lives here in the
// wrapper: BuildWith runs a two-pass (draft -> evaluate -> rebuild).
//
// Run from wrappers/go:
//
//	LIB_DIR=../../core/build/native/nativeCompile
//	DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR go run ./examples/evaluator
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/bloxbean/cardano-client-bindings/wrappers/go/ccl"
)

// localProvider returns fixed fixtures (stands in for Blockfrost/Yaci/…).
type localProvider struct {
	utxos  []map[string]interface{}
	params map[string]interface{}
}

func (p *localProvider) Utxos(string) ([]map[string]interface{}, error)  { return p.utxos, nil }
func (p *localProvider) ProtocolParams() (map[string]interface{}, error) { return p.params, nil }

func mustRead(path string) []byte {
	b, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	return b
}

func main() {
	// Shared fixtures: an always-succeeds mint (TxPlan YAML), the sender's UTXOs, and protocol
	// parameters *with cost models* (Scalus needs them to run the UPLC machine).
	dir := "../../test-fixtures/plutus-mint-scalus"
	yaml := string(mustRead(filepath.Join(dir, "mint.yaml")))
	var utxos []map[string]interface{}
	_ = json.Unmarshal(mustRead(filepath.Join(dir, "utxos.json")), &utxos)
	var params map[string]interface{}
	_ = json.Unmarshal(mustRead(filepath.Join(dir, "protocol-params.json")), &params)
	sender, _ := utxos[0]["address"].(string)

	provider := &localProvider{utxos: utxos, params: params}

	bridge, err := ccl.New()
	if err != nil {
		log.Fatal(err)
	}
	defer bridge.Close()

	// 1) Offline default: no evaluator -> Scalus runs the validator and stamps the computed units.
	result, err := bridge.QuickTx.BuildWith(yaml, provider, []string{sender}, 0)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("offline (Scalus) — fee: %s  tx_hash: %s\n", result.Fee, result.TxHash)

	// 2) Remote evaluator (illustrative — needs a Blockfrost project id). The two-pass builds a
	//    draft, POSTs it to /utils/txs/evaluate, and rebuilds with the returned units:
	//
	//	evaluator, _ := ccl.NewBlockfrostEvaluator("preprod_your_project_id", "preprod")
	//	result, err := bridge.QuickTx.BuildWith(yaml, provider, []string{sender}, 0, evaluator)
	//
	// To supply units yourself, call Build directly with the units as the last argument.
}
