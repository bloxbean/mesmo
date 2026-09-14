package ccl

import (
	"crypto/ed25519"
	"encoding/hex"
	"strings"
	"testing"
)

func TestCryptoGenerate12WordMnemonic(t *testing.T) {
	mnemonic, err := bridge.Crypto.GenerateMnemonic(12)
	if err != nil {
		t.Fatalf("Crypto.GenerateMnemonic(12) failed: %v", err)
	}
	if words := strings.Fields(mnemonic); len(words) != 12 {
		t.Errorf("expected 12 words, got %d", len(words))
	}
	if !bridge.Crypto.ValidateMnemonic(mnemonic) {
		t.Error("generated 12-word mnemonic should validate")
	}
}

// A real Ed25519 vector: the bridge signs a 32-byte seed key and the result must match Go's stdlib
// (Ed25519 is deterministic per RFC 8032), and the signature must verify against the matching public
// key. This makes the sign/verify assertions concrete rather than length-only.
func TestCryptoSignVerifyVector(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)

	msg := []byte("hello")
	seedHex := hex.EncodeToString(seed)
	msgHex := hex.EncodeToString(msg)
	pubHex := hex.EncodeToString(pub)
	wantSig := hex.EncodeToString(ed25519.Sign(priv, msg))

	gotSig, err := bridge.Crypto.Sign(msgHex, seedHex)
	if err != nil {
		t.Fatalf("Crypto.Sign() failed: %v", err)
	}
	if gotSig != wantSig {
		t.Errorf("signature mismatch:\n got %s\nwant %s", gotSig, wantSig)
	}
	if !bridge.Crypto.Verify(gotSig, msgHex, pubHex) {
		t.Error("valid signature should verify against its public key")
	}
	// Wrong message must not verify.
	if bridge.Crypto.Verify(gotSig, hex.EncodeToString([]byte("goodbye")), pubHex) {
		t.Error("signature must not verify against a different message")
	}
}

// A fabricated signature must be rejected (mirrors Python test_crypto_verify_rejects_wrong_signature).
func TestCryptoVerifyRejectsWrongSignature(t *testing.T) {
	mnemonic, err := bridge.Crypto.GenerateMnemonic(24)
	if err != nil {
		t.Fatalf("GenerateMnemonic() failed: %v", err)
	}
	key, err := bridge.Crypto.DeriveKey(mnemonic, 0, 0, "payment")
	if err != nil {
		t.Fatalf("Crypto.DeriveKey() failed: %v", err)
	}
	pubKey := key.PublicKey
	fakeSig := strings.Repeat("00", 64)
	if bridge.Crypto.Verify(fakeSig, "68656c6c6f", pubKey) {
		t.Error("a fake all-zero signature must not verify")
	}
}

// --- Negative / Error Tests ---

func TestCryptoBlake2b256InvalidHex(t *testing.T) {
	_, err := bridge.Crypto.Blake2b256("not_valid_hex!")
	assertCclError(t, "Blake2b256(invalid hex)", err)
}

func TestCryptoSignInvalidKey(t *testing.T) {
	_, err := bridge.Crypto.Sign("68656c6c6f", strings.Repeat("zz", 32))
	assertCclError(t, "Sign(invalid key)", err)
}
