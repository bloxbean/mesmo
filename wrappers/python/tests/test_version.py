"""Tests for the native-lib / wrapper version-skew check."""

import pytest

import mesmo._ffi as ffi


def test_base_version_strips_suffix():
    assert ffi._base_version("0.1.0") == "0.1.0"
    assert ffi._base_version("0.1.0-preview1") == "0.1.0"
    assert ffi._base_version("1.2.3+build.5") == "1.2.3"
    assert ffi._base_version("  0.1.0  ") == "0.1.0"


def test_matching_version_loads():
    # The bundled/in-tree lib matches EXPECTED_LIB_VERSION, so construction succeeds.
    lib = ffi.Mesmo()
    assert ffi._base_version(lib.version()) == ffi._base_version(ffi.EXPECTED_LIB_VERSION)


def test_version_mismatch_raises(monkeypatch):
    monkeypatch.setattr(ffi, "EXPECTED_LIB_VERSION", "9.9.9")
    monkeypatch.delenv("MESMO_SKIP_VERSION_CHECK", raising=False)
    with pytest.raises(RuntimeError, match="incompatible"):
        ffi.Mesmo()


def test_version_mismatch_bypassed_by_env(monkeypatch):
    monkeypatch.setattr(ffi, "EXPECTED_LIB_VERSION", "9.9.9")
    monkeypatch.setenv("MESMO_SKIP_VERSION_CHECK", "1")
    lib = ffi.Mesmo()  # must not raise despite the (fake) mismatch
    assert lib.version()
