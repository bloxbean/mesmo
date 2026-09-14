mod ffi;
pub mod accounts;

#[cfg(feature = "providers")]
pub mod providers;

use std::ffi::{CStr, CString};
use std::marker::PhantomData;
use std::os::raw::{c_char, c_int};
use std::ptr;

use serde_json::Value;

pub use ffi::*;

/// Error codes from the CCL library.
pub mod error_codes {
    pub const CCL_SUCCESS: i32 = 0;
    pub const CCL_ERROR_GENERAL: i32 = -1;
    pub const CCL_ERROR_INVALID_ARGUMENT: i32 = -2;
    pub const CCL_ERROR_SERIALIZATION: i32 = -3;
    pub const CCL_ERROR_CRYPTO: i32 = -4;
    pub const CCL_ERROR_INVALID_NETWORK: i32 = -5;
    pub const CCL_ERROR_INVALID_MNEMONIC: i32 = -6;
    pub const CCL_ERROR_INVALID_ADDRESS: i32 = -7;
    pub const CCL_ERROR_INSUFFICIENT_FUNDS: i32 = -8;
    pub const CCL_ERROR_INVALID_TRANSACTION: i32 = -9;
    /// Malformed TxPlan — the most common failure on the core build path.
    pub const CCL_ERROR_TX_BUILD: i32 = -10;
    pub const CCL_ERROR_INVALID_HANDLE: i32 = -11;
}

/// Which Cardano network to derive addresses/keys for.
///
/// # These are *not* Cardano's on-chain network ids
///
/// The discriminants below are **CCL's own enum ordinals** (`Mainnet = 0`, `Testnet = 1`) —
/// they are what the native library expects. Cardano's *on-chain* network id, the one encoded
/// in an address, is the opposite way round: **0 = testnet, 1 = mainnet**. So the two disagree
/// exactly where it hurts most:
///
/// | | CCL ordinal (this enum) | on-chain network id |
/// |---|---|---|
/// | mainnet | `Network::Mainnet` = 0 | 1 |
/// | testnet | `Network::Testnet` = 1 | 0 |
///
/// An account created with [`Network::Mainnet`] therefore has an on-chain `network_id` of **1**.
/// That inversion is why these methods take a `Network` and not a bare `i32`: passing `1` because
/// you know mainnet is network id 1 on-chain would have silently derived a *testnet* key.
///
/// The `network_id` field in the JSON returned by [`AddressApi::info`] is the genuine on-chain
/// value, not an ordinal from this enum — do not compare the two.
///
/// ```
/// # use ccl::Network;
/// assert_eq!(Network::Mainnet.as_i32(), 0); // CCL ordinal, not the on-chain id (which is 1)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    /// The CCL enum ordinal for this network — what the native library expects.
    ///
    /// Not the on-chain network id; see the type-level docs.
    pub fn as_i32(self) -> i32 {
        self as i32
    }
}

impl From<Network> for i32 {
    fn from(n: Network) -> i32 {
        n.as_i32()
    }
}

/// Error type for CCL operations.
#[derive(Debug)]
pub struct CclError {
    pub code: i32,
    pub message: String,
}

impl std::fmt::Display for CclError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CCL Error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for CclError {}

pub type Result<T> = std::result::Result<T, CclError>;

/// Strip any pre-release / build suffix: `"0.1.0-preview1"` -> `"0.1.0"`.
fn base_version(v: &str) -> &str {
    v.split(['-', '+']).next().unwrap_or(v).trim()
}

fn to_cstring(s: &str) -> Result<CString> {
    CString::new(s).map_err(|e| CclError {
        code: error_codes::CCL_ERROR_INVALID_ARGUMENT,
        message: e.to_string(),
    })
}

/// Close-aware view of the bridge's isolate thread, shared with owned [`accounts::Account`]s.
pub(crate) struct BridgeShared {
    pub(crate) thread: std::cell::Cell<*mut ffi::graal_isolatethread_t>,
}

