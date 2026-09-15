# Troubleshooting (Rust)

## How the native library is obtained

`build.rs` sources `libmesmo.dylib` / `libmesmo.so` / `libmesmo.dll` at **build time**, in this order:

1. **`MESMO_LIB_PATH`** — an explicit directory containing a locally built library.
2. **In-tree build** — `core/build/native/nativeCompile`, when developing inside the `mesmo` repository.
3. **GitHub release download** — the prebuilt library for your target platform, fetched with `curl` and cached in the crate's build directory.

The downloaded release tag is pinned in `build.rs` (kept in lockstep with the crate version); override it with the `MESMO_LIB_VERSION` environment variable.

The library is staged into `OUT_DIR` and an **rpath is emitted automatically**, so nothing is needed at runtime — no `LD_LIBRARY_PATH`, no `DYLD_LIBRARY_PATH`. On macOS the install name is rewritten to `@rpath/libmesmo.dylib`; on Windows the GraalVM import library is staged for the MSVC linker.

Environment variables (build-time):

| Variable | Effect |
|---|---|
| `MESMO_LIB_PATH` | Use a local library instead of the in-tree/download paths |
| `MESMO_LIB_VERSION` | Override the pinned release tag to download |
| `MESMO_SKIP_VERSION_CHECK` | (runtime) Skip the crate ↔ native-lib version compatibility check in `Mesmo::new()` |

## Common errors

### Build fails downloading the library

The first build needs network access to GitHub releases (the ~50 MB library can't be hosted on crates.io). In restricted environments, pre-download the release tarball, extract it, and set `MESMO_LIB_PATH` to that directory — the download step is skipped entirely.

### `no prebuilt libmesmo for <platform>` (build.rs panic)

No prebuilt artifact exists for your target (see matrix below — notably macOS Intel and non-x86_64 musl). Build the library from source (below) and set `MESMO_LIB_PATH`.

### Version mismatch from `Mesmo::new()`

The crate and the native library must match on base semver. This usually means `MESMO_LIB_PATH` points at a stale local build, or `MESMO_LIB_VERSION` pins an old tag. Rebuild/repin, or (at your own risk) set `MESMO_SKIP_VERSION_CHECK=1`.

### `Mesmo` cannot be sent between threads safely (compile error)

Deliberate. The GraalVM isolate thread inside `Mesmo` is bound to the OS thread that created it — moving it would corrupt the VM, so `Mesmo` is `!Send`/`!Sync` and the compiler stops you. Create one `Mesmo` per thread (e.g. in a `thread_local!`, or construct inside each worker).

### `CCL Error -10: ...` from `quicktx().build`

`MESMO_ERROR_TX_BUILD` — the TxPlan didn't build. Usual causes:

- Malformed YAML or a wrong intent field name (check against the [TxPlan reference](../quicktx.md)).
- A Plutus transaction with wrong/missing execution units.
- `CCL Error -8` (`INSUFFICIENT_FUNDS`) means the supplied UTXOs can't cover outputs + fee.

## Building the native library from source

Needed only on platforms without a prebuilt library or for development against Mesmo itself:

```bash
git clone https://github.com/bloxbean/mesmo
cd mesmo
sdk install java 25.0.3-graal        # GraalVM with native-image
./gradlew :core:nativeCompile        # → core/build/native/nativeCompile/libmesmo.*
export MESMO_LIB_PATH=$PWD/core/build/native/nativeCompile
cargo build
```

## Platform support

| Target | Prebuilt | Notes |
|---|---|---|
| linux x86_64 (glibc ≥ 2.17) | ✅ | RHEL/CentOS 7+, Ubuntu 18.04+, Debian 9+, Amazon Linux 2, … |
| linux aarch64 (glibc ≥ 2.17) | ✅ | |
| linux x86_64 (musl / Alpine) | ✅ | selected automatically when `target_env = "musl"` |
| linux aarch64 (musl) | ❌ | GraalVM `--libc=musl` is x86_64-only |
| macOS Apple Silicon | ✅ | |
| macOS Intel | ❌ | Oracle GraalVM dropped Intel Macs |
| windows x86_64 | ✅ | |
