# Building the JavaScript bindings from source

For working in a checkout of this repository: building the npm package yourself, and running the
bindings and examples against a locally built `libmesmo`.

**If you installed `@bloxbean/mesmo` you do not need any of this** — the platform package bundles
the matching library. This page is for contributors, and for platforms with no published package.

> **Bun only.** Node.js is not supported: its FFI libraries (ffi-napi, koffi) crash against the
> GraalVM native library due to stack-boundary detection. See
> [`TODO.md`](../../TODO.md) Non-Goals.

## 1. Get `libmesmo`

Prerequisites (Oracle GraalVM) and the build itself are in the
[root README](../../README.md#prerequisites). From the repository root, either:

```bash
./gradlew :core:nativeCompile   # build it (needs GraalVM native-image)
make download-lib               # or download the pre-built binary for this platform
```

Both leave it in `core/build/native/nativeCompile/` as `libmesmo.dylib` / `libmesmo.so` /
`libmesmo.dll`.

## 2. Build a package tarball (optional)

The tarball bundles the library into `libs/`, so an installed package needs no environment
variables:

```bash
./gradlew :wrappers:js:pack               # -> wrappers/js/bloxbean-mesmo-*.tgz
bun add ./wrappers/js/bloxbean-mesmo-0.1.0.tgz
```

## 3. Or run directly against the library

Bun's FFI loads the library through the OS loader, so it needs its own search path in addition to
`MESMO_LIB_PATH`. From `wrappers/js`:

```bash
LIB_DIR=../../core/build/native/nativeCompile

MESMO_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
  bun examples/account.js
```

`DYLD_LIBRARY_PATH` is macOS, `LD_LIBRARY_PATH` is Linux — setting both is harmless.

**Resolution order:** an explicit `new Mesmo(libPath)`, then `MESMO_LIB_PATH`, then the copy bundled
in `libs/`.

## Tests

```bash
./gradlew :wrappers:js:test               # builds libmesmo from source first
./gradlew :wrappers:js:test -PusePrebuilt # or against the downloaded binary
```

## Versions must match

The bindings check that the loaded `libmesmo` reports their own version and fail with a version-skew
error otherwise, so pair a wrapper from this checkout with a library built from it.

`version` in `gradle.properties` is the single source of truth — after changing it run
`./gradlew syncVersions` (and `./gradlew checkVersions` to verify; it also runs before every wrapper
test).
