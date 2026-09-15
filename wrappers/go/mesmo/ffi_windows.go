//go:build windows

package mesmo

import "syscall"

// dlopenLib loads the DLL on Windows. purego has no Dlopen/RTLD_* there, so use the Win32 loader and
// hand the module handle to purego.RegisterLibFunc (which is cross-platform).
func dlopenLib(path string) (uintptr, error) {
	h, err := syscall.LoadLibrary(path)
	return uintptr(h), err
}
