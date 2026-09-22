# Building the Rust bindings from source

For working in a checkout of this repository: building the crate against a locally built
`libmesmo`, and running the examples.

**If you `cargo add mesmo` you do not need any of this.** The crate carries source and `build.rs`
only — crates.io cannot host the ~50 MB binary — and `build.rs` downloads the library from the
GitHub release matching the crate version, stages it and sets an `rpath`, so linking and runtime
work with no environment variables (see
[ADR-0012](../../docs/adr/0012-native-lib-bundled-in-wrapper-packages.md)).

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

In a checkout there is nothing to configure — `build.rs` finds the in-tree build automatically, and
no loader variables are needed because it sets an `rpath`. From `wrappers/rust`:

```bash
cargo build
cargo run --example account
```

To build against a library elsewhere, point `MESMO_LIB_PATH` at the directory holding it:

```bash
MESMO_LIB_PATH=../../core/build/native/nativeCompile cargo run --example account
```

**Resolution order** in `build.rs`: `MESMO_LIB_PATH`, then the in-tree monorepo build, then a
download from the GitHub release for the crate version. `MESMO_LIB_VERSION` overrides which release
that last step fetches — useful for building an unreleased version against the previous library.

The asset name `build.rs` requests must match what `release.yml` uploads;
`tests/version_sync_test.rs` cross-checks the two, since nothing else exercises the download path
before publishing.

## Tests

```bash
./gradlew :wrappers:rust:test               # builds libmesmo from source first
./gradlew :wrappers:rust:test -PusePrebuilt # or against the downloaded binary
```

## Versions must match

The bindings check that the loaded `libmesmo` reports their own version and fail with a version-skew
error otherwise, so pair a wrapper from this checkout with a library built from it.

`version` in `gradle.properties` is the single source of truth — after changing it run
`./gradlew syncVersions` (and `./gradlew checkVersions` to verify; it also runs before every wrapper
test). `Cargo.toml` is stamped from it, and `build.rs` derives the release tag from `Cargo.toml`.
