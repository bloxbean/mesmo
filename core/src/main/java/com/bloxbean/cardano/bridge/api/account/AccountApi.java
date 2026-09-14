package com.bloxbean.cardano.bridge.api.account;

import com.bloxbean.cardano.bridge.ErrorCodes;
import com.bloxbean.cardano.bridge.util.ErrorState;
import com.bloxbean.cardano.bridge.util.JsonHelper;
import com.bloxbean.cardano.bridge.util.NativeString;
import com.bloxbean.cardano.bridge.util.ResultState;
import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;
import org.graalvm.nativeimage.c.type.CLongPointer;

/**
 * Managed Account entry points (ADR-0016): open an account once and receive an opaque handle;
 * subsequent operations take the handle instead of the mnemonic.
 *
 * <p>Handles are isolate-scoped {@code uint64} identifiers (never 0), allocated from a
 * per-isolate randomized space. Unknown, closed, or foreign handles fail with
 * {@link ErrorCodes#CCL_ERROR_INVALID_HANDLE} — foreign-handle detection is statistical
 * (collision odds ~2^-62), not structural. Closing is explicit and idempotent; all handles die
 * with the isolate.
 *
 * <p>See {@link com.bloxbean.cardano.bridge.CclBridge} for the calling convention.
 */
public final class AccountApi {

    private AccountApi() {}

