package ccl

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// A known valid transaction CBOR hex (built from Java tests)
const sampleTxCbor = "84a300d901028182582073198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002010181825839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc1a001e8480021a00029810a0f5f6"

var bridge *Bridge

func TestMain(m *testing.M) {
	var err error
	bridge, err = New()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create bridge: %v\n", err)
		os.Exit(1)
	}
	code := m.Run()
	bridge.Close()
	os.Exit(code)
}

func TestVersion(t *testing.T) {
	version, err := bridge.Version()
	if err != nil {
		t.Fatalf("Version() failed: %v", err)
	}
	if version != "0.1.0" {
		t.Errorf("expected version 0.1.0, got %s", version)
	}
}

func TestAccountCreate(t *testing.T) {
	info := createTestAccount(t, Mainnet)

	if !strings.HasPrefix(info.BaseAddress, "addr1") {
		t.Errorf("expected mainnet address prefix, got %s", info.BaseAddress)
	}

	words := strings.Fields(info.Mnemonic)
	if len(words) != 24 {
		t.Errorf("expected 24 word mnemonic, got %d", len(words))
	}
}

func TestAccountFromMnemonic(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	restored, err := bridge.Accounts.FromMnemonic(created.Mnemonic, Mainnet, 0, 0)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic() failed: %v", err)
	}
	defer restored.Close()
	rinfo, err := restored.Info()
	if err != nil {
		t.Fatalf("Info() failed: %v", err)
	}

	if rinfo.BaseAddress != created.BaseAddress {
		t.Errorf("addresses don't match: %s != %s", rinfo.BaseAddress, created.BaseAddress)
	}
}

func TestAccountGetKeys(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	key, err := bridge.Crypto.DeriveKey(created.Mnemonic, 0, 0, "payment")
	if err != nil {
		t.Fatalf("Crypto.DeriveKey() failed: %v", err)
	}
	if len(key.PrivateKey) != 128 {
		t.Errorf("expected 128 hex chars (64 bytes extended), got %d", len(key.PrivateKey))
	}
	if len(key.PublicKey) != 64 {
		t.Errorf("expected 64 hex chars public key, got %d", len(key.PublicKey))
	}
}

func TestAccountDRepID(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	if !strings.HasPrefix(created.DRepID, "drep1") {
		t.Errorf("expected drep1 prefix, got %s", created.DRepID)
	}
}

func TestAccountSignTx(t *testing.T) {
	created := createTestAccount(t, Testnet)

	acct, err := bridge.Accounts.FromMnemonic(created.Mnemonic, Testnet, 0, 0)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic() failed: %v", err)
	}
	defer acct.Close()
	signed, err := acct.SignTx(sampleTxCbor, RolePayment)
	if err != nil {
		t.Fatalf("SignTx() failed: %v", err)
	}
	if len(signed) <= len(sampleTxCbor) {
		t.Error("signed tx should be larger than unsigned")
	}
}

func TestAddressToFromBytes(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	hexBytes, err := bridge.Address.ToBytes(created.BaseAddress)
	if err != nil {
		t.Fatalf("Address.ToBytes() failed: %v", err)
	}
	if len(hexBytes) == 0 {
		t.Error("hex bytes should not be empty")
	}

	restored, err := bridge.Address.FromBytes(hexBytes)
	if err != nil {
		t.Fatalf("Address.FromBytes() failed: %v", err)
	}
	if restored != created.BaseAddress {
		t.Errorf("round-trip failed: %s != %s", restored, created.BaseAddress)
	}
}

func TestAddressValidate(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	if !bridge.Address.Validate(created.BaseAddress) {
		t.Error("valid address should pass validation")
	}

	if bridge.Address.Validate("invalid_address") {
		t.Error("invalid address should fail validation")
	}
}

func TestAddressInfo(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	info, err := bridge.Address.Info(created.BaseAddress)
	if err != nil {
		t.Fatalf("Address.Info() failed: %v", err)
	}
	if info.Type != "Base" {
		t.Errorf("expected type Base, got %s", info.Type)
	}
	if info.NetworkID != 1 {
		t.Errorf("expected network_id 1, got %d", info.NetworkID)
	}
}

func TestCryptoBlake2b256(t *testing.T) {
	hash, err := bridge.Crypto.Blake2b256("48656c6c6f")
	if err != nil {
		t.Fatalf("Crypto.Blake2b256() failed: %v", err)
	}
	if len(hash) != 64 {
		t.Errorf("expected 64 hex chars, got %d", len(hash))
	}
}

