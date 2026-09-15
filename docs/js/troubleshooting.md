# Troubleshooting (JavaScript)

## How the native library is found

`new MesmoBridge(libPath?)` resolves `libmesmo.dylib` / `libmesmo.so` / `libmesmo.dll` in this order:

1. The explicit `libPath` constructor argument (a directory).
2. The `MESMO_LIB_PATH` environment variable (a directory) — the usual way to run against a locally built library.
3. A copy bundled inside the package itself (`libs/`).
4. The platform-specific package for your OS/arch (e.g. `@bloxbean/mesmo-macos-aarch64`) — this is what a normal `bun add` install uses.
5. The bare filename, letting the OS loader search its default paths.

On Linux, musl (Alpine) is detected automatically by checking for the musl dynamic loader, and the `linux-musl-x86_64` package is selected instead of the glibc one.

Check what would be loaded:

```js
import { resolveLibFile, platformSuffix } from "@bloxbean/mesmo";
console.log(platformSuffix());   // e.g. "linux-x86_64"
console.log(resolveLibFile());   // absolute path to the library
```

## Common errors

### `Failed to load the CCL native library (...)`

The library file wasn't found or couldn't be loaded.

- **Normal install:** make sure the platform package was installed (check `bun pm ls | grep cardano-client-lib`). `optionalDependencies` can be skipped by `--no-optional` / some CI caching setups — reinstall without that flag.
- **Local build:** set `MESMO_LIB_PATH` to the directory containing the library, **and** make the OS loader happy for its transitive dependencies:
  ```bash
  export MESMO_LIB_PATH=/path/to/core/build/native/nativeCompile
  export DYLD_LIBRARY_PATH=$MESMO_LIB_PATH   # macOS
  export LD_LIBRARY_PATH=$MESMO_LIB_PATH     # Linux
  ```
- **Unsupported platform** (macOS Intel; Alpine on ARM): no prebuilt library exists — build from source (below).

### `libmesmo version '...' is incompatible`

The wrapper and the native library must match on base semver. This appears when `MESMO_LIB_PATH` points at a stale build. Rebuild the library, or (at your own risk) set `MESMO_SKIP_VERSION_CHECK=1`.

### `MesmoClosedError: MesmoBridge is closed`

Something called the bridge after `close()`. This error is the wrapper saving you: handing a stale isolate handle to the native side would abort the whole process. Keep calls inside the bridge's `try`/`using` scope, or create a new bridge.

### `CCL Error -10: ...` from `quicktx.build`

`MESMO_ERROR_TX_BUILD` — the TxPlan didn't build. Usual causes:

- Malformed YAML or a wrong intent field name (check against the [TxPlan reference](../quicktx.md)).
- A Plutus transaction with wrong/missing execution units.
- Check `CCL Error -8` too: `INSUFFICIENT_FUNDS` means the supplied UTXOs can't cover outputs + fee.

### `PPViewHashesDontMatch` when submitting a Plutus transaction

The protocol parameters' cost models were mangled. `build()` normalizes the common deprecated map form automatically; if you construct parameters by hand, keep the cost models in the order-stable `cost_models_raw` array form.

### Crash / segfault under Node.js

Node is not supported — this is expected, not a bug. GraalVM native libraries do stack-boundary checks that Node FFI bridges violate. Run under [Bun](https://bun.sh) ≥ 1.0.

## Building the native library from source

Needed only on platforms without a prebuilt library (macOS Intel, Alpine ARM) or for development against the bridge itself:

```bash
git clone https://github.com/bloxbean/mesmo
cd mesmo
sdk install java 25.0.3-graal        # GraalVM with native-image
./gradlew :core:nativeCompile        # → core/build/native/nativeCompile/libmesmo.*
export MESMO_LIB_PATH=$PWD/core/build/native/nativeCompile
```

## Platform support

| Platform | Prebuilt | Notes |
|---|---|---|
| Linux x86_64 (glibc ≥ 2.17) | ✅ | RHEL/CentOS 7+, Ubuntu 18.04+, Debian 9+, Amazon Linux 2, … |
| Linux aarch64 (glibc ≥ 2.17) | ✅ | |
| Alpine x86_64 (musl) | ✅ | auto-detected |
| Alpine aarch64 (musl) | ❌ | GraalVM `--libc=musl` is x86_64-only |
| macOS Apple Silicon | ✅ | |
| macOS Intel | ❌ | Oracle GraalVM dropped Intel Macs |
| Windows x86_64 | ✅ | |
