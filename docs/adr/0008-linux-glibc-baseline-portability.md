# ADR-0008: Linux native-lib portability — glibc-baseline build + `-march=compatibility` (not static)

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** bloxbean maintainers (with Satya's review)

## Context

The shipped Linux `libccl.so` was built on `ubuntu-latest` (glibc ~2.39), so it failed to load on older
distros (`version 'GLIBC_2.3x' not found`). We explored shipping a **fully static, no-`.so`** library to
be distro-independent. A spike established two hard facts:

1. GraalVM native-image **cannot emit a static library** (`.a`) — `oracle/graal#3053`, still open — and
   musl's run-anywhere property applies only to static **executables**, not shared libraries. A truly
   static, no-`.so` distribution would require re-architecting to an IPC subprocess model (rejected as
   too invasive).
2. native-image defaults to the **build machine's CPU** instruction set, which can `SIGILL` on older /
   datacenter CPUs lacking newer instructions (AVX2/AVX-512).

## Decision

Keep the in-process FFI **shared library** and achieve portability on two axes:

1. **glibc baseline** — build the Linux `.so` inside `manylinux_2_28`. The result requires only
   `GLIBC_2.17`, so it runs on **glibc ≥ 2.17** (RHEL/CentOS 7+, Amazon Linux 2, Ubuntu 18.04+,
   Debian 9+, and all newer).
2. **CPU baseline** — set `-march=compatibility` in `native-image.properties` so the binary uses only
   instructions common to all CPUs of the architecture.
3. **musl variant** — additionally build a musl `libccl.so` via `--libc=musl` (with a musl
   toolchain: `musl-gcc` + a musl-linked `zlib`), shipped as `linux-musl-x86_64`, so Alpine/musl is
   covered by its own artifact. **aarch64 musl is unsupported by GraalVM** (native-image's
   `--libc=musl` toolchain detection hardcodes `x86_64-linux-musl-gcc`), so `linux-musl-aarch64`
   is deferred until GraalVM adds support; x86_64 is the vast majority of Alpine/Docker usage.

The musl artifact must reach **bundled**-wrapper users separately: the fetching wrappers — Rust
(`build.rs`) and Go (runtime loader) — detect musl and pick the right release artifact, but Python
(wheel) and JS (npm) bundle the lib into their packages, so each needs a musl artifact of its own or
Alpine users silently receive the glibc build, which cannot load under musl:

- **npm:** a separate `@bloxbean/cardano-client-lib-linux-musl-x86_64` package, pinned as an
  `optionalDependency`. The **`libc` field is load-bearing**: `os` (`linux`) and `cpu` (`x64`) both
  match on Alpine, so *only* `libc: ["musl"]` vs `["glibc"]` lets npm pick the right one. And because
  npm can install *both* platform packages on an Alpine box, the wrapper still resolves at runtime:
  `platformSuffix()` detects musl by its dynamic loader (`/lib/ld-musl-*.so.1`), as the Go loader does.
- **PyPI:** the wheel is built on musl and proven to load on Alpine, but publishing needs an
  `auditwheel repair` retag to `musllinux_1_2_x86_64` (the same repair the glibc wheel needs for
  `manylinux`); that step lives in the Python publish workflow.

All four wrappers are exercised **inside a real Alpine container** in `musl-alpine.yml` (load + run,
not just "artifact exists"). The `libc`-field / runtime-detection split mirrors how the glibc↔musl
choice is made on each axis: package *resolution* (npm `libc`, pip wheel tag) and, as a backstop,
*runtime* selection in the wrapper.

Verified continuously by `portable-linux-lib.yml` (objdump glibc-floor assertion + a real run on
`centos:7`); `release.yml` ships the Linux artifact from the same container. macOS/Windows are
unaffected (stable ABIs).

## Consequences

- One portable `.so` across virtually every non-musl Linux of the last decade — no wrapper or
  architecture changes ([ADR-0001](0001-native-shared-library-ffi.md), [ADR-0003](0003-four-language-wrappers-uniform-ffi.md)).
- CPU-portable; no `SIGILL` on older datacenter VMs.
- **This glibc `.so` does not run on Alpine / musl** — the separate musl variant (decision axis 3)
  covers Alpine with its own `linux-musl-x86_64` artifact and per-package-manager selection.
- Linux release builds run inside a container (extra CI plumbing).
- This portable `.so` is what the per-wrapper packages bundle for Linux users
  ([ADR-0012](0012-native-lib-bundled-in-wrapper-packages.md)); its glibc-2.17 floor is what lets the
  Linux wheel be relabelled `manylinux_2_28` for PyPI.

## Alternatives considered

- **Static library** — impossible (`oracle/graal#3053`).
- **IPC static musl executable** — meets "no dynamic linking" literally, but a large re-architecture
  with per-call overhead; rejected.
- **musl shared library as the only artifact** — musl's run-anywhere property applies to static
  executables, not shared libraries, and most Linux users run glibc; instead the musl build ships
  *in addition to* the glibc baseline (decision axis 3) rather than replacing it.
- **Build on `ubuntu-latest`** — the status quo that fails on older distros.
