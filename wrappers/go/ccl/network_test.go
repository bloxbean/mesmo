package ccl

import (
	"errors"
	"strings"
	"testing"
)

// Network is CCL's enum ordinal, which is NOT Cardano's on-chain network id — and for the first
// two values the two are inverted: Mainnet is ordinal 0 but produces addresses whose on-chain
// network id is 1, and Testnet is ordinal 1 but produces on-chain network id 0.
//
// This test pins that relationship deliberately. It looks like a bug and it is not one; without a
// test asserting it, someone will eventually "fix" the constants (or AddressInfo.NetworkID) and
// silently hand every Mainnet caller a testnet key. If this test fails, the bug is in the change
// that broke it, not here.
func TestNetworkOrdinalIsInverseOfOnChainNetworkID(t *testing.T) {
	cases := []struct {
		network         Network
		wantOnChainID   int
		wantAddrPrefix  string
		wantOrdinalIsNo int
	}{
		{network: Mainnet, wantOnChainID: 1, wantAddrPrefix: "addr1", wantOrdinalIsNo: 0},
		{network: Testnet, wantOnChainID: 0, wantAddrPrefix: "addr_test1", wantOrdinalIsNo: 1},
	}

	for _, tc := range cases {
		t.Run(tc.network.String(), func(t *testing.T) {
			if int(tc.network) != tc.wantOrdinalIsNo {
				t.Fatalf("%s: CCL enum ordinal changed: got %d, want %d (do not renumber these)",
					tc.network, int(tc.network), tc.wantOrdinalIsNo)
			}

			acct := createTestAccount(t, tc.network)
			if !strings.HasPrefix(acct.BaseAddress, tc.wantAddrPrefix) {
				t.Errorf("Accounts.Create(%s): expected %q address prefix, got %s",
					tc.network, tc.wantAddrPrefix, acct.BaseAddress)
			}

			info, err := bridge.Address.Info(acct.BaseAddress)
			if err != nil {
				t.Fatalf("Address.Info failed: %v", err)
			}
			if info.NetworkID != tc.wantOnChainID {
				t.Errorf("account created with %s (ordinal %d): expected on-chain AddressInfo.NetworkID %d, got %d",
					tc.network, int(tc.network), tc.wantOnChainID, info.NetworkID)
			}
		})
	}
}

func TestNetworkString(t *testing.T) {
	cases := []struct {
		network Network
		want    string
	}{
		{Mainnet, "mainnet"},
		{Testnet, "testnet"},
		{Network(42), "Network(42)"},
		{Network(-1), "Network(-1)"},
	}
	for _, tc := range cases {
		if got := tc.network.String(); got != tc.want {
			t.Errorf("Network(%d).String() = %q, want %q", int(tc.network), got, tc.want)
		}
	}
}

func TestNetworkValid(t *testing.T) {
	for _, n := range []Network{Mainnet, Testnet} {
		if !n.Valid() {
			t.Errorf("%s should be Valid()", n)
		}
	}
	for _, n := range []Network{Network(-1), Network(2), Network(3), Network(99)} {
		if n.Valid() {
			t.Errorf("Network(%d) should not be Valid()", int(n))
		}
	}
}

// An out-of-range Network must fail at the Go call boundary with a readable error, rather than
// reaching the native library and surfacing as an opaque enum failure.
func TestInvalidNetworkReturnsGoError(t *testing.T) {
	const bogus = Network(99)

	assertInvalid := func(op string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s: expected an error for %s, got nil", op, bogus)
		}
		if !strings.Contains(err.Error(), "invalid network") {
			t.Errorf("%s: expected an 'invalid network' error, got %v", op, err)
		}
		var ce *CclError
		if errors.As(err, &ce) {
			t.Errorf("%s: expected a Go-side error, got a native *CclError: %v", op, err)
		}
	}

	_, err := bridge.Accounts.Create(bogus)
	assertInvalid("Accounts.Create", err)

	mnemonic, err := bridge.Crypto.GenerateMnemonic(24)
	if err != nil {
		t.Fatalf("GenerateMnemonic failed: %v", err)
	}

	_, err = bridge.Accounts.FromMnemonic(mnemonic, bogus, 0, 0)
	assertInvalid("Accounts.FromMnemonic", err)
}
