# ADR-0015: No reference wrapper — keep the four wrappers at parity

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** bloxbean maintainers

## Context

The bridge exposes one native library (`libmesmo`) through four wrappers — Python, Go, Rust, and
JavaScript (Bun) ([ADR-0003](0003-four-language-wrappers-uniform-ffi.md)). As the FFI surface grows,
the wrappers can **drift**: one wrapper gains a new `@CEntryPoint` or capability that the others lack.

To manage that, a **"reference wrapper"** was proposed: designate Python — currently the most complete
and best-tested wrapper — as the canonical one, with the other three expected to *mirror* it
("Python-first"). But the project's aim is for **all four wrappers to be first-class and equally
complete**, and a designated reference is in tension with that: it frames three of the four as
secondary.

## Decision

**We will not designate a reference wrapper.** All four wrappers are first-class; the goal is *equal*
completeness, not a hierarchy.

- **Parity is the rule.** A change to the FFI surface is not done until **all four** wrappers have it —
  bound, exposed idiomatically, and tested.
- **Enforced by CI where possible:** *binding parity* — [`scripts/check_entrypoint_parity.py`](../../scripts/check_entrypoint_parity.py)
  fails CI unless every wrapper binds exactly the core `@CEntryPoint` set — and *use-case parity* —
  all four run the same build → sign → submit scenarios against a live DevKit in `integration-tests.yml`.
- **Backed by a contributor checklist** for the manual parts (below).

Explicitly **out of scope:** identical *code*. Each wrapper stays idiomatic — `MesmoLib` (Python) /
`Bridge` (Go, Rust) / `MesmoBridge` (JS), `snake_case` vs `camelCase`, per-language error types — and
some tests are legitimately wrapper-specific (the library loaders, the version-skew check, JS's
cost-model normalization, musl detection). Parity means the same *capabilities and coverage*, not the
same source.

## Consequences

- **Easier:** no wrapper is second-class; contributors have one unambiguous rule — *all four, or it's
  not merged* — and the binding half is caught automatically.
- **Harder / accepted cost:** every FFI change is ~4× the work (bind + expose + test in each wrapper).
  That is the price of genuine parity, accepted deliberately.
- **The checklist — on any FFI / API change:**
  1. **Core** — add/change the `@CEntryPoint` (`mesmo_*` naming) + a JVM test.
  2. **Bind it in all four FFI layers** — `wrappers/python/mesmo/_ffi.py`, `wrappers/go/mesmo/ffi.go`,
     `wrappers/rust/src/ffi.rs`, `wrappers/js/src/index.js`.
  3. **Expose it** in each wrapper's public API, idiomatically.
  4. **Test it in all four**, at the same level (offline build assertions + a DevKit integration test
     for build→sign→submit paths).
  5. **Update** examples + per-wrapper READMEs if the surface is user-facing.
  6. **Run** `python3 scripts/check_entrypoint_parity.py` (must pass).
  7. **Run** the four wrapper suites + the DevKit integration tests for tx paths.
  8. **Version** — bump per [`RELEASING.md`](../../RELEASING.md) if the change alters the ABI/contract.
- **Current state / follow-up:** coverage is close but not yet uniform — Python currently has the most
  per-module *unit* tests; bringing Go and Rust up is a **gap to close** (test-breadth item in
  `TODO.md`), not a hierarchy to keep.
- **Revisit if:** the project ever decides to demote a wrapper to a lower support tier, or a wrapper
  falls permanently behind — either would supersede this ADR.

## Alternatives considered

- **Designate Python as a reference wrapper ("Python-first").** Rejected. It bakes in a hierarchy that
  signals the other three are secondary, conflicting with the goal that all four are first-class.
  Python's current lead is an artifact of development *order* (it got the most tests first), not a
  reason to make the others permanently follow. The lockstep benefit it aimed for is achieved instead
  by the parity rule + CI enforcement — without the hierarchy. *(This ADR supersedes the informal
  "Python is the de-facto reference" note that previously lived in `TODO.md`.)*
- **No policy — rely on code review.** Rejected. Drift is easy to miss in review; a written rule plus
  the automatable binding-parity check makes "all four" a hard guarantee rather than a hope.
