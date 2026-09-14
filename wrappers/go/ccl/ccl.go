package ccl

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"

	goyaml "gopkg.in/yaml.v3"
)

// Network selects which Cardano network to derive addresses/keys for.
//
// These are CCL's enum ordinals, NOT Cardano's on-chain network id — the two differ, and they
// differ in the most confusing way possible: on-chain, 0 means testnet and 1 means mainnet, which
// is the inverse of Mainnet(0)/Testnet(1) below. Pass the constants, never a raw on-chain id: an
// account created with Mainnet has an AddressInfo.NetworkID of 1, and one created with Testnet has
// an AddressInfo.NetworkID of 0. That is correct and deliberate — AddressInfo.NetworkID is the
// genuine on-chain value read back off the address, while Network is CCL's selector for it.
type Network int

const (
	Mainnet Network = 0
	Testnet Network = 1
)

// String returns the network's name ("mainnet", "testnet"), so a Network reads as itself in logs
// and errors instead of as a bare, easily-misread ordinal. An unknown value prints as Network(n).
func (n Network) String() string {
	switch n {
	case Mainnet:
		return "mainnet"
	case Testnet:
		return "testnet"
	default:
		return fmt.Sprintf("Network(%d)", int(n))
	}
}

// Valid reports whether n is one of the two known networks.
func (n Network) Valid() bool {
	return n == Mainnet || n == Testnet
}

// validate turns an out-of-range Network into a clear Go error at the call boundary, rather than
// letting it reach the native library and come back as an opaque enum-ordinal failure.
func (n Network) validate() error {
	if !n.Valid() {
		return fmt.Errorf("ccl: invalid network %s: use Mainnet(0) or Testnet(1) "+
			"(these are CCL enum ordinals, not Cardano's on-chain network id)", n)
	}
	return nil
}

// Error codes
const (
	Success               = 0
	ErrGeneral            = -1
	ErrInvalidArgument    = -2
	ErrSerialization      = -3
	ErrCrypto             = -4
	ErrInvalidNetwork     = -5
	ErrInvalidMnemonic    = -6
	ErrInvalidAddress     = -7
	ErrInsufficientFunds  = -8
	ErrInvalidTransaction = -9
	// ErrTxBuild is a malformed TxPlan — the most common failure on the core build path.
	ErrTxBuild = -10
	// ErrInvalidHandle is an unknown, closed, or foreign account handle (ADR-0016).
	ErrInvalidHandle = -11
)

// CclError represents an error from the CCL native library.
type CclError struct {
	Code    int
	Message string
}

func (e *CclError) Error() string {
	return fmt.Sprintf("CCL Error %d: %s", e.Code, e.Message)
}

// AddressInfo contains address parsing result.
type AddressInfo struct {
	Type string `json:"type"`
	// NetworkID is Cardano's real on-chain network id, decoded from the address: 0 = testnet,
	// 1 = mainnet. It is NOT a Network (CCL's enum ordinal), and the two are inverted for the
	// first two values — an account created with Mainnet has NetworkID 1. Do not "fix" this.
	NetworkID                int    `json:"network_id"`
	PaymentCredentialHash    string `json:"payment_credential_hash,omitempty"`
	DelegationCredentialHash string `json:"delegation_credential_hash,omitempty"`
	IsPubkeyPayment          bool   `json:"is_pubkey_payment"`
	IsScriptPayment          bool   `json:"is_script_payment"`
}

// Bridge wraps the CCL native library.
//
// All FFI calls are funneled to a single, dedicated OS thread (see loop) for the
// lifetime of the Bridge. A GraalVM IsolateThread is bound to the OS thread that
// created it, but the Go runtime can migrate a goroutine across OS threads between
// (or within) FFI calls. Calling the isolate from a different OS thread than the one
// that created it makes GraalVM read the wrong thread's stack — which on Linux
// x86_64 crashes with a "yellow zone" StackOverflowError. Pinning every call to one
// locked OS thread keeps the isolate thread and the executing thread in sync.
type Bridge struct {
	isolate uintptr
	thread  uintptr

	mu    sync.Mutex
	calls chan func()

	// Accounts is the managed-accounts namespace (ADR-0016): handle-based accounts that keep the
	// mnemonic out of per-operation calls.
	Accounts *AccountsApi
	Address  *AddressApi
	Crypto   *CryptoApi
	Tx       *TxApi
	Plutus   *PlutusApi
	Script   *ScriptApi
	QuickTx  *QuickTxApi
}

