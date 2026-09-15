# ADR-0014: Go distribution — purego + runtime library resolution

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** bloxbean maintainers

## Context

[ADR-0012](0012-native-lib-bundled-in-wrapper-packages.md) decided the native library ships bundled in
each wrapper's platform package, and called out **one question it left "genuinely open for Go"**: Go
modules run **no install/build hook**, and the Go wrapper used **cgo**, which links `libmesmo` at build
time against an in-tree path. That combination is undistributable:

- cgo needs the native library present **at link time**, before any code runs — and Go gives no hook
  to fetch or place it first (unlike Python's wheel, npm's `optionalDependencies`, or Rust's
  `build.rs`);
- `go:embed`-ing every platform's library into the module would bloat it to **~250 MB** (Go embeds
  all embedded files into every build regardless of target);
- so `go get` on the wrapper simply could not build outside this repo.

## Decision

Two changes, together:

1. **Drop cgo for [purego](https://github.com/ebitengine/purego).** Load `libmesmo` with pure-Go
   `dlopen`/`dlsym` — **no cgo, no C toolchain, cross-compiles**. Every entry point is bound once at
   first use. The Go module becomes **pure source**, so `go get` works on any machine.
2. **Resolve the library at runtime** — Go's only hook. In order:
   `MESMO_LIB_PATH` → a per-version user cache (`os.UserCacheDir()`) → a **one-time download** of the
   release tarball (`cardano-client-lib-<version>-<platform>.tar.gz`), extracted atomically. Failure
   is **fail-hard** (a bad download errors rather than using a stale library). This mirrors the Rust
   `build.rs` fetch — same version, tarball naming, and `MESMO_LIB_VERSION` override — only shifted from
   build time to first use.

Go is **not published to a registry**: the module is served from the tagged git source by the module
proxy (`proxy.golang.org`). "Releasing" is a git tag (`wrappers/go/vX.Y.Z`) plus a matching
native-library release (see [RELEASING.md](../../RELEASING.md)).

## Consequences

- `go get github.com/bloxbean/mesmo/wrappers/go` works with **no C toolchain and no
  `MESMO_LIB_PATH`**; the module is pure Go and cross-compiles.
- First use needs the network **once** (then cached), unless `MESMO_LIB_PATH` is set — the trade-off for
  having no install hook.
- The single-locked-OS-thread isolate model (a GraalVM IsolateThread is bound to its creating OS
  thread) is **unchanged**; only the FFI mechanism changed.
- Go and Rust now depend on the **same native-library release**; their pinned versions
  (`defaultLibVersion` / `DEFAULT_LIB_VERSION`) must track the release tag.
- **Resolves the "open for Go" question in [ADR-0012](0012-native-lib-bundled-in-wrapper-packages.md).**

## Alternatives considered

- **Keep cgo (+ build-time `-lmesmo`).** Undistributable — needs the library at link time with no hook
  to fetch it. Rejected.
- **`go:embed` every platform's library.** ~250 MB module, downloaded in full by every consumer.
  Rejected.
- **Per-platform embed modules** (the npm `optionalDependencies` shape, via build-tagged imports).
  Avoids a runtime download, but needs five extra module repos, bloats git with binaries, and
  `go mod tidy` tends to pull all platforms. Rejected as the lead; a possible fallback.
- **cgo + manual `dlopen`** (link `libdl`, vendor the header, no `-lmesmo`). Removes the build-time
  library link but still requires a **C toolchain** — the thing purego eliminates. Rejected.