impl BridgeShared {
    /// The live isolate thread, or a typed error once the Bridge has been dropped.
    pub(crate) fn thread(&self) -> Result<*mut ffi::graal_isolatethread_t> {
        let t = self.thread.get();
        if t.is_null() {
            return Err(CclError {
                code: error_codes::CCL_ERROR_INVALID_HANDLE,
                message: "Bridge is closed; this Account's handle is no longer valid".to_string(),
            });
        }
        Ok(t)
    }
}

pub(crate) fn get_result_at(thread: *mut ffi::graal_isolatethread_t) -> String {
    unsafe {
        let ptr = ffi::ccl_get_result(thread);
        if ptr.is_null() {
            return String::new();
        }
        let result = CStr::from_ptr(ptr as *const c_char).to_string_lossy().into_owned();
        ffi::ccl_free_string(thread, ptr);
        result
    }
}

pub(crate) fn get_error_at(thread: *mut ffi::graal_isolatethread_t) -> String {
    unsafe {
        let ptr = ffi::ccl_get_last_error(thread);
        if ptr.is_null() {
            return String::new();
        }
        let result = CStr::from_ptr(ptr as *const c_char).to_string_lossy().into_owned();
        ffi::ccl_free_string(thread, ptr);
        result
    }
}

pub(crate) fn check_at(thread: *mut ffi::graal_isolatethread_t, rc: i32) -> Result<String> {
    if rc != error_codes::CCL_SUCCESS {
        return Err(CclError { code: rc, message: get_error_at(thread) });
    }
    Ok(get_result_at(thread))
}

/// Safe wrapper around the CCL native library.
///
/// # Threading
///
/// A `Bridge` is **thread-affine**: it must be used from the thread that created it. It is therefore
/// neither `Send` nor `Sync`, and the compiler will stop you from moving one across threads. To use
/// the library from several threads, **create one `Bridge` per thread**.
///
/// This is not a conservative choice; it is what the native library requires. A `Bridge` holds a
/// `graal_isolatethread_t*`, and that handle belongs to the OS thread that created it — it carries
/// that thread's stack bounds and the VM's thread-local state, including the result/error slots the
/// wrapper reads back after each call. Handing it to another thread corrupts the VM.
/// (The *isolate* — the heap — can be shared; the isolate **thread** cannot. Conflating the two is
/// what made the previous `unsafe impl Send for Bridge` unsound: it let safe code do exactly this,
/// with no `unsafe` block anywhere in sight, and it appeared to work right up until it didn't.)
///
/// Moving a `Bridge` to another thread does not compile — and must keep not compiling:
///
/// ```compile_fail
/// let bridge = ccl::Bridge::new().unwrap();
/// std::thread::spawn(move || {
///     let _ = bridge.version(); // error: `*mut c_void` cannot be sent between threads safely
/// });
/// ```
///
/// Use one per thread instead:
///
/// ```no_run
/// let handles: Vec<_> = (0..4)
///     .map(|_| std::thread::spawn(|| {
///         let bridge = ccl::Bridge::new()?;   // each thread owns its own isolate
///         bridge.version()
///     }))
///     .collect();
/// # Ok::<(), ccl::CclError>(())
/// ```
pub struct Bridge {
    #[allow(dead_code)]
    isolate: *mut ffi::graal_isolate_t,
    // The single home of the isolate-thread pointer, shared with owned Accounts (Rc: the Bridge
    // is !Send, so no atomics needed). Drop takes the pointer out of the cell (nulling it) before
    // tearing the isolate down, hard-invalidating every outstanding Account in the same act:
    // their calls then fail with a normal CclError instead of touching a dead isolate. Keeping
    // exactly one copy means no future close/reset path can desync Bridge and Accounts.
    pub(crate) shared: std::rc::Rc<BridgeShared>,
    // Raw pointers are already !Send + !Sync, so no negative impl is needed — but that is a load-
    // bearing property of this type, not an accident, and removing this field must not silently
    // make it Send again.
    _not_send: PhantomData<*const ()>,
}

