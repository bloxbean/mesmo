"""Unit tests for how MesmoLib locates the native library.

These don't load the library (they only exercise the path-resolution logic), so they run without a
built libmesmo.
"""
import os

from mesmo._ffi import MesmoLib


def test_explicit_lib_path_wins(monkeypatch):
    monkeypatch.setenv("MESMO_LIB_PATH", "/env/dir")
    name = MesmoLib._lib_filename()
    assert MesmoLib._resolve_lib_file("/opt/dir") == os.path.join("/opt/dir", name)


def test_env_var_used_when_no_explicit_path(monkeypatch):
    monkeypatch.setenv("MESMO_LIB_PATH", "/env/dir")
    # even if a bundled lib exists, an explicit env override takes precedence
    monkeypatch.setattr(os.path, "exists", lambda p: True)
    name = MesmoLib._lib_filename()
    assert MesmoLib._resolve_lib_file() == os.path.join("/env/dir", name)


def test_bundled_lib_preferred_when_no_env(monkeypatch):
    monkeypatch.delenv("MESMO_LIB_PATH", raising=False)
    monkeypatch.setattr(os.path, "exists", lambda p: True)  # pretend the bundled lib is present
    resolved = MesmoLib._resolve_lib_file()
    assert resolved.endswith(os.path.join("_libs", MesmoLib._lib_filename()))


def test_bare_filename_fallback(monkeypatch):
    monkeypatch.delenv("MESMO_LIB_PATH", raising=False)
    monkeypatch.setattr(os.path, "exists", lambda p: False)  # nothing bundled
    assert MesmoLib._resolve_lib_file() == MesmoLib._lib_filename()
