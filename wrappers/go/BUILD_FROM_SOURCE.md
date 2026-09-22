# Building the Go bindings from source

For working in a checkout of this repository: running the bindings and examples against a locally
built `libmesmo`.

**If you `go get github.com/bloxbean/mesmo/wrappers/go` you do not need any of this.** The loader
resolves the library itself — `MESMO_LIB_PATH`, then a per-version cache, then a one-time download
from the matching GitHub release. There is no cgo and no C toolchain involved (see
[ADR-0014](../../docs/adr/0014-go-distribution-purego-runtime-resolution.md)).

## 1. Get `libmesmo`

Prerequisites (Oracle GraalVM) and the build itself are in the
[root README](../../README.md#prerequisites). From the repository root, either:

```bash
./gradlew :core:nativeCompile   # build it (needs GraalVM native-image)
make download-lib               # or download the pre-built binary for this platform
```

Both leave it in `core/build/native/nativeCompile/` as `libmesmo.dylib` / `libmesmo.so` /
`libmesmo.dll`.

## 2. Build and run

purego loads the library at runtime, so no loader variables are needed. From `wrappers/go`:

```bash
go run ./examples/account
```

That downloads the release library on first use. To use the local build instead, point
`MESMO_LIB_PATH` at the directory holding it:

```bash
MESMO_LIB_PATH=../../core/build/native/nativeCompile go run ./examples/account
```

**Resolution order:** `MESMO_LIB_PATH` (a directory or the library file), then the per-version cache
at `os.UserCacheDir()/mesmo/<version>/`, then a download from the GitHub release.
`MESMO_LIB_VERSION` pins a different release. Resolution is fail-hard: a bad download errors rather
than silently using a stale library.

## Tests

```bash
./gradlew :wrappers:go:test               # builds libmesmo from source first
./gradlew :wrappers:go:test -PusePrebuilt # or against the downloaded binary
```

## Versions must match

The bindings check that the loaded `libmesmo` reports their own version and fail with a version-skew
error otherwise, so pair a wrapper from this checkout with a library built from it.

`version` in `gradle.properties` is the single source of truth — after changing it run
`./gradlew syncVersions` (and `./gradlew checkVersions` to verify; it also runs before every wrapper
test). For Go that stamps `defaultLibVersion` in `mesmo/loader.go`, which is the release the loader
downloads.