impl Bridge {
    /// Create a new Bridge instance with a GraalVM isolate.
    pub fn new() -> Result<Self> {
        let mut isolate: *mut ffi::graal_isolate_t = ptr::null_mut();
        let mut thread: *mut ffi::graal_isolatethread_t = ptr::null_mut();

        let rc = unsafe {
            ffi::graal_create_isolate(ptr::null_mut(), &mut isolate, &mut thread)
        };

        if rc != 0 {
            return Err(CclError {
                code: rc,
                message: format!("Failed to create GraalVM isolate: {}", rc),
            });
        }

        let bridge = Bridge {
            isolate,
            shared: std::rc::Rc::new(BridgeShared { thread: std::cell::Cell::new(thread) }),
            _not_send: PhantomData,
        };
        bridge.check_version()?;
        Ok(bridge)
    }

    /// Fail fast on a native-lib / wrapper version skew rather than surfacing it later as a confusing
    /// error. The expected version is this crate's own version (`CARGO_PKG_VERSION`, kept in lockstep
    /// with the native lib); compare base semver so pre-release suffixes don't matter. Bypass with
    /// `CCL_SKIP_VERSION_CHECK`.
    fn check_version(&self) -> Result<()> {
        if std::env::var_os("CCL_SKIP_VERSION_CHECK").is_some() {
            return Ok(());
        }
        let lib_ver = self.version()?;
        let expected = env!("CARGO_PKG_VERSION");
        if base_version(&lib_ver) != base_version(expected) {
            return Err(CclError {
                code: -1,
                message: format!(
                    "libccl version '{lib_ver}' is incompatible with the cardano-client-lib Rust \
                     wrapper (expects '{expected}'). The native library and wrapper must be the same \
                     version — rebuild against a matching libccl, or set CCL_LIB_PATH. Set \
                     CCL_SKIP_VERSION_CHECK=1 to bypass."
                ),
            });
        }
        Ok(())
    }

    /// The live isolate thread. Infallible for the Bridge's own methods: while a `&Bridge`
    /// exists, `Drop` cannot have run, so the cell is non-null by construction. (Accounts, which
    /// can outlive the Bridge, go through the fallible [`BridgeShared::thread`] instead.)
    fn thread(&self) -> *mut ffi::graal_isolatethread_t {
        self.shared.thread.get()
    }

    fn check(&self, rc: i32) -> Result<String> {
        check_at(self.thread(), rc)
    }

    /// Get the library version.
    pub fn version(&self) -> Result<String> {
        let rc = unsafe { ffi::ccl_version(self.thread()) };
        self.check(rc)
    }

    /// Get the address namespace API.
    pub fn address(&self) -> AddressApi<'_> {
        AddressApi { bridge: self }
    }

    /// Get the crypto namespace API.
    pub fn crypto(&self) -> CryptoApi<'_> {
        CryptoApi { bridge: self }
    }

    /// Get the transaction namespace API.
    pub fn tx(&self) -> TxApi<'_> {
        TxApi { bridge: self }
    }

    /// Get the plutus namespace API.
    pub fn plutus(&self) -> PlutusApi<'_> {
        PlutusApi { bridge: self }
    }

    /// Get the script namespace API.
    pub fn script(&self) -> ScriptApi<'_> {
        ScriptApi { bridge: self }
    }

    /// Managed accounts (ADR-0016): open once, hold an owned Account, sign with typed roles.
    pub fn accounts(&self) -> accounts::AccountsApi<'_> {
        accounts::AccountsApi { bridge: self }
    }

    /// Get the quicktx namespace API.
    pub fn quicktx(&self) -> QuickTxApi<'_> {
        QuickTxApi { bridge: self }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Take the pointer out of the cell (nulling it) before the isolate dies: outstanding
        // Accounts are invalidated in the same act — their calls become typed errors, never
        // dangling-isolate dereferences.
        let thread = self.shared.thread.replace(ptr::null_mut());
        if !thread.is_null() {
            unsafe {
                ffi::graal_tear_down_isolate(thread);
            }
        }
    }
}

