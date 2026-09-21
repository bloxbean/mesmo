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

/// Reads a repository file by its path from the repo root.
///
/// Repo layout only: the published crate has no repository above it, and nothing to cross-check —
/// its Cargo.toml was stamped by CI and its build.rs was published from a checked repo.
fn repo_file(relative_path: &str) -> Option<String> {
    let path = format!("{}/../../{relative_path}", env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(path).ok()
}

fn gradle_version() -> Option<String> {
    let text = repo_file("gradle.properties")?;
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

/// The asset name `build.rs` downloads must be the asset name `release.yml` uploads.
///
/// Nothing else catches a mismatch. CI builds libmesmo in-tree before every Rust test, and
/// `publish-rust.yml` points cargo's verification build at that same in-tree lib via
/// `MESMO_LIB_PATH` — so the download path is never exercised before publishing. A stale prefix
/// therefore publishes green and breaks every consumer's first `cargo build`, on a crates.io
/// version that can only be yanked, never corrected. The rename to `mesmo` was exactly that
/// near-miss: `release.yml` and the Go loader moved to `mesmo-*`, build.rs was left behind.
#[test]
fn build_rs_downloads_the_asset_that_release_yml_uploads() {
    let Some(workflow) = repo_file(".github/workflows/release.yml") else {
        eprintln!("release.yml not reachable (published crate); nothing to cross-check");
        return;
    };
    let build_rs = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/build.rs"))
        .expect("build.rs sits beside Cargo.toml");

    let asked_for = build_rs
        .lines()
        .find_map(|l| {
            let rest = l.trim().strip_prefix(r#"let tarball = format!(""#)?;
            rest.split_once("-{version}").map(|(prefix, _)| prefix)
        })
        .expect(
            r#"build.rs names the tarball as `let tarball = format!("<prefix>-{version}-..")`"#,
        );

    // `tar czf mesmo-${{ github.ref_name }}-<platform>.tar.gz` — one per built platform.
    let uploaded: Vec<&str> = workflow
        .lines()
        .filter_map(|l| l.trim().strip_prefix("tar czf "))
        .filter_map(|rest| {
            rest.split_once("-${{ github.ref_name }}")
                .map(|(prefix, _)| prefix)
        })
        .collect();
    assert!(
        !uploaded.is_empty(),
        "no `tar czf <prefix>-${{{{ github.ref_name }}}}-..` lines found in release.yml — if the \n\
         release workflow changed how it names assets, update this test and build.rs together."
    );

    for uploaded_prefix in &uploaded {
        assert_eq!(
            &asked_for, uploaded_prefix,
            "\n\nbuild.rs downloads `{asked_for}-<version>-<platform>.tar.gz`, but release.yml \n\
             uploads `{uploaded_prefix}-<version>-<platform>.tar.gz`. Every published crate resolves \n\
             its libmesmo through that URL, so a mismatch is a 404 on the consumer's first build.\n"
        );
    }
}