// New creates a new Bridge instance with a GraalVM isolate. The native library is located and loaded
// on first use (see resolveLibPath) — via CCL_LIB_PATH, a per-version cache, or a one-time download.
func New() (*Bridge, error) {
	if err := ensureLoaded(); err != nil {
		return nil, err
	}

	b := &Bridge{calls: make(chan func())}

	ready := make(chan error, 1)
	go b.loop(ready)
	if err := <-ready; err != nil {
		return nil, err
	}

	if err := b.checkVersion(); err != nil {
		b.Close()
		return nil, err
	}

	b.Accounts = &AccountsApi{bridge: b}
	b.Address = &AddressApi{bridge: b}
	b.Crypto = &CryptoApi{bridge: b}
	b.Tx = &TxApi{bridge: b}
	b.Plutus = &PlutusApi{bridge: b}
	b.Script = &ScriptApi{bridge: b}
	b.QuickTx = &QuickTxApi{bridge: b}

	return b, nil
}

// loop owns the isolate's OS thread: it locks the thread, creates the isolate on it,
// then executes every queued FFI closure on that same thread until Close.
func (b *Bridge) loop(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if rc := graalCreateIsolate(0, &b.isolate, &b.thread); rc != 0 {
		ready <- fmt.Errorf("failed to create GraalVM isolate: %d", int(rc))
		return
	}
	ready <- nil

	for fn := range b.calls {
		fn()
	}
}

// ErrBridgeClosed is returned by any call made on a Bridge after Close. Test for it with errors.Is.
var ErrBridgeClosed = errors.New("ccl: bridge is closed")

// run executes fn on the isolate's dedicated OS thread and blocks until it finishes. It returns
// ErrBridgeClosed if the Bridge is closed.
//
// The closed check is not optional: Close sets b.calls to nil, and a send on a nil channel blocks
// forever — while this goroutine holds b.mu. A single stray call after Close would therefore hang
// that goroutine permanently *and* deadlock every other goroutine behind the mutex, with no error
// and no stack to point at the cause. Failing fast here turns the worst failure mode into an error
// value.
func (b *Bridge) run(fn func()) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.calls == nil {
		return ErrBridgeClosed
	}

	done := make(chan struct{})
	b.calls <- func() {
		fn()
		close(done)
	}
	<-done
	return nil
}

// invoke runs a result-returning FFI call on the isolate thread and reads the
// per-thread result/error there, where the Java thread-local state lives.
func (b *Bridge) invoke(call func() int32) (string, error) {
	var s string
	var err error
	if rerr := b.run(func() {
		if rc := call(); rc != Success {
			err = &CclError{Code: int(rc), Message: b.getError()}
		} else {
			s = b.getResult()
		}
	}); rerr != nil {
		return "", rerr
	}
	return s, err
}

// invokeRC runs an FFI call on the isolate thread and returns its raw status code,
// for calls (e.g. validate/verify) where the caller interprets the code directly.
// A closed Bridge yields ErrGeneral, so those calls report failure rather than deadlocking.
func (b *Bridge) invokeRC(call func() int32) int32 {
	var rc int32
	if err := b.run(func() { rc = call() }); err != nil {
		return ErrGeneral
	}
	return rc
}

// Close tears down the GraalVM isolate and stops its OS thread.
func (b *Bridge) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.calls == nil {
		return nil
	}
	done := make(chan struct{})
	b.calls <- func() {
		if b.thread != 0 {
			graalTearDownIsolate(b.thread)
			b.thread = 0
		}
		close(done)
	}
	<-done
	close(b.calls)
	b.calls = nil
	return nil
}

func (b *Bridge) getResult() string {
	ptr := cclGetResult(b.thread)
	if ptr == nil {
		return ""
	}
	result := goString(ptr)
	cclFreeString(b.thread, ptr)
	return result
}

func (b *Bridge) getError() string {
	ptr := cclGetLastError(b.thread)
	if ptr == nil {
		return ""
	}
	result := goString(ptr)
	cclFreeString(b.thread, ptr)
	return result
}

// Version returns the library version string.
func (b *Bridge) Version() (string, error) {
	return b.invoke(func() int32 { return cclVersion(b.thread) })
}

// expectedLibVersion is the native libccl version this wrapper expects, kept in lockstep with the
// module release. baseVersion strips any pre-release / build suffix ("0.1.0-preview1" -> "0.1.0").
const expectedLibVersion = "0.1.0"

