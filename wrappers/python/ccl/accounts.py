"""Managed accounts (ADR-0016): open once, hold an opaque handle, sign with typed roles.

The mnemonic crosses the FFI boundary once at open (or never, for created accounts, until the
one-shot recovery-phrase export) instead of travelling with every operation.
"""
import ctypes
import json
from enum import IntFlag

from ccl.network import Network


class SigningRole(IntFlag):
    """Typed signing roles. Combine with ``|``; witnesses are applied in canonical order
    (payment, stake, DRep, committee cold, committee hot) regardless of combination order."""
    PAYMENT = 1
    STAKE = 2
    DREP = 4
    COMMITTEE_COLD = 8
    COMMITTEE_HOT = 16


class Account:
    """A managed account bound to one CIP-1852 payment leaf
    (``m/1852'/1815'/account'/0/address_index``).

    One handle is one payment address; open further handles for further address indices. The
    stake/DRep/committee keys sit at their standard role indices independent of ``address_index``,
    so handles at different address indices of one account share a single stake/DRep identity.

    Lifecycle: use as a context manager or call :meth:`close` — it is idempotent, and any call
    after close raises :class:`ccl.CclInvalidHandleError`. Garbage collection closes as a fallback
    only; do not rely on it. The ``repr`` never contains secret material.
    """

    def __init__(self, bridge, handle):
        self._b = bridge
        self._handle = handle
        self._info = None

    @property
    def info(self):
        """Public account data: the base/enterprise/stake/change addresses, network and
        derivation indices, ``drep_id``, and the committee identifiers/credentials. Never contains secrets. Immutable for the handle's
        lifetime, so it is fetched once and memoized (a fresh copy is returned per access)."""
        if self._info is None:
            rc = self._b._lib.ccl_account_get_info(self._b._thread, self._handle)
            self._info = json.loads(self._b._check(rc))
        return dict(self._info)

    def sign_tx(self, tx_cbor_hex, roles=SigningRole.PAYMENT):
        """Sign a transaction with the selected roles; returns the signed CBOR hex.

        ``roles`` is a :class:`SigningRole` combination (or a plain int mask), e.g.
        ``SigningRole.PAYMENT | SigningRole.STAKE`` for a stake-certificate transaction. An empty
        mask is rejected — signing never silently uses every key.
        """
        rc = self._b._lib.ccl_account_sign_tx_handle(
            self._b._thread, self._handle, self._b._encode(tx_cbor_hex), int(roles))
        return self._b._check(rc)

    def export_recovery_phrase(self):
        """One-shot export of a freshly created account's recovery phrase.

        Only available on accounts from :meth:`Accounts.create`, and only once — the phrase is
        removed on retrieval. Accounts opened from a mnemonic raise (the caller already holds the
        phrase). Persist the returned value securely; nothing else ever returns it.
        """
        # Delivered via out-param in the SAME call — never through the read-once result slot.
        # The native side destroys its pending copy only after this string is materialized, so
        # a failed delivery is retryable instead of orphaning the only copy of the phrase.
        out = ctypes.c_void_p()
        rc = self._b._lib.ccl_account_export_recovery_phrase(
            self._b._thread, self._handle, ctypes.byref(out))
        if rc != self._b.CCL_SUCCESS:
            from ccl._ffi import CclError, CclInvalidHandleError
            error = self._b._get_error()
            if rc == self._b.CCL_ERROR_INVALID_HANDLE:
                raise CclInvalidHandleError(rc, error or f"Unknown error (code {rc})")
            raise CclError(rc, error or f"Unknown error (code {rc})")
        phrase = ctypes.string_at(out.value).decode("utf-8")
        self._b._lib.ccl_free_string(self._b._thread, out)
        return phrase

    def close(self):
        """Release the native account state. Idempotent; further use raises
        :class:`ccl.CclInvalidHandleError`."""
        handle, self._handle = self._handle, 0  # 0 is never a valid handle
        self._info = None
        if handle and not getattr(self._b, "_closed", True):
            rc = self._b._lib.ccl_account_close(self._b._thread, handle)
            # Deliberately NOT self._b._check(rc): on success _check drains the
            # READ-ONCE result slot, and close() also runs from __del__ during
            # cyclic GC — which can fire between another call's native return and
            # its result fetch, on this same thread. ccl_account_close produces no
            # result, so on success there is nothing to read; draining here would
            # steal that in-flight call's pending result.
            if rc != self._b.CCL_SUCCESS:
                from ccl._ffi import CclError
                error = self._b._get_error()
                raise CclError(rc, error or f"Unknown error (code {rc})")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass  # fallback only; never raise from a finalizer

    def __repr__(self):
        state = "closed" if not self._handle else f"handle={self._handle}"
        return f"<ccl.Account {state}>"


class Accounts:
    """Managed-accounts namespace (``lib.accounts``)."""

    def __init__(self, bridge):
        self._b = bridge

    def from_mnemonic(self, mnemonic, network, account_index=0, address_index=0):
        """Open an account from a mnemonic at fixed derivation indices; returns :class:`Account`.

        The mnemonic crosses the boundary once, here; no later operation needs it.
        """
        handle = ctypes.c_int64(0)
        rc = self._b._lib.ccl_account_open_mnemonic(
            self._b._thread, Network(network), self._b._encode(mnemonic),
            account_index, address_index, ctypes.byref(handle))
        self._b._check(rc)
        return Account(self._b, handle.value)

    def create(self, network):
        """Create a brand-new account (fresh 24-word mnemonic); returns :class:`Account`.

        No secret is returned here — retrieve the recovery phrase once, deliberately, with
        :meth:`Account.export_recovery_phrase`.
        """
        handle = ctypes.c_int64(0)
        rc = self._b._lib.ccl_account_create_handle(
            self._b._thread, Network(network), ctypes.byref(handle))
        self._b._check(rc)
        return Account(self._b, handle.value)
