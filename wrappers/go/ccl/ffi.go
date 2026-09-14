package ccl

// FFI binding layer. The native library (libccl) is loaded with purego — pure-Go dlopen/dlsym, no
// cgo and no C toolchain — so `go get` works without a prebuilt library on the build machine. Every
// entry point is a package-level function variable bound once, on first use, in ensureLoaded().

import (
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// GraalVM isolate lifecycle + the shared result/error accessors.
var (
	graalCreateIsolate   func(params uintptr, isolate *uintptr, thread *uintptr) int32
	graalTearDownIsolate func(thread uintptr) int32
	cclGetResult         func(thread uintptr) *byte // char* (freed via cclFreeString)
	cclGetLastError      func(thread uintptr) *byte // char*
	cclFreeString        func(thread uintptr, s *byte)
)

// One function variable per libccl entry point. purego marshals Go strings to C strings for the
// call (and frees them after), so the wrappers pass strings directly.
var (
	cclVersion func(thread uintptr) int32

	cclAddressInfo      func(thread uintptr, bech32 string) int32
	cclAddressValidate  func(thread uintptr, bech32 string) int32
	cclAddressToBytes   func(thread uintptr, bech32 string) int32
	cclAddressFromBytes func(thread uintptr, hexBytes string) int32

	cclCryptoBlake2b256     func(thread uintptr, dataHex string) int32
	cclCryptoBlake2b224     func(thread uintptr, dataHex string) int32
	cclCryptoGenerateMnemon func(thread uintptr, wordCount int32) int32
	cclCryptoValidateMnemon func(thread uintptr, mnemonic string) int32
	cclCryptoSign           func(thread uintptr, messageHex, skHex string) int32
	cclCryptoDeriveKey      func(thread uintptr, mnemonic string, accIdx, addrIdx int32, role string) int32
	cclCryptoVerify         func(thread uintptr, signatureHex, messageHex, pkHex string) int32

	cclTxHash          func(thread uintptr, tx string) int32
	cclTxSignSecretKey func(thread uintptr, tx, sk string) int32
	cclTxToJSON        func(thread uintptr, tx string) int32
	cclTxFromJSON      func(thread uintptr, txJSON string) int32
	cclTxDeserialize   func(thread uintptr, tx string) int32

	cclPlutusDataHash     func(thread uintptr, datum string) int32
	cclPlutusDataToJSON   func(thread uintptr, cborHex string) int32
	cclPlutusDataFromJSON func(thread uintptr, jsonStr string) int32

	cclScriptNativeFromJSON func(thread uintptr, jsonStr string) int32
	cclScriptHash           func(thread uintptr, scriptCbor string, scriptType int32) int32

	cclQuicktxBuild func(thread uintptr, yaml, utxos, params, execUnits string, additionalSigners int32) int32

	// Managed account handles (ADR-0016)
	cclAccountOpenMnemonic         func(thread uintptr, network int32, mnemonic string, accountIndex, addressIndex int32, outHandle *int64) int32
	cclAccountGetInfo              func(thread uintptr, handle int64) int32
	cclAccountSignTxHandle         func(thread uintptr, handle int64, txCbor string, roleMask int32) int32
	cclAccountCloseHandle          func(thread uintptr, handle int64) int32
	cclAccountCreateHandle         func(thread uintptr, network int32, outHandle *int64) int32
	cclAccountExportRecoveryPhrase func(thread uintptr, handle int64, outPhrase **byte) int32
)

var (
	loadOnce sync.Once
	loadErr  error
)

// ensureLoaded resolves + dlopens libccl and binds every entry point, exactly once per process.
func ensureLoaded() error {
	loadOnce.Do(func() {
		path, err := resolveLibPath()
		if err != nil {
			loadErr = err
			return
		}
		// dlopenLib is platform-specific: purego.Dlopen on Unix, syscall.LoadLibrary on Windows
		// (purego.Dlopen / RTLD_* don't exist on Windows). See ffi_unix.go / ffi_windows.go.
		lib, err := dlopenLib(path)
		if err != nil {
			loadErr = fmt.Errorf("load %s: %w", path, err)
			return
		}
		reg := func(fptr any, name string) { purego.RegisterLibFunc(fptr, lib, name) }

		reg(&graalCreateIsolate, "graal_create_isolate")
		reg(&graalTearDownIsolate, "graal_tear_down_isolate")
		reg(&cclGetResult, "ccl_get_result")
		reg(&cclGetLastError, "ccl_get_last_error")
		reg(&cclFreeString, "ccl_free_string")

		reg(&cclVersion, "ccl_version")

		reg(&cclAddressInfo, "ccl_address_info")
		reg(&cclAddressValidate, "ccl_address_validate")
		reg(&cclAddressToBytes, "ccl_address_to_bytes")
		reg(&cclAddressFromBytes, "ccl_address_from_bytes")

		reg(&cclCryptoBlake2b256, "ccl_crypto_blake2b_256")
		reg(&cclCryptoBlake2b224, "ccl_crypto_blake2b_224")
		reg(&cclCryptoGenerateMnemon, "ccl_crypto_generate_mnemonic")
		reg(&cclCryptoValidateMnemon, "ccl_crypto_validate_mnemonic")
		reg(&cclCryptoSign, "ccl_crypto_sign")
		reg(&cclCryptoVerify, "ccl_crypto_verify")
		reg(&cclCryptoDeriveKey, "ccl_crypto_derive_key")

		reg(&cclTxHash, "ccl_tx_hash")
		reg(&cclTxSignSecretKey, "ccl_tx_sign_with_secret_key")
		reg(&cclTxToJSON, "ccl_tx_to_json")
		reg(&cclTxFromJSON, "ccl_tx_from_json")
		reg(&cclTxDeserialize, "ccl_tx_deserialize")

		reg(&cclPlutusDataHash, "ccl_plutus_data_hash")
		reg(&cclPlutusDataToJSON, "ccl_plutus_data_to_json")
		reg(&cclPlutusDataFromJSON, "ccl_plutus_data_from_json")

		reg(&cclScriptNativeFromJSON, "ccl_script_native_from_json")
		reg(&cclScriptHash, "ccl_script_hash")

		reg(&cclQuicktxBuild, "ccl_quicktx_build")
		reg(&cclAccountOpenMnemonic, "ccl_account_open_mnemonic")
		reg(&cclAccountGetInfo, "ccl_account_get_info")
		reg(&cclAccountSignTxHandle, "ccl_account_sign_tx_handle")
		reg(&cclAccountCloseHandle, "ccl_account_close")
		reg(&cclAccountCreateHandle, "ccl_account_create_handle")
		reg(&cclAccountExportRecoveryPhrase, "ccl_account_export_recovery_phrase")
	})
	return loadErr
}

// goString copies a NUL-terminated C string into a Go string (safe to keep after the source is
// freed). Works from a *byte so no uintptr→Pointer conversion is needed (vet-clean).
func goString(p *byte) string {
	if p == nil {
		return ""
	}
	var n int
	for *(*byte)(unsafe.Add(unsafe.Pointer(p), n)) != 0 {
		n++
	}
	return string(unsafe.Slice(p, n))
}
