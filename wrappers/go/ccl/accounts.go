package ccl

// Managed accounts (ADR-0016): open once, hold an *Account, sign with typed roles. The mnemonic
// crosses the FFI boundary once at open (or never, for created accounts, until the one-shot
// recovery-phrase export) instead of travelling with every operation.
//
// Every Account call runs on its Bridge's dedicated isolate thread via the same executor as all
// other FFI (ADR-0010) — an Account adds no concurrency of its own, and a closed Bridge yields the
// Bridge's normal closed error rather than a deadlock or a dangling-isolate call.

import (
	"encoding/json"
	"fmt"
	"runtime"
)

// SigningRole is a typed signing-role bit mask. Combine with |; witnesses are applied in canonical
// order (payment, stake, DRep, committee cold, committee hot) regardless of combination order.
type SigningRole int32

const (
	RolePayment       SigningRole = 1
	RoleStake         SigningRole = 1 << 1
	RoleDRep          SigningRole = 1 << 2
	RoleCommitteeCold SigningRole = 1 << 3
	RoleCommitteeHot  SigningRole = 1 << 4
)

// AccountsApi is the managed-accounts namespace (bridge.Accounts).
type AccountsApi struct {
	bridge *Bridge
}

// AccountPublicInfo is a managed account's public data — never contains the mnemonic or any private key.
type AccountPublicInfo struct {
	BaseAddress       string `json:"base_address"`
	EnterpriseAddress string `json:"enterprise_address"`
	StakeAddress      string `json:"stake_address"`
	// The CIP-1852 role-1 (internal/change) leaf at this account's address index.
	ChangeAddress string `json:"change_address"`
	Network       int    `json:"network"`
	AccountIndex  int    `json:"account_index"`
	AddressIndex  int    `json:"address_index"`
	DRepID        string `json:"drep_id"`
	// Committee identifiers: bech32 id and hex credential (blake2b-224 verification-key hash,
	// as used in committee certificates). Public data like everything else here.
	CommitteeColdID         string `json:"committee_cold_id"`
	CommitteeColdCredential string `json:"committee_cold_credential"`
	CommitteeHotID          string `json:"committee_hot_id"`
	CommitteeHotCredential  string `json:"committee_hot_credential"`
}

// Account is a managed account bound to one CIP-1852 payment leaf
// (m/1852'/1815'/account'/0/addressIndex).
//
// One handle is one payment address; open further Accounts for further address indices. The
// stake/DRep/committee keys sit at their standard role indices independent of addressIndex, so
// Accounts at different address indices of one account index share a single stake/DRep identity.
//
// Close is explicit and idempotent; any use after Close fails with ErrInvalidHandle (-11).
// Close Accounts like files — but like os.File, a dropped Account is reclaimed best-effort by a
// GC finalizer (ADR-0016 "wrapper finalizers are fallback protection"): a leaked registry entry
// would pin key material Java-side until process exit. The finalizer is fallback only;
// reclamation timing is the GC's.
type Account struct {
	bridge *Bridge
	handle int64 // 0 after Close — never a valid handle
}

// FromMnemonic opens an account from a mnemonic at fixed derivation indices. The mnemonic crosses
// the boundary once, here; no later operation needs it.
func (a *AccountsApi) FromMnemonic(mnemonic string, network Network, accountIndex, addressIndex int) (*Account, error) {
	if err := network.validate(); err != nil {
		return nil, err
	}
	var handle int64
	_, err := a.bridge.invoke(func() int32 {
		return cclAccountOpenMnemonic(a.bridge.thread, int32(network), mnemonic,
			int32(accountIndex), int32(addressIndex), &handle)
	})
	if err != nil {
		return nil, err
	}
	return newAccount(a.bridge, handle), nil
}

