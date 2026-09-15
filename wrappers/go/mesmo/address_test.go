package mesmo

import "testing"

// --- Negative / Error Tests ---

func TestAddressInfoInvalid(t *testing.T) {
	_, err := bridge.Address.Info("not_a_valid_address")
	assertMesmoError(t, "Address.Info(invalid)", err)
}

func TestAddressFromBytesInvalid(t *testing.T) {
	_, err := bridge.Address.FromBytes("zzzz")
	assertMesmoError(t, "Address.FromBytes(invalid hex)", err)
}
