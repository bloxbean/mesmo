package ccl

import (
	"errors"
	"strings"
	"testing"
)

// assertCclError fails unless err is a non-nil *CclError. Used by the offline negative/error tests
// ported from the Python wrapper (which assert a CclError is raised).
func assertCclError(t *testing.T, op string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: expected an error, got nil", op)
	}
	var ce *CclError
	if !errors.As(err, &ce) {
		t.Fatalf("%s: expected *CclError, got %T: %v", op, err, err)
	}
}

// A testnet account's base address is bech32 with the addr_test1 prefix (network id 0 on the wire).
func TestAccountCreateTestnet(t *testing.T) {
	info := createTestAccount(t, Testnet)
	if !strings.HasPrefix(info.BaseAddress, "addr_test1") {
		t.Errorf("expected addr_test1 prefix, got %s", info.BaseAddress)
	}
}

// Restoring from a mnemonic must reproduce every derived address, not just the base one.
func TestAccountFromMnemonicRestoresAllAddresses(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	acct, err := bridge.Accounts.FromMnemonic(created.Mnemonic, Mainnet, 0, 0)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic() failed: %v", err)
	}
	defer acct.Close()
	restored, err := acct.Info()
	if err != nil {
		t.Fatalf("Info() failed: %v", err)
	}

	if restored.BaseAddress != created.BaseAddress {
		t.Errorf("base address mismatch: %s != %s", restored.BaseAddress, created.BaseAddress)
	}
	if restored.EnterpriseAddress != created.EnterpriseAddress {
		t.Errorf("enterprise address mismatch: %s != %s", restored.EnterpriseAddress, created.EnterpriseAddress)
	}
	if restored.StakeAddress != created.StakeAddress {
		t.Errorf("stake address mismatch: %s != %s", restored.StakeAddress, created.StakeAddress)
	}
}

// Different address indices derive different base addresses from the same mnemonic.
func TestAccountFromMnemonicDifferentIndices(t *testing.T) {
	created := createTestAccount(t, Mainnet)

	infoAt := func(index int) *AccountPublicInfo {
		acct, err := bridge.Accounts.FromMnemonic(created.Mnemonic, Mainnet, 0, index)
		if err != nil {
			t.Fatalf("FromMnemonic(0,%d) failed: %v", index, err)
		}
		defer acct.Close()
		info, err := acct.Info()
		if err != nil {
			t.Fatalf("Info() failed: %v", err)
		}
		return info
	}
	if infoAt(0).BaseAddress == infoAt(1).BaseAddress {
		t.Error("addresses at different indices should differ")
	}
}

// --- Negative / Error Tests ---

func TestAccountFromInvalidMnemonic(t *testing.T) {
	_, err := bridge.Accounts.FromMnemonic("invalid words that are not a valid mnemonic phrase at all", Mainnet, 0, 0)
	assertCclError(t, "FromMnemonic(invalid)", err)
}

func TestAccountFromEmptyMnemonic(t *testing.T) {
	_, err := bridge.Accounts.FromMnemonic("", Mainnet, 0, 0)
	assertCclError(t, "FromMnemonic(empty)", err)
}

func TestAccountSignTxInvalidCbor(t *testing.T) {
	created := createTestAccount(t, Testnet)
	acct, err := bridge.Accounts.FromMnemonic(created.Mnemonic, Testnet, 0, 0)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic() failed: %v", err)
	}
	defer acct.Close()
	_, err = acct.SignTx("deadbeef", RolePayment)
	assertCclError(t, "SignTx(invalid cbor)", err)
}