func TestCryptoBlake2b224(t *testing.T) {
	hash, err := bridge.Crypto.Blake2b224("48656c6c6f")
	if err != nil {
		t.Fatalf("Crypto.Blake2b224() failed: %v", err)
	}
	if len(hash) != 56 {
		t.Errorf("expected 56 hex chars, got %d", len(hash))
	}
}

func TestCryptoMnemonic(t *testing.T) {
	mnemonic, err := bridge.Crypto.GenerateMnemonic(24)
	if err != nil {
		t.Fatalf("Crypto.GenerateMnemonic() failed: %v", err)
	}

	words := strings.Fields(mnemonic)
	if len(words) != 24 {
		t.Errorf("expected 24 words, got %d", len(words))
	}

	if !bridge.Crypto.ValidateMnemonic(mnemonic) {
		t.Error("generated mnemonic should be valid")
	}

	if bridge.Crypto.ValidateMnemonic("invalid mnemonic") {
		t.Error("invalid mnemonic should fail validation")
	}
}

func TestCryptoSign(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	key, err := bridge.Crypto.DeriveKey(created.Mnemonic, 0, 0, "payment")
	if err != nil {
		t.Fatalf("Crypto.DeriveKey() failed: %v", err)
	}

	// Round-trip regression pin: the whole extended key must sign AND verify against
	// the key's own public key; half of it (a clamped scalar, not a seed) must not.
	messageHex := "68656c6c6f"
	sig, err := bridge.Crypto.Sign(messageHex, key.PrivateKey)
	if err != nil {
		t.Fatalf("Crypto.Sign() failed: %v", err)
	}
	if len(sig) != 128 {
		t.Errorf("expected 128 hex chars signature, got %d", len(sig))
	}
	if !bridge.Crypto.Verify(sig, messageHex, key.PublicKey) {
		t.Error("extended-key signature must verify against the derived public key")
	}

	wrong, err := bridge.Crypto.Sign(messageHex, key.PrivateKey[:64])
	if err != nil {
		t.Fatalf("Crypto.Sign(seed form) failed: %v", err)
	}
	if bridge.Crypto.Verify(wrong, messageHex, key.PublicKey) {
		t.Error("half an extended key treated as a seed signs under a different keypair — must not verify")
	}
}

func TestTxHash(t *testing.T) {
	hash, err := bridge.Tx.Hash(sampleTxCbor)
	if err != nil {
		t.Fatalf("Tx.Hash() failed: %v", err)
	}
	if len(hash) != 64 {
		t.Errorf("expected 64 hex chars, got %d", len(hash))
	}
	if hash != "7af07f974db1d004305d29670d04faeef0e9670e8cf95e4b54a06f668eed8de4" {
		t.Errorf("unexpected tx hash: %s", hash)
	}
}

