# Building the Python bindings from source

For working in a checkout of this repository: building the wheel yourself, and running the bindings
and examples against a locally built `libmesmo`.

**If you installed from PyPI you do not need any of this** — the platform wheel bundles the matching
library. This page is for contributors, and for platforms with no published wheel: there is no
source distribution, so an unlisted platform has to build the library and point the bindings at it.

## 1. Get `libmesmo`

Prerequisites (Oracle GraalVM) and the build itself are in the
[root README](../../README.md#prerequisites). From the repository root, either:

```bash
./gradlew :core:nativeCompile   # build it (needs GraalVM native-image)
make download-lib               # or download the pre-built binary for this platform
```

Both leave it in `core/build/native/nativeCompile/` as `libmesmo.dylib` / `libmesmo.so` /
`libmesmo.dll`.

## 2. Build a wheel (optional)

The wheel bundles the library into `mesmo/_libs/`, so an installed wheel needs no environment
variables. Needs `pip install build`:

```bash
./gradlew :wrappers:python:wheel          # -> wrappers/python/dist/mesmo-*.whl
pip install wrappers/python/dist/mesmo-*.whl
```

## 3. Or run directly against the library

`ctypes` loads the library through the OS loader, so it needs its own search path in addition to
`MESMO_LIB_PATH`. From the repository root:

```bash
LIB_DIR=$PWD/core/build/native/nativeCompile

PYTHONPATH=wrappers/python \
MESMO_LIB_PATH=$LIB_DIR \
DYLD_LIBRARY_PATH=$LIB_DIR \
LD_LIBRARY_PATH=$LIB_DIR \
  python3 wrappers/python/examples/01_account_and_keys.py
```

`DYLD_LIBRARY_PATH` is macOS, `LD_LIBRARY_PATH` is Linux — setting both is harmless.

**Resolution order:** an explicit `Mesmo(lib_path=...)`, then `MESMO_LIB_PATH`, then the copy
bundled in `mesmo/_libs/`.

## Tests

```bash
./gradlew :wrappers:python:test               # builds libmesmo from source first
./gradlew :wrappers:python:test -PusePrebuilt # or against the downloaded binary
```

## Versions must match

The bindings check that the loaded `libmesmo` reports their own version and fail with a version-skew
error otherwise, so pair a wrapper from this checkout with a library built from it.

`version` in `gradle.properties` is the single source of truth — after changing it run
`./gradlew syncVersions` (and `./gradlew checkVersions` to verify; it also runs before every wrapper
test).