// Create creates a brand-new account (fresh 24-word mnemonic). No secret is returned here —
// retrieve the recovery phrase once, deliberately, with ExportRecoveryPhrase.
func (a *AccountsApi) Create(network Network) (*Account, error) {
	if err := network.validate(); err != nil {
		return nil, err
	}
	var handle int64
	_, err := a.bridge.invoke(func() int32 {
		return cclAccountCreateHandle(a.bridge.thread, int32(network), &handle)
	})
	if err != nil {
		return nil, err
	}
	return newAccount(a.bridge, handle), nil
}

// newAccount wires the best-effort GC fallback: a dropped Account (no Close) is closed when
// the collector reaps it. The finalizer runs on a GC goroutine, so it hops onto the bridge's
// serialized executor via run() — and reads no result (ccl_account_close produces none; the
// result slot belongs to whichever call is in flight). A closed bridge makes run() return an
// error, which is deliberately ignored: the isolate died and took the registry with it.
func newAccount(bridge *Bridge, handle int64) *Account {
	acct := &Account{bridge: bridge, handle: handle}
	runtime.SetFinalizer(acct, func(a *Account) {
		if h := a.handle; h != 0 {
			_ = a.bridge.run(func() { cclAccountCloseHandle(a.bridge.thread, h) })
		}
	})
	return acct
}

// Info returns the account's public data. Never contains secrets.
func (a *Account) Info() (*AccountPublicInfo, error) {
	result, err := a.bridge.invoke(func() int32 {
		return cclAccountGetInfo(a.bridge.thread, a.handle)
	})
	if err != nil {
		return nil, err
	}
	var info AccountPublicInfo
	if err := json.Unmarshal([]byte(result), &info); err != nil {
		return nil, fmt.Errorf("failed to parse account info: %w", err)
	}
	return &info, nil
}

// SignTx signs a transaction with the selected roles and returns the signed CBOR hex.
//
// roles is a SigningRole combination, e.g. RolePayment|RoleStake for a stake-certificate
// transaction. An empty mask is rejected — signing never silently uses every key.
func (a *Account) SignTx(txCborHex string, roles SigningRole) (string, error) {
	return a.bridge.invoke(func() int32 {
		return cclAccountSignTxHandle(a.bridge.thread, a.handle, txCborHex, int32(roles))
	})
}

// ExportRecoveryPhrase is the one-shot export of a freshly created account's recovery phrase.
//
// Only available on Accounts from Create, and only once — the phrase is removed on retrieval.
// Accounts opened from a mnemonic fail (the caller already holds the phrase). Persist the returned
// value securely; nothing else ever returns it.
func (a *Account) ExportRecoveryPhrase() (string, error) {
	// Delivered via out-param in the SAME call — never through the read-once result slot.
	// The native side destroys its pending copy only after the string is materialized, so a
	// failed delivery is retryable instead of orphaning the only copy of the phrase.
	var phrase string
	var callErr error
	if rerr := a.bridge.run(func() {
		var out *byte
		if rc := cclAccountExportRecoveryPhrase(a.bridge.thread, a.handle, &out); rc != Success {
			callErr = &CclError{Code: int(rc), Message: a.bridge.getError()}
			return
		}
		phrase = goString(out)
		cclFreeString(a.bridge.thread, out)
	}); rerr != nil {
		return "", rerr
	}
	return phrase, callErr
}

// Close releases the native account state. Idempotent; further use fails with ErrInvalidHandle.
func (a *Account) Close() error {
	runtime.SetFinalizer(a, nil) // closed deterministically; nothing left to finalize
	handle := a.handle
	a.handle = 0 // 0 is never a valid handle
	if handle == 0 {
		return nil
	}
	_, err := a.bridge.invoke(func() int32 {
		return cclAccountCloseHandle(a.bridge.thread, handle)
	})
	return err
}

// String never contains secret material — just the handle.
func (a *Account) String() string {
	if a.handle == 0 {
		return "<ccl.Account closed>"
	}
	return fmt.Sprintf("<ccl.Account handle=%d>", a.handle)
}