// --- AddressApi ---

pub struct AddressApi<'a> {
    bridge: &'a Bridge,
}

impl<'a> AddressApi<'a> {
    pub fn info(&self, bech32: &str) -> Result<String> {
        let cs = to_cstring(bech32)?;
        let rc = unsafe { ffi::ccl_address_info(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn validate(&self, bech32: &str) -> bool {
        let cs = match CString::new(bech32) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let rc = unsafe { ffi::ccl_address_validate(self.bridge.thread(), cs.as_ptr()) };
        rc == error_codes::CCL_SUCCESS
    }

    pub fn to_bytes(&self, bech32: &str) -> Result<String> {
        let cs = to_cstring(bech32)?;
        let rc = unsafe { ffi::ccl_address_to_bytes(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn from_bytes(&self, hex_bytes: &str) -> Result<String> {
        let cs = to_cstring(hex_bytes)?;
        let rc = unsafe { ffi::ccl_address_from_bytes(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }
}

// --- CryptoApi ---

pub struct CryptoApi<'a> {
    bridge: &'a Bridge,
}

impl<'a> CryptoApi<'a> {
    pub fn blake2b_256(&self, data_hex: &str) -> Result<String> {
        let cs = to_cstring(data_hex)?;
        let rc = unsafe { ffi::ccl_crypto_blake2b_256(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn blake2b_224(&self, data_hex: &str) -> Result<String> {
        let cs = to_cstring(data_hex)?;
        let rc = unsafe { ffi::ccl_crypto_blake2b_224(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn generate_mnemonic(&self, word_count: i32) -> Result<String> {
        let rc = unsafe { ffi::ccl_crypto_generate_mnemonic(self.bridge.thread(), word_count) };
        self.bridge.check(rc)
    }

    pub fn validate_mnemonic(&self, mnemonic: &str) -> bool {
        let cs = match CString::new(mnemonic) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let rc = unsafe { ffi::ccl_crypto_validate_mnemonic(self.bridge.thread(), cs.as_ptr()) };
        rc == error_codes::CCL_SUCCESS
    }

    /// Ed25519 sign. `sk_hex` is a 32-byte seed (64 hex chars) or a 64-byte BIP32-Ed25519
    /// extended key (128 hex chars, e.g. `derive_key`'s `private_key`) — detected by length.
    pub fn sign(&self, message_hex: &str, sk_hex: &str) -> Result<String> {
        let cs_msg = to_cstring(message_hex)?;
        let cs_sk = to_cstring(sk_hex)?;
        let rc = unsafe { ffi::ccl_crypto_sign(self.bridge.thread(), cs_msg.as_ptr(), cs_sk.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn verify(&self, signature_hex: &str, message_hex: &str, pk_hex: &str) -> bool {
        let cs_sig = match CString::new(signature_hex) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let cs_msg = match CString::new(message_hex) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let cs_pk = match CString::new(pk_hex) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let rc = unsafe {
            ffi::ccl_crypto_verify(self.bridge.thread(), cs_sig.as_ptr(), cs_msg.as_ptr(), cs_pk.as_ptr())
        };
        rc == error_codes::CCL_SUCCESS
    }

    /// Stateless CIP-1852 key derivation — the explicit "raw key material" utility.
    ///
    /// `role` is one of `"payment"`, `"change"`, `"stake"`, `"drep"`, `"committee_cold"`,
    /// `"committee_hot"`. Returns the JSON `{"path","private_key","public_key","public_key_hash"}`.
    /// Pass `private_key` (the 64-byte extended BIP32-Ed25519 key) whole to [`CryptoApi::sign`],
    /// which detects the extended form by length — never slice it, its first half is a clamped
    /// scalar, not a seed. Key derivation is network-independent. Prefer the managed accounts
    /// API for signing — handles never expose key bytes.
    pub fn derive_key(
        &self,
        mnemonic: &str,
        account_index: i32,
        address_index: i32,
        role: &str,
    ) -> Result<String> {
        let cs_mnemonic = to_cstring(mnemonic)?;
        let cs_role = to_cstring(role)?;
        let rc = unsafe {
            ffi::ccl_crypto_derive_key(
                self.bridge.thread(),
                cs_mnemonic.as_ptr(),
                account_index,
                address_index,
                cs_role.as_ptr(),
            )
        };
        self.bridge.check(rc)
    }
}

// --- TxApi ---

pub struct TxApi<'a> {
    bridge: &'a Bridge,
}

impl<'a> TxApi<'a> {
    pub fn hash(&self, tx_cbor_hex: &str) -> Result<String> {
        let cs = to_cstring(tx_cbor_hex)?;
        let rc = unsafe { ffi::ccl_tx_hash(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn sign_with_secret_key(&self, tx_cbor_hex: &str, sk_cbor_hex: &str) -> Result<String> {
        let cs_tx = to_cstring(tx_cbor_hex)?;
        let cs_sk = to_cstring(sk_cbor_hex)?;
        let rc = unsafe {
            ffi::ccl_tx_sign_with_secret_key(self.bridge.thread(), cs_tx.as_ptr(), cs_sk.as_ptr())
        };
        self.bridge.check(rc)
    }

    pub fn to_json(&self, tx_cbor_hex: &str) -> Result<String> {
        let cs = to_cstring(tx_cbor_hex)?;
        let rc = unsafe { ffi::ccl_tx_to_json(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn from_json(&self, tx_json: &str) -> Result<String> {
        let cs = to_cstring(tx_json)?;
        let rc = unsafe { ffi::ccl_tx_from_json(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn deserialize(&self, tx_cbor_hex: &str) -> Result<String> {
        let cs = to_cstring(tx_cbor_hex)?;
        let rc = unsafe { ffi::ccl_tx_deserialize(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }
}

// --- PlutusApi ---

pub struct PlutusApi<'a> {
    bridge: &'a Bridge,
}

impl<'a> PlutusApi<'a> {
    pub fn data_hash(&self, datum_cbor_hex: &str) -> Result<String> {
        let cs = to_cstring(datum_cbor_hex)?;
        let rc = unsafe { ffi::ccl_plutus_data_hash(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn data_to_json(&self, cbor_hex: &str) -> Result<String> {
        let cs = to_cstring(cbor_hex)?;
        let rc = unsafe { ffi::ccl_plutus_data_to_json(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn data_from_json(&self, json: &str) -> Result<String> {
        let cs = to_cstring(json)?;
        let rc = unsafe { ffi::ccl_plutus_data_from_json(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }
}

// --- ScriptApi ---

pub struct ScriptApi<'a> {
    bridge: &'a Bridge,
}

impl<'a> ScriptApi<'a> {
    pub fn native_from_json(&self, json: &str) -> Result<String> {
        let cs = to_cstring(json)?;
        let rc = unsafe { ffi::ccl_script_native_from_json(self.bridge.thread(), cs.as_ptr()) };
        self.bridge.check(rc)
    }

    pub fn hash(&self, script_cbor_hex: &str, script_type: i32) -> Result<String> {
        let cs = to_cstring(script_cbor_hex)?;
        let rc = unsafe { ffi::ccl_script_hash(self.bridge.thread(), cs.as_ptr(), script_type) };
        self.bridge.check(rc)
    }
}

// --- QuickTx API ---

/// Result from building a transaction.
#[derive(Debug, serde::Deserialize)]
pub struct TxResult {
    pub tx_cbor: String,
    pub tx_hash: String,
    pub fee: String,
}

/// QuickTx namespace API.
pub struct QuickTxApi<'a> {
    bridge: &'a Bridge,
}

impl<'a> QuickTxApi<'a> {
    /// Build an unsigned transaction from a CCL TxPlan (YAML), fully offline.
    ///
    /// `utxos` and `protocol_params` are the caller-supplied chain data (the CCL `Utxo` /
    /// `ProtocolParams` JSON models). The transaction is built offline and never submitted —
    /// sign the returned `tx_cbor` and submit it yourself.
    ///
    /// For Plutus script transactions, pass the redeemers' execution units as `exec_units` — a JSON
    /// array of `{mem, steps}` (one per redeemer, in transaction order). Compute them with any
    /// evaluator (Ogmios, Blockfrost, Aiken, Scalus); the bridge does not run the script. Pass
    /// `None` for non-script transactions.
    ///
    /// `additional_signers` budgets vkey witnesses for fee estimation, beyond those the input
    /// UTXOs imply (one per sender). You know how many keys will sign: `0` for a plain payment,
    /// `1` for a stake or DRep certificate (payment+stake signing), `2` for both in one tx, the
    /// number of `sig` keys for a native-script spend, plus one per plan-level required signer.
    /// Undercounting yields a fee the node rejects with `FeeTooSmallUTxO`; overcounting only
    /// overpays (~4,400 lovelace per extra witness).
    pub fn build(
        &self,
        yaml: &str,
        utxos: &Value,
        protocol_params: &Value,
        exec_units: Option<&Value>,
        additional_signers: u32,
    ) -> Result<TxResult> {
        let utxos_json = serde_json::to_string(utxos).map_err(|e| CclError {
            code: error_codes::CCL_ERROR_SERIALIZATION,
            message: format!("Failed to serialize utxos: {}", e),
        })?;
        let pp_json = serde_json::to_string(protocol_params).map_err(|e| CclError {
            code: error_codes::CCL_ERROR_SERIALIZATION,
            message: format!("Failed to serialize protocol params: {}", e),
        })?;

        let yaml_cs = to_cstring(yaml)?;
        let utxos_cs = to_cstring(&utxos_json)?;
        let pp_cs = to_cstring(&pp_json)?;

        // Optional execution units; null pointer when absent. The CString must outlive the call.
        let exec_cs = match exec_units {
            Some(eu) => {
                let s = serde_json::to_string(eu).map_err(|e| CclError {
                    code: error_codes::CCL_ERROR_SERIALIZATION,
                    message: format!("Failed to serialize exec units: {}", e),
                })?;
                Some(to_cstring(&s)?)
            }
            None => None,
        };
        let exec_ptr = exec_cs.as_ref().map_or(ptr::null(), |c| c.as_ptr());

        let rc = unsafe {
            ffi::ccl_quicktx_build(
                self.bridge.thread(),
                yaml_cs.as_ptr(),
                utxos_cs.as_ptr(),
                pp_cs.as_ptr(),
                exec_ptr,
                additional_signers as c_int,
            )
        };
        // The build result is a YAML document.
        let result = self.bridge.check(rc)?;
        serde_yaml::from_str(&result).map_err(|e| CclError {
            code: error_codes::CCL_ERROR_SERIALIZATION,
            message: format!("Failed to parse tx result: {}", e),
        })
    }
}

#[cfg(test)]
mod version_tests {
    use super::base_version;

    #[test]
    fn base_version_strips_suffix() {
        assert_eq!(base_version("0.1.0"), "0.1.0");
        assert_eq!(base_version("0.1.0-preview1"), "0.1.0");
        assert_eq!(base_version("1.2.3+build.5"), "1.2.3");
        assert_eq!(base_version("  0.1.0  "), "0.1.0");
    }
}
