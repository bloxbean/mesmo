---
title: Platforms & Packages
description: Supported operating systems and architectures, package sizes, and how the native library reaches each language.
---

The native library (`libmesmo`) is a platform-specific binary built with GraalVM native-image. This page is the single answer to "does it run on my machine, and how big is it?".

## Platform support matrix

| Platform | Prebuilt | Notes |
|---|---|---|
| Linux x86_64 (glibc ≥ 2.17) | ✅ | RHEL/CentOS 7+, Ubuntu 18.04+, Debian 9+, Amazon Linux 2, and newer |
| Linux aarch64 (glibc ≥ 2.17) | ✅ | |
| Linux x86_64 (musl / Alpine) | ✅ | Separate `linux-musl-x86_64` artifact; Rust/Go pick it automatically, npm via the `libc` field. musllinux **wheel** publishing is still being wired up — Python on Alpine installs from source for now |
| macOS Apple Silicon | ✅ | |
| macOS Intel | ❌ | Oracle GraalVM dropped Intel Macs — build from source with an older toolchain, or use a supported platform |
| Windows x86_64 | ✅ | |
| Windows ARM64 | ❌ | Not built yet |
| Linux aarch64 (musl) | ❌ | GraalVM's musl toolchain support is x86_64-only today |

The Linux builds are deliberately conservative: built inside `manylinux_2_28` for a **glibc 2.17 floor**, and compiled with `-march=compatibility` so no modern-CPU instructions (AVX2/AVX-512) are required — they run on a decade of distros and older datacenter VMs alike.

## Size

- **Native library:** ~50–60 MB uncompressed per platform. The embedded [Scalus](https://scalus.org) UPLC evaluator — which is what lets Plutus transactions build fully offline — accounts for roughly 12 MB.
- **Wrapper packages:** Python wheels and npm platform packages bundle the library, so they weigh tens of MB (compressed). Rust and Go keep their packages small: the crate/module is source-only and fetches the library once (Rust at first build, Go at first use, both cached; `MESMO_LIB_PATH` overrides).

## How the library reaches you

Every wrapper resolves `libmesmo` in the same priority order:

1. an explicit path passed in code;
2. the `MESMO_LIB_PATH` environment variable (local development);
3. the copy bundled in / cached by the installed package;
4. the OS loader's default search paths.

| Language | Mechanism | Network needed? |
|---|---|---|
| Python | platform wheel bundles the lib | No — at install |
| JavaScript | npm platform packages via `optionalDependencies` (musl selected by the `libc` field) | No — at install |
| Rust | `build.rs` fetches from the GitHub release, stages with `@rpath` | Once, at first build |
| Go | pure-Go runtime resolution: `MESMO_LIB_PATH` → user cache → one-time download | Once, at first use |

## Runtimes

- **Python** ≥ 3.8 (pure ctypes — one wheel per platform works on any Python 3)
- **Go** ≥ 1.21 (no cgo — cross-compiles, no C toolchain)
- **Rust** ≥ 1.70
- **JavaScript**: [Bun](https://bun.sh) 1.0+ only — see [limitations](../limitations/#javascript-runs-on-bun-only)

## Building from source

Needed only on unsupported platforms or for developing the bindings themselves — requires [Oracle GraalVM 25](https://www.graalvm.org/) (with `native-image`):

```bash
git clone https://github.com/bloxbean/mesmo
cd mesmo
sdk install java 25.0.3-graal
./gradlew :core:nativeCompile     # → core/build/native/nativeCompile/libmesmo.*
export MESMO_LIB_PATH=$PWD/core/build/native/nativeCompile
```

Each language's *Troubleshooting* page covers the loader environment variables and common load errors.
