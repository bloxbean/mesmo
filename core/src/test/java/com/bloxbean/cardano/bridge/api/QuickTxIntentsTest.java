package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.api.quicktx.QuickTxService;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.metadata.Metadata;
import com.bloxbean.cardano.client.metadata.MetadataBuilder;
import com.bloxbean.cardano.client.quicktx.AbstractTx;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.plutus.spec.PlutusV2Script;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.serialization.TxPlan;
import com.bloxbean.cardano.client.transaction.spec.governance.Anchor;
import com.bloxbean.cardano.client.transaction.spec.governance.DRep;
import com.bloxbean.cardano.client.transaction.spec.governance.Vote;
import com.bloxbean.cardano.client.transaction.spec.governance.Voter;
import com.bloxbean.cardano.client.transaction.spec.governance.VoterType;
import com.bloxbean.cardano.client.transaction.spec.governance.actions.GovActionId;
import com.bloxbean.cardano.client.transaction.spec.governance.actions.InfoAction;
import com.bloxbean.cardano.client.spec.UnitInterval;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.transaction.spec.Policy;
import com.bloxbean.cardano.client.transaction.spec.cert.PoolRegistration;
import com.bloxbean.cardano.client.transaction.spec.cert.SingleHostAddr;
import com.bloxbean.cardano.client.transaction.spec.script.ScriptAll;
import com.bloxbean.cardano.client.util.HexUtil;
import com.bloxbean.cardano.client.util.PolicyUtil;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Verifies the bridge builds each non-payment TxPlan intent (staking, governance, DRep, voting,
 * proposals, …) offline. Each operation is built programmatically with CCL, serialized to TxPlan
 * YAML via {@link TxPlan#toYaml()} (so the exact intent shape is authoritative), then built through
 * the bridge with caller-supplied UTXOs + protocol parameters.
 */
class QuickTxIntentsTest {

    private static final String TEST_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";
    private static final String FAKE_TX_HASH = "a".repeat(64);
    private static final String POOL_ID = "pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy";
    private static final String GOV_ACTION_TX = "12745f09b138d4d0a11a560b4591ebb830cf12336347606d2edbbf1893d395c6";

    private final QuickTxService service = new QuickTxService();

    private String protocolParamsJson;
    private Account account;
    private String sender;
    private String sender2;
    private String stakeAddress;
    private Credential drepCredential;

    @BeforeEach
    void setUp() throws IOException {
        try (InputStream is = getClass().getClassLoader().getResourceAsStream("protocol-params.json")) {
            protocolParamsJson = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
        account = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);
        sender = account.baseAddress();
        sender2 = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 1).baseAddress();
        stakeAddress = account.stakeAddress();
        drepCredential = account.drepCredential();
    }

    private static final String REF_TX_HASH = "c".repeat(64);

    /**
     * UTXOs at {@code sender}: a 2000-ADA one (covers deposits — gov action = 1000 ADA) plus a small
     * one that the reference-input test can read.
     */
    private String utxos() {
        return """
            [{"tx_hash":"%s","output_index":0,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"2000000000"}]},
             {"tx_hash":"%s","output_index":0,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"5000000"}]},
             {"tx_hash":"%s","output_index":1,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"2000000000"}]}]
            """.formatted(FAKE_TX_HASH, sender, REF_TX_HASH, sender, FAKE_TX_HASH, sender2);
    }

    /**
     * Build a Tx through the bridge (TxPlan YAML -> offline build) and assert it produced CBOR. Also
     * writes the generated TxPlan YAML to {@code build/intent-yamls/<name>.yaml} so the wrapper
     * end-to-end tests (Go) can drive the exact same intent through the native library.
     */
    private void assertBuilds(String name, Tx tx) throws Exception {
        String yaml = TxPlan.from(tx).feePayer(sender).toYaml();

        java.nio.file.Path dir = java.nio.file.Path.of("build/intent-yamls");
        java.nio.file.Files.createDirectories(dir);
        java.nio.file.Files.writeString(dir.resolve(name + ".yaml"), yaml);

        String resultYaml = service.buildTransaction(yaml, utxos(), protocolParamsJson, null, 1);
        var result = com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer
                .getYamlMapper().readTree(resultYaml);
        assertFalse(result.get("tx_cbor").asText().isEmpty(), "tx_cbor should not be empty");
        assertEquals(64, result.get("tx_hash").asText().length());
        assertTrue(Long.parseLong(result.get("fee").asText()) > 0);
    }

    private Anchor anchor() {
        return new Anchor("https://example.com/meta.json",
                com.bloxbean.cardano.client.util.HexUtil.decodeHexString(FAKE_TX_HASH));
    }

    // --- Staking ---

    @Test
    void stakeRegistration() throws Exception {
        assertBuilds("stake_registration", new Tx().registerStakeAddress(stakeAddress).from(sender));
    }

    @Test
    void stakeDelegation() throws Exception {
        // Delegation only (no registration): the integration test registers the stake address and a
        // pool first, then delegates to that pool.
        assertBuilds("stake_delegation", new Tx().delegateTo(stakeAddress, POOL_ID).from(sender));
    }

    @Test
    void stakeDeregistration() throws Exception {
        assertBuilds("stake_deregistration", new Tx().deregisterStakeAddress(stakeAddress, sender).from(sender));
    }

    @Test
    void stakeWithdrawal() throws Exception {
        assertBuilds("stake_withdrawal", new Tx().withdraw(stakeAddress, BigInteger.ZERO).from(sender));
    }

    // --- Metadata ---

    @Test
    void metadata() throws Exception {
        Metadata md = MetadataBuilder.metadataFromJson("{\"674\":{\"msg\":\"Hello from Mesmo\"}}");
        assertBuilds("metadata", new Tx()
                .payToAddress(account.enterpriseAddress(), Amount.ada(2))
                .attachMetadata(md)
                .from(sender));
    }

    // --- Compose (multiple senders into one transaction) ---

    @Test
    void compose() throws Exception {
        String receiver = account.enterpriseAddress();
        Tx tx1 = new Tx().payToAddress(receiver, Amount.ada(5)).from(sender);
        Tx tx2 = new Tx().payToAddress(receiver, Amount.ada(3)).from(sender2);
        String yaml = TxPlan.from(List.<AbstractTx<?>>of(tx1, tx2)).feePayer(sender).toYaml();

        java.nio.file.Path dir = java.nio.file.Path.of("build/intent-yamls");
        java.nio.file.Files.createDirectories(dir);
        java.nio.file.Files.writeString(dir.resolve("compose.yaml"), yaml);

        var result = com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer.getYamlMapper()
                .readTree(service.buildTransaction(yaml, utxos(), protocolParamsJson, null, 1));
        assertFalse(result.get("tx_cbor").asText().isEmpty());
        assertEquals(64, result.get("tx_hash").asText().length());
        assertTrue(Long.parseLong(result.get("fee").asText()) > 0);
    }

    // --- Treasury ---

    @Test
    void donation() throws Exception {
        // currentTreasuryValue is 0 to match a freshly-reset devnet (the Conway donation cert
        // asserts the stated treasury equals the chain's actual value at submit time).
        assertBuilds("donation", new Tx()
                .donateToTreasury(BigInteger.ZERO, BigInteger.valueOf(1_000_000L))
                .from(sender));
    }

    // --- DRep ---

    @Test
    void drepRegistration() throws Exception {
        assertBuilds("drep_registration", new Tx().registerDRep(drepCredential, anchor()).from(sender));
    }

    @Test
    void drepDeregistration() throws Exception {
        assertBuilds("drep_deregistration", new Tx().unregisterDRep(drepCredential).from(sender));
    }

    @Test
    void drepUpdate() throws Exception {
        assertBuilds("drep_update", new Tx().updateDRep(drepCredential, anchor()).from(sender));
    }

    // --- Voting & proposals ---

    @Test
    void voting() throws Exception {
        Voter voter = new Voter(VoterType.DREP_KEY_HASH, drepCredential);
        assertBuilds("voting", new Tx()
                .createVote(voter, new GovActionId(GOV_ACTION_TX, 0), Vote.YES, anchor())
                .from(sender));
    }

    @Test
    void votingDelegation() throws Exception {
        assertBuilds("voting_delegation", new Tx()
                .delegateVotingPowerTo(new Address(stakeAddress), DRep.abstain())
                .from(sender));
    }

    @Test
    void governanceProposalInfoAction() throws Exception {
        assertBuilds("governance_proposal", new Tx()
                .createProposal(new InfoAction(), stakeAddress, anchor())
                .from(sender));
    }

    // --- Stake pools ---

    private PoolRegistration samplePool() {
        // Key the pool to the account's stake key (operator + owner + reward account) so the pool
        // registration can be witnessed by signing with the account's stake key — no separate pool
        // cold key is needed. The reward account must be a registered stake address (the integration
        // test registers it first).
        byte[] stakeAddrBytes = new Address(account.stakeAddress()).getBytes();
        byte[] stakeKeyHash = java.util.Arrays.copyOfRange(stakeAddrBytes, 1, stakeAddrBytes.length);
        return PoolRegistration.builder()
                .operator(stakeKeyHash)
                .vrfKeyHash(HexUtil.decodeHexString("b95af7a0a58928fbd0e73b03ce81dedd42d4a776685b443cf2016c18438a3b9b"))
                .pledge(BigInteger.valueOf(100_000_000L))
                .cost(BigInteger.valueOf(340_000_000L))
                .margin(new UnitInterval(BigInteger.valueOf(1), BigInteger.valueOf(100)))
                .rewardAccount(HexUtil.encodeHexString(stakeAddrBytes))
                .poolOwners(Set.of(HexUtil.encodeHexString(stakeKeyHash)))
                .relays(List.of(SingleHostAddr.builder().port(3001).build()))
                .build();
    }

    @Test
    void poolRegistration() throws Exception {
        assertBuilds("pool_registration", new Tx().registerPool(samplePool()).from(sender));
    }

    @Test
    void poolUpdate() throws Exception {
        assertBuilds("pool_update", new Tx().updatePool(samplePool()).from(sender));
    }

    @Test
    void poolRetirement() throws Exception {
        assertBuilds("pool_retirement", new Tx().retirePool(POOL_ID, 500).from(sender));
    }

    // --- Native scripts, explicit & reference inputs ---

    @Test
    void nativeMinting() throws Exception {
        // An empty ScriptAll requires no signatures (vacuously true), so the minted policy needs no
        // policy-key witness — the fee payer alone can submit it.
        ScriptAll noKeyPolicy = new ScriptAll();
        assertBuilds("minting", new Tx()
                .mintAssets(noKeyPolicy, new Asset("TestNFT", BigInteger.ONE), account.enterpriseAddress())
                .from(sender));
    }

    @Test
    void nativeScriptAttachment() throws Exception {
        Policy policy = PolicyUtil.createMultiSigScriptAllPolicy("test-policy", 1);
        assertBuilds("native_script", new Tx()
                .attachNativeScript(policy.getPolicyScript())
                .payToAddress(account.enterpriseAddress(), Amount.ada(5))
                .from(sender));
    }

    @Test
    void collectFromRegular() throws Exception {
        Utxo senderUtxo = Utxo.builder()
                .txHash(FAKE_TX_HASH).outputIndex(0).address(sender)
                .amount(List.of(Amount.ada(2000)))
                .build();
        assertBuilds("collect_from", new Tx()
                .collectFrom(List.of(senderUtxo))
                .payToAddress(account.enterpriseAddress(), Amount.ada(5))
                .from(sender));
    }

    @Test
    void referenceInput() throws Exception {
        assertBuilds("reference_input", new Tx()
                .readFrom(REF_TX_HASH, 0)
                .payToAddress(account.enterpriseAddress(), Amount.ada(5))
                .from(sender));
    }

    // --- Plutus scripts (mint + spend) ---

    private static final String ALWAYS_SUCCEEDS_V2 = "4e4d01000033222220051200120011";

    @Test
    void scriptMinting() throws Exception {
        PlutusScript script = PlutusV2Script.builder().cborHex(ALWAYS_SUCCEEDS_V2).build();
        PlutusData redeemer = BigIntPlutusData.of(0);
        Tx tx = new Tx()
                .mintAsset(script, new Asset("TestToken", BigInteger.ONE), redeemer, account.enterpriseAddress())
                .from(sender);

        String yaml = TxPlan.from(tx).feePayer(sender).toYaml();
        java.nio.file.Path dir = java.nio.file.Path.of("build/intent-yamls");
        java.nio.file.Files.createDirectories(dir);
        java.nio.file.Files.writeString(dir.resolve("script_minting.yaml"), yaml);

        String execUnits = "[{\"mem\": 2000000, \"steps\": 500000000}]";
        var result = com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer.getYamlMapper()
                .readTree(service.buildTransaction(yaml, utxos(), protocolParamsJson, execUnits, 1));
        assertFalse(result.get("tx_cbor").asText().isEmpty());
        assertEquals(64, result.get("tx_hash").asText().length());
        assertTrue(Long.parseLong(result.get("fee").asText()) > 0);
    }

    @Test
    void plutusLock() throws Exception {
        // Pays a UTXO to the always-succeeds script address carrying the datum hash, so a later
        // script spend has something to collect. The integration test submits this first.
        PlutusScript script = PlutusV2Script.builder().cborHex(ALWAYS_SUCCEEDS_V2).build();
        String scriptAddr = AddressProvider.getEntAddress(script, Networks.testnet()).toBech32();
        PlutusData datum = BigIntPlutusData.of(42);

        Tx tx = new Tx()
                .payToContract(scriptAddr, Amount.ada(10), datum.getDatumHash())
                .from(sender);

        String yaml = TxPlan.from(tx).feePayer(sender).toYaml();
        java.nio.file.Path dir = java.nio.file.Path.of("build/intent-yamls");
        java.nio.file.Files.createDirectories(dir);
        java.nio.file.Files.writeString(dir.resolve("plutus_lock.yaml"), yaml);

        var result = com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer.getYamlMapper()
                .readTree(service.buildTransaction(yaml, utxos(), protocolParamsJson, null, 1));
        assertFalse(result.get("tx_cbor").asText().isEmpty());
        assertEquals(64, result.get("tx_hash").asText().length());
    }

    @Test
    void scriptCollectFrom() throws Exception {
        PlutusScript script = PlutusV2Script.builder().cborHex(ALWAYS_SUCCEEDS_V2).build();
        String scriptAddr = AddressProvider.getEntAddress(script, Networks.testnet()).toBech32();
        PlutusData datum = BigIntPlutusData.of(42);
        PlutusData redeemer = BigIntPlutusData.of(0);
        String scriptTxHash = "b".repeat(64);

        Utxo scriptUtxo = Utxo.builder()
                .txHash(scriptTxHash).outputIndex(0).address(scriptAddr)
                .amount(List.of(Amount.ada(10)))
                .dataHash(datum.getDatumHash())
                .build();

        Tx tx = new Tx()
                .collectFrom(scriptUtxo, redeemer, datum)
                .payToAddress(account.enterpriseAddress(), Amount.ada(5))
                .attachSpendingValidator(script)
                .from(sender);

        String yaml = TxPlan.from(tx).feePayer(sender).toYaml();
        java.nio.file.Path dir = java.nio.file.Path.of("build/intent-yamls");
        java.nio.file.Files.createDirectories(dir);
        java.nio.file.Files.writeString(dir.resolve("script_collect_from.yaml"), yaml);

        // The script UTXO (to spend) + a sender UTXO (fees + collateral). Plutus spends need
        // caller-supplied execution units (one redeemer here).
        String utxosJson = """
            [{"tx_hash":"%s","output_index":0,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"10000000"}],"data_hash":"%s"},
             {"tx_hash":"%s","output_index":0,"address":"%s",
              "amount":[{"unit":"lovelace","quantity":"2000000000"}]}]
            """.formatted(scriptTxHash, scriptAddr, datum.getDatumHash(), FAKE_TX_HASH, sender);
        String execUnits = "[{\"mem\": 2000000, \"steps\": 500000000}]";

        String resultYaml = service.buildTransaction(yaml, utxosJson, protocolParamsJson, execUnits, 1);
        var result = com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer
                .getYamlMapper().readTree(resultYaml);
        assertFalse(result.get("tx_cbor").asText().isEmpty());
        assertEquals(64, result.get("tx_hash").asText().length());
        assertTrue(Long.parseLong(result.get("fee").asText()) > 0);
    }
}
