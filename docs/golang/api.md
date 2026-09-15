# Go API Reference

Everything lives in package `mesmo`:

```go
import "github.com/bloxbean/mesmo/wrappers/go/mesmo"
```

## Mesmo

```go
func New() (*Mesmo, error)
func (b *Mesmo) Close() error
func (b *Mesmo) Version() (string, error)

var ErrClosed = errors.New("mesmo: closed")
```

`New()` loads the native library (downloading it on first use — see [troubleshooting](troubleshooting.md#how-the-native-library-is-found)), creates a GraalVM isolate on a dedicated pinned OS thread, and verifies the library version matches the wrapper. The API groups are exported fields:

```go
lib.Accounts // *AccountsApi (managed accounts, ADR-0016)
lib.Address  // *AddressApi
lib.Crypto   // *CryptoApi
lib.Tx       // *TxApi
lib.Plutus   // *PlutusApi
lib.Script   // *ScriptApi
lib.QuickTx  // *QuickTxApi
```

**Lifecycle.** `Close()` tears down the isolate and is idempotent. Any call after `Close` returns `ErrClosed` (test with `errors.Is`) — it never hangs or panics.

**Concurrency.** A `*Mesmo` may be shared across goroutines; calls are serialized onto Mesmo's single isolate thread. Create multiple instances for parallelism.

## Networks

```go
type Network int

const (
	Mainnet Network = 0
	Testnet Network = 1
)

func (n Network) String() string  // "mainnet", "testnet", ...
func (n Network) Valid() bool
```

Account operations (`Accounts`) require a `Network` value; an out-of-range value returns a plain descriptive error before any native call. The stateless `Crypto.DeriveKey` takes none — key derivation is network-independent.

> **Gotcha:** these constants are CCL enum ordinals, **not** Cardano's on-chain network id — the two are inverted for mainnet/testnet (`Mainnet = 0`, but a mainnet address's on-chain `network_id` is `1`). `AddressInfo.NetworkID` is the genuine on-chain value; never feed it back into an API that takes a `Network`.

## Errors

```go
type MesmoError struct {
	Code    int
	Message string
}
func (e *MesmoError) Error() string  // "Mesmo error <code>: <message>"
```

Native failures surface as `*MesmoError` — match with `errors.As`. Error codes:

| Constant | Code | Meaning |
|---|---|---|
| `ErrGeneral` | -1 | Unspecified failure |
| `ErrInvalidArgument` | -2 | Bad argument |
| `ErrSerialization` | -3 | (De)serialization failure |
| `ErrCrypto` | -4 | Cryptographic failure |
| `ErrInvalidNetwork` | -5 | Bad network value |
| `ErrInvalidMnemonic` | -6 | Bad mnemonic |
| `ErrInvalidAddress` | -7 | Bad address |
| `ErrInsufficientFunds` | -8 | UTXOs can't cover outputs + fee |
| `ErrInvalidTransaction` | -9 | Bad transaction |
| `ErrTxBuild` | -10 | TxPlan build failure (most common `QuickTx.Build` error — usually a malformed plan) |
| `ErrInvalidHandle` | -11 | Unknown or closed account handle |

Predicate methods (`Address.Validate`, `Crypto.ValidateMnemonic`, `Crypto.Verify`) return `bool` and never error.

## lib.Accounts — managed accounts

Handle-based accounts (ADR-0016): open once, then operate without the mnemonic — the only
account API.

```go
acct, err := lib.Accounts.FromMnemonic(mnemonic, mesmo.Testnet, 0, 0)  // or lib.Accounts.Create(...)
defer acct.Close()

info, _ := acct.Info()                            // *AccountPublicInfo — never the mnemonic
signed, err := acct.SignTx(txCbor, mesmo.RolePayment|mesmo.RoleStake)
// after Close: further use fails with ErrInvalidHandle (-11)
```

- `FromMnemonic(mnemonic, network, accountIndex, addressIndex)` — the mnemonic crosses the FFI
  boundary once, here.
- `Create(network)` — fresh 24-word account; **no secret in the result**. Retrieve the phrase once,
  deliberately, with `acct.ExportRecoveryPhrase()` — a second call fails, as does export on a
  mnemonic-opened account.
- `SignTx(txCborHex, roles)` — typed `SigningRole` bit mask (`RolePayment`, `RoleStake`, `RoleDRep`,
  `RoleCommitteeCold`, `RoleCommitteeHot`);
  witnesses apply in canonical order. An empty mask is rejected.
- `Close()` is explicit and idempotent — close Accounts like files. Like `os.File`, a dropped
  Account is reclaimed best-effort by a GC finalizer (fallback only; timing is the GC's). All
  Account calls ride the Mesmo's dedicated isolate thread, so concurrent goroutine use is safe
  (and serialized). `String()` shows only the handle.
- `Info()` returns public data only: the base/enterprise/stake/change addresses, network and
  derivation indices, `DRepID`, and the committee identifiers (`CommitteeColdID`/`CommitteeHotID`, bech32,
  plus `CommitteeColdCredential`/`CommitteeHotCredential` — hex blake2b-224 verification-key
  hashes, as used in committee certificates).

An account is bound to **one CIP-1852 payment leaf** (`m/1852'/1815'/account'/0/address_index`): one handle, one payment address — open further accounts for further address indices. The stake/DRep/committee keys sit at their standard role indices *independent of* `address_index`, so accounts at different address indices of one account index **share a single stake/DRep identity**.

## lib.Address

```go
func (a *AddressApi) Info(bech32 string) (*AddressInfo, error)
func (a *AddressApi) Validate(bech32 string) bool
func (a *AddressApi) ToBytes(bech32 string) (string, error)     // hex
func (a *AddressApi) FromBytes(hexBytes string) (string, error) // bech32
```

```go
type AddressInfo struct {
	Type                     string `json:"type"`        // "Base", "Enterprise", "Pointer", "Reward"
	NetworkID                int    `json:"network_id"`  // on-chain id: 0=testnet, 1=mainnet
	PaymentCredentialHash    string `json:"payment_credential_hash,omitempty"`
	DelegationCredentialHash string `json:"delegation_credential_hash,omitempty"`
	IsPubkeyPayment          bool   `json:"is_pubkey_payment"`
	IsScriptPayment          bool   `json:"is_script_payment"`
}
```

## lib.Crypto

```go
func (c *CryptoApi) Blake2b256(dataHex string) (string, error)
func (c *CryptoApi) Blake2b224(dataHex string) (string, error)
func (c *CryptoApi) GenerateMnemonic(wordCount int) (string, error)   // 12 or 24
func (c *CryptoApi) ValidateMnemonic(mnemonic string) bool
func (c *CryptoApi) Sign(messageHex, skHex string) (string, error)    // Ed25519; 32-byte seed or 64-byte extended key (by length)
func (c *CryptoApi) Verify(signatureHex, messageHex, pkHex string) bool
func (c *CryptoApi) DeriveKey(mnemonic string, accountIndex, addressIndex int, role string) (*DerivedKey, error)
```

`DeriveKey` is the stateless CIP-1852 "raw key material" utility — `role` is one of `"payment"`,
`"change"`, `"stake"`, `"drep"`, `"committee_cold"`, `"committee_hot"`; it returns
`{Path, PrivateKey, PublicKey, PublicKeyHash}`, plus — for the governance roles — the CIP-105
bech32 encodings `Bech32VerificationKey`/`Bech32VerificationKeyHash` (what cardano-cli and GovTool
accept for registration). Key derivation is network-independent. Prefer
managed accounts for signing — handles never expose key bytes.

Hash inputs are hex in → hex out:

```go
digest, _ := lib.Crypto.Blake2b256("48656c6c6f") // "Hello"
key, _ := lib.Crypto.DeriveKey(mnemonic, 0, 0, "payment")
sig, _ := lib.Crypto.Sign(msgHex, key.PrivateKey) // pass the extended key whole
```

## lib.Tx

```go
func (t *TxApi) Hash(txCborHex string) (string, error)
func (t *TxApi) SignWithSecretKey(txCborHex, skCborHex string) (string, error)
func (t *TxApi) ToJson(txCborHex string) (string, error)
func (t *TxApi) FromJson(txJson string) (string, error)     // returns CBOR hex
func (t *TxApi) Deserialize(txCborHex string) (string, error)
```

`ToJson`/`Deserialize` return a JSON string with a `body` field (inputs/outputs/fee). `SignWithSecretKey` expects a CBOR-encoded secret key, not raw key hex — for mnemonic-based accounts prefer `Account.SignTx`.

## lib.Plutus

```go
func (p *PlutusApi) DataHash(datumCborHex string) (string, error)   // 64 hex chars
func (p *PlutusApi) DataToJson(cborHex string) (string, error)
func (p *PlutusApi) DataFromJson(jsonStr string) (string, error)    // returns CBOR hex
```

```go
hash, _ := lib.Plutus.DataHash("182a")  // hash of PlutusData int 42
```

## lib.Script

```go
func (s *ScriptApi) NativeFromJson(jsonStr string) (string, error)              // JSON: {policy_id, script_hash, cbor_hex}
func (s *ScriptApi) Hash(scriptCborHex string, scriptType int) (string, error)  // 56 hex chars
```

`scriptType`: `0` native, `1` PlutusV1, `2` PlutusV2, `3` PlutusV3.

```go
scriptJSON := fmt.Sprintf(`{"type":"sig","keyHash":"%s"}`, info.PaymentCredentialHash)
result, _ := lib.Script.NativeFromJson(scriptJSON)
// unmarshal result → policy_id, script_hash, cbor_hex
```

## Governance identity and HD-wallet flows

There is no separate Gov/Wallet API. Governance *identity* (DRep id, committee ids and
credentials) is public data on `acct.Info()`; governance *signing* uses `SignTx` with the
`RoleDRep`/`RoleCommittee*` roles; raw governance key material comes from `Crypto.DeriveKey`.
An HD wallet is one recovery phrase with one managed handle per CIP-1852 payment leaf — pass
`addressIndex` to `Accounts.FromMnemonic` to enumerate addresses.

## lib.QuickTx

```go
func (q *QuickTxApi) Build(yaml string, utxos interface{}, protocolParams interface{}, additionalSigners int, execUnits ...interface{}) (*TxResult, error)
func (q *QuickTxApi) BuildWith(yaml string, provider ChainDataProvider, senders []string, additionalSigners int, evaluator ...TransactionEvaluator) (*TxResult, error)
```

```go
type TxResult struct {
	TxCbor string `yaml:"tx_cbor"`
	TxHash string `yaml:"tx_hash"`
	Fee    string `yaml:"fee"`
}
```

- **`Build`** is fully offline: you describe the transaction as [TxPlan YAML](../quicktx.md) and supply the chain data yourself. UTXO selection, fee calculation, and change handling happen inside the native library. It never submits — sign the returned `TxCbor` and submit with any HTTP client.
- `utxos` is a slice of CCL `Utxo` objects (typically `[]map[string]interface{}`): `{tx_hash, output_index, address, amount: [{unit, quantity}]}`. `unit` is `"lovelace"` or `policyId + assetNameHex`. Quantities are best passed as **strings**.
- `protocolParams` is the CCL `ProtocolParams` model (typically `map[string]interface{}`); unknown fields are ignored.
- `execUnits` — for Plutus transactions, pass one value: a slice of `{mem, steps}` maps, one per redeemer in transaction order. When omitted, the native library computes them **offline** with the embedded Scalus evaluator.
- `additionalSigners` budgets vkey witnesses for fee estimation, **beyond those the input UTXOs imply** (one per sender). You know how many keys will sign: `0` for a plain payment, `1` for a stake or DRep certificate, `2` for both in one tx, the number of `sig` keys for a native-script spend, plus one per plan-level required signer. Undercounting yields a fee the node rejects with `FeeTooSmallUTxO`; overcounting only overpays (~4,400 lovelace per extra witness).
- **`BuildWith`** fetches each sender's UTXOs from a [provider](providers.md) — merged and de-duplicated by `(tx_hash, output_index)` — plus protocol parameters, then builds. With multiple senders, TxPlan's `context.fee_payer` decides who pays the fee. With an evaluator it runs two passes: draft build → remote evaluation → rebuild with the returned units.

```go
result, err := lib.QuickTx.Build(yaml, utxos, params, 0)          // plain payment

stakeResult, err := lib.QuickTx.Build(yaml, utxos, params, 1)     // payment+stake signing

plutusResult, err := lib.QuickTx.Build(yaml, utxos, params, 0,
	[]map[string]interface{}{{"mem": 2000000, "steps": 500000000}})
```
