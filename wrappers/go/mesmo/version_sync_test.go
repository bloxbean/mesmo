package mesmo

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

// The Go module is served straight from git source, so its consumer build has no step that can
// derive constants from gradle.properties. The repository's `syncVersions` Gradle task writes the
// committed values instead. Before that task existed they rotted — defaultLibVersion sat at
// v0.1.0-preview1, the one release whose assets still used the old `mesmo-*` names, so the
// loader built a `mesmo-*` URL against it and every `go get` user got a bare HTTP 404.
//
// These tests make gradle.properties the source of truth anyway, by enforcement rather than
// derivation: drift now fails CI here instead of on a user's first call.

// gradleVersion reads `version` from the repo's gradle.properties, or "" when it isn't reachable
// (i.e. someone consuming the published module, where only the wrapper subtree exists).
func gradleVersion(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../../../gradle.properties")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "version="); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func TestVersionConstantsMatchGradle(t *testing.T) {
	version := gradleVersion(t)
	if version == "" {
		t.Skip("gradle.properties not reachable (published module); nothing to cross-check")
	}

	// The release tag is always v<version> — CI enforces that when tagging.
	if want := "v" + version; defaultLibVersion != want {
		t.Errorf("defaultLibVersion = %q, want %q (from gradle.properties version=%s).\n"+
			"A stale pin makes the loader request a release asset that does not exist, so `go get` "+
			"users get an HTTP 404 on first call. Run ./gradlew syncVersions from the repository root.",
			defaultLibVersion, want, version)
	}

	// The skew check compares base semver, so expectedLibVersion drops any -pre/-rc suffix.
	if want := baseVersion(version); expectedLibVersion != want {
		t.Errorf("expectedLibVersion = %q, want %q (base semver of gradle.properties version=%s). "+
			"Run ./gradlew syncVersions from the repository root.",
			expectedLibVersion, want, version)
	}
}

// TestReleaseAssetURLResolves is the test that would have caught the 404: it asks GitHub whether the
// asset the loader will actually request exists. A version-bump PR necessarily runs before its tag
// and assets exist, so normal branch/PR CI cannot make this assertion. release.yml opts in after the
// GitHub Release has been published.
func TestReleaseAssetURLResolves(t *testing.T) {
	if testing.Short() {
		t.Skip("network test")
	}
	if os.Getenv("MESMO_VERIFY_RELEASE_ASSET") != "1" {
		t.Skip("release asset is verified after publishing; set MESMO_VERIFY_RELEASE_ASSET=1 to run")
	}
	slug, err := platformSlug()
	if err != nil {
		t.Skipf("no prebuilt libmesmo for this platform: %v", err)
	}

	url := releaseAssetURL(defaultLibVersion, slug)
	req, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("HEAD %s: %v", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("HEAD %s: HTTP %d — the pinned release has no asset for this platform, so the "+
			"zero-config download path is broken for every user on it.", url, resp.StatusCode)
	}
}

func TestReleaseAssetURL(t *testing.T) {
	got := releaseAssetURL("v1.2.3", "linux-x86_64")
	want := "https://github.com/bloxbean/mesmo/releases/download/v1.2.3/mesmo-v1.2.3-linux-x86_64.tar.gz"
	if got != want {
		t.Errorf("releaseAssetURL() = %q, want %q", got, want)
	}
}