func TestTxToJson(t *testing.T) {
	jsonStr, err := bridge.Tx.ToJson(sampleTxCbor)
	if err != nil {
		t.Fatalf("Tx.ToJson() failed: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
		t.Fatalf("Tx.ToJson returned invalid JSON: %v", err)
	}
	if _, ok := parsed["body"]; !ok {
		t.Error("expected 'body' key in JSON")
	}
}

func TestTxDeserialize(t *testing.T) {
	jsonStr, err := bridge.Tx.Deserialize(sampleTxCbor)
	if err != nil {
		t.Fatalf("Tx.Deserialize() failed: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
		t.Fatalf("Tx.Deserialize returned invalid JSON: %v", err)
	}
	if _, ok := parsed["body"]; !ok {
		t.Error("expected 'body' key in deserialized JSON")
	}
}

func TestPlutusDataHash(t *testing.T) {
	hash, err := bridge.Plutus.DataHash("182a")
	if err != nil {
		t.Fatalf("Plutus.DataHash() failed: %v", err)
	}
	if len(hash) != 64 {
		t.Errorf("expected 64 hex chars, got %d", len(hash))
	}
	if hash != "9e1199a988ba72ffd6e9c269cadb3b53b5f360ff99f112d9b2ee30c4d74ad88b" {
		t.Errorf("unexpected datum hash: %s", hash)
	}
}

func TestScriptNativeFromJson(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	addrInfo, err := bridge.Address.Info(created.BaseAddress)
	if err != nil {
		t.Fatalf("Address.Info() failed: %v", err)
	}

	scriptJSON := fmt.Sprintf(`{"type":"sig","keyHash":"%s"}`, addrInfo.PaymentCredentialHash)
	result, err := bridge.Script.NativeFromJson(scriptJSON)
	if err != nil {
		t.Fatalf("Script.NativeFromJson() failed: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("Script.NativeFromJson returned invalid JSON: %v", err)
	}
	if _, ok := parsed["policy_id"]; !ok {
		t.Error("expected 'policy_id' key in result")
	}
	if _, ok := parsed["script_hash"]; !ok {
		t.Error("expected 'script_hash' key in result")
	}
	if _, ok := parsed["cbor_hex"]; !ok {
		t.Error("expected 'cbor_hex' key in result")
	}
}

func TestScriptHash(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	addrInfo, err := bridge.Address.Info(created.BaseAddress)
	if err != nil {
		t.Fatalf("Address.Info() failed: %v", err)
	}

	scriptJSON := fmt.Sprintf(`{"type":"sig","keyHash":"%s"}`, addrInfo.PaymentCredentialHash)
	result, err := bridge.Script.NativeFromJson(scriptJSON)
	if err != nil {
		t.Fatalf("Script.NativeFromJson() failed: %v", err)
	}

	var parsed map[string]interface{}
	json.Unmarshal([]byte(result), &parsed)
	cborHex := parsed["cbor_hex"].(string)

	hash, err := bridge.Script.Hash(cborHex, 0)
	if err != nil {
		t.Fatalf("Script.Hash() failed: %v", err)
	}
	if len(hash) != 56 {
		t.Errorf("expected 56 hex chars, got %d", len(hash))
	}
}

func TestGovDrepKey(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	key, err := bridge.Crypto.DeriveKey(created.Mnemonic, 0, 0, "drep")
	if err != nil {
		t.Fatalf("Crypto.DeriveKey(drep) failed: %v", err)
	}
	if len(key.PublicKey) == 0 {
		t.Error("verification key should not be empty")
	}
	if !strings.HasPrefix(created.DRepID, "drep1") {
		t.Errorf("expected drep1 prefix, got %s", created.DRepID)
	}
}

func TestGovCommitteeColdKey(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	key, err := bridge.Crypto.DeriveKey(created.Mnemonic, 0, 0, "committee_cold")
	if err != nil {
		t.Fatalf("Crypto.DeriveKey(committee_cold) failed: %v", err)
	}
	if len(key.PublicKey) == 0 {
		t.Error("verification key should not be empty")
	}
	if !strings.HasPrefix(created.CommitteeColdID, "cc_cold1") {
		t.Errorf("expected cc_cold1 prefix, got %s", created.CommitteeColdID)
	}
}

func TestGovCommitteeHotKey(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	key, err := bridge.Crypto.DeriveKey(created.Mnemonic, 0, 0, "committee_hot")
	if err != nil {
		t.Fatalf("Crypto.DeriveKey(committee_hot) failed: %v", err)
	}
	if len(key.PublicKey) == 0 {
		t.Error("verification key should not be empty")
	}
	if !strings.HasPrefix(created.CommitteeHotID, "cc_hot1") {
		t.Errorf("expected cc_hot1 prefix, got %s", created.CommitteeHotID)
	}
}

func TestWalletCreate(t *testing.T) {
	wallet := createTestAccount(t, Mainnet)

	words := strings.Fields(wallet.Mnemonic)
	if len(words) != 24 {
		t.Errorf("expected 24 word mnemonic, got %d", len(words))
	}
}

func TestWalletFromMnemonic(t *testing.T) {
	wallet := createTestAccount(t, Mainnet)

	restored, err := bridge.Accounts.FromMnemonic(wallet.Mnemonic, Mainnet, 0, 0)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic() failed: %v", err)
	}
	defer restored.Close()
	rinfo, err := restored.Info()
	if err != nil {
		t.Fatalf("Info() failed: %v", err)
	}

	if rinfo.StakeAddress != wallet.StakeAddress {
		t.Errorf("stake addresses don't match: %s != %s", rinfo.StakeAddress, wallet.StakeAddress)
	}
}

func TestWalletGetAddress(t *testing.T) {
	wallet := createTestAccount(t, Mainnet)

	// Address enumeration is one managed handle per CIP-1852 payment leaf.
	addrAt := func(index int) string {
		acct, err := bridge.Accounts.FromMnemonic(wallet.Mnemonic, Mainnet, 0, index)
		if err != nil {
			t.Fatalf("Accounts.FromMnemonic(index %d) failed: %v", index, err)
		}
		defer acct.Close()
		info, err := acct.Info()
		if err != nil {
			t.Fatalf("Info() failed: %v", err)
		}
		return info.BaseAddress
	}

	addr0 := addrAt(0)
	if !strings.HasPrefix(addr0, "addr1") {
		t.Errorf("expected addr1 prefix, got %s", addr0)
	}

	if addr1 := addrAt(1); addr0 == addr1 {
		t.Error("addresses at different indices should differ")
	}
}

// --- QuickTx Tests ---

var fakeTxHash = strings.Repeat("a", 64)

func testProtocolParams() map[string]interface{} {
	return map[string]interface{}{
		"min_fee_a":                        44,
		"min_fee_b":                        155381,
		"max_block_size":                   65536,
		"max_tx_size":                      16384,
		"max_block_header_size":            1100,
		"key_deposit":                      "2000000",
		"pool_deposit":                     "500000000",
		"e_max":                            18,
		"n_opt":                            500,
		"a0":                               0.3,
		"rho":                              0.003,
		"tau":                              0.2,
		"min_utxo":                         "34482",
		"min_pool_cost":                    "340000000",
		"price_mem":                        0.0577,
		"price_step":                       0.0000721,
		"max_tx_ex_mem":                    "10000000",
		"max_tx_ex_steps":                  "10000000000",
		"max_block_ex_mem":                 "50000000",
		"max_block_ex_steps":               "40000000000",
		"max_val_size":                     "5000",
		"collateral_percent":               150,
		"max_collateral_inputs":            3,
		"coins_per_utxo_size":              "4310",
		"coins_per_utxo_word":              "34482",
		"pvt_motion_no_confidence":         0.51,
		"pvt_committee_normal":             0.51,
		"pvt_committee_no_confidence":      0.51,
		"pvt_hard_fork_initiation":         0.51,
		"dvt_motion_no_confidence":         0.51,
		"dvt_committee_normal":             0.51,
		"dvt_committee_no_confidence":      0.51,
		"dvt_update_to_constitution":       0.51,
		"dvt_hard_fork_initiation":         0.51,
		"dvt_ppnetwork_group":              0.51,
		"dvt_ppeconomic_group":             0.51,
		"dvt_pptechnical_group":            0.51,
		"dvt_ppgov_group":                  0.51,
		"dvt_treasury_withdrawal":          0.51,
		"committee_min_size":               0,
		"committee_max_term_length":        200,
		"gov_action_lifetime":              10,
		"gov_action_deposit":               1000000000,
		"drep_deposit":                     2000000,
		"drep_activity":                    20,
		"min_fee_ref_script_cost_per_byte": 44,
	}
}

func makeUtxos(address string, lovelace int64) []map[string]interface{} {
	return []map[string]interface{}{
		{
			"tx_hash":      fakeTxHash,
			"output_index": 0,
			"address":      address,
			"amount": []map[string]interface{}{
				{"unit": "lovelace", "quantity": fmt.Sprintf("%d", lovelace)},
			},
		},
	}
}

func assertTxResult(t *testing.T, result *TxResult) {
	t.Helper()
	if len(result.TxCbor) == 0 {
		t.Error("tx_cbor should not be empty")
	}
	if len(result.TxHash) != 64 {
		t.Errorf("expected 64 char tx_hash, got %d", len(result.TxHash))
	}
	fee := 0
	fmt.Sscanf(result.Fee, "%d", &fee)
	if fee <= 0 {
		t.Errorf("expected positive fee, got %s", result.Fee)
	}
}

// quickTxYaml is a single-payment TxPlan YAML document.
func quickTxYaml(from, to, quantity string) string {
	return fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: payment
          address: %s
          amounts:
            - unit: lovelace
              quantity: "%s"
`, from, to, quantity)
}

func TestQuickTxSimplePayment(t *testing.T) {
	sender := createTestAccount(t, Testnet)
	receiver := createTestAccount(t, Testnet)

	yaml := quickTxYaml(sender.BaseAddress, receiver.BaseAddress, "5000000")
	result, err := bridge.QuickTx.Build(yaml, makeUtxos(sender.BaseAddress, 100_000_000), testProtocolParams(), 0)
	if err != nil {
		t.Fatalf("Build() failed: %v", err)
	}
	assertTxResult(t, result)
}

func TestQuickTxMultiplePayments(t *testing.T) {
	sender := createTestAccount(t, Testnet)
	r1 := createTestAccount(t, Testnet)
	r2 := createTestAccount(t, Testnet)

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
        - type: payment
          address: %s
          amounts:
            - unit: lovelace
              quantity: "3000000"
`, sender.BaseAddress, r1.BaseAddress, r2.BaseAddress)

	result, err := bridge.QuickTx.Build(yaml, makeUtxos(sender.BaseAddress, 100_000_000), testProtocolParams(), 0)
	if err != nil {
		t.Fatalf("Build() failed: %v", err)
	}
	assertTxResult(t, result)
}

func TestQuickTxVariableSubstitution(t *testing.T) {
	sender := createTestAccount(t, Testnet)
	receiver := createTestAccount(t, Testnet)

	yaml := fmt.Sprintf(`
version: 1.0
variables:
  to: %s
  amount: "4000000"
transaction:
  - tx:
      from: %s
      intents:
        - type: payment
          address: ${to}
          amounts:
            - unit: lovelace
              quantity: ${amount}
`, receiver.BaseAddress, sender.BaseAddress)

	result, err := bridge.QuickTx.Build(yaml, makeUtxos(sender.BaseAddress, 100_000_000), testProtocolParams(), 0)
	if err != nil {
		t.Fatalf("Build() failed: %v", err)
	}
	assertTxResult(t, result)
}

func TestQuickTxInsufficientFunds(t *testing.T) {
	sender := createTestAccount(t, Testnet)
	receiver := createTestAccount(t, Testnet)

	yaml := quickTxYaml(sender.BaseAddress, receiver.BaseAddress, "200000000")
	_, err := bridge.QuickTx.Build(yaml, makeUtxos(sender.BaseAddress, 1_000_000), testProtocolParams(), 0)
	if err == nil {
		t.Fatal("expected insufficient funds error")
	}
}

// testAccount mirrors what the tests need from a freshly created account: its public
// addresses plus the one-shot recovery phrase, all obtained through the managed API.
type testAccount struct {
	Mnemonic          string
	BaseAddress       string
	EnterpriseAddress string
	StakeAddress      string
	DRepID            string
	CommitteeColdID   string
	CommitteeHotID    string
}

func createTestAccount(t *testing.T, network Network) testAccount {
	t.Helper()
	acct, err := bridge.Accounts.Create(network)
	if err != nil {
		t.Fatalf("Accounts.Create() failed: %v", err)
	}
	defer acct.Close()
	info, err := acct.Info()
	if err != nil {
		t.Fatalf("Info() failed: %v", err)
	}
	phrase, err := acct.ExportRecoveryPhrase()
	if err != nil {
		t.Fatalf("ExportRecoveryPhrase() failed: %v", err)
	}
	return testAccount{Mnemonic: phrase, BaseAddress: info.BaseAddress,
		EnterpriseAddress: info.EnterpriseAddress, StakeAddress: info.StakeAddress,
		DRepID: info.DRepID, CommitteeColdID: info.CommitteeColdID, CommitteeHotID: info.CommitteeHotID}
}

func TestDeriveKeyCip105Bech32Encodings(t *testing.T) {
	// Governance registration (cardano-cli / GovTool) takes verification keys in CIP-105
	// bech32 form; the deleted gov API returned them and derive_key must too.
	mnemonic, err := bridge.Crypto.GenerateMnemonic(24)
	if err != nil {
		t.Fatalf("GenerateMnemonic: %v", err)
	}
	for role, prefix := range map[string]string{
		"drep": "drep", "committee_cold": "cc_cold", "committee_hot": "cc_hot",
	} {
		key, err := bridge.Crypto.DeriveKey(mnemonic, 0, 0, role)
		if err != nil {
			t.Fatalf("DeriveKey(%s): %v", role, err)
		}
		if !strings.HasPrefix(key.Bech32VerificationKey, prefix+"_vk1") {
			t.Errorf("%s: expected %s_vk1 prefix, got %q", role, prefix, key.Bech32VerificationKey)
		}
		if !strings.HasPrefix(key.Bech32VerificationKeyHash, prefix+"_vkh1") {
			t.Errorf("%s: expected %s_vkh1 prefix, got %q", role, prefix, key.Bech32VerificationKeyHash)
		}
	}
	payment, err := bridge.Crypto.DeriveKey(mnemonic, 0, 0, "payment")
	if err != nil {
		t.Fatalf("DeriveKey(payment): %v", err)
	}
	if payment.Bech32VerificationKey != "" {
		t.Error("non-governance roles carry no CIP-105 encodings by design")
	}
}
