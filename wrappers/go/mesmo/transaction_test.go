package mesmo

import "testing"

// --- Negative / Error Tests ---

// Well-formed hex, but not a valid transaction CBOR.
func TestTxHashMalformedCbor(t *testing.T) {
	_, err := bridge.Tx.Hash("deadbeef")
	assertMesmoError(t, "Tx.Hash(malformed cbor)", err)
}

// Not even valid hex.
func TestTxHashInvalidHex(t *testing.T) {
	_, err := bridge.Tx.Hash("not_hex!")
	assertMesmoError(t, "Tx.Hash(invalid hex)", err)
}

func TestTxDeserializeMalformed(t *testing.T) {
	_, err := bridge.Tx.Deserialize("deadbeef")
	assertMesmoError(t, "Tx.Deserialize(malformed)", err)
}
