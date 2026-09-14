# ADR-0016: Encapsulate signing secrets in managed Account handles

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** bloxbean maintainers

## Context

The current C ABI is deliberately flat and stateless. Account operations receive all of their state
on every call, so signing in the four wrappers looks approximately like this:

```text
sign_tx(mnemonic, network, account_index, address_index, tx_cbor)
```

The native implementation reconstructs a CCL `Account` from those values for every signature. This
is inconsistent with Cardano Client Lib's object model: a CCL `Account` owns its key source, network,
and derivation path, and exposes `account.sign(transaction)` plus role-specific stake, DRep, and
committee signing methods. QuickTx uses signer objects such as `SignerProviders.signerFrom(account)`;
the mnemonic and derivation coordinates are not transaction-signing parameters.

The flat API has several related problems:

- It encourages applications to carry a recovery phrase through ordinary transaction-building code
  and copies that phrase across the wrapper/C/native/Java boundary on every signature. Most of those
  representations are immutable or garbage-collected and cannot be reliably zeroized.
- Network and derivation coordinates can drift between address derivation, transaction construction,
  and signing. A derivation path is not confidential, but selecting it again at signing time is an
  avoidable correctness hazard.
- `account.create` and `wallet.create` put a mnemonic in an otherwise ordinary account/wallet result;
  the corresponding restore methods echo the supplied mnemonic back. These objects are easy to
  print, log, serialize, or include in an error report accidentally.
- Public-data operations (`get_public_key`, DRep/governance identifiers, and wallet address
  derivation) also require the mnemonic on every call. Some of these can operate from an already-open
  account or from watch-only public derivation material.
- `get_private_key`, raw cryptographic signing, and transaction signing with a raw secret key are
  presented beside routine APIs even though they expand the secret-exposure surface substantially.
- The native result transport retains the last result in a `ThreadLocal<String>` after it has been
  read. A generated mnemonic, restored account JSON, or exported private key can therefore remain as
  the current result until another result replaces it or the isolate is torn down. Returned unmanaged
  strings are freed without first being overwritten.
- Multi-role signing uses untyped strings (`payment`, `stake`, `drep`, `committee_cold`,
  `committee_hot`). The signer roles and actual witness count can differ from QuickTx's fee estimate,
  which currently budgets signers independently of the Account signing call.

This is mainly an encapsulation, accidental-disclosure, and misuse problem. Passing a mnemonic as an
argument is not by itself a cryptographic vulnerability, and an opaque in-process object cannot
protect secrets from a process compromise. Nevertheless, reducing the number of components that see
the mnemonic, the number and lifetime of its copies, and the opportunity to choose the wrong key is a
material improvement.

This decision interacts with three accepted ADRs:

- [ADR-0002](0002-offline-stateless-no-provider.md) keeps `libccl` offline, stateless, and free of
  provider/network configuration. That rule remains. This ADR carves a narrow, explicit exception
  for caller-created, in-memory signing capabilities: it supersedes ADR-0002 only where ADR-0002
  says that `libccl` holds no key/account state.
- [ADR-0003](0003-four-language-wrappers-uniform-ffi.md) requires a common thin C ABI. Account objects
  must therefore be native resources surfaced idiomatically by thin wrappers, not four independent
  account implementations.
- [ADR-0015](0015-no-reference-wrapper-parity.md) requires the capability, lifecycle behavior, and
  coverage to ship in Python, Go, Rust, and JavaScript together.

## Decision

We will replace mnemonic-per-operation signing as the primary API with **managed Account objects
backed by opaque native handles**. We will retain the unsigned transaction workflow and introduce a
general signer abstraction so software accounts are one signing option rather than the boundary for
all future signers.

### Native Account resource

The C ABI will create/import an account once and return an opaque integer handle. A representative
surface is:

```c
ccl_account_create_handle(..., uint64_t *out_handle);
ccl_account_open_mnemonic(..., uint64_t *out_handle);
ccl_account_get_info(..., uint64_t handle);
ccl_account_sign(..., uint64_t handle, const char *tx_cbor, uint32_t role_mask);
ccl_account_close(..., uint64_t handle);
```

Exact names and result mechanics may change during implementation, but these invariants will not:

- The handle is an opaque identifier, not a raw pointer exposed to wrappers.
- Network, account index, and address index are fixed when the Account is opened. Signing takes a
  transaction and typed role selection, not mnemonic/network/path arguments.
- Handles are scoped to one bridge/GraalVM isolate and allocated from a per-isolate randomized
  62-bit space. Foreign, closed, and stale handles fail with a normal CCL error rather than
  accessing another object — foreign-handle detection is *statistical* (collision odds ~2⁻⁶²), not
  structural; a fixed counter would make cross-isolate collisions certain and let a foreign handle
  silently alias a real account, which the wrong-pairing regression test pins against.
