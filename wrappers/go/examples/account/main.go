// Account creation and key derivation (offline).
//
// Run from wrappers/go:
//
//	LIB_DIR=../../core/build/native/nativeCompile
//	DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR go run ./examples/account
package main

import (
	"fmt"
	"log"

	"github.com/bloxbean/cardano-client-bindings/wrappers/go/ccl"
)

func main() {
	bridge, err := ccl.New()
	if err != nil {
		log.Fatal(err)
	}
	defer bridge.Close()

	// 1. Create a brand-new testnet account (managed handle; the recovery phrase is
	//    exported once, deliberately — it is never part of the account's Info).
	account, err := bridge.Accounts.Create(ccl.Testnet)
	if err != nil {
		log.Fatal(err)
	}
	defer account.Close()
	info, _ := account.Info()
	mnemonic, _ := account.ExportRecoveryPhrase()
	fmt.Println("Created account")
	fmt.Println("  base address:", info.BaseAddress)
	fmt.Println("  DRep ID     :", info.DRepID)
	fmt.Println("  mnemonic    :", mnemonic)

	// 2. Restore the same account from its phrase — the address must match.
	restored, err := bridge.Accounts.FromMnemonic(mnemonic, ccl.Testnet, 0, 0)
	if err != nil {
		log.Fatal(err)
	}
	defer restored.Close()
	rinfo, _ := restored.Info()
	if rinfo.BaseAddress != info.BaseAddress {
		log.Fatal("restored address does not match")
	}
	fmt.Println("Restored from mnemonic — address matches:", rinfo.BaseAddress)

	// 3. Raw key material, when interop genuinely needs it, comes from the stateless
	//    derivation utility — handles never expose key bytes.
	key, _ := bridge.Crypto.DeriveKey(mnemonic, 0, 0, "payment")
	fmt.Println("  private key (extended, hex):", key.PrivateKey)
	fmt.Println("  public key (hex)           :", key.PublicKey)
}