func baseVersion(v string) string {
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

// checkVersion fails fast on a native-lib / wrapper version skew rather than surfacing it later as a
// confusing missing-symbol or wrong-result error. Bypass with CCL_SKIP_VERSION_CHECK.
func (b *Bridge) checkVersion() error {
	if os.Getenv("CCL_SKIP_VERSION_CHECK") != "" {
		return nil
	}
	libVer, err := b.Version()
	if err != nil {
		return err
	}
	if baseVersion(libVer) != baseVersion(expectedLibVersion) {
		return fmt.Errorf("libccl version %q is incompatible with the cardano-client-lib Go wrapper "+
			"(expects %q); the native library and wrapper must be the same version — update the module "+
			"or set CCL_LIB_PATH/CCL_LIB_VERSION to a matching libccl (set CCL_SKIP_VERSION_CHECK=1 to bypass)",
			libVer, expectedLibVersion)
	}
	return nil
}

// --- AddressApi ---

type AddressApi struct {
	bridge *Bridge
}

func (a *AddressApi) Info(bech32 string) (*AddressInfo, error) {
	result, err := a.bridge.invoke(func() int32 { return cclAddressInfo(a.bridge.thread, bech32) })
	if err != nil {
		return nil, err
	}
	var info AddressInfo
	if err := json.Unmarshal([]byte(result), &info); err != nil {
		return nil, err
	}
	return &info, nil
}

func (a *AddressApi) Validate(bech32 string) bool {
	return a.bridge.invokeRC(func() int32 { return cclAddressValidate(a.bridge.thread, bech32) }) == Success
}

func (a *AddressApi) ToBytes(bech32 string) (string, error) {
	return a.bridge.invoke(func() int32 { return cclAddressToBytes(a.bridge.thread, bech32) })
}

func (a *AddressApi) FromBytes(hexBytes string) (string, error) {
	return a.bridge.invoke(func() int32 { return cclAddressFromBytes(a.bridge.thread, hexBytes) })
}

// --- CryptoApi ---

type CryptoApi struct {
	bridge *Bridge
}

func (c *CryptoApi) Blake2b256(dataHex string) (string, error) {
	return c.bridge.invoke(func() int32 { return cclCryptoBlake2b256(c.bridge.thread, dataHex) })
}

func (c *CryptoApi) Blake2b224(dataHex string) (string, error) {
	return c.bridge.invoke(func() int32 { return cclCryptoBlake2b224(c.bridge.thread, dataHex) })
}

func (c *CryptoApi) GenerateMnemonic(wordCount int) (string, error) {
	return c.bridge.invoke(func() int32 { return cclCryptoGenerateMnemon(c.bridge.thread, int32(wordCount)) })
}

func (c *CryptoApi) ValidateMnemonic(mnemonic string) bool {
	return c.bridge.invokeRC(func() int32 { return cclCryptoValidateMnemon(c.bridge.thread, mnemonic) }) == Success
}

// Sign produces an Ed25519 signature. skHex is a 32-byte seed (64 hex chars) or a
// 64-byte BIP32-Ed25519 extended key (128 hex chars, e.g. DeriveKey's PrivateKey) —
// the form is detected by length.
func (c *CryptoApi) Sign(messageHex, skHex string) (string, error) {
	return c.bridge.invoke(func() int32 { return cclCryptoSign(c.bridge.thread, messageHex, skHex) })
}

// DeriveKey is the stateless CIP-1852 key-derivation utility — the explicit "raw key
// material" escape hatch. role is one of "payment", "change", "stake", "drep",
// "committee_cold", "committee_hot". Pass PrivateKey (the 64-byte extended BIP32-Ed25519
// key) whole to Crypto.Sign, which detects the extended form by length — never slice it,
// its first half is a clamped scalar, not a seed. Key derivation is network-independent.
// Prefer the managed Accounts API for signing; handles never expose key bytes.
func (c *CryptoApi) DeriveKey(mnemonic string, accountIndex, addressIndex int, role string) (*DerivedKey, error) {
	result, err := c.bridge.invoke(func() int32 {
		return cclCryptoDeriveKey(c.bridge.thread, mnemonic, int32(accountIndex), int32(addressIndex), role)
	})
	if err != nil {
		return nil, err
	}
	var key DerivedKey
	if err := json.Unmarshal([]byte(result), &key); err != nil {
		return nil, err
	}
	return &key, nil
}

func (c *CryptoApi) Verify(signatureHex, messageHex, pkHex string) bool {
	return c.bridge.invokeRC(func() int32 { return cclCryptoVerify(c.bridge.thread, signatureHex, messageHex, pkHex) }) == Success
}

// --- TxApi ---

type TxApi struct {
	bridge *Bridge
}

func (t *TxApi) Hash(txCborHex string) (string, error) {
	return t.bridge.invoke(func() int32 { return cclTxHash(t.bridge.thread, txCborHex) })
}

func (t *TxApi) SignWithSecretKey(txCborHex, skCborHex string) (string, error) {
	return t.bridge.invoke(func() int32 { return cclTxSignSecretKey(t.bridge.thread, txCborHex, skCborHex) })
}

func (t *TxApi) ToJson(txCborHex string) (string, error) {
	return t.bridge.invoke(func() int32 { return cclTxToJSON(t.bridge.thread, txCborHex) })
}

func (t *TxApi) FromJson(txJson string) (string, error) {
	return t.bridge.invoke(func() int32 { return cclTxFromJSON(t.bridge.thread, txJson) })
}

func (t *TxApi) Deserialize(txCborHex string) (string, error) {
	return t.bridge.invoke(func() int32 { return cclTxDeserialize(t.bridge.thread, txCborHex) })
}

// --- PlutusApi ---

type PlutusApi struct {
	bridge *Bridge
}

func (p *PlutusApi) DataHash(datumCborHex string) (string, error) {
	return p.bridge.invoke(func() int32 { return cclPlutusDataHash(p.bridge.thread, datumCborHex) })
}

func (p *PlutusApi) DataToJson(cborHex string) (string, error) {
	return p.bridge.invoke(func() int32 { return cclPlutusDataToJSON(p.bridge.thread, cborHex) })
}

func (p *PlutusApi) DataFromJson(jsonStr string) (string, error) {
	return p.bridge.invoke(func() int32 { return cclPlutusDataFromJSON(p.bridge.thread, jsonStr) })
}

// --- ScriptApi ---

type ScriptApi struct {
	bridge *Bridge
}

func (s *ScriptApi) NativeFromJson(jsonStr string) (string, error) {
	return s.bridge.invoke(func() int32 { return cclScriptNativeFromJSON(s.bridge.thread, jsonStr) })
}

func (s *ScriptApi) Hash(scriptCborHex string, scriptType int) (string, error) {
	return s.bridge.invoke(func() int32 { return cclScriptHash(s.bridge.thread, scriptCborHex, int32(scriptType)) })
}

// --- QuickTx API ---

// TxResult is the result of building a transaction: the unsigned CBOR, its hash, and the fee.
type TxResult struct {
	TxCbor string `yaml:"tx_cbor"`
	TxHash string `yaml:"tx_hash"`
	Fee    string `yaml:"fee"`
}

// QuickTxApi builds unsigned transactions from a CCL TxPlan (YAML), fully offline.
type QuickTxApi struct {
	bridge *Bridge
}

// Build builds an unsigned transaction from a TxPlan YAML document using the caller-supplied
// UTXOs and protocol parameters. utxos and protocolParams are marshalled to JSON (the standard
// CCL Utxo / ProtocolParams models). The transaction is built offline and never submitted —
// sign the returned TxCbor and submit it yourself.
//
// additionalSigners budgets vkey witnesses for fee estimation, beyond those the input UTXOs imply
// (one per sender). You know how many keys will sign: 0 for a plain payment, 1 for a stake or DRep
// certificate (payment+stake signing), 2 for both in one tx, the number of sig keys for a
// native-script spend, plus one per plan-level required signer. Undercounting yields a fee the node
// rejects with FeeTooSmallUTxO; overcounting only overpays (~4,400 lovelace per extra witness).
//
// For Plutus script transactions, pass the redeemers' execution units as the optional execUnits
// argument: a slice of {mem, steps} (one per redeemer, in transaction order). Omit them to have the
// bridge compute them offline with Scalus.
func (q *QuickTxApi) Build(yaml string, utxos interface{}, protocolParams interface{}, additionalSigners int, execUnits ...interface{}) (*TxResult, error) {
	if additionalSigners < 0 {
		return nil, fmt.Errorf("additionalSigners must be >= 0, got %d", additionalSigners)
	}
	utxosJSON, err := json.Marshal(utxos)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal utxos: %w", err)
	}
	ppJSON, err := json.Marshal(protocolParams)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal protocol params: %w", err)
	}

	// An empty string means "no execution units" (the native side treats blank as absent).
	execStr := ""
	if len(execUnits) > 0 && execUnits[0] != nil {
		execJSON, err := json.Marshal(execUnits[0])
		if err != nil {
			return nil, fmt.Errorf("failed to marshal exec units: %w", err)
		}
		execStr = string(execJSON)
	}

	result, err := q.bridge.invoke(func() int32 {
		return cclQuicktxBuild(q.bridge.thread, yaml, string(utxosJSON), string(ppJSON), execStr, int32(additionalSigners))
	})
	if err != nil {
		return nil, err
	}

	// The build result is a YAML document.
	var txResult TxResult
	if err := goyaml.Unmarshal([]byte(result), &txResult); err != nil {
		return nil, fmt.Errorf("failed to parse tx result: %w", err)
	}
	return &txResult, nil
}

// DerivedKey is the result of stateless CIP-1852 key derivation (Crypto.DeriveKey).
type DerivedKey struct {
	Path          string `json:"path"`
	PrivateKey    string `json:"private_key"`
	PublicKey     string `json:"public_key"`
	PublicKeyHash string `json:"public_key_hash"`
	// CIP-105 bech32 encodings, present only for the governance roles (drep,
	// committee_cold, committee_hot) — the forms cardano-cli and GovTool accept.
	Bech32VerificationKey     string `json:"bech32_verification_key,omitempty"`
	Bech32VerificationKeyHash string `json:"bech32_verification_key_hash,omitempty"`
}
