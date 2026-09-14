# Troubleshooting (Python)

## How the native library is found

`CclLib(lib_path=None)` resolves `libccl.dylib` / `libccl.so` / `libccl.dll` in this order:

1. The explicit `lib_path` constructor argument (a directory).
2. The `CCL_LIB_PATH` environment variable (a directory) — the usual way to run against a locally built library.
3. A copy bundled inside the installed wheel (`ccl/_libs/`) — this is what a normal `pip install` uses.
4. The bare filename, letting the OS loader search its default paths.

On Windows, the library's directory is registered with `os.add_dll_directory` so sibling DLL dependencies resolve.

## Common errors

### `OSError` loading the library

The library file wasn't found or couldn't be loaded.

- **Wheel install:** make sure you installed a wheel built for your platform (check `pip show -f cardano-client-lib` lists `ccl/_libs/libccl...`). A source install has no bundled library — set `CCL_LIB_PATH`.
- **Local build:** set `CCL_LIB_PATH` to the directory containing the library, **and** make the OS loader happy for its transitive dependencies:
  ```bash
  export CCL_LIB_PATH=/path/to/core/build/native/nativeCompile
  export DYLD_LIBRARY_PATH=$CCL_LIB_PATH   # macOS
  export LD_LIBRARY_PATH=$CCL_LIB_PATH     # Linux
  ```
- **Unsupported platform** (macOS Intel): no prebuilt library exists — build from source (below).

### `RuntimeError: ... incompatible ...` (version mismatch)

The wrapper and the native library must match on base semver. This appears when `CCL_LIB_PATH` points at a stale build. Rebuild the library, or (at your own risk) set `CCL_SKIP_VERSION_CHECK=1`.

### `CclClosedError`

Something called the instance after `close()` (or after its `with` block ended). This exception is the wrapper saving you: handing a stale isolate handle to the native side would abort the whole interpreter. Keep calls inside the instance's lifetime, or create a new `CclLib`.

### `TypeError` / `ValueError` about `network`

The `network` argument is required and validated — there is no default (a silent mainnet default was removed deliberately). Pass `Network.MAINNET` or `Network.TESTNET`.

### `CCL Error -10: ...` from `quicktx.build`

`CCL_ERROR_TX_BUILD` — the TxPlan didn't build. Usual causes:

- Malformed YAML or a wrong intent field name (check against the [TxPlan reference](../quicktx.md)).
- A Plutus transaction with wrong/missing execution units.
- `CCL Error -8` (`INSUFFICIENT_FUNDS`) means the supplied UTXOs can't cover outputs + fee.

### `tx.from_json` / `plutus.data_to_json` / `plutus.data_from_json` fail

Known limitation of the current native library (GraalVM reflection configuration gaps). Use the working alternatives: a managed account's `sign_tx` for signing, `plutus.data_hash` for datum hashing.

## Building the native library from source

Needed only on platforms without a prebuilt library (macOS Intel) or for development against the bridge itself:

```bash
git clone https://github.com/bloxbean/cardano-client-bindings
cd cardano-client-bindings
sdk install java 25.0.3-graal        # GraalVM with native-image
./gradlew :core:nativeCompile        # → core/build/native/nativeCompile/libccl.*
export PYTHONPATH=$PWD/wrappers/python
export CCL_LIB_PATH=$PWD/core/build/native/nativeCompile
```

## Platform support

| Platform | Prebuilt | Notes |
|---|---|---|
| Linux x86_64 (glibc ≥ 2.17) | ✅ | RHEL/CentOS 7+, Ubuntu 18.04+, Debian 9+, Amazon Linux 2, … |
| Linux aarch64 (glibc ≥ 2.17) | ✅ | |
| macOS Apple Silicon | ✅ | |
| macOS Intel | ❌ | Oracle GraalVM dropped Intel Macs |
| Windows x86_64 | ✅ | |

> Alpine/musl: the musl native library exists (the Go/Rust/JS wrappers use it), but musllinux wheel publishing is still being wired up — on Alpine, install from source with `CCL_LIB_PATH` pointing at the musl `libccl.so` for now.
