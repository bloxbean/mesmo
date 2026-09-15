# ADR-0001: Native shared library via GraalVM native-image + C FFI

- **Status:** Accepted
- **Date:** 2026-02-11
- **Deciders:** bloxbean maintainers

## Context

Cardano Client Lib (CCL) is a mature, actively-maintained JVM library for Cardano transaction building,
crypto, and serialization. Other ecosystems (Python, Go, Rust, JavaScript) rely on their own native
implementations, which vary in completeness and — as has happened in the Cardano ecosystem — can stop
being maintained abruptly, leaving downstream users stranded. We wanted a **maintained alternative**
that reuses CCL's exact, well-tested behavior from other languages, with native startup and no JVM at
runtime — without having to build and keep four independent reimplementations in lockstep ourselves.

## Decision

Compile CCL into a single **native shared library** (`libmesmo`) using **GraalVM native-image**, exposing
a stable **C ABI** via `@CEntryPoint` exports, and bind to it from each language through that language's
FFI. No JVM is shipped or required at runtime. Data crosses the boundary as C strings (JSON/YAML/hex).

## Consequences

- One core codebase reused everywhere; CCL semantics are identical across all languages.
- Native startup, small footprint, no JVM dependency.
- native-image constraints become ours: reflection must be registered (`reflect-config.json`),
  some libraries need build-time initialization, builds are slower.
- The C ABI is a lowest-common-denominator interface (strings in/out, manual memory release).
- Portability of the produced `.so`/`.dylib`/`.dll` becomes a real concern — see [ADR-0008](0008-linux-glibc-baseline-portability.md).

## Alternatives considered

- **Rely solely on existing per-language native libraries** — they exist and work, but carry the risk
  of being abruptly abandoned; Mesmo is the maintained fallback. (Building and maintaining our
  *own* four independent reimplementations would also be a large, duplicated effort with correctness
  drift across languages.)
- **JNI / embedded JVM** — ships and runs a JVM; heavy footprint and startup.
- **REST sidecar service** — network hop, stateful, operational burden; contradicts an offline,
  in-process model ([ADR-0002](0002-offline-stateless-no-provider.md)).
