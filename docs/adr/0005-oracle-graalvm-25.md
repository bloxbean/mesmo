# ADR-0005: Standardize on Oracle GraalVM 25.0.3

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** bloxbean maintainers

## Context

CI floated `java-version: '25'` (a moving target), while local builds and docs referenced varying
setups. native-image behavior, available flags, and the produced binary can shift across GraalVM
versions, so an unpinned toolchain undermines reproducibility.

## Decision

Pin the **entire project** — local builds, CI, and release — to **Oracle GraalVM 25.0.3** exactly
(`distribution: 'graalvm'`, `java-version: '25.0.3'`).

## Consequences

- Reproducible builds; consistent native-image behavior across machines and CI.
- Adopting a newer GraalVM patch/feature release is a deliberate, single-point bump.

## Alternatives considered

- **Floating `'25'`** — non-reproducible; silent behavior changes on runner image updates.
- **GraalVM Community Edition** — we standardized on Oracle GraalVM (the `graalvm` distribution).

## Addendum (2026-09): bump to the 25.3 Innovation line

The pin moved from **25.0.3 (LTS patch line)** to **Oracle GraalVM 25.3.4.1** (the monthly
"Innovation" feature line on the JDK 25 LTS baseline):

- ~2.4% smaller native images were already measured on 25.1 (`libmesmo` 60.14 → 58.70 MB);
  25.3 carries those gains forward.
- `setup-graalvm` gained working Innovation-release resolution (`version:` field; the
  `artifact.metadata` bug that blocked the earlier 25.1 attempt was fixed in v1.6.2, and
  v1.6.5 added explicit 25.3.4.1 support). CI pins the action at v1.6.6.
- The manylinux/container builds fetch from the GDS archive
  (`gds.oracle.com/download/graal/25i3/latest/…`) — `download.oracle.com/archive` carries
  only LTS patch releases.
- Scalus's transitive `io.github.cquiroz:scala-java-time*` jars are excluded: they shadow
  `java.time` classes, which native-image's stricter class-path check (since 25.1) rejects;
  `java.base` provides `java.time` on the JVM anyway.

The decision itself is unchanged: pin exactly, bump deliberately at a single point.