- `close` is explicit and idempotent. Closing a bridge closes and clears all accounts that belong to
  it. Wrapper finalizers are fallback protection, never the primary lifecycle mechanism.
- Go Account calls use the Bridge's existing dedicated OS-thread executor in accordance with
  [ADR-0010](0010-go-isolate-thread-affinity.md).
- Account objects expose public account metadata and operations such as payment/stake addresses,
  public keys, DRep/governance identifiers, and payment/stake/DRep/committee signing without
  re-importing the mnemonic.

Where CCL permits it, an imported mnemonic will be used to derive the hardened account-level extended
private key once, and the managed CCL `Account` will be created from that account key. This avoids
retaining the root recovery phrase and limits the capability to one account while preserving its
non-hardened payment, change, stake, DRep, and committee roles. Temporary mnemonic/root-key material
and the retained account key will be overwritten on a best-effort basis when no longer needed. Key
derivation and signing parity must be verified against mnemonic-backed CCL Accounts before this mode
is enabled.

### Derivation model

The path model is **CIP-1852** (`m/1852'/1815'/account'/role/index`), matching CCL's `Account`
semantics exactly. An account handle is **one payment leaf plus the account's role keys**: the
payment key uses role `0` at the handle's `address_index`; the stake, DRep, and committee keys sit
at their standard role indices **independent of `address_index`**. Consequently, two handles opened
at different address indices of the same account share one stake/DRep identity — this is inherited
CCL behavior, pinned by the signing-parity tests, and must be documented in every wrapper guide.

Multiple addresses under one account are served in this ADR's scope by **opening one handle per
leaf** (opening is cheap). A **wallet handle** — the managed successor to the mnemonic-per-call HD
`wallet` API group: open the account-level node once, then `derive_address(handle, index)` and sign
for any derived leaf (including multi-address senders) — is deliberate **future work**: it is purely
additive to this ABI (new entry points, no changes to the account surface). Watch-only handles from
account-level public derivation material are future work of the same additive kind. Arbitrary
non-CIP-1852 derivation paths are **out of scope** for handles; the low-level raw-key APIs remain
the escape hatch.

All handle kinds share **one namespace** (a single isolate-local counter with kind-tagged entries),
so a handle of one kind passed to another kind's entry point fails with a typed error rather than
aliasing an object by numeric coincidence.

### Public information and recovery material

An Account's ordinary representation will contain public information only. It must be safe to inspect
or serialize without disclosing a mnemonic or private key.

- Creating a new Account will return or expose its recovery phrase through a separate, explicitly
  secret-bearing value. Secret access must be deliberate (for example, `recoveryPhrase.reveal()` or
  `account.export_recovery_phrase()`), and the secret will be redacted from default string/debug/JSON
  representations.
- Restoring an Account will not echo the supplied mnemonic in its result.
- Wallet creation/restoration will follow the same rule.
- Watch-only address/public-key derivation should accept account-level public derivation material
  where possible instead of requiring a mnemonic.
- No example or primary documentation will print a mnemonic or private key. Examples may demonstrate
  where an application would persist a recovery phrase securely without displaying its value.

Language wrappers will use the best practical secret container for their runtime: zeroizing secret
types in Rust, mutable/redacted byte-backed values where practical in Go, Python, and JavaScript, and
no plain JSON field for recovery material. This is defense in depth; managed runtimes and CCL's
current mnemonic `String` API prevent a guarantee that every historical copy is wiped.

### Signing roles and signer abstraction

Signing roles will be typed in each wrapper and represented by a validated enum/bit mask in the C
ABI. The default Account signature uses the payment key. Stake, DRep, and committee authorization is
selected explicitly; the API will not silently sign with every key the Account controls.

A bit mask is deliberately **unordered**, unlike today's `sign_tx_with_keys` role list, whose
documentation says roles are "applied in order". Witnesses form a set in the transaction witness
structure, so application order does not affect validity; the native side will add witnesses in a
fixed canonical order (payment, stake, DRep, committee cold, committee hot) so signed outputs are
deterministic and byte-identical across wrappers.

Each wrapper will expose an idiomatic transaction signer abstraction:

| Wrapper | Account shape | Lifecycle | Signer abstraction |
|---------|---------------|-----------|--------------------|
| JavaScript/TypeScript | `Account` object | `close()` / `Symbol.dispose` | `TransactionSigner` interface |
| Python | `Account` object/context manager | `close()` / `with` | `Protocol` or equivalent |
| Rust | `Account` (owned handle) | `Drop` plus explicit close where useful | trait |
| Go | `*Account` tied to `*Bridge` | explicit `Close()` | interface |

