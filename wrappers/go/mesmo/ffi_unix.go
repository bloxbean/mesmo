//go:build !windows

package mesmo

import "github.com/ebitengine/purego"

// dlopenLib loads the shared library on Unix (Linux / macOS) via purego's dlopen.
func dlopenLib(path string) (uintptr, error) {
	return purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
}
