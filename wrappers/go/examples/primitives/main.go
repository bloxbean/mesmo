// Crypto and address primitives (offline).
//
// Run from wrappers/go:
//
//	LIB_DIR=../../core/build/native/nativeCompile
//	DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR go run ./examples/primitives
package main

import (
	"fmt"
	"log"

	"github.com/bloxbean/mesmo/wrappers/go/mesmo"
)

func main() {
	lib, err := mesmo.New()
	if err != nil {
		log.Fatal(err)
	}
	defer lib.Close()

	// --- Mnemonics ---
	mnemonic, _ := lib.Crypto.GenerateMnemonic(24)
	fmt.Println("Generated 24-word mnemonic:", mnemonic)
	fmt.Println("  valid?", lib.Crypto.ValidateMnemonic(mnemonic))
	fmt.Println("  'not a real mnemonic' valid?", lib.Crypto.ValidateMnemonic("not a real mnemonic"))

	// --- Blake2b hashing (hex in -> hex out). "Hello" == 48656c6c6f ---
	h256, _ := lib.Crypto.Blake2b256("48656c6c6f")
	h224, _ := lib.Crypto.Blake2b224("48656c6c6f")
	fmt.Println("Blake2b-256('Hello'):", h256)
	fmt.Println("Blake2b-224('Hello'):", h224)

	// --- Ed25519 signing ---
	// DeriveKey returns the 64-byte extended BIP32-Ed25519 key; pass it whole to
	// Sign — the extended form is detected by length. (Never slice it: its first
	// half is a clamped scalar, not a seed.)
	key, _ := lib.Crypto.DeriveKey(mnemonic, 0, 0, "payment")
	privExt, pub := key.PrivateKey, key.PublicKey
	messageHex := "68656c6c6f" // "hello"
	sig, _ := lib.Crypto.Sign(messageHex, privExt)
	fmt.Println("Ed25519 signature:", sig)
	// A tampered signature is correctly rejected.
	fmt.Println("  verify(fake signature) ->", lib.Crypto.Verify("00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", messageHex, pub))

	// --- Address parsing & validation ---
	acct, _ := lib.Accounts.FromMnemonic(mnemonic, mesmo.Testnet, 0, 0)
	defer acct.Close()
	acctInfo, _ := acct.Info()
	addr := acctInfo.BaseAddress
	fmt.Println("Address valid?", lib.Address.Validate(addr))
	info, _ := lib.Address.Info(addr)
	fmt.Printf("Address info  : %+v\n", info)
	raw, _ := lib.Address.ToBytes(addr)
	back, _ := lib.Address.FromBytes(raw)
	fmt.Println("Address -> bytes -> address round-trips:", back == addr)
}
