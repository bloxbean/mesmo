// Package mesmo provides Go bindings for the Cardano Client Lib (CCL), exposed through the libmesmo
// GraalVM native shared library. It covers account, address, crypto, transaction (QuickTx / TxPlan),
// Plutus, script, governance, and wallet operations.
//
// The native library is loaded in pure Go (via purego — no cgo, no C toolchain) and resolved at
// runtime: from MESMO_LIB_PATH, a per-version cache, or a one-time download of the matching GitHub
// release. See the package README for installation and usage.
//
// Project: https://github.com/bloxbean/mesmo
package mesmo
