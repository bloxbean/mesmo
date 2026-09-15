package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.api.quicktx.QuickTxService;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.plutus.spec.PlutusV2Script;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.serialization.TxPlan;
import com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.transaction.spec.Transaction;
import com.bloxbean.cardano.client.util.HexUtil;

import java.math.BigInteger;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Builds unsigned transactions from TxPlan YAML, fully offline, with static UTXOs + protocol params.
 */
class QuickTxApiTest {

    private static final String TEST_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";
    private static final String FAKE_TX_HASH = "a".repeat(64);

    private final QuickTxService service = new QuickTxService();

    private String protocolParamsJson;
    private String sender;
    private String receiver1;
    private String receiver2;

    @BeforeEach
    void setUp() throws IOException {
        try (InputStream is = getClass().getClassLoader().getResourceAsStream("protocol-params.json")) {
            protocolParamsJson = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
        sender = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0).baseAddress();
        receiver1 = new Account(Networks.testnet()).baseAddress();
        receiver2 = new Account(Networks.testnet()).baseAddress();
    }

    /** A single 100-ADA UTXO at {@code sender}, as a JSON array of the CCL Utxo model. */
    private String utxos() {
        return """
            [{"tx_hash":"%s","output_index":0,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"100000000"}]}]
            """.formatted(FAKE_TX_HASH, sender);
    }

    private JsonNode build(String yaml) throws Exception {
        // The build result is YAML now; parse it with CCL's YAML mapper.
        return YamlSerializer.getYamlMapper()
                .readTree(service.buildTransaction(yaml, utxos(), protocolParamsJson, null, 1));
    }

    private static void assertBuilt(JsonNode result) {
        assertFalse(result.get("tx_cbor").asText().isEmpty());
        assertEquals(64, result.get("tx_hash").asText().length());
        assertTrue(Long.parseLong(result.get("fee").asText()) > 0);
    }

    @Test
    void simplePayment() throws Exception {
        String yaml = """
            version: 1.0
            transaction:
              - tx:
                  from: %s
                  intents:
                    - type: payment
                      address: %s
                      amounts:
                        - unit: lovelace
                          quantity: "5000000"
            """.formatted(sender, receiver1);
        assertBuilt(build(yaml));
    }

    @Test
    void multiplePayments() throws Exception {
        String yaml = """
            version: 1.0
            transaction:
              - tx:
                  from: %s
                  intents:
                    - type: payment
                      address: %s
                      amounts:
                        - unit: lovelace
                          quantity: "5000000"
                    - type: payment
                      address: %s
                      amounts:
                        - unit: lovelace
                          quantity: "3000000"
            """.formatted(sender, receiver1, receiver2);
        assertBuilt(build(yaml));
    }

    @Test
    void paymentWithMetadata() throws Exception {
        // The metadata intent's value is a scalar string the deserializer auto-detects; JSON
        // (starting with '{') is parsed via MetadataBuilder.metadataFromJson.
        String yaml = """
            version: 1.0
            transaction:
              - tx:
                  from: %s
                  intents:
                    - type: payment
                      address: %s
                      amounts:
                        - unit: lovelace
                          quantity: "2000000"
                    - type: metadata
                      metadata: '{"674": {"msg": "Hello from Mesmo"}}'
            """.formatted(sender, receiver1);
        JsonNode result = build(yaml);
        assertBuilt(result);

        // The metadata must actually be attached: the tx body carries an auxiliary data hash.
        Transaction tx = Transaction.deserialize(HexUtil.decodeHexString(result.get("tx_cbor").asText()));
        assertNotNull(tx.getBody().getAuxiliaryDataHash(), "metadata should set the auxiliary data hash");
    }

    @Test
    void variableSubstitution() throws Exception {
        String yaml = """
            version: 1.0
            variables:
              to: %s
              amount: "4000000"
            transaction:
              - tx:
                  from: %s
                  intents:
                    - type: payment
                      address: ${to}
                      amounts:
                        - unit: lovelace
                          quantity: ${amount}
            """.formatted(receiver1, sender);
        assertBuilt(build(yaml));
    }

