package ccl

import (
	"os"
	"strings"
	"testing"
)

// The mnemonic the intent fixtures are derived from (account index 0/0 == intentSender).
const intentMnemonic = "test walk nut penalty hip pave soap entry language right filter choice"

// A stake registration must be witnessed by the stake key in addition to the payment key, or the
// node rejects it with MissingVKeyWitnessesUTXOW. This verifies the stake role adds that second
// witness (the signed CBOR is longer by one vkey witness) where SignTx (payment only) does not.
func TestSignTxWithStakeKey(t *testing.T) {
	yamlBytes, err := os.ReadFile("../../../test-fixtures/quicktx-intents/stake_registration.yaml")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	utxos := []map[string]interface{}{{
		"tx_hash":      strings.Repeat("a", 64),
		"output_index": 0,
		"address":      intentSender,
		"amount":       []map[string]interface{}{{"unit": "lovelace", "quantity": "2000000000"}},
	}}

	built, err := bridge.QuickTx.Build(string(yamlBytes), utxos, testProtocolParams(), 1)
	if err != nil {
		t.Fatalf("build stake registration: %v", err)
	}

	signedPayment := intentSign(t, built.TxCbor, "payment")
	signedStake := intentSign(t, built.TxCbor, "payment", "stake")

	if len(signedStake) <= len(signedPayment) {
		t.Errorf("payment+stake signing should add a witness: payment=%d, payment+stake=%d",
			len(signedPayment), len(signedStake))
	}
}

// An unknown role bit is rejected by the typed mask.
func TestSignTxRejectsUnknownRole(t *testing.T) {
	acct, err := bridge.Accounts.FromMnemonic(intentMnemonic, Testnet, 0, 0)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic: %v", err)
	}
	defer acct.Close()
	if _, err := acct.SignTx("84a300d9010281825820"+strings.Repeat("0", 100), SigningRole(1<<7)); err == nil {
		t.Error("expected an error for an unknown signing role")
	}
}

// rolesFromKeys maps the fixture role names onto the typed mask.
func rolesFromKeys(t *testing.T, keys []string) SigningRole {
	t.Helper()
	var mask SigningRole
	for _, k := range keys {
		switch k {
		case "payment":
			mask |= RolePayment
		case "stake":
			mask |= RoleStake
		case "drep":
			mask |= RoleDRep
		default:
			t.Fatalf("unknown signing role %q", k)
		}
	}
	return mask
}

// intentSignAt signs with the fixture mnemonic through a managed handle at the given address index.
func intentSignAt(t *testing.T, addressIndex int, txCbor string, keys ...string) string {
	t.Helper()
	acct, err := bridge.Accounts.FromMnemonic(intentMnemonic, Testnet, 0, addressIndex)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic: %v", err)
	}
	defer acct.Close()
	signed, err := acct.SignTx(txCbor, rolesFromKeys(t, keys))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

func intentSign(t *testing.T, txCbor string, keys ...string) string {
	return intentSignAt(t, 0, txCbor, keys...)
}