The following representative API sketches establish the intended ownership, lifecycle, and signing
shape. Final names may change to remain idiomatic, but mnemonic/network/path arguments must not return
to the per-transaction signing call.

#### JavaScript / TypeScript

```javascript
const sender = bridge.accounts.fromMnemonic(mnemonic, TESTNET, {
  accountIndex: 0,
  addressIndex: 0,
});

try {
  const built = bridge.quicktx.build(plan, utxos, protocolParams);
  const signed = sender.signTx(built.tx_cbor);

  const governanceSigned = sender.signTx(built.tx_cbor, {
    roles: [SigningRole.Payment, SigningRole.DRep],
  });
} finally {
  sender.close();
}
```

A JavaScript `RecoveryPhrase` should redact string, inspection, and JSON representations. A
byte-backed value should be overwritten by `close()`/`Symbol.dispose` where Bun permits it; it still
cannot guarantee removal of copies previously made as JavaScript strings.

#### Python

```python
with bridge.accounts.from_mnemonic(
    mnemonic,
    Network.TESTNET,
    account_index=0,
    address_index=0,
) as sender:
    built = bridge.quicktx.build(plan, utxos, protocol_params)
    signed = sender.sign_tx(built["tx_cbor"])

    governance_signed = sender.sign_tx(
        built["tx_cbor"],
        roles={SigningRole.PAYMENT, SigningRole.DREP},
    )
```

A Python `RecoveryPhrase` wrapper should redact `repr()` and `str()`. New secret-import ABI calls
should accept a mutable `bytearray` where practical so the wrapper can overwrite it after import,
while documenting that earlier `str` and native copies may remain.

#### Rust

```rust
let sender = bridge.accounts().from_mnemonic(
    &mnemonic,
    Network::Testnet,
    AccountPath::new(0, 0),
)?;

let built = bridge.quicktx().build(&plan, &utxos, &params, None)?;
let signed = sender.sign_tx(&built.tx_cbor, &[SigningRole::Payment])?;
```

The Rust Account will be an **owned value holding shared ownership of the bridge's isolate state**
(reference-counted internally), not a type that borrows the Bridge with a lifetime parameter
(`Account<'bridge>`). Validity is enforced at runtime, exactly as the handle invariants above
require for every wrapper: a call on an Account whose Bridge has been closed — or whose own handle
was closed — fails with a normal CCL error rather than touching freed native memory. `Drop` closes
the native handle; explicit close remains available.

Rationale for owned over borrowed: a borrowed `Account<'bridge>` cannot be stored in the same
struct as its `Bridge` (a self-referential borrow), which is precisely what long-lived applications
want to do, and it forces `'static`/global-Bridge workarounds in threaded and async code. Owned
handles keep Rust's failure model identical to Python, Go, and JavaScript (same stale-handle error,
same negative tests), and the choice is wrapper-internal: it can be revisited in a breaking crate
release without touching the C ABI or other wrappers.

Recovery phrases should use `secrecy::SecretString`/`zeroize`, not plain
`String` or JSON. Secret-bearing, untyped JSON account results are specifically rejected
by this decision.

#### Go

```go
sender, err := bridge.Accounts.FromMnemonic(
	mnemonic,
	ccl.Testnet,
	ccl.AccountPath{Account: 0, Address: 0},
)
if err != nil {
	return err
}
defer sender.Close()

built, err := bridge.QuickTx.Build(plan, utxos, params, nil)
if err != nil {
	return err
}
signed, err := sender.SignTx(built.TxCbor, ccl.Payment)
```

Go will use a typed `SigningRole`, not variadic strings. Secret import/export should prefer a mutable
`[]byte` or redacted `RecoveryPhrase` over an ordinary immutable `string`. `Close` is explicit; a
finalizer may only be a fallback.

Implementations for hardware wallets, browser/CIP-30 wallets, KMS/remote services, and air-gapped
workflows are outside the initial implementation, but the abstraction must allow them without
requiring a mnemonic to enter `libccl`.

### QuickTx remains unsigned by default

`quicktx.build` will continue to return unsigned transaction CBOR. Build/sign separation is required
for external, hardware, multisignature, and air-gapped workflows and remains the lowest common
denominator across all four wrappers.

An optional CCL-like `build_and_sign`/`with_signer` convenience may accept Account handles or signer
descriptors. Whether signing is integrated or performed after build, QuickTx must receive an accurate
expected witness count/plan before fee calculation. A convenience API must not make submission or
network access implicit.

### Low-level secret APIs

Raw capabilities remain available for advanced use cases, but they will not be the recommended path:

- private-key export;
- Ed25519 signing with a raw secret key; and
- transaction signing with a raw secret key.

They will move to an explicitly named advanced/unsafe namespace or receive equivalently prominent
documentation and types. Public examples will use Account or external Signer objects instead of
exporting a private key and slicing hex strings.

