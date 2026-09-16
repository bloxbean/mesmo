package com.bloxbean.cardano.bridge.api.account;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The ADR-0016 gate for the account-key open mode: an account held by its hardened account-level
 * key ({@code m/1852'/1815'/account'}) must be indistinguishable from a mnemonic-backed one —
 * byte-identical addresses, identifiers, and signatures — across derivation coordinates and every
 * signing role. If any assertion here fails, the mode must not ship.
 */
class AccountKeyDerivationParityTest {

    private static final String TEST_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";
    private static final int TESTNET = 1;

    private static final int[][] COORDINATES = {{0, 0}, {0, 5}, {2, 0}, {3, 7}};

    @Test
    void addressesAndIdentifiers_matchMnemonicBackedAccounts_acrossCoordinates() {
        for (int[] coordinate : COORDINATES) {
            int accountIndex = coordinate[0];
            int addressIndex = coordinate[1];
            long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, accountIndex, addressIndex);
            try {
                Map<String, Object> info = AccountService.info(handle);
                Account reference = Account.createFromMnemonic(
                        Networks.testnet(), TEST_MNEMONIC, accountIndex, addressIndex);
                String at = " at " + accountIndex + "/" + addressIndex;
                assertEquals(reference.baseAddress(), info.get("base_address"), "base" + at);
                assertEquals(reference.enterpriseAddress(), info.get("enterprise_address"), "enterprise" + at);
                assertEquals(reference.stakeAddress(), info.get("stake_address"), "stake" + at);
                assertEquals(reference.drepId(), info.get("drep_id"), "drep" + at);
            } finally {
                AccountService.close(handle);
            }
        }
    }

    @Test
    void signatures_matchMnemonicBackedAccounts_forEveryRole() throws Exception {
        long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, 0, 0);
        try {
            String unsigned = TestTransactions.unsignedStakeRegistration(TEST_MNEMONIC);
            Account reference = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);

            var tx = com.bloxbean.cardano.client.transaction.spec.Transaction.deserialize(
                    com.bloxbean.cardano.client.util.HexUtil.decodeHexString(unsigned));
            tx = reference.sign(tx);
            tx = reference.signWithStakeKey(tx);
            tx = reference.signWithDRepKey(tx);
            tx = reference.signWithCommitteeColdKey(tx);
            tx = reference.signWithCommitteeHotKey(tx);
            String allRolesLegacy = tx.serializeToHex();

            String allRolesManaged = AccountService.signTx(handle, unsigned,
                    AccountService.ROLE_PAYMENT | AccountService.ROLE_STAKE
                            | AccountService.ROLE_DREP | AccountService.ROLE_COMMITTEE_COLD
                            | AccountService.ROLE_COMMITTEE_HOT);
            assertEquals(allRolesLegacy, allRolesManaged,
                    "account-key mode must sign byte-identically across every role");
        } finally {
            AccountService.close(handle);
        }
    }

    /** Shared offline transaction builder for the parity tests. */
    static final class TestTransactions {
        static String unsignedStakeRegistration(String mnemonic) throws Exception {
            var service = new com.bloxbean.cardano.bridge.api.quicktx.QuickTxService();
            Account reference = Account.createFromMnemonic(Networks.testnet(), mnemonic, 0, 0);
            String yaml = com.bloxbean.cardano.client.quicktx.serialization.TxPlan
                    .from(new com.bloxbean.cardano.client.quicktx.Tx()
                            .registerStakeAddress(reference.stakeAddress())
                            .from(reference.baseAddress()))
                    .feePayer(reference.baseAddress()).toYaml();
            String utxos = """
                [{"tx_hash":"%s","output_index":0,"address":"%s",
                  "amount":[{"unit":"lovelace","quantity":"2000000000"}]}]
                """.formatted("a".repeat(64), reference.baseAddress());
            String params;
            try (var is = TestTransactions.class.getClassLoader()
                    .getResourceAsStream("protocol-params.json")) {
                params = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            }
            var result = com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer
                    .getYamlMapper().readTree(service.buildTransaction(yaml, utxos, params, null, 5));
            return result.get("tx_cbor").asText();
        }
    }
}
