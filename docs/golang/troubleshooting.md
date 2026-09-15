# Troubleshooting (Go)

## How the native library is found

The `mesmo` package resolves `libmesmo.dylib` / `libmesmo.so` / `libmesmo.dll` at runtime, once per process, in this order:

1. **`MESMO_LIB_PATH`** — a directory containing the library, or the library file itself. If set but the file isn't there, resolution fails hard (no fallback) — this is the way to run against a locally built library.
2. **The per-version cache**: `os.UserCacheDir()/mesmo/<version>/` (e.g. `~/Library/Caches/...` on macOS, `~/.cache/...` on Linux).
3. **A one-time download** of the release tarball from GitHub releases, extracted atomically into the cache.

The downloaded release tag is pinned in the wrapper (kept in lockstep with the wrapper version); override it with `MESMO_LIB_VERSION` (e.g. `MESMO_LIB_VERSION=v0.1.0-pre4`).

On Linux, musl (Alpine) is detected automatically by checking for the musl dynamic loader, and the `linux-musl-x86_64` artifact is downloaded instead of the glibc one.

Environment variables:

| Variable | Effect |
|---|---|
| `MESMO_LIB_PATH` | Use a local library instead of the cache/download |
| `MESMO_LIB_VERSION` | Override the pinned release tag to download |
| `MESMO_SKIP_VERSION_CHECK` | Skip the wrapper ↔ native-lib version compatibility check |

## Common errors

### `MESMO_LIB_PATH set but ... not found`

`MESMO_LIB_PATH` is authoritative: when set, nothing else is tried. Point it at the directory that actually contains `libmesmo.so`/`libmesmo.dylib` (typically `core/build/native/nativeCompile` in a source checkout), or unset it to use the downloaded library.

### Download fails on first use

The first `mesmo.New()` needs network access to GitHub releases (a one-time, per-version download). In restricted environments, either pre-populate the cache directory, or build from source and set `MESMO_LIB_PATH`. The download is atomic (temp file + rename), so a killed process can't leave a corrupt library behind.

### `no prebuilt libmesmo for <GOOS>/<GOARCH>`

No prebuilt artifact exists for your platform (see matrix below). Build from source and set `MESMO_LIB_PATH`.

### Version mismatch on `New()`

The wrapper and the native library must match on base semver. This usually means `MESMO_LIB_PATH` points at a stale build, or `MESMO_LIB_VERSION` pins an old tag. Rebuild/repin, or (at your own risk) set `MESMO_SKIP_VERSION_CHECK=1`.

### `mesmo: closed`

Something called Mesmo after `Close()`. Check with `errors.Is(err, mesmo.ErrClosed)`. Keep Mesmo alive for as long as callers use it — the guard exists because handing a stale isolate handle to the native side would crash the process.

### `CCL Error -10: ...` from `QuickTx.Build`

`ErrTxBuild` — the TxPlan didn't build. Usual causes:

- Malformed YAML or a wrong intent field name (check against the [TxPlan reference](../quicktx.md)).
- A Plutus transaction with wrong/missing execution units.
- `CCL Error -8` (`ErrInsufficientFunds`) means the supplied UTXOs can't cover outputs + fee.

### Old `go get` errors (module not found)

Early revisions of the module had a stale internal pin that broke `go get`. Update to the latest tagged version; the pin is now enforced by CI.

## Building the native library from source

Needed only on platforms without a prebuilt library or for development against Mesmo itself:

```bash
git clone https://github.com/bloxbean/mesmo
cd mesmo
sdk install java 25.0.3-graal        # GraalVM with native-image
./gradlew :core:nativeCompile        # → core/build/native/nativeCompile/libmesmo.*
export MESMO_LIB_PATH=$PWD/core/build/native/nativeCompile
```

## Platform support

| GOOS/GOARCH | Prebuilt | Notes |
|---|---|---|
| linux/amd64 (glibc ≥ 2.17) | ✅ | RHEL/CentOS 7+, Ubuntu 18.04+, Debian 9+, Amazon Linux 2, … |
| linux/arm64 (glibc ≥ 2.17) | ✅ | |
| linux/amd64 (musl / Alpine) | ✅ | auto-detected |
| linux/arm64 (musl) | ❌ | GraalVM `--libc=musl` is x86_64-only |
| darwin/arm64 (Apple Silicon) | ✅ | |
| darwin/amd64 (macOS Intel) | ❌ | Oracle GraalVM dropped Intel Macs |
| windows/amd64 | ✅ | |
