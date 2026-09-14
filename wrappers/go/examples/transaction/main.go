// Build and sign a payment transaction fully offline from a TxPlan (YAML).
//
// The transaction is defined as a TxPlan YAML document; we supply the UTXOs and protocol
// parameters ourselves (no node / no provider). The bridge builds the unsigned CBOR, which we
// then sign locally. Submitting it is a separate, online step.
//
// Run from wrappers/go:
//
//	LIB_DIR=../../core/build/native/nativeCompile
//	DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR go run ./examples/transaction
package main

import (
	"fmt"
	"log"
	"strings"

	"github.com/bloxbean/cardano-client-bindings/wrappers/go/ccl"
)

// Minimal protocol parameters (CCL test-resource values), the CCL ProtocolParams model as a map.
var protocolParams = map[string]interface{}{
	"min_fee_a": 44, "min_fee_b": 155381, "max_tx_size": 16384,
	"key_deposit": "2000000", "pool_deposit": "500000000",
	"coins_per_utxo_size": "4310", "max_val_size": "5000",
	"max_tx_ex_mem": "10000000", "max_tx_ex_steps": "10000000000",
	"price_mem": 0.0577, "price_step": 0.0000721, "collateral_percent": 150,
	"max_collateral_inputs": 3,
}

func main() {
	bridge, err := ccl.New()
	if err != nil {
		log.Fatal(err)
	}
	defer bridge.Close()

	sender, _ := bridge.Accounts.Create(ccl.Testnet) // managed handle — signs below
	defer sender.Close()
	senderInfo, _ := sender.Info()
	receiver, _ := bridge.Accounts.Create(ccl.Testnet)
	receiverInfo, _ := receiver.Info()
	receiver.Close()

	// A static UTXO the sender controls (100 ADA), instead of querying a node.
	utxos := []map[string]interface{}{{
		"tx_hash":      strings.Repeat("a", 64),
		"output_index": 0,
		"address":      senderInfo.BaseAddress,
		"amount":       []map[string]interface{}{{"unit": "lovelace", "quantity": "100000000"}},
	}}

	// Define the transaction as a TxPlan YAML document: pay 5 ADA to the receiver.
	yaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: payment
          address: %s
          amounts:
            - unit: lovelace
              quantity: "5000000"
`, senderInfo.BaseAddress, receiverInfo.BaseAddress)

	// Build the unsigned transaction offline.
	result, err := bridge.QuickTx.Build(yaml, utxos, protocolParams, 0)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("Built unsigned transaction from TxPlan YAML")
	fmt.Println("  tx hash:", result.TxHash)
	fmt.Println("  fee    :", result.Fee)
	fmt.Println("  cbor   :", result.TxCbor[:80], "...")

	// Sign it with the sender's managed handle — no mnemonic in the call.
	signed, err := sender.SignTx(result.TxCbor, ccl.RolePayment)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("Signed transaction cbor:", signed[:80], "...")
	fmt.Println("\nNext step (not shown): submit `signed` to a Cardano node over HTTP.")
}
