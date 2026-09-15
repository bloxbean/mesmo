#!/usr/bin/env python3
"""Cross-wrapper @CEntryPoint parity check.

The native lib (`libmesmo`) exports a set of `mesmo_*` `@CEntryPoint` functions. Every language wrapper
must bind *all* of them, or that wrapper silently loses API surface when an entry point is added or
renamed. This check extracts the canonical set from the core Java sources and asserts each wrapper's
FFI bindings match it exactly. Run from anywhere; exits non-zero on any mismatch.

    python3 scripts/check_entrypoint_parity.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Where each wrapper declares its FFI bindings, and the pattern that yields the bound `mesmo_*` names.
# Patterns are anchored to line-start (with MULTILINE) so a commented-out binding does not count.
WRAPPERS = {
    "python": (ROOT / "wrappers/python/mesmo/_ffi.py", r"^\s*lib\.(mesmo_[a-z0-9_]+)\.argtypes"),
    "js":     (ROOT / "wrappers/js/src/index.js",    r"^\s*(mesmo_[a-z0-9_]+):"),
    "rust":   (ROOT / "wrappers/rust/src/ffi.rs",    r"^\s*pub fn (mesmo_[a-z0-9_]+)"),
    "go":     (ROOT / "wrappers/go/mesmo/ffi.go",      r'^\s*reg\(&\w+, "(mesmo_[a-z0-9_]+)"'),
}


def canonical_entrypoints() -> set[str]:
    names: set[str] = set()
    for java in (ROOT / "core/src/main/java").rglob("*.java"):
        names |= set(re.findall(r'@CEntryPoint\(name = "(mesmo_[a-z0-9_]+)"', java.read_text()))
    return names


def bound_names(path: Path, pattern: str) -> set[str]:
    return set(re.findall(pattern, path.read_text(), re.MULTILINE))


def main() -> int:
    canon = canonical_entrypoints()
    if not canon:
        print("ERROR: found no @CEntryPoint functions in core — check the script's paths.")
        return 2
    print(f"Canonical @CEntryPoint functions in core: {len(canon)}\n")

    ok = True
    for name, (path, pattern) in WRAPPERS.items():
        got = bound_names(path, pattern)
        missing = canon - got
        extra = got - canon
        status = "OK" if not missing and not extra else "FAIL"
        print(f"  {name:7} binds {len(got):3}  [{status}]")
        if missing:
            print(f"    MISSING (in core, not bound): {', '.join(sorted(missing))}")
        if extra:
            print(f"    EXTRA   (bound, not in core):  {', '.join(sorted(extra))}")
        ok = ok and status == "OK"

    if not ok:
        print(
            "\nParity check FAILED. Every wrapper must bind exactly the core @CEntryPoint set — "
            "add the missing binding(s), or fix the stray one(s)."
        )
        return 1
    print(f"\nParity OK — all {len(WRAPPERS)} wrappers bind all {len(canon)} entry points.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
