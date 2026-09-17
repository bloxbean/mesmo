package com.bloxbean.cardano.mesmo.api;

import com.bloxbean.cardano.mesmo.api.quicktx.QuickTxService;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.serialization.TxPlan;
import com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer;
import com.bloxbean.cardano.client.transaction.spec.Transaction;
import com.bloxbean.cardano.client.util.HexUtil;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.UnaryOperator;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The witness budget is <b>caller-supplied</b> ({@code additional_signers}): the dev signing a
 * transaction knows how many signers there will be, and passes the count beyond the
 * input-UTXO-implied witnesses. These tests document the contract per transaction shape: with the
 * correct count, the built fee covers the fully signed size ({@code fee >= min_fee(signed size)},
 * the ledger rule behind {@code FeeTooSmallUTxO}); with an undercount, it deliberately does not —
 * the count is the caller's responsibility, not the lib's guess.
 */
class FeeWitnessBudgetTest {

    private static final String TEST_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";
    private static final String FAKE_TX_HASH = "a".repeat(64);

    private final QuickTxService service = new QuickTxService();

    private String protocolParamsJson;
    private long minFeeA;
    private long minFeeB;
    private Account account;
    private String sender;

    @BeforeEach
    void setUp() throws IOException {
        try (InputStream is = getClass().getClassLoader().getResourceAsStream("protocol-params.json")) {
            protocolParamsJson = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
        var params = YamlSerializer.getYamlMapper().readTree(protocolParamsJson);
        minFeeA = params.get("min_fee_a").asLong();
        minFeeB = params.get("min_fee_b").asLong();
        account = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);
        sender = account.baseAddress();
    }

    private String utxos() {
        return """
            [{"tx_hash":"%s","output_index":0,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"2000000000"}]}]
            """.formatted(FAKE_TX_HASH, sender);
    }

    private record Built(long fee, Transaction unsigned) {}

    private Built build(String yaml, String utxosJson, int additionalSigners) throws Exception {
        var result = YamlSerializer.getYamlMapper()
                .readTree(service.buildTransaction(yaml, utxosJson, protocolParamsJson, null, additionalSigners));
        return new Built(Long.parseLong(result.get("fee").asText()),
                Transaction.deserialize(HexUtil.decodeHexString(result.get("tx_cbor").asText())));
    }

    private long minFeeOfSigned(Built built, UnaryOperator<Transaction> signer) throws Exception {
        long signedSize = signer.apply(built.unsigned()).serialize().length;
        return minFeeA * signedSize + minFeeB;
    }

    /** Build with the given count, sign, and assert paid fee ≥ min fee of the signed size. */
    private void assertFeeCoversSignedSize(Tx tx, int additionalSigners,
                                           UnaryOperator<Transaction> signer) throws Exception {
        assertFeeCoversSignedSize(TxPlan.from(tx).feePayer(sender).toYaml(), utxos(), additionalSigners, signer);
    }

    private void assertFeeCoversSignedSize(String yaml, String utxosJson, int additionalSigners,
                                           UnaryOperator<Transaction> signer) throws Exception {
        Built built = build(yaml, utxosJson, additionalSigners);
        long minFee = minFeeOfSigned(built, signer);
        assertTrue(built.fee() >= minFee,
                "fee " + built.fee() + " must cover min fee " + minFee
                        + " (short by " + (minFee - built.fee()) + ")");
    }

    /** Payment + one certificate: one signer beyond the fee payer. */
    @Test
    void singleCertificate_coveredWithOneAdditionalSigner() throws Exception {
        Tx tx = new Tx().registerStakeAddress(account.stakeAddress()).from(sender);
        assertFeeCoversSignedSize(tx, 1, t -> account.signWithStakeKey(account.sign(t)));
    }

    /** Stake + DRep certificates in one tx: two signers beyond the fee payer. */
    @Test
    void combinedCertificates_coveredWithTwoAdditionalSigners() throws Exception {
        Tx tx = new Tx()
                .registerStakeAddress(account.stakeAddress())
                .registerDRep(account.drepCredential())
                .from(sender);
        assertFeeCoversSignedSize(tx, 2,
                t -> account.signWithDRepKey(account.signWithStakeKey(account.sign(t))));
    }

