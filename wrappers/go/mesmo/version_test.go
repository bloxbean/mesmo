package mesmo

import "testing"

func TestBaseVersion(t *testing.T) {
	cases := map[string]string{
		"0.1.0":          "0.1.0",
		"0.1.0-preview1": "0.1.0",
		"1.2.3+build.5":  "1.2.3",
		"  0.1.0  ":      "0.1.0",
	}
	for in, want := range cases {
		if got := baseVersion(in); got != want {
			t.Errorf("baseVersion(%q) = %q, want %q", in, got, want)
		}
	}
}
