//! Managed accounts (ADR-0016): open once, hold an **owned** [`Account`], sign with typed roles.
//!
//! The mnemonic crosses the FFI boundary once at open (or never, for created accounts, until the
//! one-shot recovery-phrase export) instead of travelling with every operation.
//!
//! Ownership model (ADR-0016, as amended): an `Account` is an owned value — not a borrow of the
//! [`crate::Bridge`] — holding shared, close-aware access to the bridge's isolate state.
//! It can live in the same struct as its `Bridge`. Validity is enforced at runtime: any call after
//! the account's `close()` — or after the `Bridge` itself is dropped — fails with a normal
//! [`CclError`] (`CCL_ERROR_INVALID_HANDLE`, `-11`), never by touching a dead isolate. Like the
//! `Bridge`, an `Account` is `!Send`.

use std::cell::Cell;
use std::ops::BitOr;
use std::rc::Rc;

use serde_json::Value;

use crate::{check_at, error_codes, ffi, to_cstring, Bridge, BridgeShared, CclError, Network, Result};

/// Typed signing roles. Combine with `|`; witnesses are applied in canonical order
/// (payment, stake, DRep, committee cold, committee hot) regardless of combination order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SigningRole(pub u32);

impl SigningRole {
    pub const PAYMENT: SigningRole = SigningRole(1);
    pub const STAKE: SigningRole = SigningRole(1 << 1);
    pub const DREP: SigningRole = SigningRole(1 << 2);
    pub const COMMITTEE_COLD: SigningRole = SigningRole(1 << 3);
    pub const COMMITTEE_HOT: SigningRole = SigningRole(1 << 4);
}

impl BitOr for SigningRole {
    type Output = SigningRole;
    fn bitor(self, rhs: SigningRole) -> SigningRole {
        SigningRole(self.0 | rhs.0)
    }
}

/// Managed-accounts namespace, obtained via [`Bridge::accounts`](crate::Bridge::accounts).
pub struct AccountsApi<'a> {
    pub(crate) bridge: &'a Bridge,
}

impl<'a> AccountsApi<'a> {
    /// Open an account from a mnemonic at fixed derivation indices; returns an owned
    /// [`Account`]. The mnemonic crosses the boundary once, here.
    pub fn from_mnemonic(
        &self,
        mnemonic: &str,
        network: Network,
        account_index: u32,
        address_index: u32,
    ) -> Result<Account> {
        let mnemonic_cs = to_cstring(mnemonic)?;
        let mut handle: i64 = 0;
        let thread = self.bridge.shared.thread()?;
        let rc = unsafe {
            ffi::ccl_account_open_mnemonic(
                thread,
                network.into(),
                mnemonic_cs.as_ptr(),
                account_index as i32,
                address_index as i32,
                &mut handle,
            )
        };
        check_at(thread, rc)?;
        Ok(Account {
            shared: Rc::clone(&self.bridge.shared),
            handle: Cell::new(handle),
        })
    }

    /// Create a brand-new account (fresh 24-word mnemonic); returns an owned [`Account`].
    ///
    /// No secret is returned here — retrieve the recovery phrase once, deliberately, with
    /// [`Account::export_recovery_phrase`].
    pub fn create(&self, network: Network) -> Result<Account> {
        let mut handle: i64 = 0;
        let thread = self.bridge.shared.thread()?;
        let rc = unsafe { ffi::ccl_account_create_handle(thread, network.into(), &mut handle) };
        check_at(thread, rc)?;
        Ok(Account {
            shared: Rc::clone(&self.bridge.shared),
            handle: Cell::new(handle),
        })
    }
}

/// A managed account bound to one CIP-1852 payment leaf
/// (`m/1852'/1815'/account'/0/address_index`).
///
/// One handle is one payment address; open further accounts for further address indices. The
/// stake/DRep/committee keys sit at their standard role indices independent of `address_index`,
/// so accounts at different address indices of one account index share a single stake/DRep
/// identity.
///
/// Dropping the value closes the native handle (best-effort); [`close`](Account::close) is the
/// explicit, idempotent form. The `Debug` representation never contains secret material.
pub struct Account {
    shared: Rc<BridgeShared>,
    // 0 after close — never a valid handle, so the native registry stays the single authority.
    handle: Cell<i64>,
}

impl Account {
    /// Public account data: `{"base_address", "enterprise_address", "stake_address",
    /// "change_address", "network", "account_index", "address_index", "drep_id",
    /// "committee_cold_id", "committee_cold_credential", "committee_hot_id",
    /// "committee_hot_credential"}`. Never contains secrets.
    pub fn info(&self) -> Result<Value> {
        let thread = self.shared.thread()?;
        let rc = unsafe { ffi::ccl_account_get_info(thread, self.handle.get()) };
        let json = check_at(thread, rc)?;
        serde_json::from_str(&json).map_err(|e| CclError {
            code: error_codes::CCL_ERROR_SERIALIZATION,
            message: format!("Failed to parse account info: {}", e),
        })
    }

    /// Sign a transaction with the selected roles; returns the signed CBOR hex.
    ///
    /// `roles` is a [`SigningRole`] combination, e.g.
    /// `SigningRole::PAYMENT | SigningRole::STAKE` for a stake-certificate transaction. An empty
    /// mask is rejected — signing never silently uses every key.
    pub fn sign_tx(&self, tx_cbor_hex: &str, roles: SigningRole) -> Result<String> {
        let tx_cs = to_cstring(tx_cbor_hex)?;
        let thread = self.shared.thread()?;
        let rc = unsafe {
            ffi::ccl_account_sign_tx_handle(thread, self.handle.get(), tx_cs.as_ptr(), roles.0 as i32)
        };
        check_at(thread, rc)
    }

    /// One-shot export of a freshly created account's recovery phrase.
    ///
    /// Only available on accounts from [`AccountsApi::create`], and only once — the phrase is
    /// removed on retrieval. Accounts opened from a mnemonic fail (the caller already holds the
    /// phrase). Persist the returned value securely; nothing else ever returns it.
    pub fn export_recovery_phrase(&self) -> Result<String> {
        // Delivered via out-param in the SAME call — never through the read-once result slot.
        // The native side destroys its pending copy only after the string is materialized, so
        // a failed delivery is retryable instead of orphaning the only copy of the phrase.
        let thread = self.shared.thread()?;
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = unsafe {
            ffi::ccl_account_export_recovery_phrase(thread, self.handle.get(), &mut out)
        };
        if rc != crate::error_codes::CCL_SUCCESS {
            return Err(crate::CclError { code: rc, message: crate::get_error_at(thread) });
        }
        let phrase = unsafe { std::ffi::CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        unsafe { ffi::ccl_free_string(thread, out) };
        Ok(phrase)
    }

    /// Release the native account state. Idempotent; further use fails with
    /// `CCL_ERROR_INVALID_HANDLE` (`-11`).
    pub fn close(&self) -> Result<()> {
        let handle = self.handle.replace(0); // 0 is never a valid handle
        if handle != 0 {
            if let Ok(thread) = self.shared.thread() {
                let rc = unsafe { ffi::ccl_account_close(thread, handle) };
                check_at(thread, rc)?;
            }
        }
        Ok(())
    }
}

impl Drop for Account {
    fn drop(&mut self) {
        let _ = self.close(); // fallback only; never panic from a destructor
    }
}

impl std::fmt::Debug for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let handle = self.handle.get();
        if handle == 0 {
            write!(f, "<ccl::Account closed>")
        } else {
            write!(f, "<ccl::Account handle={}>", handle)
        }
    }
}