    @Test
    void insufficientFundsFails() {
        String yaml = """
            version: 1.0
            transaction:
              - tx:
                  from: %s
                  intents:
                    - type: payment
                      address: %s
                      amounts:
                        - unit: lovelace
                          quantity: "200000000"
            """.formatted(sender, receiver1);
        assertThrows(Exception.class, () -> service.buildTransaction(yaml, utxos(), protocolParamsJson, null, 1));
    }

    // An always-succeeds Plutus V2 minting policy. The script is never executed offline — the
    // StaticTransactionEvaluator stamps the caller-supplied execution units onto the redeemer —
    // so any valid Plutus CBOR is enough to build the transaction.
    private static final String ALWAYS_SUCCEEDS_V2 = "4e4d01000033222220051200120011";

    /** Build a Plutus mint as a TxPlan YAML (generated by CCL so the script-intent shape is exact). */
    private String mintScriptYaml() {
        PlutusScript mintScript = PlutusV2Script.builder().cborHex(ALWAYS_SUCCEEDS_V2).build();
        Asset asset = new Asset("TestToken", BigInteger.ONE);
        PlutusData redeemer = BigIntPlutusData.of(0);
        Tx tx = new Tx()
                .mintAsset(mintScript, asset, redeemer, sender)
                .from(sender);
        return TxPlan.from(tx).feePayer(sender).toYaml();
    }

    @Test
    void plutusMintWithSuppliedExecUnits() throws Exception {
        String yaml = mintScriptYaml();
        // One redeemer (the mint) → one ExUnits, supplied by the caller (as it would from Ogmios,
        // Blockfrost, Aiken, Scalus, …).
        String execUnits = "[{\"mem\": 2000000, \"steps\": 500000000}]";

        JsonNode result = YamlSerializer.getYamlMapper()
                .readTree(service.buildTransaction(yaml, utxos(), protocolParamsJson, execUnits, 1));
        assertBuilt(result);

        // The built tx must carry the redeemer with exactly the supplied execution units.
        Transaction tx = Transaction.deserialize(HexUtil.decodeHexString(result.get("tx_cbor").asText()));
        assertNotNull(tx.getWitnessSet().getRedeemers());
        assertEquals(1, tx.getWitnessSet().getRedeemers().size());
        var exUnits = tx.getWitnessSet().getRedeemers().get(0).getExUnits();
        assertEquals(BigInteger.valueOf(2000000), exUnits.getMem());
        assertEquals(BigInteger.valueOf(500000000), exUnits.getSteps());
    }

    @Test
    void plutusMintWithoutExecUnitsUsesScalus() throws Exception {
        String yaml = mintScriptYaml();
        // Scalus needs cost models to run the UPLC machine; the default fixture omits them.
        String paramsWithCostModels;
        try (InputStream is = getClass().getClassLoader()
                .getResourceAsStream("protocol-params-with-costmodels.json")) {
            paramsWithCostModels = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
        // No supplied units → the Scalus evaluator computes them offline by running the validator.
        JsonNode result = YamlSerializer.getYamlMapper()
                .readTree(service.buildTransaction(yaml, utxos(), paramsWithCostModels, null, 1));
        assertBuilt(result);

        Transaction tx = Transaction.deserialize(HexUtil.decodeHexString(result.get("tx_cbor").asText()));
        var exUnits = tx.getWitnessSet().getRedeemers().get(0).getExUnits();
        System.out.println("SCALUS-COMPUTED UNITS: mem=" + exUnits.getMem() + " steps=" + exUnits.getSteps());
        // A real UPLC evaluation of the always-succeeds script → non-zero mem and steps.
        assertTrue(exUnits.getMem().signum() > 0);
        assertTrue(exUnits.getSteps().signum() > 0);

        // Dump fixtures for the native-image harness.
        System.out.println("FIXTURE_YAML<<<" + yaml + ">>>");
        System.out.println("FIXTURE_UTXOS<<<" + utxos() + ">>>");
    }
}
