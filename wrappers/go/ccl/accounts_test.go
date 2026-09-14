package ccl

// Managed-account object tests (ADR-0016 slice 6): lifecycle, typed-role signing parity with the
// mnemonic-per-call path, one-shot recovery-phrase export, secret hygiene, and executor-thread
// concurrency. Fully offline.

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func unsignedStakeReg(t *testing.T, info *AccountPublicInfo) string {
	t.Helper()
	yaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: stake_registration
          stake_address: %s
`, info.BaseAddress, info.StakeAddress)
	utxos := makeUtxos(info.BaseAddress, 2_000_000_000)
	result, err := bridge.QuickTx.Build(yaml, utxos, testProtocolParams(), 1)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	return result.TxCbor
}

func handleErrCode(t *testing.T, err error) int {
	t.Helper()
	var cclErr *CclError
	if !errors.As(err, &cclErr) {
		t.Fatalf("expected *CclError, got %T: %v", err, err)
	}
	return cclErr.Code
}

func TestManagedAccountInfoMatchesPinnedDerivation(t *testing.T) {
	acct, err := bridge.Accounts.FromMnemonic(intentMnemonic, Testnet, 0, 0)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer acct.Close()

	info, err := acct.Info()
	if err != nil {
		t.Fatalf("info: %v", err)
	}
	// Pinned CIP-1852 derivation for the standard CCL test mnemonic at testnet 0/0; the
	// mnemonic-path equivalence proof lives in the core's AccountKeyDerivationParityTest.
	const pinnedBase = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer" +
		"3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp"
	const pinnedStake = "stake_test1uqevw2xnsc0pvn9t9r9c7qryfqfeerchgrlm3ea2nefr9hqp8n5xl"
	const pinnedChange = "addr_test1qz4kjk0as0x7ptt54l6cnfyzejqg22cku0qhqx6al4g2xe" +
		"pjcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq5hxe5g"
	if info.ChangeAddress != pinnedChange {
		t.Fatalf("change_address diverges from pinned derivation: %s", info.ChangeAddress)
	}
	if info.BaseAddress != pinnedBase || info.StakeAddress != pinnedStake {
		t.Fatalf("managed info diverges from pinned derivation: %+v", info)
	}
	if info.Network != int(Testnet) || info.AccountIndex != 0 || info.AddressIndex != 0 {
		t.Fatalf("unexpected derivation metadata: %+v", info)
	}
}

func TestManagedAccountSignDeterminismAndRoles(t *testing.T) {
	acct, err := bridge.Accounts.FromMnemonic(intentMnemonic, Testnet, 0, 0)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer acct.Close()
	info, _ := acct.Info()
	unsigned := unsignedStakeReg(t, info)

	managed, err := acct.SignTx(unsigned, RolePayment)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	// Deterministic: signing twice yields byte-identical output.
	managedAgain, err := acct.SignTx(unsigned, RolePayment)
	if err != nil {
		t.Fatalf("sign again: %v", err)
	}
	if managed != managedAgain {
		t.Fatal("signing is not deterministic")
	}

	managed2, err := acct.SignTx(unsigned, RolePayment|RoleStake)
	if err != nil {
		t.Fatalf("sign 2: %v", err)
	}
	if len(managed2) <= len(managed) {
		t.Fatal("the stake role should add a second witness")
	}

	// Mask order is irrelevant — canonical application order fixes the output.
	reordered, _ := acct.SignTx(unsigned, RoleStake|RolePayment)
	if reordered != managed2 {
		t.Fatal("mask order changed the signed output")
	}
}

func TestManagedAccountEmptyMaskRejected(t *testing.T) {
	acct, _ := bridge.Accounts.FromMnemonic(intentMnemonic, Testnet, 0, 0)
	defer acct.Close()
	info, _ := acct.Info()
	if _, err := acct.SignTx(unsignedStakeReg(t, info), 0); err == nil {
		t.Fatal("empty role mask must be rejected")
	}
}

func TestManagedAccountLifecycle(t *testing.T) {
	acct, _ := bridge.Accounts.FromMnemonic(intentMnemonic, Testnet, 0, 0)
	if err := acct.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := acct.Close(); err != nil { // idempotent
		t.Fatalf("double close: %v", err)
	}
	_, err := acct.Info()
	if err == nil {
		t.Fatal("use after close must fail")
	}
	if code := handleErrCode(t, err); code != ErrInvalidHandle {
		t.Fatalf("expected ErrInvalidHandle (-11), got %d", code)
	}
}

func TestManagedAccountCreateExportOnceRestore(t *testing.T) {
	acct, err := bridge.Accounts.Create(Testnet)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer acct.Close()
	info, _ := acct.Info()

	phrase, err := acct.ExportRecoveryPhrase()
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if len(strings.Fields(phrase)) != 24 {
		t.Fatalf("expected 24 words, got %d", len(strings.Fields(phrase)))
	}

	restored, err := bridge.Accounts.FromMnemonic(phrase, Testnet, 0, 0)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	defer restored.Close()
	rInfo, _ := restored.Info()
	if rInfo.BaseAddress != info.BaseAddress {
		t.Fatal("exported phrase does not restore the same account")
	}

	if _, err := acct.ExportRecoveryPhrase(); err == nil {
		t.Fatal("export must be one-shot")
	}
	if _, err := restored.ExportRecoveryPhrase(); err == nil {
		t.Fatal("imported accounts must not export")
	}
}

func TestManagedAccountStringNeverContainsSecrets(t *testing.T) {
	acct, _ := bridge.Accounts.Create(Testnet)
	defer acct.Close()
	phrase, _ := acct.ExportRecoveryPhrase()
	s := acct.String()
	if strings.Contains(s, "addr") || strings.Contains(s, strings.Fields(phrase)[0]) {
		t.Fatalf("secret or address leaked through String(): %s", s)
	}
	acct.Close()
	if acct.String() != "<ccl.Account closed>" {
		t.Fatalf("unexpected closed representation: %s", acct.String())
	}
}

// Concurrent Account use from many goroutines must serialize safely onto the Bridge's dedicated
// isolate thread (ADR-0010) — correct results, no data race (run with -race in CI).
func TestManagedAccountConcurrentUseSerializes(t *testing.T) {
	acct, _ := bridge.Accounts.FromMnemonic(intentMnemonic, Testnet, 0, 0)
	defer acct.Close()
	want, _ := acct.Info()

	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			info, err := acct.Info()
			if err != nil {
				errs <- err
				return
			}
			if info.BaseAddress != want.BaseAddress {
				errs <- fmt.Errorf("diverging info under concurrency")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

// A dropped Account (no Close) must be reclaimed by the GC fallback: leaked registry entries
// pin key material Java-side until process exit. Deterministic Close remains the contract —
// this pins only that leaks are eventually narrowed, per ADR-0016's fallback-protection note.
func TestDroppedAccountIsReclaimedByGC(t *testing.T) {
	acct, err := bridge.Accounts.Create(Testnet)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	handle := acct.handle
	acct = nil // drop the only reference

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		_, err := bridge.invoke(func() int32 {
			return cclAccountGetInfo(bridge.thread, handle)
		})
		var ce *CclError
		if errors.As(err, &ce) && ce.Code == ErrInvalidHandle {
			return // the finalizer closed it
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("dropped Account was never reclaimed — no GC fallback closes leaked handles")
}
