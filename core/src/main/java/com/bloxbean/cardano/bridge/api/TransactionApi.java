package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.ErrorCodes;
import com.bloxbean.cardano.bridge.util.ErrorState;
import com.bloxbean.cardano.bridge.util.NativeString;
import com.bloxbean.cardano.bridge.util.ResultState;
import com.bloxbean.cardano.client.common.cbor.CborSerializationUtil;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.SecretKey;
import com.bloxbean.cardano.client.transaction.TransactionSigner;
import com.bloxbean.cardano.client.transaction.spec.Transaction;
import com.bloxbean.cardano.client.util.HexUtil;
import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;

/**
 * Transaction entry points: hash, sign (with a raw secret key), and CBOR&#8596;JSON conversion.
 *
 * <p>Transactions are passed as CBOR hex (the on-chain serialization). The JSON form is a readable
 * representation for inspection, not the on-chain format. See
 * {@link com.bloxbean.cardano.bridge.CclBridge} for the calling convention. Every entry point here
 * is a static GraalVM {@code @CEntryPoint}.
 */
public final class TransactionApi {

    private TransactionApi() {}

    /**
     * Signs a transaction with a raw Ed25519 secret key.
     *
     * <p>Exported as {@code ccl_tx_sign_with_secret_key}. On success the result is the signed
     * transaction as CBOR hex. Use this when you hold a key directly rather than a managed
     * account handle (cf. {@code ccl_account_sign_tx_handle}).
     *
     * @param thread        the current isolate thread
     * @param txCborHexPtr  the transaction as CBOR hex
     * @param skCborHexPtr  the secret key as CBOR hex
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_TRANSACTION}
     */
    @CEntryPoint(name = "ccl_tx_sign_with_secret_key")
    public static int signWithSecretKey(IsolateThread thread, CCharPointer txCborHexPtr,
                                        CCharPointer skCborHexPtr) {
        try {
            String txCborHex = NativeString.toJavaString(txCborHexPtr);
            String skCborHex = NativeString.toJavaString(skCborHexPtr);

            if (txCborHex == null || txCborHex.isEmpty()) {
                ErrorState.set("Transaction CBOR hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            if (skCborHex == null || skCborHex.isEmpty()) {
                ErrorState.set("Secret key CBOR hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            Transaction tx = Transaction.deserialize(HexUtil.decodeHexString(txCborHex));
            SecretKey sk = new SecretKey(skCborHex);
            Transaction signedTx = TransactionSigner.INSTANCE.sign(tx, sk);
            ResultState.set(signedTx.serializeToHex());
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_TRANSACTION;
        }
    }

    /**
     * Computes the transaction hash (Blake2b-256 of the transaction body).
     *
     * <p>Exported as {@code ccl_tx_hash}. On success the result is the 32-byte hash as hex (64 hex
     * chars) — i.e. the transaction id.
     *
     * @param thread       the current isolate thread
     * @param txCborHexPtr the transaction as CBOR hex
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_TRANSACTION}
     */
    @CEntryPoint(name = "ccl_tx_hash")
    public static int hash(IsolateThread thread, CCharPointer txCborHexPtr) {
        try {
            String txCborHex = NativeString.toJavaString(txCborHexPtr);
            if (txCborHex == null || txCborHex.isEmpty()) {
                ErrorState.set("Transaction CBOR hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            Transaction tx = Transaction.deserialize(HexUtil.decodeHexString(txCborHex));
            byte[] txBodyBytes = CborSerializationUtil.serialize(tx.getBody().serialize());
            byte[] txHash = Blake2bUtil.blake2bHash256(txBodyBytes);
            ResultState.set(HexUtil.encodeHexString(txHash));
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_TRANSACTION;
        }
    }

    /**
     * Converts a transaction's CBOR to a readable JSON representation.
     *
     * <p>Exported as {@code ccl_tx_to_json}. On success the result is the transaction as JSON (for
     * inspection — this is not the on-chain format). Equivalent to {@code ccl_tx_deserialize}.
     *
     * @param thread       the current isolate thread
     * @param txCborHexPtr the transaction as CBOR hex
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "ccl_tx_to_json")
    public static int toJson(IsolateThread thread, CCharPointer txCborHexPtr) {
        try {
            String txCborHex = NativeString.toJavaString(txCborHexPtr);
            if (txCborHex == null || txCborHex.isEmpty()) {
                ErrorState.set("Transaction CBOR hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            Transaction tx = Transaction.deserialize(HexUtil.decodeHexString(txCborHex));
            String json = com.bloxbean.cardano.bridge.util.JsonHelper.toJson(tx);
            ResultState.set(json);
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_SERIALIZATION;
        }
    }

    /**
     * Builds a transaction's CBOR from its JSON representation.
     *
     * <p>Exported as {@code ccl_tx_from_json}. The inverse of {@code ccl_tx_to_json}: on success the
     * result is the transaction as CBOR hex.
     *
     * @param thread     the current isolate thread
     * @param txJsonPtr  the transaction as JSON (UTF-8 C string)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "ccl_tx_from_json")
    public static int fromJson(IsolateThread thread, CCharPointer txJsonPtr) {
        try {
            String txJson = NativeString.toJavaString(txJsonPtr);
            if (txJson == null || txJson.isEmpty()) {
                ErrorState.set("Transaction JSON is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            Transaction tx = com.bloxbean.cardano.bridge.util.JsonHelper.fromJson(txJson, Transaction.class);
            ResultState.set(tx.serializeToHex());
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_SERIALIZATION;
        }
    }

    /**
     * Deserializes a transaction's CBOR into its JSON representation.
     *
     * <p>Exported as {@code ccl_tx_deserialize}. On success the result is the transaction as JSON
     * (for inspection). Same output as {@code ccl_tx_to_json}.
     *
     * @param thread       the current isolate thread
     * @param txCborHexPtr the transaction as CBOR hex
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "ccl_tx_deserialize")
    public static int deserialize(IsolateThread thread, CCharPointer txCborHexPtr) {
        try {
            String txCborHex = NativeString.toJavaString(txCborHexPtr);
            if (txCborHex == null || txCborHex.isEmpty()) {
                ErrorState.set("Transaction CBOR hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            Transaction tx = Transaction.deserialize(HexUtil.decodeHexString(txCborHex));
            String json = com.bloxbean.cardano.bridge.util.JsonHelper.toJson(tx);
            ResultState.set(json);
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_SERIALIZATION;
        }
    }
}
