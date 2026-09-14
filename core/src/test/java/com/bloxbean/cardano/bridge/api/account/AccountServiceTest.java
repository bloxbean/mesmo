package com.bloxbean.cardano.bridge.api.account;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Lifecycle and public-data invariants of the managed-account registry (ADR-0016): handles are
 * opaque and never reused as another account after close; unknown/closed/stale handles fail with a
 * typed error; close is idempotent; account info never carries secrets.
 */
class AccountServiceTest {

    private static final String TEST_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";
    private static final int TESTNET = 1;

    private final List<Long> opened = new ArrayList<>();

    private long open(int accountIndex, int addressIndex) {
        long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, accountIndex, addressIndex);
        opened.add(handle);
        return handle;
    }

    @AfterEach
    void tearDown() {
        opened.forEach(AccountService::close);
        opened.clear();
    }

    @Test
    void openReturnsNonZeroHandle_andInfoMatchesCclDerivation() {
        long handle = open(0, 0);
        assertTrue(handle > 0, "handles start at 1; 0 is never valid");

        Map<String, Object> info = AccountService.info(handle);
        Account reference = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);
        assertEquals(reference.baseAddress(), info.get("base_address"));
        assertEquals(reference.enterpriseAddress(), info.get("enterprise_address"));
        assertEquals(reference.stakeAddress(), info.get("stake_address"));
        assertEquals(reference.drepId(), info.get("drep_id"));
        assertEquals(TESTNET, info.get("network"));
        assertEquals(0, info.get("account_index"));
        assertEquals(0, info.get("address_index"));
    }

    @Test
    void infoNeverContainsSecrets() {
        Map<String, Object> info = AccountService.info(open(0, 0));
        for (var entry : info.entrySet()) {
            String key = entry.getKey().toLowerCase();
            assertFalse(key.contains("mnemonic") || key.contains("private") || key.contains("secret"),
                    "secret-bearing key in account info: " + entry.getKey());
            String value = String.valueOf(entry.getValue());
            assertFalse(value.contains(TEST_MNEMONIC.split(" ")[0] + " "),
                    "mnemonic words leaked through info value: " + entry.getKey());
        }
    }

    @Test
    void distinctHandles_forSameAndDifferentDerivations() {
        long first = open(0, 0);
        long again = open(0, 0);   // same derivation opened twice: independent handles
        long other = open(0, 1);
        assertNotEquals(first, again);
        assertNotEquals(first, other);

        // Interleaved use: each handle answers for its own derivation.
        assertNotEquals(AccountService.info(first).get("base_address"),
                AccountService.info(other).get("base_address"));
        assertEquals(AccountService.info(first).get("base_address"),
                AccountService.info(again).get("base_address"));
    }

    @Test
    void unknownHandleFails_withTypedException() {
        assertThrows(AccountService.UnknownHandleException.class,
                () -> AccountService.info(999_999_999L));
        assertThrows(AccountService.UnknownHandleException.class,
                () -> AccountService.info(0L), "0 must never be a valid handle");
    }

    @Test
    void useAfterClose_failsWithTypedException_andCloseIsIdempotent() {
        long handle = open(0, 0);
        AccountService.close(handle);
        assertThrows(AccountService.UnknownHandleException.class,
                () -> AccountService.info(handle));
        assertDoesNotThrow(() -> AccountService.close(handle), "double-close must be a no-op");
        assertDoesNotThrow(() -> AccountService.close(123_456_789L), "closing unknown is a no-op");
    }

    @Test
    void closedHandleIsNeverReassigned() {
        long first = open(0, 0);
        AccountService.close(first);
        long next = open(0, 1);
        assertNotEquals(first, next, "handles are never reused after close");
        assertThrows(AccountService.UnknownHandleException.class,
                () -> AccountService.info(first), "the closed handle stays dead");
    }

    // --- Signing: typed role mask, byte-identical with the mnemonic-per-call path ---

    /** An unsigned stake-registration tx built offline, for signing tests. */
    private String unsignedTx() throws Exception {
        var service = new com.bloxbean.cardano.bridge.api.quicktx.QuickTxService();
        Account reference = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);
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
        try (var is = getClass().getClassLoader().getResourceAsStream("protocol-params.json")) {
            params = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        var result = com.bloxbean.cardano.client.quicktx.serialization.YamlSerializer
                .getYamlMapper().readTree(service.buildTransaction(yaml, utxos, params, null, 1));
        return result.get("tx_cbor").asText();
    }

    /** Reference signature straight from a mnemonic-backed CCL Account (the parity oracle). */
    private String signReference(String txCborHex, boolean stake, boolean drep) throws Exception {
        Account account = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);
        var tx = com.bloxbean.cardano.client.transaction.spec.Transaction.deserialize(
                com.bloxbean.cardano.client.util.HexUtil.decodeHexString(txCborHex));
        tx = account.sign(tx);
        if (stake) tx = account.signWithStakeKey(tx);
        if (drep) tx = account.signWithDRepKey(tx);
        return tx.serializeToHex();
    }

    @Test
    void signParity_byteIdenticalWithLegacyPath_acrossRoleCombos() throws Exception {
        long handle = open(0, 0);
        String unsigned = unsignedTx();

        assertEquals(signReference(unsigned, false, false),
                AccountService.signTx(handle, unsigned,
                        AccountService.ROLE_PAYMENT));
        assertEquals(signReference(unsigned, true, false),
                AccountService.signTx(handle, unsigned,
                        AccountService.ROLE_PAYMENT | AccountService.ROLE_STAKE));
        assertEquals(signReference(unsigned, true, true),
                AccountService.signTx(handle, unsigned,
                        AccountService.ROLE_PAYMENT | AccountService.ROLE_STAKE
                                | AccountService.ROLE_DREP));
    }

    @Test
    void signMaskValidation_zeroAndUnknownBitsRejected() throws Exception {
        long handle = open(0, 0);
        String unsigned = unsignedTx();
        assertThrows(IllegalArgumentException.class,
                () -> AccountService.signTx(handle, unsigned, 0),
                "empty mask must not silently sign with every key");
        assertThrows(IllegalArgumentException.class,
                () -> AccountService.signTx(handle, unsigned, 1 << 7));
        assertThrows(IllegalArgumentException.class,
                () -> AccountService.signTx(handle, "  ", AccountService.ROLE_PAYMENT));
    }

    @Test
    void signOnClosedHandle_failsTyped() throws Exception {
        long handle = open(0, 0);
        String unsigned = unsignedTx();
        AccountService.close(handle);
        assertThrows(AccountService.UnknownHandleException.class,
                () -> AccountService.signTx(handle, unsigned,
                        AccountService.ROLE_PAYMENT));
    }

    // --- Freshly created accounts and the one-shot recovery-phrase export ---

    @Test
    void createNew_exportsPhraseExactlyOnce_andPhraseRestoresSameAccount() {
        long handle = AccountService.createNew(TESTNET);
        opened.add(handle);

        String baseAddress = (String) AccountService.info(handle).get("base_address");
        String phrase = AccountService.exportRecoveryPhrase(handle);
        assertEquals(24, phrase.trim().split("\\s+").length);

        // The exported phrase restores the identical account.
        Account restored = Account.createFromMnemonic(Networks.testnet(), phrase, 0, 0);
        assertEquals(baseAddress, restored.baseAddress());

        // One-shot: a second export fails, but the handle itself stays fully usable.
        assertThrows(IllegalStateException.class,
                () -> AccountService.exportRecoveryPhrase(handle));
        assertEquals(baseAddress, AccountService.info(handle).get("base_address"));
    }

    @Test
    void exportOnImportedAccount_fails_theCallerAlreadyHoldsThePhrase() {
        long handle = open(0, 0);
        assertThrows(IllegalStateException.class,
                () -> AccountService.exportRecoveryPhrase(handle));
    }

    @Test
    void exportAfterClose_failsWithHandleError_notStateError() {
        long handle = AccountService.createNew(TESTNET);
        AccountService.close(handle);
        assertThrows(AccountService.UnknownHandleException.class,
                () -> AccountService.exportRecoveryPhrase(handle),
                "unknown-handle semantics take precedence; close also drops the pending phrase");
    }

    @Test
    void closeLeavesNoStateBehind_inEitherMap() {
        int baseOpen = AccountService.openCount();
        int basePending = AccountService.pendingPhraseCount();
        int baseInfoCache = AccountService.infoCacheCount();

        long imported = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, 0, 0);
        long created = AccountService.createNew(TESTNET);
        long exported = AccountService.createNew(TESTNET);
        AccountService.exportRecoveryPhrase(exported);
        assertDoesNotThrow(() -> AccountService.infoJson(imported)); // populate the memoized info

        assertEquals(baseOpen + 3, AccountService.openCount());
        assertEquals(basePending + 1, AccountService.pendingPhraseCount(),
                "imported accounts pend no phrase; the exported one was consumed");

        AccountService.close(imported);
        AccountService.close(created);
        AccountService.close(exported);
        assertEquals(baseOpen, AccountService.openCount(), "every handle removed");
        assertEquals(baseInfoCache, AccountService.infoCacheCount(), "info cache drained on close");
        assertEquals(basePending, AccountService.pendingPhraseCount(),
                "close drops an unexported phrase too — no secret outlives its handle");
    }

    @Test
    void invalidOpenArguments_rejected() {
        assertThrows(IllegalArgumentException.class,
                () -> AccountService.openMnemonic(99, TEST_MNEMONIC, 0, 0));
        assertThrows(IllegalArgumentException.class,
                () -> AccountService.openMnemonic(TESTNET, "  ", 0, 0));
        assertThrows(IllegalArgumentException.class,
                () -> AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, -1, 0));
        assertThrows(Exception.class,
                () -> AccountService.openMnemonic(TESTNET, "not a valid mnemonic at all", 0, 0));
    }

    // --- The public info contract: complete, and never silently shrinking ---
    //
    // change_address went missing once (the legacy API had it; the first handle info() didn't, and
    // no other entry point could rebuild it — a capability loss the removal commit claimed not to
    // make). Pinning the exact key set makes any field deletion or rename a test failure with the
    // field's name in it, instead of a silent contract change discovered by a downstream wallet.

    @Test
    void infoExposesTheCompletePublicFieldSet() {
        long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, 0, 0);
        try {
            var info = AccountService.info(handle);
            assertEquals(
                    java.util.List.of(
                            "base_address", "enterprise_address", "stake_address", "change_address",
                            "network", "account_index", "address_index", "drep_id",
                            "committee_cold_id", "committee_cold_credential",
                            "committee_hot_id", "committee_hot_credential"),
                    new java.util.ArrayList<>(info.keySet()),
                    "the public info field set (and its order) is a contract — extend deliberately, never shrink");
        } finally {
            AccountService.close(handle);
        }
    }

    @Test
    void changeAddressMatchesTheMnemonicBackedDerivation() {
        long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, 0, 0);
        try {
            var reference = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);
            assertEquals(reference.changeAddress(),
                    AccountService.info(handle).get("change_address"),
                    "change_address must be the CIP-1852 role-1 leaf, byte-identical to CCL's own");
        } finally {
            AccountService.close(handle);
        }
    }

    // --- signTx error precedence ---
    //
    // The class's own rule (established in exportRecoveryPhrase): unknown/closed-handle semantics
    // take precedence over argument validation, so wrapper recovery keyed on the typed handle
    // error (-11) always triggers. And corrupt hex is a corrupt transaction (-9), the same class
    // as valid-hex-bad-CBOR — not an invalid argument (-2).

    @Test
    void signTxOnAClosedHandleThrowsTheHandleError_evenWithBadArguments() {
        long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, 0, 0);
        AccountService.close(handle);
        assertThrows(AccountService.UnknownHandleException.class,
                () -> AccountService.signTx(handle, "", 0),
                "closed-handle semantics must take precedence over argument validation");
    }

    @Test
    void nonHexTransactionIsAnInvalidTransaction_notAnInvalidArgument() {
        long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, 0, 0);
        try {
            for (String corrupt : new String[]{"zz", "abc"}) { // non-hex; odd length
                var e = assertThrows(IllegalStateException.class,
                        () -> AccountService.signTx(handle, corrupt, AccountService.ROLE_PAYMENT),
                        "corrupt hex must map to CCL_ERROR_INVALID_TRANSACTION like corrupt CBOR");
                assertTrue(e.getMessage().startsWith("Transaction signing failed"));
            }
        } finally {
            AccountService.close(handle);
        }
    }

    @Test
    void handlesComeFromARandomizedPerIsolateSpace() {
        // Cross-isolate aliasing guard: if handles ever count from 1 again, two bridges in one
        // process collide and a foreign handle silently resolves a real account (wrong keys)
        // instead of -11. A tiny first handle means the random base is gone.
        long handle = AccountService.openMnemonic(TESTNET, TEST_MNEMONIC, 0, 0);
        try {
            assertTrue(handle > 1_000_000L,
                    "handle " + handle + " looks like a fixed small counter — the per-isolate "
                            + "random base (see nextHandle) has been removed");
        } finally {
            AccountService.close(handle);
        }
    }

    // --- Export delivery: claimed phrases are retryable on failure, never orphaned ---

    @Test
    void restoredPhraseKeepsAFailedDeliveryRetryable() {
        long handle = AccountService.createNew(TESTNET);
        try {
            String phrase = AccountService.exportRecoveryPhrase(handle); // atomic claim
            assertThrows(IllegalStateException.class,
                    () -> AccountService.exportRecoveryPhrase(handle), "one-shot: claimed");

            AccountService.restoreRecoveryPhrase(handle, phrase); // as after a failed delivery
            assertEquals(phrase, AccountService.exportRecoveryPhrase(handle),
                    "a failed delivery must leave the export retryable — the phrase is the only copy");
        } finally {
            AccountService.close(handle);
        }
    }

    @Test
    void restoreAfterCloseLeavesNoSecretBehind() {
        int basePending = AccountService.pendingPhraseCount();
        long handle = AccountService.createNew(TESTNET);
        String phrase = AccountService.exportRecoveryPhrase(handle);
        AccountService.close(handle);

        AccountService.restoreRecoveryPhrase(handle, phrase); // lost the race with close
        assertEquals(basePending, AccountService.pendingPhraseCount(),
                "close wins: no secret outlives its handle, even via a late restore");
    }
}
