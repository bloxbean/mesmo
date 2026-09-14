# ADR-0012: Distribute the native library bundled in per-wrapper platform packages

- **Status:** Accepted — Go mechanism superseded by [ADR-0014](0014-go-distribution-purego-runtime-resolution.md)
- **Date:** 2026-07-01
- **Deciders:** bloxbean maintainers

## Context

Cardano Client Bindings ships a native shared library (`libccl.{so,dylib,dll}`, [ADR-0001](0001-native-shared-library-ffi.md))
that each language wrapper ([ADR-0003](0003-four-language-wrappers-uniform-ffi.md)) loads over FFI. Until
now the wrappers only located that library through an environment variable (`CCL_LIB_PATH`, plus the OS
loader's `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH`): the user had to build or download the lib and point the
wrapper at it by hand. That is the single biggest adoption blocker — a `P0` in [`TODO.md`](../../TODO.md) —
and it is un-idiomatic for every target ecosystem, where `pip install` / `npm install` / `cargo add` are
expected to "just work".

The pieces to fix it already exist: the release pipeline builds a per-platform lib, and the Linux build is
distro-portable down to glibc 2.17 ([ADR-0008](0008-linux-glibc-baseline-portability.md)). What was missing
is a decision on **how the lib reaches an end user of a wrapper**.

Relevant forces:

- The lib is a **platform-specific binary** (~50 MB uncompressed), different per OS/arch. A single
  universal package cannot serve every platform.
- Each ecosystem has different packaging affordances and constraints (install hooks, binary-size limits,
  tag rules).
- We still need a **development** path: running a wrapper against a locally built lib without packaging.

## Decision

We will **distribute the native library bundled inside each wrapper's own platform-specific package**, so a
normal install needs no environment variables. `CCL_LIB_PATH` remains supported as a **development / override
fallback**, not the primary path.

Each wrapper resolves the library in this priority order:

1. an explicit path passed in code (e.g. `CclLib(lib_path=...)`);
2. the `CCL_LIB_PATH` environment variable (local development);
3. the copy **bundled inside the installed package**;
4. the bare filename, letting the OS loader search its default paths.

Per-wrapper mechanism (each is a separate delivery, but all follow the rule above):

- **Python — platform wheels (implemented).** A `py3-none-<platform>` wheel bundles the matching `libccl.*`
  under `ccl/_libs/`. Pure-`ctypes` binding, so one wheel works on any Python 3 for that platform; only the
  binary is platform-specific. The binary is never committed — it is staged at wheel-build time
  (`:wrappers:python:wheel`) and CI proves the built wheel installs into a clean venv and loads with no env
  vars.
- **JavaScript — npm (implemented).** `CclBridge` resolves the lib with the same priority order and loads a
  copy bundled under the package's `libs/`. `:wrappers:js:pack` stages the lib and runs `npm pack`; CI proves
  the tarball installs into a clean project and loads with no env vars. The binary is gitignored (staged at
  pack time). For *publishing*, a single npm package can't be per-platform, so the release step will ship
  per-platform packages via `optionalDependencies` (each carrying one platform's lib) — the loader already
  finds a bundled lib regardless of which package provides it.
- **Rust — crates.io (implemented).** crates.io won't host the ~50 MB binary, so the crate carries only
  source + `build.rs`; `build.rs` sources `libccl.*` (from `CCL_LIB_PATH`, the in-tree build, or the GitHub
  release), stages a copy in `OUT_DIR`, rewrites the macOS install name to `@rpath`, and emits an `rpath` —
  so linking *and* runtime work with no env vars. CI proves the crate loads with `CCL_LIB_PATH`/`DYLD`/`LD`
  unset. Tradeoff vs. the wheel/npm: network is needed at the *first build* (not install), since Rust has no
  install hook.
- **Go — hardest.** Go modules run no install hooks, so bundling means `go:embed` of the platform lib +
  extract-to-temp at runtime, or a documented fetch step.

Publishing to registries (PyPI/npm/crates; Go uses the module proxy over git tags) is a **release-pipeline**
concern and explicitly *out of scope for this ADR's first implementation*: it needs a per-platform build
matrix, `auditwheel repair` to relabel the Linux wheel `manylinux_2_28_x86_64` (PyPI rejects raw
`linux_x86_64`), and OIDC **Trusted Publishing** rather than long-lived tokens.

## Consequences

- `pip install ccl` (and eventually the npm/crates equivalents) works with **no `CCL_LIB_PATH`**, on a fresh
  machine — the adoption blocker is removed, one wrapper at a time.
- Packages get **large** (tens of MB) and are **per-platform**; releasing means a build matrix producing one
  artifact per OS/arch, and users on an unsupported platform fall back to source/`CCL_LIB_PATH`.
- The set of shippable platforms is bounded by what we build: `linux-x86_64` + `linux-aarch64` (both
  glibc-baseline), `macos-aarch64`, and `windows-x86_64`. `macos-x86_64` (Intel) is **not** built —
  Oracle GraalVM is dropping Intel-Mac support (its 25.1 line ships none). `windows-arm64` remains
  unbuilt; musl/Alpine has its own `linux-musl-x86_64` artifact
  ([ADR-0008](0008-linux-glibc-baseline-portability.md)), though its *wheel* is still unpublished.
- Each ecosystem needs its own bundling code and its own publishing story; the four will land incrementally,
  not atomically.
- A lib a version behind its wrapper still fails confusingly — bundling makes version-lock easier (same
  release builds both) but does not by itself add a runtime check (tracked separately).
- **The two wrapper families resolve the lib differently.** Python (ctypes) and JS (`dlopen`) load a file
  *by path* at runtime, so the lib's install name is irrelevant — they just point at the bundled copy. The
  **native-linked** wrappers (Rust `extern "C"` and C) *link* against `libccl` at build time — Go resolves it at runtime via purego ([ADR-0014](0014-go-distribution-purego-runtime-resolution.md)) —
  so removing the env-var requirement means making the runtime loader find it: stage the lib and reference
  it via **`@rpath`** (macOS needs `install_name_tool -id @rpath/libccl.dylib` because GraalVM stamps an
  absolute build path — exactly what forced `DYLD_LIBRARY_PATH` before; the Linux `.so`'s SONAME is already
  the leaf name), plus emit an `rpath`. Rust does this in `build.rs`.

## Alternatives considered

- **Keep `CCL_LIB_PATH`-only (status quo).** Zero packaging work, but leaves the primary adoption blocker in
  place and is alien to every target ecosystem. Rejected as the default; retained as the dev fallback.
- **Download-on-install (postinstall fetch for every wrapper).** Smaller published packages, but needs
  network at install time, breaks offline/air-gapped installs and reproducibility, and fails behind strict
  proxies. Kept as an option only where bundling is impractical (npm/Go), not as the general rule.
- **System package managers (apt/brew/…) for the lib.** Familiar to ops users, but multiplies the packaging
  surface enormously and still doesn't make the language installs self-contained. Rejected.
- **One fat package carrying every platform's lib.** Simplest to publish (no matrix), but multiplies download
  size several-fold for everyone and fights each registry's platform-tag model. Rejected in favour of
  per-platform artifacts.
- **Runtime `dlopen` for the native-linked wrappers, instead of build-time linking + `@rpath`.** Rust/C/Go
  *could* drop `extern "C"`/cgo and load `libccl` at runtime (via `libloading` / `purego`, like Python and
  JS), which sidesteps the install-name/`rpath` dance entirely. Rejected for Rust and taken as the default:
  it's a full rewrite of each wrapper's FFI layer, whereas stage-`@rpath`-link keeps the existing,
  well-tested bindings while still dropping the env-var requirement. **Left genuinely open for Go**, where
  cgo's build-time linking *plus* Go's no-install-hook constraint (a ~250 MB all-platforms module otherwise)
  may tip the balance toward `go:embed` + runtime `dlopen`.
  → **Resolved by [ADR-0014](0014-go-distribution-purego-runtime-resolution.md):** Go drops cgo for
  **purego** and resolves `libccl` at runtime (`CCL_LIB_PATH` → cache → one-time download) — not
  `go:embed`, which would have shipped the ~250 MB.
