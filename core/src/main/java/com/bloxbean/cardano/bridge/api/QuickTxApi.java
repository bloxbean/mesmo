package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.ErrorCodes;
import com.bloxbean.cardano.bridge.api.quicktx.QuickTxService;
import com.bloxbean.cardano.bridge.util.ErrorState;
import com.bloxbean.cardano.bridge.util.NativeString;
import com.bloxbean.cardano.bridge.util.ResultState;
import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;

/**
 * QuickTx entry point: build an unsigned transaction from a CCL TxPlan (YAML), fully offline.
 *
 * <p>The transaction is defined by a <a href="https://cardano-client.dev">TxPlan</a> YAML document
 * (CCL's native transaction format). The caller also supplies the chain data the build needs —
 * available UTXOs and protocol parameters — as JSON. Nothing is fetched and nothing is submitted;
 * the result is the unsigned transaction CBOR.
 *
 * <p>See {@link com.bloxbean.cardano.bridge.CclBridge} for the calling convention. The single entry
 * point here is a static GraalVM {@code @CEntryPoint}.
 */
public final class QuickTxApi {

    private static final QuickTxService service = new QuickTxService();

    private QuickTxApi() {}

    /**
     * Builds an unsigned transaction from a TxPlan YAML document and caller-supplied chain data.
     *
     * <p>Exported as {@code ccl_quicktx_build}. {@code yaml} is the TxPlan transaction definition;
     * {@code utxos_json} is a JSON array of the sender's UTXOs and {@code protocol_params_json} a
     * JSON protocol-parameters object (both standard CCL data models). On success the result is a
     * JSON object:
     * <pre>{@code {"tx_cbor","tx_hash","fee"}}</pre>
     * where {@code tx_cbor} is the unsigned transaction; sign it with
     * {@code ccl_account_sign_tx_handle} / {@code ccl_tx_sign_with_secret_key} and submit it
     * yourself.
     *
     * <p>For Plutus script transactions, pass the redeemers' execution units in
     * {@code exec_units_json} (a JSON array of {@code {"mem","steps"}}, one per redeemer in
     * transaction order). The caller computes these with any UPLC evaluator (Ogmios, Blockfrost,
     * Aiken, Scalus) and passes them in, just like UTXOs and protocol parameters. Pass {@code null}
     * (or an empty array) for non-script transactions. A script transaction with no execution units
     * fails with {@link ErrorCodes#CCL_ERROR_TX_BUILD}.
     *
     * <p>{@code additional_signers} budgets vkey witnesses for fee estimation, beyond those the
     * input UTXOs imply (one per sender): {@code 0} for a plain payment, {@code 1} for a stake or
     * DRep certificate, {@code 2} for both in one tx, the number of {@code sig} keys for a
     * native-script spend. The dev signing the transaction knows how many signers there will be —
     * the bridge does not guess. Undercounting yields a fee the node rejects with
     * {@code FeeTooSmallUTxO}; overcounting only overpays (~4,400 lovelace per extra witness).
     *
     * @param thread                the current isolate thread
     * @param yamlPtr               the TxPlan YAML (UTF-8 C string)
     * @param utxosJsonPtr          JSON array of UTXOs (UTF-8 C string)
     * @param protocolParamsJsonPtr JSON protocol parameters (UTF-8 C string)
     * @param execUnitsJsonPtr      JSON array of redeemer execution units, or null (UTF-8 C string)
     * @param additionalSigners     signer count beyond the input-UTXO-implied witnesses (≥ 0)
     * @return {@link ErrorCodes#CCL_SUCCESS}; on failure
     *         {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT},
     *         {@link ErrorCodes#CCL_ERROR_INSUFFICIENT_FUNDS}, or
     *         {@link ErrorCodes#CCL_ERROR_TX_BUILD}
     */
    @CEntryPoint(name = "ccl_quicktx_build")
    public static int build(IsolateThread thread, CCharPointer yamlPtr,
                            CCharPointer utxosJsonPtr, CCharPointer protocolParamsJsonPtr,
                            CCharPointer execUnitsJsonPtr, int additionalSigners) {
        try {
            if (additionalSigners < 0) {
                ErrorState.set("additional_signers must be >= 0");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            String yaml = NativeString.toJavaString(yamlPtr);
            if (yaml == null || yaml.isEmpty()) {
                ErrorState.set("TxPlan YAML is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            String utxosJson = NativeString.toJavaString(utxosJsonPtr);
            String protocolParamsJson = NativeString.toJavaString(protocolParamsJsonPtr);
            if (protocolParamsJson == null || protocolParamsJson.isEmpty()) {
                ErrorState.set("Protocol parameters JSON is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            String execUnitsJson = NativeString.toJavaString(execUnitsJsonPtr);

            String resultJson = service.buildTransaction(yaml, utxosJson, protocolParamsJson, execUnitsJson, additionalSigners);
            ResultState.set(resultJson);
            return ErrorCodes.CCL_SUCCESS;
        } catch (IllegalArgumentException e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
        } catch (Exception e) {
            String msg = e.getMessage();
            if (msg != null && msg.toLowerCase().contains("not enough")) {
                ErrorState.set(msg);
                return ErrorCodes.CCL_ERROR_INSUFFICIENT_FUNDS;
            }
            // Include the root cause — wrapped exceptions (e.g. YAML deserialization) otherwise
            // hide the actual problem behind a generic message.
            StringBuilder detail = new StringBuilder(msg != null ? msg : e.getClass().getName());
            for (Throwable c = e.getCause(); c != null && c != c.getCause(); c = c.getCause()) {
                detail.append(" | ").append(c.getClass().getSimpleName())
                      .append(": ").append(c.getMessage());
            }
            ErrorState.set(detail.toString());
            return ErrorCodes.CCL_ERROR_TX_BUILD;
        }
    }
}
