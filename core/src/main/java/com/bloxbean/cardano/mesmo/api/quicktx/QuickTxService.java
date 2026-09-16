package com.bloxbean.cardano.mesmo.api.quicktx;

import com.bloxbean.cardano.mesmo.util.JsonHelper;
import com.bloxbean.cardano.client.api.ProtocolParamsSupplier;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.impl.StaticTransactionEvaluator;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.common.cbor.CborSerializationUtil;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.plutus.spec.ExUnits;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.serialization.TxPlan;
import com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer;
import com.bloxbean.cardano.client.transaction.spec.Transaction;
import com.bloxbean.cardano.client.util.HexUtil;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds unsigned Cardano transactions from a CCL {@link TxPlan} (YAML), fully offline.
 *
 * <p>The transaction is defined by a TxPlan YAML document; the caller supplies the chain data
 * (UTXOs and protocol parameters) as JSON. No backend/provider is used and the transaction is never
 * submitted — the result is the unsigned CBOR plus its hash and fee.
 *
 * <p>Plutus script transactions are supported when the caller supplies the redeemers' execution
 * units (memory + CPU steps); with none supplied, the embedded Scalus evaluator computes them
 * offline.
 *
 * <p><b>Witness budgeting is caller-supplied</b>, exactly like UTXOs, protocol parameters, and
 * execution units: the caller passes the number of signers beyond those implied by the input UTXOs
 * ({@code additionalSigners}, forwarded to CCL's {@code additionalSignersCount}). The dev signing a
 * transaction knows how many signers there will be; the lib does not guess. An undercounted
 * budget produces a fee the node rejects with {@code FeeTooSmallUTxO}; an overcount only overpays
 * (~4,400 lovelace per extra witness at mainnet parameters).
 */
public class QuickTxService {

    /**
     * Build an unsigned transaction from a TxPlan YAML document and caller-supplied chain data.
     *
     * @param yaml               the TxPlan YAML defining the transaction(s)
     * @param utxosJson          JSON array of UTXOs available to the sender (CCL {@code Utxo} model)
     * @param protocolParamsJson JSON protocol parameters (CCL {@code ProtocolParams} model)
     * @param execUnitsJson      JSON array of redeemer execution units ({@code [{"mem","steps"}]},
     *                           one per redeemer in transaction order); null/empty for non-script txs
     * @param additionalSigners  number of vkey witnesses beyond those implied by the input UTXOs
     *                           (one per sender): e.g. {@code 0} for a plain payment, {@code 1} for
     *                           a stake or DRep certificate, {@code 2} for both in one tx, the
     *                           number of {@code sig} keys for a native-script spend
     * @return JSON string with {@code tx_cbor}, {@code tx_hash}, {@code fee}
     */
    public String buildTransaction(String yaml, String utxosJson, String protocolParamsJson,
                                   String execUnitsJson, int additionalSigners) throws Exception {
        TxPlan plan = TxPlan.from(yaml);

        List<Utxo> utxos = parseUtxos(utxosJson);
        ProtocolParams protocolParams = JsonHelper.fromJson(protocolParamsJson, ProtocolParams.class);

        UtxoSupplier utxoSupplier = new StaticUtxoSupplier(utxos);
        ProtocolParamsSupplier ppSupplier = () -> protocolParams;

        // No TransactionProcessor (offline; never submits). compose(plan) applies the plan's
        // context (fee payer, validity, deposit mode, required signers, …) to the TxContext.
        QuickTxBuilder builder = new QuickTxBuilder(utxoSupplier, ppSupplier, null);
        QuickTxBuilder.TxContext txContext = builder.compose(plan);

        // Plutus script cost: when the caller supplies execution units, a static evaluator stamps
        // them onto the redeemers (offline). The caller computes them however it likes (Ogmios,
        // Blockfrost, Aiken, Scalus); the lib does not run the script.
        List<ExUnits> execUnits = parseExUnits(execUnitsJson);
        if (!execUnits.isEmpty()) {
            txContext.withTxEvaluator(new StaticTransactionEvaluator(execUnits));
        } else {
            // No caller-supplied units: fall back to Scalus, which evaluates the script(s) offline
            // (runs the UPLC engine in-process, no network). Requires cost models in the protocol
            // params. TODO(evaluators): expose this as a pluggable Evaluator with a graceful path
            // when cost models are absent (Scalus MachineParams.defaultPlutusV2PostConwayParams) and
            // a remote (Blockfrost /utils/txs/evaluate) fallback.
            txContext.withTxEvaluator(
                    new scalus.bloxbean.ScalusTransactionEvaluator(protocolParams, utxoSupplier));
        }

        // Witness budget for fee estimation of the (still unsigned) transaction: caller-supplied,
        // forwarded to CCL as-is (CCL adds the input-UTXO-implied signers itself).
        txContext.additionalSignersCount(Math.max(0, additionalSigners));

        Transaction transaction = txContext.build();

        String txCborHex = transaction.serializeToHex();
        byte[] txBodyBytes = CborSerializationUtil.serialize(transaction.getBody().serialize());
        String txHash = HexUtil.encodeHexString(Blake2bUtil.blake2bHash256(txBodyBytes));
        String fee = transaction.getBody().getFee().toString();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("tx_cbor", txCborHex);
        result.put("tx_hash", txHash);
        result.put("fee", fee);
        return YamlSerializer.serialize(result);
    }

    private static List<Utxo> parseUtxos(String utxosJson) throws Exception {
        if (utxosJson == null || utxosJson.isBlank()) {
            return Collections.emptyList();
        }
        Utxo[] utxos = JsonHelper.fromJson(utxosJson, Utxo[].class);
        return utxos != null ? Arrays.asList(utxos) : Collections.emptyList();
    }

    private static List<ExUnits> parseExUnits(String execUnitsJson) throws Exception {
        if (execUnitsJson == null || execUnitsJson.isBlank()) {
            return Collections.emptyList();
        }
        ExUnits[] exUnits = JsonHelper.fromJson(execUnitsJson, ExUnits[].class);
        return exUnits != null ? Arrays.asList(exUnits) : Collections.emptyList();
    }
}
