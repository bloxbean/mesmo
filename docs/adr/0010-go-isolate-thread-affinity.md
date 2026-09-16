# ADR-0010: Go wrapper isolate thread-affinity — all FFI on one dedicated OS thread

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** bloxbean maintainers

## Context

A GraalVM isolate's `IsolateThread` is bound to the OS thread that created/attached it. Go goroutines
migrate freely across OS threads, so an FFI call could execute on a different OS thread than the one
that owns the isolate — producing a GraalVM "yellow zone" `StackOverflowError` (observed on Linux
x86_64, which forced the Go CI to be non-blocking).

## Decision

In the Go wrapper, pin **all FFI calls to a single dedicated OS thread** for the `Mesmo`'s lifetime: a
`runtime.LockOSThread`'d executor goroutine serializes every native call onto the thread that owns the
isolate (calls are submitted over a channel and run there).

## Consequences

- Eliminates the thread-migration crash; Linux Go CI is blocking and green again.
- Native calls are **serialized per `Mesmo`** — correctness at the FFI boundary over raw concurrency.
- One dedicated OS thread per `Mesmo` (acceptable for this workload).

## Alternatives considered

- **Attach/detach the isolate on every call** — per-call overhead and easy to get wrong.
- **Only raise the native-image stack size** — masks the symptom without fixing the root cause.
- **Document "don't call from multiple goroutines"** — fragile; pushes a sharp edge onto users.