    /**
     * Opens an account from a mnemonic at fixed derivation indices.
     *
     * <p>Exported as {@code ccl_account_open_mnemonic}. On success writes the handle to
     * {@code out_handle} and returns {@link ErrorCodes#CCL_SUCCESS}. The account's network and
     * derivation path are fixed for the handle's lifetime; no result string is produced (fetch
     * public data with {@code ccl_account_get_info}).
     *
     * @param thread       the current isolate thread
     * @param networkId    0=mainnet, 1=testnet
     * @param mnemonicPtr  the BIP-39 mnemonic phrase (UTF-8 C string)
     * @param accountIndex HD account index (typically 0)
     * @param addressIndex HD address index (typically 0)
     * @param outHandle    receives the opaque account handle (must be non-null)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT} /
     *         {@link ErrorCodes#CCL_ERROR_INVALID_NETWORK} /
     *         {@link ErrorCodes#CCL_ERROR_INVALID_MNEMONIC} / {@link ErrorCodes#CCL_ERROR_GENERAL}
     */
    @CEntryPoint(name = "ccl_account_open_mnemonic")
    public static int openMnemonic(IsolateThread thread, int networkId, CCharPointer mnemonicPtr,
                                   int accountIndex, int addressIndex, CLongPointer outHandle) {
        try {
            if (outHandle.isNull()) {
                ErrorState.set("out_handle must be non-null");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            String mnemonic = NativeString.toJavaString(mnemonicPtr);
            long handle = AccountService.openMnemonic(networkId, mnemonic, accountIndex, addressIndex);
            outHandle.write(handle);
            return ErrorCodes.CCL_SUCCESS;
        } catch (AccountService.InvalidNetworkException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_NETWORK;
        } catch (AccountService.InvalidMnemonicException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_MNEMONIC;
        } catch (IllegalArgumentException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_GENERAL;
        }
    }

    /**
     * Creates a brand-new account with a freshly generated 24-word mnemonic.
     *
     * <p>Exported as {@code ccl_account_create_handle}. On success writes the handle to
     * {@code out_handle}; <b>no secret is returned</b> — the recovery phrase is retrievable once,
     * deliberately, via {@code ccl_account_export_recovery_phrase}.
     *
     * @param thread    the current isolate thread
     * @param networkId 0=mainnet, 1=testnet
     * @param outHandle receives the opaque account handle (must be non-null)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_NETWORK} /
     *         {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT} / {@link ErrorCodes#CCL_ERROR_GENERAL}
     */
    @CEntryPoint(name = "ccl_account_create_handle")
    public static int createNew(IsolateThread thread, int networkId, CLongPointer outHandle) {
        try {
            if (outHandle.isNull()) {
                ErrorState.set("out_handle must be non-null");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            outHandle.write(AccountService.createNew(networkId));
            return ErrorCodes.CCL_SUCCESS;
        } catch (AccountService.InvalidNetworkException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_NETWORK;
        } catch (IllegalArgumentException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_GENERAL;
        }
    }

    /**
     * One-shot export of a freshly created account's recovery phrase, delivered <b>in this
     * call</b> via {@code out_phrase} — never through the result slot.
     *
     * <p>Exported as {@code ccl_account_export_recovery_phrase}. On success {@code out_phrase}
     * receives a malloc'd, NUL-terminated copy of the BIP-39 phrase (free it with
     * {@code ccl_free_string}). The pending phrase is destroyed only <em>after</em> that copy has
     * been materialized: a failed delivery leaves the export retryable instead of orphaning the
     * only copy. A second call fails, as does calling this on an account opened from a mnemonic
     * (the caller already holds that phrase). Secret access is deliberate by design: nothing else
     * ever returns the phrase.
     *
     * @param thread    the current isolate thread
     * @param handle    an open, freshly created account handle
     * @param outPhrase receives the malloc'd phrase (must be non-null)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_HANDLE} /
     *         {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT}
     */
    @CEntryPoint(name = "ccl_account_export_recovery_phrase")
    public static int exportRecoveryPhrase(IsolateThread thread, long handle,
                                           org.graalvm.nativeimage.c.type.CCharPointerPointer outPhrase) {
        try {
            if (outPhrase.isNull()) {
                ErrorState.set("out_phrase must be non-null");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            String phrase = AccountService.exportRecoveryPhrase(handle); // atomic one-shot claim
            try {
                outPhrase.write(NativeString.toCString(phrase)); // caller frees via ccl_free_string
            } catch (Throwable t) {
                AccountService.restoreRecoveryPhrase(handle, phrase); // delivery failed: retryable
                throw t;
            }
            return ErrorCodes.CCL_SUCCESS;
        } catch (AccountService.UnknownHandleException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_HANDLE;
        } catch (IllegalStateException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_GENERAL;
        }
    }

    /**
     * Public information for an open account.
     *
     * <p>Exported as {@code ccl_account_get_info}. On success the result is a JSON object:
     * <pre>{@code {"base_address","enterprise_address","stake_address","network","account_index",
     * "address_index","drep_id"}}</pre>
     * It contains public data only — never the mnemonic or private keys.
     *
     * @param thread the current isolate thread
     * @param handle an open account handle
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_HANDLE} /
     *         {@link ErrorCodes#CCL_ERROR_GENERAL}
     */
    @CEntryPoint(name = "ccl_account_get_info")
    public static int getInfo(IsolateThread thread, long handle) {
        try {
            ResultState.set(AccountService.infoJson(handle));
            return ErrorCodes.CCL_SUCCESS;
        } catch (AccountService.UnknownHandleException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_HANDLE;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_GENERAL;
        }
    }

    /**
     * Signs a transaction with the account keys selected by a typed role mask.
     *
     * <p>Exported as {@code ccl_account_sign_tx_handle}. {@code role_mask} bits: {@code 1}=payment,
     * {@code 2}=stake, {@code 4}=DRep, {@code 8}=committee cold, {@code 16}=committee hot. The mask
     * is unordered (witnesses form a set); keys are applied in canonical order so signed outputs are
     * byte-identical across wrappers. A zero or unknown-bit mask fails — the API never silently
     * signs with every key the account controls. On success the result is the signed transaction
     * CBOR hex.
     *
     * @param thread      the current isolate thread
     * @param handle      an open account handle
     * @param txCborPtr   the unsigned (or partially signed) transaction CBOR hex (UTF-8 C string)
     * @param roleMask    bit mask of signing roles (non-zero, known bits only)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_HANDLE} /
     *         {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT} /
     *         {@link ErrorCodes#CCL_ERROR_INVALID_TRANSACTION}
     */
    @CEntryPoint(name = "ccl_account_sign_tx_handle")
    public static int signTx(IsolateThread thread, long handle, CCharPointer txCborPtr, int roleMask) {
        try {
            String txCborHex = NativeString.toJavaString(txCborPtr);
            ResultState.set(AccountService.signTx(handle, txCborHex, roleMask));
            return ErrorCodes.CCL_SUCCESS;
        } catch (AccountService.UnknownHandleException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_HANDLE;
        } catch (IllegalArgumentException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_TRANSACTION;
        }
    }

    /**
     * Closes an account handle, releasing its native state.
     *
     * <p>Exported as {@code ccl_account_close}. Idempotent: closing an unknown or already-closed
     * handle succeeds (returns {@link ErrorCodes#CCL_SUCCESS}) — double-close must be safe for
     * wrapper finalizers.
     *
     * @param thread the current isolate thread
     * @param handle the account handle to close
     * @return {@link ErrorCodes#CCL_SUCCESS}
     */
    @CEntryPoint(name = "ccl_account_close")
    public static int close(IsolateThread thread, long handle) {
        try {
            AccountService.close(handle);
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_GENERAL;
        }
    }
}