### Result transport and secret lifetime

The native result channel will become consumptive: retrieving a result removes it from thread-local
state. Secret-producing paths will not leave recoverable stale values after wrapper parsing. Native
output buffers will be overwritten before being freed where their length is known or safely
discoverable. New secret-import ABI functions should accept pointer-plus-length mutable buffers
rather than requiring null-terminated immutable strings when practical.

These measures reduce lifetime and copies; they do not claim guaranteed zeroization across Java and
all four host runtimes.

### Compatibility and rollout

The change will be staged:

1. Stop printing secrets; separate public account/wallet information from recovery material; consume
   result state after retrieval; and document raw-key APIs as advanced.
2. Add the opaque-handle ABI and Account objects in all four wrappers, with lifecycle, role, negative
   handle, and signing-parity tests.
3. Add signer abstractions and pass accurate signer/witness information into QuickTx fee estimation.
4. Remove the mnemonic-per-operation account, wallet, governance, and signing calls outright.
   Pre-release, with only preview-tagged packages and no meaningful consumers, no deprecation
   period or compatibility facade is warranted — but no capability may be lost: public identity
   moves onto the account info, and raw key material survives as the stateless
   `crypto.derive_key` utility, documented as advanced.

The old and new ABI must not silently disagree. ABI additions and removals follow the versioning and
all-wrapper release requirements in `RELEASING.md` and ADR-0015.

Explicitly out of scope for this ADR are key persistence at rest, OS keychains, hardware-wallet
protocol implementations, remote signer authentication, transaction submission, and network/provider
state inside `libccl`.

## Consequences

- **Safer primary API:** recovery phrases no longer flow through routine transaction code or ordinary
  account serialization, and signing configuration cannot drift from the Account created earlier.
- **CCL-aligned ergonomics:** all wrappers expose the same conceptual `Account.sign` model as CCL
  while remaining idiomatic in resource management and naming.
- **Extensible signing boundary:** unsigned QuickTx plus a signer abstraction supports software,
  browser, hardware, remote, multisig, and offline signers without redesigning transaction building.
- **More accurate fee planning:** signer roles/count become part of build context instead of being
  inferred independently from the later signing call.
- **Native state is introduced:** `libccl` must maintain an isolate-local resource registry, validate
  handles, clean up deterministically, and test use-after-close and bridge-close behavior. This is an
  intentional exception to the broad wording of ADR-0002, but it does not introduce network or
  provider state.
- **Secrets live longer in one place:** a reusable Account retains signing authority until closed.
  This trades repeated, widespread mnemonic copies for one explicitly managed capability. Short-lived
  applications should close it promptly; long-lived applications must treat the process as a wallet.
- **Zeroization remains best effort:** Java `String`, garbage collection, FFI marshalling, and runtime
  copies prevent a universal guarantee. The design reduces exposure but does not provide an enclave.
- **API and ABI migration cost:** core lifecycle code, four wrapper object models, tests, examples,
  documentation, and package versions must change together.
- **Concurrency remains bridge-scoped:** accounts do not make a Bridge concurrently callable. In Go,
  calls remain serialized on its isolate thread; other wrappers retain their existing Bridge rules.
- **Revisit if:** CCL adds a dedicated destroyable/zeroizing key container, GraalVM offers a safer
  cross-language object-handle mechanism, or supported external signers make native software-key
  custody unnecessary.

## Alternatives considered

- **Keep the stateless mnemonic-per-call API.** Rejected as the primary API. It is simple at the C
  boundary but pushes recovery phrases and derivation choices into every application layer, creates
  repeated copies, and diverges from CCL's Account model.
- **Add wrapper-only Account facades that privately store the mnemonic.** Useful only as a migration
  step. It fixes call-site ergonomics but still sends and copies the mnemonic on every operation, and
  four wrappers would own security-sensitive state independently.
- **Pass an account private key instead of a mnemonic on every call.** Rejected. It reduces mnemonic
  exposure but continues the same raw-secret-per-operation design and makes private-key export a
  prerequisite for ordinary signing.
- **Fuse QuickTx build and Account signing exclusively.** Rejected. It would resemble CCL's convenient
  path but prevent hardware, remote, multisignature, and air-gapped workflows. Build-and-sign may be
  additive, never the only route.
- **Always add every Account witness.** Rejected. Signing is authorization and must remain explicit;
  extra witnesses also change transaction size and fees.
- **Support external signers only and remove native software accounts.** Not chosen now. It offers the
  strongest separation but removes the offline software-wallet capability users already rely on.
  External signers will instead coexist with managed Accounts behind one signer abstraction.
- **Store raw native pointers in wrappers.** Rejected. Opaque validated identifiers provide better
  stale-handle detection and avoid exposing managed-object or native-address details across the ABI.
