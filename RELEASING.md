# Releasing

A release has two layers: the **native library** (one shared binary artifact, built once per
platform) and the **per-wrapper packages** that deliver it to each language's ecosystem. The native
library is the foundation — everything else references a published native-library release, so it
must go out **first**.

> **You do not push `v*` tags by hand.** Tagging is gated behind a reviewed PR — see
> [How releases are triggered](#how-releases-are-triggered-pr-gated-tagging) below.

## 1. Release the native library (do this first)

The `v*` tag (created for you by the release flow) triggers
[`release.yml`](.github/workflows/release.yml), which builds `libmesmo` on every platform and produces
one tarball per platform:

```
mesmo-<tag>-<platform>.tar.gz     # contains libmesmo.{so,dylib,dll} + headers
```

Platforms (5): `linux-x86_64`, `linux-aarch64`, `linux-musl-x86_64`, `macos-aarch64`, `windows-x86_64`.
(macOS x86_64 / Intel is **not** built — Oracle GraalVM is dropping Intel-Mac support, and its 25.1
line ships no macOS-x86_64 build. `linux-musl-aarch64` is **not** built — GraalVM's `--libc=musl` is
x86_64-only; see [ADR-0008](docs/adr/0008-linux-glibc-baseline-portability.md).) The standard Linux
builds use a glibc 2.17 baseline for portability; `linux-musl-x86_64` is linked against musl for
Alpine / musl-based images (`--libc=musl`). Attach all five tarballs (and a `SHA256SUMS`) to the
GitHub Release for the tag.

## 2. Keep the pinned versions in lockstep

**`gradle.properties` `version` is the single source of truth.** After changing it, run:

```bash
./gradlew syncVersions
```

The task updates every checked-in wrapper manifest, lockfile pin, download version, and native-library
compatibility constant. `./gradlew checkVersions` guards the invariant in wrapper test runs. JS and
Rust are also stamped again from `gradle.properties` in publish CI as a defensive check; Python's
`pyproject.toml` is *asserted* against it instead (the wheel build reads the checked-in file, so a
drifted version fails the build with a pointer to `syncVersions`). On a `v*` tag the tag must equal
`v<version>`, so a mistyped tag can't publish a mismatched version.

| Wrapper | Fields synchronized by `syncVersions` | Manual bump needed? |
|---|---|---|
| **Rust** | `Cargo.toml` + the crate entry in `Cargo.lock`; `build.rs` derives the release tag as `v$CARGO_PKG_VERSION` | **No** — run the root task |
| **JS** | `package.json` version + platform `optionalDependencies`, matching `bun.lock` pins, and the base compatibility version in `src/index.js` | **No** — run the root task |
| **Go** | `defaultLibVersion` (full release tag) + `expectedLibVersion` (base compatibility version) | **No** — run the root task |
| **Python** | `pyproject.toml` version + `EXPECTED_LIB_VERSION` (base compatibility version) | **No** — run the root task |

Rust and Go both accept a `MESMO_LIB_VERSION` environment override (build time for Rust, run time for
Go) — useful for testing against a release before pinning it.

**Version-skew check.** On init each wrapper calls `mesmo_version` and fails fast if it doesn't match
the wrapper's expected version (bypass with `MESMO_SKIP_VERSION_CHECK`). The lib side is single-sourced —
`mesmo_version` is generated from `gradle.properties` `version` (base semver), so bumping that is enough
for the native lib. The wrapper's *expected* version must be bumped in lockstep too:

| Wrapper | Expected-version source | Bump needed? |
|---|---|---|
| Rust | `CARGO_PKG_VERSION` (`Cargo.toml` `version`, itself stamped from `gradle.properties`) | **no** — fully derived |
| Python | `EXPECTED_LIB_VERSION` in [`wrappers/python/mesmo/_ffi.py`](wrappers/python/mesmo/_ffi.py) | **no** — synchronized by `syncVersions` |
| JS | `EXPECTED_LIB_VERSION` in [`wrappers/js/src/index.js`](wrappers/js/src/index.js) | **no** — synchronized by `syncVersions` |
| Go | `expectedLibVersion` in [`wrappers/go/mesmo/mesmo.go`](wrappers/go/mesmo/mesmo.go) | **no** — synchronized by `syncVersions` |

(Only the base semver is compared, so a `-preview1`-style suffix on the release/tag doesn't matter.)

## 3. Publish the per-wrapper packages

Each ecosystem has a different distribution model:

| Wrapper | Artifact | Registry | How the native lib ships |
|---|---|---|---|
| **Python** | wheel (`.whl`) | PyPI | **bundled** into `mesmo/_libs/` (platform wheels) |
| **JS** | tarball (`.tgz`) | npm | **bundled** into per-platform `optionalDependencies` |
| **Rust** | crate source | crates.io | **fetched** by `build.rs` from the release (crates.io can't host the binary) |
| **Go** | *(none)* | *(none — the git repo is the module)* | **fetched** by the loader at runtime |

Python, JS, and Rust each publish to a registry from a `release`-gated publish workflow, using that
registry's trusted publishing (OIDC) — no stored credentials anywhere. **Go does not** — see below.

### musl / Alpine

The **fetching** wrappers (Rust, Go) get musl for free: they download from the release, which carries
a `linux-musl-x86_64` tarball, and both detect musl at build/run time and pick it. The **bundling**
wrappers do not — a musl tarball on the release does nothing for a `pip install` or an `npm install`,
so each needs a musl artifact of its own:

| Wrapper | musl artifact | Selected by |
|---|---|---|
| **JS** | `@bloxbean/mesmo-linux-musl-x86_64` npm package | npm's `libc: ["musl"]` field, plus `platformSuffix()` detecting musl at runtime |
| **Python** | a `musllinux_1_2_x86_64` wheel | pip, from the wheel's platform tag |
| **Rust / Go** | *(none needed)* | `build.rs` / the loader pick `linux-musl-x86_64` off the release |

The `libc` field is what stops an Alpine user silently installing the glibc package: `os` and `cpu`
match on Alpine too, so without it npm resolves the glibc build, which cannot load under musl.

`musl-alpine.yml` builds the musl lib and then runs **all four wrappers inside a real Alpine
container** — so what is verified is that they work there, not merely that an artifact exists.

**x86_64 only.** GraalVM's `--libc=musl` hardcodes the `x86_64-linux-musl-gcc` compiler name and never
looks for an aarch64 one, so there is no musl/aarch64 build. Alpine-on-ARM users must build libmesmo
from source and set `MESMO_LIB_PATH`; the wrappers say so explicitly rather than handing back a glibc
artifact that cannot load. See [ADR-0008](docs/adr/0008-linux-glibc-baseline-portability.md).

## Go: no artifact, no registry — just a tag

Go modules are served directly from the tagged git source by the module proxy (`proxy.golang.org`).
There is nothing to build into a package and no registry to push to. To release the Go module:

```bash
git tag wrappers/go/v0.2.0     # NOTE: submodule path prefix, not a bare v0.2.0
git push origin wrappers/go/v0.2.0
```

- The tag **must** be prefixed with the module's subdirectory (`wrappers/go/`) — that's Go's rule for
  a module that isn't at the repo root. This is a **different tag** from the native-library `v0.2.0`
  tag (they can point at the same commit).
- After tagging, `go get github.com/bloxbean/mesmo/wrappers/go@v0.2.0` just works — no cgo, no C
  toolchain. On first use the loader downloads `libmesmo` for the platform from the native-library
  release (step 1) and caches it, so `defaultLibVersion` (step 2) **must** match a published release.

## How releases are triggered (PR-gated tagging)

Nobody pushes `v*` tags by hand — direct tag pushes are blocked by a repository ruleset. Instead:

1. Open a PR that bumps `version` in `gradle.properties`, run `./gradlew syncVersions`, and commit
   the synchronized wrapper files in the same PR.
2. A **release code owner** (`@satran004`, `@matiwinnetou`, `@fabianbormann`) reviews and merges it
   to `main`. This is enforced by [`.github/CODEOWNERS`](.github/CODEOWNERS) + the `main` branch
   ruleset.
3. On merge, [`tag-release.yml`](.github/workflows/tag-release.yml) resolves the version, then
   **pauses** on the `release` environment (`authorize` job) until a release code owner approves.
   Only then does it push `v<version>`, using a GitHub App token so the tag fires the downstream
   workflows: `release.yml`, `publish-js.yml`, `publish-rust.yml` and `publish-py.yml`. The tag is
   the point of no cheap return — `release.yml` publishes the GitHub Release with no further gate —
   so it is gated too. A bump can be merged now and tagged later; a rejected approval can be retried
   with a manual run, which is gated identically.
4. `publish-js.yml`, `publish-rust.yml`, and `publish-py.yml` each build, then **pause** on the
   shared `release` environment until a release code owner approves the final publish. All three
   registries are irreversible — a published version can never be overwritten, only unpublished
   (npm, within a window), yanked (crates.io), or deleted-without-reuse (PyPI) — so the approval is
   the last chance to stop.

Why a GitHub App token (not the default `GITHUB_TOKEN`): GitHub does not fire `on: push` workflows
for refs pushed by `GITHUB_TOKEN` (a recursion guard), so a `GITHUB_TOKEN`-pushed tag would not
trigger `release.yml` / `publish-js.yml` / `publish-rust.yml` / `publish-py.yml`. The App token is a
normal actor, so the tag fans out.

### One-time repo settings (admin)

These enforce the flow and are configured in GitHub settings, not code:

- **GitHub App** with Contents: read & write, installed on the repo; secrets `RELEASE_APP_ID` +
  `RELEASE_APP_PRIVATE_KEY` held by the **`release-staging` environment**, which `tag-release.yml`'s
  `tag` job declares — so they are not readable from a workflow on any other branch.
- **`main` ruleset**: require a PR, ≥1 approval, and **Require review from Code Owners**. Keep the
  bypass list empty (do not add `Maintain`/`Write` roles — anyone on it skips code-owner review).
- **`v*` tag ruleset**: restrict tag creation; bypass list = the release App only, so a `v*` tag can
  only come from the approved-PR auto-tag.
- **`release` environment**: required reviewers = the release code owners; enable "Prevent
  self-review". Holds no secrets. Four jobs gate on it — `tag-release.yml`'s `authorize` plus the
  three publish workflows — so it is the human gate on tagging and on every irreversible publish.
  Its deployment policy must allow **`tag: v*`** as well as `branch: main`, because the publish jobs
  run on the tag; a branch-only policy rejects them outright.
- **`release-staging` environment**: no reviewers, holds the release App secrets, deployment policy
  `branch: main`, `branch: release/**`, `tag: v*`.
- **Trusted publishing** (no API-token secrets — every registry mints a short-lived token from the
  GitHub OIDC identity): configure the publisher on
  [npmjs.com](https://docs.npmjs.com/trusted-publishers) against `publish-js.yml` + `release`, on
  [crates.io](https://crates.io/crates/mesmo/settings) against `publish-rust.yml` +
  `release`, and on [PyPI](https://docs.pypi.org/trusted-publishers/) against `publish-py.yml` +
  `release`. Each publisher matches on the **top-level workflow filename** and the environment name,
  so renaming either breaks the OIDC exchange until it is re-registered. crates.io needs the crate
  to exist, so the **first** Rust release is a one-off manual `cargo publish` from a maintainer's
  machine (see step 3); PyPI accepts a *pending* publisher, so the first wheel upload creates the
  project.

### npm dist-tags

`publish-js.yml` publishes all six npm packages under one dist-tag, chosen from the version suffix.
**While this project is pre-1.0, a `-preN` version is published as `latest`** — not `preview`.

That is deliberate, and it has to be revisited at 1.0.0:

- A bare `npm install @bloxbean/mesmo` resolves the `latest` tag and nothing else, and npmjs.com
  renders the `latest` version's README on the package page. Publishing every release under
  `preview` would leave `latest` pinned forever to `0.0.0-oidc-bootstrap.0`, the placeholder
  published once to create the package name for trusted publishing — so a plain `npm install` would
  fetch an empty stub. (npm sets `latest` on a package's first-ever version regardless of
  `--tag`, and `npm deprecate` does not move a dist-tag.)
- A semver *range* never matches a prerelease (`npm i @bloxbean/mesmo@^0.1.0` does not resolve
  `0.1.0-pre7`), so the dist-tag is the only path by which a consumer gets a `-preN` build.

**At 1.0.0**, flip the `*-preview*|*-pre*|*-alpha*` arm of the `case` in `publish-js.yml` back to
`NPM_TAG=preview`, so a later `1.1.0-pre1` cannot displace the stable release on `latest`. The
`beta` and `rc` arms already tag `beta` / `next` and need no change.

Moving a tag after the fact is `npm dist-tag add <pkg>@<version> latest`, repeated for all six
packages — and with the packages set to "require 2FA and disallow tokens" it is interactive-only,
so it is worth getting the publish tag right instead.

## Release checklist

1. [ ] Open a PR bumping `version` in `gradle.properties`, run `./gradlew syncVersions`, and commit
       every resulting wrapper manifest, lockfile, and constant update. Confirm
       `./gradlew checkVersions` passes, get the PR approved by a release code owner, and merge it
       to `main`.
2. [ ] Approve the `authorize` job on `tag-release.yml` (environment `release`) to create
       `vX.Y.Z` → `release.yml` builds + uploads the 5 platform tarballs +
       `SHA256SUMS`; `publish-js.yml`, `publish-rust.yml`, and `publish-py.yml` build, then wait on
       the `release` approval. `publish-py.yml` also attaches its 5 wheels to the release before the
       approval gate, so they are downloadable regardless of the PyPI outcome.
3. [ ] Verify the release assets are named `mesmo-vX.Y.Z-<platform>.tar.gz`. **The Rust
       crate is source-only** — its `build.rs` downloads these at the consumer's build time, so they
       must be uploaded *before* approving the crates.io publish, or a `cargo add` will fail.
4. [ ] Approve the `release` environment on `publish-js.yml` (npm), `publish-rust.yml`
       (crates.io), and `publish-py.yml` (PyPI) to publish.
5. [ ] Tag `wrappers/go/vX.Y.Z` and push (Go module release — no build step, separate tag).
6. [ ] Smoke-test each: a clean `pip install` / `npm install` / `cargo add` / `go get` with no
       `MESMO_LIB_PATH` set.
