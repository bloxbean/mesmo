package ccl

import (
	"strings"
	"testing"
)

// A testnet wallet's stake address carries the stake_test1 prefix.
func TestWalletCreateTestnet(t *testing.T) {
	wallet := createTestAccount(t, Testnet)
	if !strings.HasPrefix(wallet.StakeAddress, "stake_test1") {
		t.Errorf("expected stake_test1 prefix, got %s", wallet.StakeAddress)
	}
}
