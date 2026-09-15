package mesmo

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func makeTarGz(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, data := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractLib(t *testing.T) {
	want := []byte("fake-native-lib")
	tgz := makeTarGz(t, map[string][]byte{
		"libmesmo.h":  []byte("header"),
		"libmesmo.so": want,
	})
	// Extract into a nested dir that doesn't exist yet (must be created).
	dst := filepath.Join(t.TempDir(), "sub", "libmesmo.so")
	if err := extractLib(bytes.NewReader(tgz), "libmesmo.so", dst); err != nil {
		t.Fatalf("extractLib: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("extracted %q, want %q", got, want)
	}
}

func TestExtractLibMissing(t *testing.T) {
	tgz := makeTarGz(t, map[string][]byte{"other.txt": []byte("x")})
	dst := filepath.Join(t.TempDir(), "libmesmo.so")
	if err := extractLib(bytes.NewReader(tgz), "libmesmo.so", dst); err == nil {
		t.Fatal("expected an error when the lib is absent from the tarball")
	}
}

func TestResolveLibPathHonorsEnvDir(t *testing.T) {
	// MESMO_LIB_PATH pointing at a directory containing the platform lib resolves to that file.
	dir := t.TempDir()
	libFile := filepath.Join(dir, libFileName())
	if err := os.WriteFile(libFile, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MESMO_LIB_PATH", dir)
	got, err := resolveLibPath()
	if err != nil {
		t.Fatal(err)
	}
	if got != libFile {
		t.Fatalf("resolveLibPath = %q, want %q", got, libFile)
	}
}

func TestPlatformSlugKnown(t *testing.T) {
	// The current test platform must map to a known slug (so a download URL can be built).
	if _, err := platformSlug(); err != nil {
		t.Fatalf("platformSlug for current platform: %v", err)
	}
}

func TestMuslLoaderPath(t *testing.T) {
	// The musl loader path is arch-specific; verify the mapping for this host's arch.
	got := muslLoaderPath()
	want := map[string]string{
		"amd64": "/lib/ld-musl-x86_64.so.1",
		"arm64": "/lib/ld-musl-aarch64.so.1",
	}[runtime.GOARCH] // "" for unmapped arches, which is what muslLoaderPath returns too
	if got != want {
		t.Fatalf("muslLoaderPath() = %q, want %q for %s", got, want, runtime.GOARCH)
	}
}

func TestIsMuslLinuxMatchesLoaderFile(t *testing.T) {
	// isMuslLinux must agree with the actual presence of the musl loader (false off Linux).
	var want bool
	if runtime.GOOS == "linux" {
		if p := muslLoaderPath(); p != "" {
			_, err := os.Stat(p)
			want = err == nil
		}
	}
	if got := isMuslLinux(); got != want {
		t.Fatalf("isMuslLinux() = %v, want %v", got, want)
	}
}

func TestPlatformSlugGlibcHasNoMuslInfix(t *testing.T) {
	// On a glibc Linux (the CI runners), the slug must be the plain glibc variant, never "-musl".
	if runtime.GOOS != "linux" || isMuslLinux() {
		t.Skip("only meaningful on glibc Linux")
	}
	slug, err := platformSlug()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(slug, "musl") {
		t.Fatalf("glibc Linux slug should not contain 'musl': %q", slug)
	}
}

func TestPlatformSlugMuslSelectsMuslArtifact(t *testing.T) {
	// On a real musl system (Alpine), the loader must auto-select the musl artifact. This is the
	// meaningful half of the auto-selection; it only fires under the musl-alpine.yml Alpine job.
	if runtime.GOOS != "linux" || !isMuslLinux() {
		t.Skip("only meaningful on musl Linux (Alpine)")
	}
	slug, err := platformSlug()
	if err != nil {
		t.Fatal(err)
	}
	if slug != "linux-musl-x86_64" {
		t.Fatalf("musl slug = %q, want linux-musl-x86_64", slug)
	}
}
