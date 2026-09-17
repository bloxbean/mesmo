# ADR-0004: Bun is the only supported JavaScript runtime

- **Status:** Accepted
- **Date:** 2026-02-11
- **Deciders:** bloxbean maintainers

## Context

The JavaScript wrapper needs FFI into `libmesmo`. Node.js FFI libraries (`ffi-napi`, `koffi`) crash
against the GraalVM native-image library due to stack-boundary detection issues (notably on macOS
ARM64). Bun ships a built-in, stable FFI (`bun:ffi`).

## Decision

Support **Bun** as the only JavaScript runtime for the JS wrapper. **Node.js is not supported** — it is
tracked as a wanted-but-blocked investigation, not a committed deliverable.

## Consequences

- A working, stable JS FFI path via `bun:ffi`.
- Node.js users are not served directly; Bun is required to use the JS wrapper.
- Revisit if/when Node FFI stabilizes against GraalVM native-image.

## Alternatives considered

- **`ffi-napi` / `koffi` on Node** — crashes against the native-image library (stack boundaries).
- **A WebAssembly build** — different toolchain and a large, separate effort.
- **A local helper service for JS** — rejected; contradicts the in-process, offline model
  ([ADR-0002](0002-offline-stateless-no-provider.md)).
