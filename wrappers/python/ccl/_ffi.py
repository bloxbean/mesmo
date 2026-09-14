import ctypes
import os
import sys
import json
import threading
from ctypes import c_int, c_char_p, c_void_p, POINTER, byref

from ccl.network import Network

# Native libccl version this wrapper expects, kept in lockstep with the package version. On init the
# wrapper compares it against ccl_version() and fails fast on a skew (see CclLib._check_version).
EXPECTED_LIB_VERSION = "0.1.0"


def _base_version(v):
    """Strip any pre-release / build suffix: '0.1.0-preview1' -> '0.1.0'."""
    return v.split("-", 1)[0].split("+", 1)[0].strip()


class CclLib:
    """Low-level FFI wrapper around libccl shared library."""

    # Error codes
    CCL_SUCCESS = 0
    CCL_ERROR_GENERAL = -1
    CCL_ERROR_INVALID_ARGUMENT = -2
    CCL_ERROR_SERIALIZATION = -3
    CCL_ERROR_CRYPTO = -4
    CCL_ERROR_INVALID_NETWORK = -5
    CCL_ERROR_INVALID_MNEMONIC = -6
    CCL_ERROR_INVALID_ADDRESS = -7
    CCL_ERROR_INSUFFICIENT_FUNDS = -8
    CCL_ERROR_INVALID_TRANSACTION = -9
    # Raised for a malformed TxPlan — the most common failure on the core build path.
    CCL_ERROR_TX_BUILD = -10
    CCL_ERROR_INVALID_HANDLE = -11

    # Networks. Kept as aliases of the Network enum for the call sites that predate it — prefer
    # `from ccl import Network`. NB these are CCL's enum ordinals, not Cardano's on-chain network
    # id (MAINNET is 0 here, but a mainnet address's on-chain network_id is 1); see ccl/network.py.
    MAINNET = Network.MAINNET
    TESTNET = Network.TESTNET

    @staticmethod
    def _lib_filename():
        if sys.platform == 'darwin':
            return 'libccl.dylib'
        if sys.platform == 'win32':
            return 'libccl.dll'
        return 'libccl.so'

    @classmethod
    def _resolve_lib_file(cls, lib_path=None):
        """Locate the native library, in priority order:

        1. an explicit ``lib_path`` argument (a directory), if given;
        2. the ``CCL_LIB_PATH`` env var (a directory) — for development against a locally built lib;
        3. the copy bundled inside this package (``ccl/_libs/``) — how an installed wheel ships it;
        4. the bare filename, letting the system loader search its default paths.
        """
        name = cls._lib_filename()
        if lib_path:
            return os.path.join(lib_path, name)
        env = os.environ.get('CCL_LIB_PATH')
        if env:
            return os.path.join(env, name)
        bundled = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_libs', name)
        if os.path.exists(bundled):
            return bundled
        return name

    def __init__(self, lib_path=None):
        # Set first: __del__ runs even if __init__ raises below (e.g. the library fails to load), and
        # close() must be able to tell "never opened" from "open" without tripping over a half-built
        # object and masking the real error with an AttributeError.
        self._closed = True
        self._main_thread = None

        lib_file = self._resolve_lib_file(lib_path)
        # On Windows, register the library's directory so the loader can also find any sibling
        # DLL dependencies next to libccl.dll (no-op / absent on Unix).
        if sys.platform == 'win32' and hasattr(os, 'add_dll_directory'):
            lib_dir = os.path.dirname(os.path.abspath(lib_file))
            if os.path.isdir(lib_dir):
                os.add_dll_directory(lib_dir)
        try:
            self._lib = ctypes.CDLL(lib_file)
        except OSError as e:
            raise OSError(
                f"Failed to load the CCL native library ({lib_file}): {e}\n"
                f"Install a platform wheel that bundles it, or set CCL_LIB_PATH to the "
                f"directory containing {self._lib_filename()}."
            ) from None
        self._setup_functions()
        self._isolate = c_void_p()
        main_thread = c_void_p()
        rc = self._lib.graal_create_isolate(None, byref(self._isolate), byref(main_thread))
        if rc != 0:
            raise RuntimeError(f"Failed to create GraalVM isolate: {rc}")
        self._main_thread = main_thread

        # A GraalVM IsolateThread is bound to the OS thread that created it, so it cannot be shared
        # across threads — every thread needs its own, obtained via graal_attach_thread. See the
        # _thread property, which attaches lazily and keeps each thread's handle here.
        self._local = threading.local()
        self._local.thread = main_thread
        self._closed = False

        self._check_version()

        # Namespace APIs
        from ccl.address import Address
        from ccl.crypto import Crypto
        from ccl.transaction import Transaction
        from ccl.plutus import Plutus
        from ccl.script import Script
        from ccl.quicktx import QuickTx
        from ccl.accounts import Accounts

        self.accounts = Accounts(self)
        self.address = Address(self)
        self.crypto = Crypto(self)
        self.tx = Transaction(self)
        self.plutus = Plutus(self)
        self.script = Script(self)
        self.quicktx = QuickTx(self)

    def _setup_functions(self):
        lib = self._lib

        # Lifecycle
        lib.graal_create_isolate.argtypes = [c_void_p, POINTER(c_void_p), POINTER(c_void_p)]
        lib.graal_create_isolate.restype = c_int

        lib.graal_tear_down_isolate.argtypes = [c_void_p]
        lib.graal_tear_down_isolate.restype = c_int

        # Per-thread isolate attachment (see the _thread property) and a teardown that first detaches
        # every thread that attached itself.
        lib.graal_attach_thread.argtypes = [c_void_p, POINTER(c_void_p)]
        lib.graal_attach_thread.restype = c_int

        lib.graal_detach_all_threads_and_tear_down_isolate.argtypes = [c_void_p]
        lib.graal_detach_all_threads_and_tear_down_isolate.restype = c_int

        lib.ccl_version.argtypes = [c_void_p]
        lib.ccl_version.restype = c_int

        lib.ccl_get_result.argtypes = [c_void_p]
        lib.ccl_get_result.restype = c_void_p

        lib.ccl_get_last_error.argtypes = [c_void_p]
        lib.ccl_get_last_error.restype = c_void_p

        lib.ccl_free_string.argtypes = [c_void_p, c_void_p]
        lib.ccl_free_string.restype = None

        # Address API
        lib.ccl_address_info.argtypes = [c_void_p, c_char_p]
        lib.ccl_address_info.restype = c_int

        lib.ccl_address_to_bytes.argtypes = [c_void_p, c_char_p]
        lib.ccl_address_to_bytes.restype = c_int

        lib.ccl_address_from_bytes.argtypes = [c_void_p, c_char_p]
        lib.ccl_address_from_bytes.restype = c_int

        lib.ccl_address_validate.argtypes = [c_void_p, c_char_p]
        lib.ccl_address_validate.restype = c_int

        # Crypto API
        lib.ccl_crypto_blake2b_256.argtypes = [c_void_p, c_char_p]
        lib.ccl_crypto_blake2b_256.restype = c_int

        lib.ccl_crypto_blake2b_224.argtypes = [c_void_p, c_char_p]
        lib.ccl_crypto_blake2b_224.restype = c_int

        lib.ccl_crypto_generate_mnemonic.argtypes = [c_void_p, c_int]
        lib.ccl_crypto_generate_mnemonic.restype = c_int

        lib.ccl_crypto_validate_mnemonic.argtypes = [c_void_p, c_char_p]
        lib.ccl_crypto_validate_mnemonic.restype = c_int

        lib.ccl_crypto_sign.argtypes = [c_void_p, c_char_p, c_char_p]
        lib.ccl_crypto_sign.restype = c_int

        lib.ccl_crypto_verify.argtypes = [c_void_p, c_char_p, c_char_p, c_char_p]
        lib.ccl_crypto_verify.restype = c_int

        lib.ccl_crypto_derive_key.argtypes = [c_void_p, c_char_p, c_int, c_int, c_char_p]
        lib.ccl_crypto_derive_key.restype = c_int

        # Transaction API
        lib.ccl_tx_sign_with_secret_key.argtypes = [c_void_p, c_char_p, c_char_p]
        lib.ccl_tx_sign_with_secret_key.restype = c_int

        lib.ccl_tx_hash.argtypes = [c_void_p, c_char_p]
        lib.ccl_tx_hash.restype = c_int

        lib.ccl_tx_to_json.argtypes = [c_void_p, c_char_p]
        lib.ccl_tx_to_json.restype = c_int

        lib.ccl_tx_from_json.argtypes = [c_void_p, c_char_p]
        lib.ccl_tx_from_json.restype = c_int

        lib.ccl_tx_deserialize.argtypes = [c_void_p, c_char_p]
        lib.ccl_tx_deserialize.restype = c_int

        # Plutus API
        lib.ccl_plutus_data_hash.argtypes = [c_void_p, c_char_p]
        lib.ccl_plutus_data_hash.restype = c_int

        lib.ccl_plutus_data_to_json.argtypes = [c_void_p, c_char_p]
        lib.ccl_plutus_data_to_json.restype = c_int

        lib.ccl_plutus_data_from_json.argtypes = [c_void_p, c_char_p]
        lib.ccl_plutus_data_from_json.restype = c_int

        # Script API
        lib.ccl_script_native_from_json.argtypes = [c_void_p, c_char_p]
        lib.ccl_script_native_from_json.restype = c_int

        lib.ccl_script_hash.argtypes = [c_void_p, c_char_p, c_int]
        lib.ccl_script_hash.restype = c_int

        # QuickTx API
        lib.ccl_quicktx_build.argtypes = [c_void_p, c_char_p, c_char_p, c_char_p, c_char_p, c_int]
        lib.ccl_quicktx_build.restype = c_int

        # Managed account handles (ADR-0016)
        lib.ccl_account_open_mnemonic.argtypes = [c_void_p, c_int, c_char_p, c_int, c_int,
                                                  POINTER(ctypes.c_int64)]
        lib.ccl_account_open_mnemonic.restype = c_int
        lib.ccl_account_get_info.argtypes = [c_void_p, ctypes.c_int64]
        lib.ccl_account_get_info.restype = c_int
        lib.ccl_account_sign_tx_handle.argtypes = [c_void_p, ctypes.c_int64, c_char_p, c_int]
        lib.ccl_account_sign_tx_handle.restype = c_int
        lib.ccl_account_close.argtypes = [c_void_p, ctypes.c_int64]
        lib.ccl_account_close.restype = c_int
        lib.ccl_account_create_handle.argtypes = [c_void_p, c_int, POINTER(ctypes.c_int64)]
        lib.ccl_account_create_handle.restype = c_int
        lib.ccl_account_export_recovery_phrase.argtypes = [c_void_p, ctypes.c_int64, POINTER(c_void_p)]
        lib.ccl_account_export_recovery_phrase.restype = c_int

    @property
    def _thread(self):
        """The GraalVM IsolateThread for the *calling* thread, attaching it on first use.

        Every FFI call in this package reaches the native library through this property, so it is the
        one place that can enforce both invariants:

        1. **Closed.** After close() the isolate is gone; passing its stale handle to the native side
           aborts the process with an uncatchable GraalVM fatal error ("Failed to enter the specified
           IsolateThread context"), not a Python exception. Raise instead.
        2. **Thread affinity.** An IsolateThread belongs to the OS thread that created it and carries
           that thread's stack bounds and VM thread-locals. Reusing one handle from another thread —
           which is what this class used to do — corrupts the VM: sharing a CclLib across a
           ThreadPoolExecutor killed the interpreter with "Must either be at a safepoint or in native
           mode". Each thread therefore gets its own handle via graal_attach_thread. The Java side's
           result/error state is thread-local too, so concurrent calls stay independent.
        """
        if self._closed:
            raise CclClosedError(
                "CclLib is closed; create a new instance (or don't call it outside its `with` block)"
            )
        thread = getattr(self._local, "thread", None)
        if thread is None:
            thread = c_void_p()
            rc = self._lib.graal_attach_thread(self._isolate, byref(thread))
            if rc != 0:
                raise CclError(rc, f"failed to attach thread to the GraalVM isolate (code {rc})")
            self._local.thread = thread
        return thread

    def _get_result(self):
        """Get the last result string and free it."""
        ptr = self._lib.ccl_get_result(self._thread)
        if not ptr:
            return None
        result = ctypes.string_at(ptr).decode('utf-8')
        self._lib.ccl_free_string(self._thread, ptr)
        return result

    def _get_error(self):
        """Get the last error string and free it."""
        ptr = self._lib.ccl_get_last_error(self._thread)
        if not ptr:
            return None
        error = ctypes.string_at(ptr).decode('utf-8')
        self._lib.ccl_free_string(self._thread, ptr)
        return error

    def _check(self, rc):
        """Check return code and raise if error."""
        if rc != self.CCL_SUCCESS:
            error = self._get_error()
            if rc == self.CCL_ERROR_INVALID_HANDLE:
                raise CclInvalidHandleError(rc, error or f"Unknown error (code {rc})")
            raise CclError(rc, error or f"Unknown error (code {rc})")
        return self._get_result()

    def _encode(self, s):
        """Encode string to bytes for C."""
        if isinstance(s, str):
            return s.encode('utf-8')
        return s

    def close(self):
        """Tear down the isolate. Idempotent; further calls raise CclClosedError.

        Uses graal_detach_all_threads_and_tear_down_isolate rather than graal_tear_down_isolate:
        other threads may have attached themselves (see the _thread property), and tearing down an
        isolate that still has threads attached is undefined.
        """
        # Guarded with getattr: if __init__ raised before these were set (e.g. the library failed to
        # load), __del__ still calls close(), and a bare attribute access would raise a confusing
        # AttributeError on top of the real error.
        if getattr(self, "_closed", True):
            return
        self._closed = True
        main_thread = getattr(self, "_main_thread", None)
        if main_thread:
            self._lib.graal_detach_all_threads_and_tear_down_isolate(main_thread)
            self._main_thread = None

    def __del__(self):
        self.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def version(self):
        rc = self._lib.ccl_version(self._thread)
        return self._check(rc)

    def _check_version(self):
        """Fail fast on a native-lib / wrapper version skew (bypass with CCL_SKIP_VERSION_CHECK)."""
        if os.environ.get("CCL_SKIP_VERSION_CHECK"):
            return
        lib_ver = self.version()
        if _base_version(lib_ver) != _base_version(EXPECTED_LIB_VERSION):
            raise RuntimeError(
                f"libccl version {lib_ver!r} is incompatible with the cardano-client-lib Python "
                f"wrapper (expects {EXPECTED_LIB_VERSION!r}). The native library and wrapper must be "
                f"the same version — reinstall the package, or set CCL_LIB_PATH to a matching libccl. "
                f"Set CCL_SKIP_VERSION_CHECK=1 to bypass."
            )


class CclError(Exception):
    """Exception raised for CCL errors."""

    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(f"CCL Error {code}: {message}")


class CclInvalidHandleError(CclError):
    """Raised when an account handle is unknown, closed, or from another bridge (code -11)."""


class CclClosedError(RuntimeError):
    """Raised when a CclLib is used after close().

    Without this, the stale isolate handle reaches the native library and GraalVM aborts the whole
    process ("Failed to enter the specified IsolateThread context") — not a Python exception, so it
    cannot be caught, and no traceback points at the offending call.
    """