    /** Plain payment: no additional signers needed. */
    @Test
    void plainPayment_coveredWithZeroAdditionalSigners() throws Exception {
        Tx tx = new Tx().payToAddress(account.enterpriseAddress(), Amount.ada(5)).from(sender);
        assertFeeCoversSignedSize(tx, 0, account::sign);
    }

    /**
     * Spending from a native-script address whose UTXO covers the whole tx: the inputs imply no
     * vkey signers at all, so the script's {@code sig} key is the one (additional) signer.
     */
    @Test
    void nativeScriptSpendFromScriptOnlyInputs_coveredWithOneAdditionalSigner() throws Exception {
        byte[] paymentKeyHash = new com.bloxbean.cardano.client.address.Address(sender)
                .getPaymentCredentialHash().orElseThrow();
        var script = new com.bloxbean.cardano.client.transaction.spec.script.ScriptPubkey(
                HexUtil.encodeHexString(paymentKeyHash));
        String scriptHex = HexUtil.encodeHexString(script.serializeScriptBody());
        byte[] scriptAddrBytes = new byte[29];
        scriptAddrBytes[0] = (byte) 0x70; // testnet enterprise script address header
        System.arraycopy(script.getScriptHash(), 0, scriptAddrBytes, 1, 28);
        String scriptAddress = new com.bloxbean.cardano.client.address.Address(scriptAddrBytes).toBech32();

        String scriptTxHash = "b".repeat(64);
        String yaml = """
            version: 1.0
            context:
              fee_payer: %s
            transaction:
              - tx:
                  from: %s
                  change_address: %s
                  inputs:
                    - type: collect_from
                      utxo_refs:
                        - tx_hash: %s
                          output_index: 0
                  intents:
                    - type: payment
                      address: %s
                      amounts:
                        - unit: lovelace
                          quantity: "3000000"
                  scripts:
                    - type: native_script
                      script_hex: %s
            """.formatted(sender, sender, sender, scriptTxHash, sender, scriptHex);
        String scriptOnlyUtxos = """
            [{"tx_hash":"%s","output_index":0,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"10000000"}]}]
            """.formatted(scriptTxHash, scriptAddress);

        assertFeeCoversSignedSize(yaml, scriptOnlyUtxos, 1, account::sign);
    }

    /** Plan-level required_signers count toward the total the caller must supply. */
    @Test
    void requiredSigners_countTowardCallerSuppliedTotal() throws Exception {
        Account cosigner = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 5);
        String cosignerKeyHash = HexUtil.encodeHexString(
                new com.bloxbean.cardano.client.address.Address(cosigner.baseAddress())
                        .getPaymentCredentialHash().orElseThrow());

        String yaml = """
            version: 1.0
            context:
              fee_payer: %s
              required_signers:
                - %s
            transaction:
              - tx:
                  from: %s
                  intents:
                    - type: payment
                      address: %s
                      amounts:
                        - unit: lovelace
                          quantity: "3000000"
            """.formatted(sender, cosignerKeyHash, sender, account.enterpriseAddress());

        assertFeeCoversSignedSize(yaml, utxos(), 1, t -> cosigner.sign(account.sign(t)));
    }

    /**
     * Documents the contract's sharp edge: an undercounted budget produces a fee below the signed
     * transaction's min fee — the node would reject it with {@code FeeTooSmallUTxO}. Supplying the
     * correct count is the caller's responsibility.
     */
    @Test
    void undercountedSigners_yieldInsufficientFee() throws Exception {
        Tx tx = new Tx()
                .registerStakeAddress(account.stakeAddress())
                .registerDRep(account.drepCredential())
                .from(sender);
        Built built = build(TxPlan.from(tx).feePayer(sender).toYaml(), utxos(), 0);
        long minFee = minFeeOfSigned(built,
                t -> account.signWithDRepKey(account.signWithStakeKey(account.sign(t))));
        assertTrue(built.fee() < minFee,
                "expected an undercounted budget to underpay (fee " + built.fee()
                        + " vs min fee " + minFee + ")");
    }
}
