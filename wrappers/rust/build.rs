// Build script: make `libmesmo.*` available to the linker AND findable at runtime with no
// DYLD_LIBRARY_PATH / LD_LIBRARY_PATH, so `cargo build` "just works".
//
// The native lib is sourced in priority order:
//   1. MESMO_LIB_PATH        — an explicit directory (local development);
//   2. the in-tree build   — ../../core/build/native/nativeCompile (developing in this repo);
//   3. the GitHub release  — downloaded for the target platform (published-crate path).
//
// We stage a *copy* of the lib into OUT_DIR (a dir we control), rewrite its macOS install name to
// `@rpath/libmesmo.dylib` (GraalVM stamps an absolute build path, which would otherwise be baked into
// every consumer binary), and emit an rpath to OUT_DIR — so the runtime loader finds it with no env.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const REPO: &str = "bloxbean/mesmo";

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let lib_file = lib_filename(&target_os);

    let src = resolve_source_lib(&lib_file, &out_dir);
    let staged = out_dir.join(&lib_file);
    if src != staged {
        fs::copy(&src, &staged)
            .unwrap_or_else(|e| panic!("staging {} -> {}: {e}", src.display(), staged.display()));
    }

    if target_os == "macos" {
        // Make the dependency resolvable via rpath instead of the absolute build path.
        let _ = Command::new("install_name_tool")
            .args(["-id", &format!("@rpath/{lib_file}")])
            .arg(&staged)
            .status();
    }

    if target_os == "windows" {
        // GraalVM produces the import library as `libmesmo.lib`, but `cargo:rustc-link-lib=dylib=mesmo`
        // makes the MSVC linker look for `mesmo.lib`. Stage a copy under that name into OUT_DIR (which
        // is on the link search path) so linking resolves. The import lib sits next to the DLL.
        if let Some(src_dir) = src.parent() {
            let import_src = src_dir.join("libmesmo.lib");
            if import_src.exists() {
                let import_dst = out_dir.join("mesmo.lib");
                fs::copy(&import_src, &import_dst).unwrap_or_else(|e| {
                    panic!(
                        "staging {} -> {}: {e}",
                        import_src.display(),
                        import_dst.display()
                    )
                });
            }
        }
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=dylib=mesmo");
    if target_os != "windows" {
        // Runtime: find libmesmo next to where we staged it — no DYLD/LD_LIBRARY_PATH needed.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", out_dir.display());
    }
    println!("cargo:rerun-if-env-changed=MESMO_LIB_PATH");
    println!("cargo:rerun-if-env-changed=MESMO_LIB_VERSION");
    println!("cargo:rerun-if-changed=build.rs");
}

fn lib_filename(target_os: &str) -> String {
    match target_os {
        "macos" => "libmesmo.dylib",
        "windows" => "libmesmo.dll",
        _ => "libmesmo.so",
    }
    .to_string()
}

fn resolve_source_lib(lib_file: &str, out_dir: &Path) -> PathBuf {
    if let Ok(dir) = env::var("MESMO_LIB_PATH") {
        let p = Path::new(&dir).join(lib_file);
        if p.exists() {
            return p;
        }
    }
    let in_tree = Path::new("../../core/build/native/nativeCompile").join(lib_file);
    if in_tree.exists() {
        return in_tree;
    }
    download_lib(lib_file, out_dir)
}

fn download_lib(lib_file: &str, out_dir: &Path) -> PathBuf {
    // The release tag is *derived*, never assumed: a crate published at X was built from the tag vX
    // (CI enforces tag == v<version>, both from gradle.properties), so vX is exactly the release
    // holding the matching libmesmo. Nothing to hand-maintain, and it can't drift out of lockstep.
    // Override with MESMO_LIB_VERSION to build against a different release.
    let version = env::var("MESMO_LIB_VERSION").unwrap_or_else(|_| {
        format!(
            "v{}",
            env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION")
        )
    });
    let platform = platform_tag();
    // Must match the asset name uploaded by .github/workflows/release.yml, which
    // tests/version_sync_test.rs cross-checks — nothing else does. The publish workflow verify-builds
    // against an in-tree libmesmo, so a stale name here publishes cleanly and only fails later, at
    // every consumer's first build, for a version that can then only be yanked.
    let tarball = format!("mesmo-{version}-{platform}.tar.gz");
    let url = format!("https://github.com/{REPO}/releases/download/{version}/{tarball}");
    let dl = out_dir.join(&tarball);

    let ok = Command::new("curl")
        .args(["-fsSL", "-o"])
        .arg(&dl)
        .arg(&url)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    // The usual cause is building an in-development version that has no release yet (the published
    // path always resolves, by the argument above) — so point at the two local sources instead.
    assert!(
        ok,
        "could not download libmesmo from {url}\n\
         If you are building this repo from source, there is no release for an unreleased version: \
         build the native library (./gradlew :core:nativeCompile) or set MESMO_LIB_PATH to a \
         directory containing {lib_file}."
    );
    run(
        Command::new("tar")
            .arg("xzf")
            .arg(&dl)
            .arg("-C")
            .arg(out_dir),
        "extract native library",
    );
    let extracted = out_dir.join(lib_file);
    assert!(
        extracted.exists(),
        "native library {lib_file} not found after extracting {tarball}"
    );
    extracted
}

fn platform_tag() -> String {
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    // macOS x86_64 (Intel) has no prebuilt libmesmo: Oracle GraalVM is dropping Intel-Mac support (its
    // 25.1 line ships no macOS-x86_64 build), so none is released. Fail clearly instead of downloading
    // a tarball that doesn't exist.
    if os == "macos" && arch == "x86_64" {
        panic!(
            "no prebuilt libmesmo for macOS x86_64 (Intel); build libmesmo from source and set MESMO_LIB_PATH"
        );
    }
    // Rust knows musl vs glibc from the target triple (…-linux-musl vs …-linux-gnu) via TARGET_ENV,
    // so pick the musl artifact for Alpine / musl targets — the glibc .so can't load there.
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os == "linux" && target_env == "musl" {
        if arch != "x86_64" {
            panic!(
                "no prebuilt musl libmesmo for linux/{arch} (GraalVM's --libc=musl is x86_64-only); \
                 build libmesmo from source and set MESMO_LIB_PATH"
            );
        }
        return "linux-musl-x86_64".to_string();
    }
    let os = match os.as_str() {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = match arch.as_str() {
        "aarch64" => "aarch64",
        _ => "x86_64",
    };
    format!("{os}-{arch}")
}

fn run(cmd: &mut Command, what: &str) {
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("failed to run ({what}): {e}"));
    assert!(status.success(), "command failed ({what}): {status}");
}
