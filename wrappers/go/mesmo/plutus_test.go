package mesmo

import "testing"

// --- Negative / Error Tests ---

func TestPlutusDataHashInvalidCbor(t *testing.T) {
	_, err := lib.Plutus.DataHash("zzzz")
	assertMesmoError(t, "Plutus.DataHash(invalid cbor)", err)
}

func TestPlutusDataHashEmpty(t *testing.T) {
	_, err := lib.Plutus.DataHash("")
	assertMesmoError(t, "Plutus.DataHash(empty)", err)
}
