package com.bloxbean.cardano.bridge;

/**
 * Status codes returned by every Cardano Client Bindings entry point.
 *
 * <p>{@link #CCL_SUCCESS} ({@code 0}) indicates success; all error codes are negative. On a
 * negative return, a human-readable message is available via {@code ccl_get_last_error}. The
 * specific code is a coarse category — the message carries the detail.
 *
 * @see CclBridge#getLastError calling convention and result/error retrieval
 */
public final class ErrorCodes {
    /** Operation succeeded; a result (if any) is available via {@code ccl_get_result}. */
    public static final int CCL_SUCCESS = 0;
    /** Unspecified failure not covered by a more specific code. */
    public static final int CCL_ERROR_GENERAL = -1;
    /** A required argument was missing, malformed, or out of range. */
    public static final int CCL_ERROR_INVALID_ARGUMENT = -2;
    /** CBOR/JSON (de)serialization failed. */
    public static final int CCL_ERROR_SERIALIZATION = -3;
    /** A cryptographic operation failed (hashing, signing, verification, key derivation). */
    public static final int CCL_ERROR_CRYPTO = -4;
    /** The supplied network id is not one of mainnet/testnet. */
    public static final int CCL_ERROR_INVALID_NETWORK = -5;
    /** The supplied mnemonic phrase is invalid. */
    public static final int CCL_ERROR_INVALID_MNEMONIC = -6;
    /** The supplied address is invalid or could not be parsed. */
    public static final int CCL_ERROR_INVALID_ADDRESS = -7;
    /** Inputs do not cover the transaction's outputs, fees, and deposits. */
    public static final int CCL_ERROR_INSUFFICIENT_FUNDS = -8;
    /** A transaction could not be parsed, signed, or otherwise processed. */
    public static final int CCL_ERROR_INVALID_TRANSACTION = -9;
    /** Building a transaction from a QuickTx spec failed. */
    public static final int CCL_ERROR_TX_BUILD = -10;
    /** The supplied account handle is unknown, closed, or belongs to another isolate. */
    public static final int CCL_ERROR_INVALID_HANDLE = -11;

    private ErrorCodes() {}
}
