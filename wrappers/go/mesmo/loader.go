package mesmo

// Native-library resolution. Go ships as source and has no build/install hook, so — unlike the
// Python (wheel), npm (optionalDeps), and Rust (build.rs) wrappers — libmesmo is located at runtime:
// an explicit override, a per-version cache, or a one-time download of the release tarball we already
// publish. Resolution is fail-hard: a bad download errors out rather than falling back to a stale lib.

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

// defaultLibVersion pins the libmesmo release fetched when the library isn't already present. Override
// at runtime with MESMO_LIB_VERSION.
//
// Unlike the other wrappers, Go cannot derive this at consumer build time: the module is consumed
// straight from git source. The repository's `syncVersions` Gradle task writes this committed
// constant from gradle.properties, and TestVersionConstantsMatchGradle guards it against drift so a
// stale pin fails CI instead of 404ing on a user.
const defaultLibVersion = "v0.1.0-pre8"

const releaseBaseURL = "https://github.com/bloxbean/mesmo/releases/download"

// releaseAssetURL builds the download URL for a libmesmo release tarball.
func releaseAssetURL(version, slug string) string {
	return fmt.Sprintf("%s/%s/mesmo-%s-%s.tar.gz", releaseBaseURL, version, version, slug)
}

func libVersion() string {
	if v := os.Getenv("MESMO_LIB_VERSION"); v != "" {
		return v
	}
	return defaultLibVersion
}

func libFileName() string {
	switch runtime.GOOS {
	case "windows":
		return "libmesmo.dll"
	case "darwin":
		return "libmesmo.dylib"
	default:
		return "libmesmo.so"
	}
}

// platformSlug maps GOOS/GOARCH to the release tarball's platform token.
func platformSlug() (string, error) {
	switch runtime.GOOS {
	case "linux":
		// Go reports GOOS=linux for both glibc and musl, so detect musl (Alpine) at runtime and pick
		// the musl artifact — the glibc .so can't load there.
		musl := ""
		if isMuslLinux() {
			musl = "-musl"
		}
		switch runtime.GOARCH {
		case "amd64":
			return "linux" + musl + "-x86_64", nil
		case "arm64":
			if musl != "" {
				return "", fmt.Errorf("no prebuilt musl libmesmo for linux/arm64 " +
					"(GraalVM's --libc=musl is x86_64-only); build from source or set MESMO_LIB_PATH")
			}
			return "linux-aarch64", nil
		}
	case "darwin":
		// macOS x86_64 (Intel) has no prebuilt libmesmo: Oracle GraalVM is dropping Intel-Mac support
		// (its 25.1 line ships no macOS-x86_64 build), so we don't release one. Intel-Mac users build
		// from source or set MESMO_LIB_PATH.
		if runtime.GOARCH == "arm64" {
			return "macos-aarch64", nil
		}
	case "windows":
		if runtime.GOARCH == "amd64" {
			return "windows-x86_64", nil
		}
	}
	return "", fmt.Errorf("no prebuilt libmesmo for %s/%s; set MESMO_LIB_PATH to a local build",
		runtime.GOOS, runtime.GOARCH)
}

// muslLoaderPath returns the musl dynamic-loader path for this arch (empty if unmapped).
func muslLoaderPath() string {
	switch runtime.GOARCH {
	case "amd64":
		return "/lib/ld-musl-x86_64.so.1"
	case "arm64":
		return "/lib/ld-musl-aarch64.so.1"
	}
	return ""
}

// isMuslLinux reports whether this is a musl-based Linux (e.g. Alpine). Go's GOOS is "linux" for both
// glibc and musl, so detect musl by its dynamic loader — a file only musl systems ship.
func isMuslLinux() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	p := muslLoaderPath()
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// resolveLibPath finds libmesmo, in order: the MESMO_LIB_PATH override (a directory or the file itself),
// the per-version user cache, or a one-time download of the release tarball into that cache.
func resolveLibPath() (string, error) {
	name := libFileName()

	if p := os.Getenv("MESMO_LIB_PATH"); p != "" {
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			p = filepath.Join(p, name)
		}
		if fileExists(p) {
			return p, nil
		}
		return "", fmt.Errorf("MESMO_LIB_PATH set but %s not found", p)
	}

	cacheRoot, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("locate cache dir: %w", err)
	}
	dst := filepath.Join(cacheRoot, "mesmo", libVersion(), name)
	if fileExists(dst) {
		return dst, nil
	}

	if err := downloadLib(dst, name); err != nil {
		return "", fmt.Errorf("fetch libmesmo %s: %w", libVersion(), err)
	}
	return dst, nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// downloadLib fetches the platform release tarball and extracts `name` to `dst`.
func downloadLib(dst, name string) error {
	slug, err := platformSlug()
	if err != nil {
		return err
	}
	url := releaseAssetURL(libVersion(), slug)

	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	return extractLib(resp.Body, name, dst)
}

// extractLib reads a gzip'd tarball from r and writes the entry named `name` to `dst`, publishing it
// atomically (temp file + rename) so concurrent or interrupted downloads never leave a partial lib.
func extractLib(r io.Reader, name, dst string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s not found in tarball", name)
		}
		if err != nil {
			return err
		}
		if filepath.Base(hdr.Name) != name {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		tmp, err := os.CreateTemp(filepath.Dir(dst), ".libmesmo-*")
		if err != nil {
			return err
		}
		defer os.Remove(tmp.Name()) // no-op after a successful rename
		if _, err := io.Copy(tmp, tr); err != nil {
			tmp.Close()
			return err
		}
		if err := tmp.Close(); err != nil {
			return err
		}
		if err := os.Chmod(tmp.Name(), 0o755); err != nil {
			return err
		}
		return os.Rename(tmp.Name(), dst)
	}
}
