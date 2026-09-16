//! Keeps the committed Cargo.toml in lockstep with gradle.properties (the single source of truth).
//!
//! Publishing never needs a manual bump — CI stamps Cargo.toml from gradle.properties at build time
//! and build.rs derives the libmesmo release tag from that. But the
//! *committed* Cargo.toml is what regular CI compiles the tests against, and the version-skew check
//! compares its CARGO_PKG_VERSION with the freshly built libmesmo. So a base-version bump in
//! gradle.properties (0.1.0 -> 0.2.0) with a stale committed Cargo.toml would fail every Rust test
//! with a runtime "version skew" error that says nothing about the real cause. This test fails
//! instead, with the repo-wide synchronization command in the message.

use std::fs;

fn gradle_version() -> Option<String> {
    // Repo layout only: in the published crate there is no gradle.properties two levels up, and
    // nothing to cross-check — the published Cargo.toml was stamped by CI.
    let text = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../gradle.properties"
    ))
    .ok()?;
    text.lines().find_map(|l| {
        l.trim()
            .strip_prefix("version=")
            .map(|v| v.trim().to_string())
    })
}

#[test]
fn cargo_version_matches_gradle_properties() {
    let Some(gradle) = gradle_version() else {
        eprintln!("gradle.properties not reachable (published crate); nothing to cross-check");
        return;
    };
    let cargo = env!("CARGO_PKG_VERSION");
    assert_eq!(
        cargo, gradle,
        "\n\nCargo.toml version ({cargo}) does not match gradle.properties version ({gradle}).\n\
         gradle.properties is the single source of truth; the committed Cargo.toml must be kept in\n\
         lockstep, or the wrapper<->libmesmo version-skew check fails every Rust test with an\n\
         unrelated-looking runtime error. Fix from the repository root:\n\n\
         \x20   ./gradlew syncVersions\n\n\
         and commit the resulting wrapper version updates.\n"
    );
}
