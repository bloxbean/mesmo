"""Isolate lifecycle: thread affinity and use-after-close.

Both behaviours these tests pin down used to end the *process*, not the test — GraalVM aborts, which
Python cannot catch — so each test here is one that could not previously fail politely.

Each test builds its own CclLib rather than using the shared `ccl` fixture: they close it, and one
attaches extra threads to its isolate.
"""

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from ccl import CclClosedError, CclLib, Network


def test_shared_instance_is_usable_from_many_threads():
    """One CclLib, many threads.

    A GraalVM IsolateThread belongs to the OS thread that created it. This class used to hand the
    creating thread's handle to every caller, so any threaded server (Flask/FastAPI/gunicorn) would
    eventually die with "Must either be at a safepoint or in native mode" — a fatal VM error, not an
    exception. Each thread now attaches its own handle (see CclLib._thread).
    """
    with CclLib() as lib:

        def work(_):
            with lib.accounts.create(Network.TESTNET) as acct:
                base_address = acct.info["base_address"]
            info = lib.address.info(base_address)
            return info["network_id"]

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(work, range(40)))

    assert len(results) == 40
    assert set(results) == {0}, "every worker should have produced a testnet address"


def test_calls_after_close_raise_instead_of_aborting():
    """Use-after-close must raise, not abort.

    close() tore down the isolate but left the stale handle reachable, so the next call passed it to
    the native side and GraalVM killed the process ("Failed to enter the specified IsolateThread
    context"). Uncatchable, and no traceback pointed at the call.
    """
    lib = CclLib()
    lib.close()

    with pytest.raises(CclClosedError):
        lib.accounts.create(Network.TESTNET)

    with pytest.raises(CclClosedError):
        lib.version()


def test_close_is_idempotent():
    lib = CclLib()
    lib.close()
    lib.close()  # must not tear the isolate down twice


def test_failed_load_raises_cleanly():
    """A library that won't load must surface the OSError, not an AttributeError from __del__.

    __init__ raised before the isolate fields existed, so __del__ -> close() tripped over the
    half-built object and printed "'CclLib' object has no attribute '_thread'" on top of the real
    error — the first thing a newcomer with a bad CCL_LIB_PATH ever saw.

    This has to run in a subprocess with the library-path variables stripped. Pointing CclLib at a
    nonexistent directory is not enough on its own: macOS's dyld searches DYLD_LIBRARY_PATH for the
    *leaf name* of a dylib even when it was given an absolute path, so with DYLD_LIBRARY_PATH set —
    which is exactly what the Gradle test task does — "/nonexistent/libccl.dylib" cheerfully
    resolves to the real library and nothing fails. (Linux's glibc does not do this for paths
    containing a slash, so the bug was macOS-only and invisible locally.)
    """
    code = (
        "from ccl import CclLib\n"
        "try:\n"
        "    CclLib(lib_path='/nonexistent-ccl-dir')\n"
        "except OSError as e:\n"
        "    print('OSERROR:', str(e).splitlines()[0])\n"
        "else:\n"
        "    print('NO-ERROR')\n"
    )
    env = {k: v for k, v in os.environ.items()
           if k not in ("CCL_LIB_PATH", "DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH")}
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                          timeout=120, env=env)

    assert "Failed to load the CCL native library" in proc.stdout, (
        f"expected a clean OSError; got stdout={proc.stdout!r} stderr={proc.stderr[-400:]!r}"
    )
    # The actual regression: __del__ must not pile an AttributeError on top of the real error.
    assert "AttributeError" not in proc.stderr, (
        f"__del__ raised on a half-built object: {proc.stderr[-400:]}"
    )


def test_use_after_close_does_not_kill_the_interpreter():
    """Belt and braces: prove the process actually survives.

    The regression this guards against was a process abort, and an aborted interpreter can't report
    its own failure — an in-process assertion would simply vanish. So run it in a subprocess and
    check it exits cleanly.
    """
    code = (
        "from ccl import CclLib, CclClosedError\n"
        "lib = CclLib()\n"
        "lib.close()\n"
        "try:\n"
        "    lib.accounts.create(1)\n"
        "except CclClosedError:\n"
        "    print('raised')\n"
        "print('survived')\n"
    )
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)

    assert proc.returncode == 0, f"interpreter died (rc={proc.returncode}): {proc.stderr[-400:]}"
    assert "raised" in proc.stdout
    assert "survived" in proc.stdout
