package com.bloxbean.cardano.bridge.api.account;

import com.bloxbean.cardano.bridge.util.NetworkMapper;
import com.bloxbean.cardano.client.common.model.Network;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Isolate-local registry of managed Accounts (ADR-0016): open an account once, receive an opaque
 * {@code long} handle, and use the handle for subsequent operations — the mnemonic never travels
 * with per-operation calls.
 *
 * <p>Lifecycle invariants (the ADR's, verbatim): handles are opaque identifiers scoped to one
 * GraalVM isolate (this class is a per-isolate static, so handles die with the isolate); network
 * and derivation indices are fixed at open; unknown, closed, or foreign handles fail with
 * {@link UnknownHandleException} — never by touching another object; {@link #close} is explicit
 * and idempotent.
 *
 * <p>The Account's ordinary representation ({@link #info}) contains public data only — it never
 * echoes the mnemonic. Accounts are held by their <b>hardened account-level key</b> (the ADR's
 * preferred mode; see {@link #accountFromAccountKey}): the phrase is consumed at open and never
 * retained, gated by {@code AccountKeyDerivationParityTest}.
 */
public final class AccountService {

    /** Thrown when a handle is unknown, already closed, or from another isolate. */
    public static final class UnknownHandleException extends RuntimeException {
        UnknownHandleException(long handle) {
            super("Unknown or closed account handle: " + handle);
        }
    }

    /** Thrown for a network id that is not MAINNET (0) or TESTNET (1). */
    public static final class InvalidNetworkException extends IllegalArgumentException {
        InvalidNetworkException(int networkId) {
            super("Invalid network id: " + networkId);
        }
    }

    /** Thrown for a syntactically invalid BIP-39 mnemonic. */
    public static final class InvalidMnemonicException extends IllegalArgumentException {
        InvalidMnemonicException(String reason) {
            super("Invalid mnemonic: " + reason);
        }
    }

    // Handles start at a per-isolate 62-bit random base (never 0, so a zero-initialized
    // out-parameter can't alias a real account). Every isolate counting from 1 would make
    // cross-isolate handle collisions certain: with two bridges in one process, bridge A's
    // handle 1 aliased bridge B's account 1, and the wrong bridge/handle pairing signed with
    // the WRONG KEYS instead of failing with -11. Randomized bases make the documented
    // foreign-handle failure hold statistically (collision odds ~ n·m / 2^62).
    private static final AtomicLong nextHandle = new AtomicLong(
            (new java.security.SecureRandom().nextLong() & ((1L << 62) - 1)) | 1L);
    private static final ConcurrentHashMap<Long, Account> accounts = new ConcurrentHashMap<>();

    // Recovery phrases of freshly created (not imported) accounts, held only until exported or the
    // handle closes. Kept out of the Account record so the ordinary object graph never carries the
    // phrase; removal on export makes the export naturally one-shot.
    private static final ConcurrentHashMap<Long, String> pendingRecoveryPhrases = new ConcurrentHashMap<>();

    // Serialized info(), memoized per handle: every field is fixed at open (the class invariant),
    // yet computing it re-derives the DRep and committee keys. Cleared on close.
    private static final ConcurrentHashMap<Long, String> infoJsonCache = new ConcurrentHashMap<>();

    private AccountService() {}

    /**
     * Opens an account from a mnemonic at fixed derivation indices and returns its handle.
     *
     * @throws IllegalArgumentException for a bad network id, blank mnemonic, or negative indices
     */
    public static long openMnemonic(int networkId, String mnemonic, int accountIndex, int addressIndex) {
        Network network = NetworkMapper.toNetwork(networkId);
        if (network == null) {
            throw new InvalidNetworkException(networkId);
        }
        if (mnemonic == null || mnemonic.isBlank()) {
            throw new InvalidMnemonicException("a non-blank phrase is required");
        }
        try {
            com.bloxbean.cardano.client.crypto.MnemonicUtil.validateMnemonic(mnemonic);
        } catch (Exception e) {
            throw new InvalidMnemonicException(e.getMessage());
        }
        if (accountIndex < 0 || addressIndex < 0) {
            throw new IllegalArgumentException("Account and address indices must be >= 0");
        }
        // The mnemonic is consumed here (transient parameter); the stored account retains only
        // the derived account-level key — see accountFromAccountKey.
        var cclAccount = accountFromAccountKey(network, mnemonic, accountIndex, addressIndex);
        long handle = nextHandle.getAndIncrement();
        accounts.put(handle, new Account(cclAccount, networkId, accountIndex, addressIndex));
        return handle;
    }

    /**
     * Builds the CCL account from the <b>hardened account-level key</b> (ADR-0016's preferred
     * mode).
     *
     * <p><b>Reviewer note — passing is not retaining:</b> the mnemonic here is a <em>transient
     * parameter</em>, consumed within this one call to derive {@code m/1852'/1815'/accountIndex'}.
     * The account it returns is built via CCL's {@code createFromAccountKey}, so the long-lived
     * object in the registry holds <em>only</em> that 96-byte account key — its {@code mnemonic}
     * and {@code rootKey} fields are null. The blast radius of a later memory disclosure is one
     * account, not the wallet's entire derivation universe.
     *
     * <p>The derivation intermediates (root, purpose, coin-type — and the account-level pair,
     * whose retained form is the independent merged copy handed to CCL) are zeroed in the
     * {@code finally} block below; CCL's {@code getKeyData()}/{@code getChainCode()} expose the
     * backing arrays, so the fill genuinely overwrites them. What this cannot reach — the mnemonic
     * String itself and CCL-internal seed copies — stays GC-transient; zeroization remains
     * best-effort overall, per the ADR.
     *
     * <p>Gated by {@code AccountKeyDerivationParityTest}: addresses, identifiers, and signatures
     * must be byte-identical with mnemonic-backed accounts.
     */
    private static com.bloxbean.cardano.client.account.Account accountFromAccountKey(
            Network network, String mnemonic, int accountIndex, int addressIndex) {
        var generator = new com.bloxbean.cardano.client.crypto.bip32.HdKeyGenerator();
        com.bloxbean.cardano.client.crypto.bip32.HdKeyPair root = null;
        com.bloxbean.cardano.client.crypto.bip32.HdKeyPair purpose = null;
        com.bloxbean.cardano.client.crypto.bip32.HdKeyPair coinType = null;
        com.bloxbean.cardano.client.crypto.bip32.HdKeyPair accountLevel = null;
        try {
            root = new com.bloxbean.cardano.client.crypto.cip1852.CIP1852()
                    .getRootKeyPairFromMnemonic(mnemonic);
            purpose = generator.getChildKeyPair(root, 1852, true);
            coinType = generator.getChildKeyPair(purpose, 1815, true);
            accountLevel = generator.getChildKeyPair(coinType, accountIndex, true);
            // getBytes() merges keyData + chainCode into a NEW array — the one thing that
            // legitimately survives this method, inside the CCL account.
            byte[] accountKey = accountLevel.getPrivateKey().getBytes();
            return com.bloxbean.cardano.client.account.Account
                    .createFromAccountKey(network, accountKey, accountIndex, addressIndex);
        } finally {
            wipe(root);
            wipe(purpose);
            wipe(coinType);
            wipe(accountLevel);
        }
    }

    /**
     * Zeroes a derivation intermediate's private key material in place. Child derivation copies
     * out of fresh HMAC output ({@code Arrays.copyOfRange}), so no wiped array is shared with a
     * pair that must stay live; the private and public halves of one pair share their chain-code
     * array, which is fine — both halves are being discarded together.
     */
    private static void wipe(com.bloxbean.cardano.client.crypto.bip32.HdKeyPair pair) {
        if (pair == null) {
            return;
        }
        byte[] keyData = pair.getPrivateKey().getKeyData();
        if (keyData != null) {
            Arrays.fill(keyData, (byte) 0);
        }
        byte[] chainCode = pair.getPrivateKey().getChainCode();
        if (chainCode != null) {
            Arrays.fill(chainCode, (byte) 0);
        }
    }

    /**
     * Creates a brand-new account (fresh 24-word mnemonic) and returns its handle. The recovery
     * phrase is <b>not</b> part of the account's ordinary representation — retrieve it once,
     * deliberately, via {@link #exportRecoveryPhrase(long)}.
     */
    public static long createNew(int networkId) {
        Network network = NetworkMapper.toNetwork(networkId);
        if (network == null) {
            throw new InvalidNetworkException(networkId);
        }
        // Generate the phrase directly (no throwaway mnemonic-backed Account, which would derive
        // a full key set and float to GC holding the phrase and root key), then hold the account
        // by its account-level key — same mode as openMnemonic. The phrase itself lives only in
        // the pending map until export/close.
        String phrase;
        try {
            phrase = String.join(" ", com.bloxbean.cardano.client.crypto.bip39.MnemonicCode.INSTANCE
                    .createMnemonic(com.bloxbean.cardano.client.crypto.bip39.Words.TWENTY_FOUR));
        } catch (Exception e) {
            throw new IllegalStateException("Mnemonic generation failed: " + e.getMessage(), e);
        }
        // As in openMnemonic: the phrase is consumed transiently; the stored account retains only
        // the account-level key. The pending map below is the phrase's sole retention, for export.
        var cclAccount = accountFromAccountKey(network, phrase, 0, 0);
        long handle = nextHandle.getAndIncrement();
        accounts.put(handle, new Account(cclAccount, networkId, 0, 0));
        pendingRecoveryPhrases.put(handle, phrase);

        return handle;
    }

    /**
     * One-shot export of a freshly created account's recovery phrase. The phrase is removed on
     * retrieval: a second call fails, as does calling it on an account opened from a mnemonic
     * (the caller already has that phrase — re-serving it would only widen its exposure).
     *
     * @throws IllegalStateException when the phrase was already exported or the account was
     *                               opened from a mnemonic
     */
    public static String exportRecoveryPhrase(long handle) {
        lookup(handle); // typed -11 semantics for unknown/closed handles take precedence
        String phrase = pendingRecoveryPhrases.remove(handle); // atomic claim: one-shot
        if (phrase == null) {
            throw new IllegalStateException(
                    "No recovery phrase to export: already exported, or the account was opened from a mnemonic");
        }
        return phrase;
    }

    /**
     * Puts a claimed-but-undelivered phrase back, so a failed delivery (e.g. the unmanaged-memory
     * allocation for the out-param C string) leaves the export <em>retryable</em> instead of
     * orphaning the only copy of a funded account's recovery phrase. No-op if the handle closed
     * concurrently — close's cleanup wins, no secret outlives its handle.
     */
    static void restoreRecoveryPhrase(long handle, String phrase) {
        pendingRecoveryPhrases.putIfAbsent(handle, phrase);
        if (!accounts.containsKey(handle)) {
            pendingRecoveryPhrases.remove(handle); // lost the race with close(); handles never reused
        }
    }

    /**
     * Public account information — safe to log or serialize; never contains the mnemonic or any
     * private key material.
     */
    /** {@link #info} as its serialized JSON, memoized for the handle's lifetime. */
    public static String infoJson(long handle) throws com.fasterxml.jackson.core.JsonProcessingException {
        String cached = infoJsonCache.get(handle);
        if (cached != null) {
            return cached;
        }
        String json = com.bloxbean.cardano.bridge.util.JsonHelper.toJson(info(handle));
        infoJsonCache.put(handle, json);
        if (!accounts.containsKey(handle)) {
            infoJsonCache.remove(handle); // lost the race with close(); handles are never reused
        }
        return json;
    }

    public static Map<String, Object> info(long handle) {
        Account managed = lookup(handle);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("base_address", managed.cclAccount().baseAddress());
        result.put("enterprise_address", managed.cclAccount().enterpriseAddress());
        result.put("stake_address", managed.cclAccount().stakeAddress());
        // The CIP-1852 role-1 (internal/change) leaf at this account's address index — wallet
        // apps need it to see funds sitting on change outputs.
        result.put("change_address", managed.cclAccount().changeAddress());
        result.put("network", managed.networkId());
        result.put("account_index", managed.accountIndex());
        result.put("address_index", managed.addressIndex());
        result.put("drep_id", managed.cclAccount().drepId());
        // Committee identifiers — bech32 id and hex credential (blake2b-224 verification-key
        // hash, as used in committee certificates). Public data like everything else here.
        var coldKey = managed.cclAccount().committeeColdKey();
        var hotKey = managed.cclAccount().committeeHotKey();
        result.put("committee_cold_id", coldKey.id());
        result.put("committee_cold_credential",
                com.bloxbean.cardano.client.util.HexUtil.encodeHexString(coldKey.verificationKeyHash()));
        result.put("committee_hot_id", hotKey.id());
        result.put("committee_hot_credential",
                com.bloxbean.cardano.client.util.HexUtil.encodeHexString(hotKey.verificationKeyHash()));
        return result;
    }

    // Typed signing roles (ADR-0016): a validated bit mask, deliberately unordered — witnesses form
    // a set — with a fixed canonical application order so signed outputs are byte-identical across
    // wrappers.
    public static final int ROLE_PAYMENT = 1;
    public static final int ROLE_STAKE = 1 << 1;
    public static final int ROLE_DREP = 1 << 2;
    public static final int ROLE_COMMITTEE_COLD = 1 << 3;
    public static final int ROLE_COMMITTEE_HOT = 1 << 4;
    private static final int ALL_ROLES = ROLE_PAYMENT | ROLE_STAKE | ROLE_DREP
            | ROLE_COMMITTEE_COLD | ROLE_COMMITTEE_HOT;

    /**
     * Signs a transaction with the account keys selected by {@code roleMask}, applied in canonical
     * order (payment, stake, DRep, committee cold, committee hot). The mask must be non-zero and
     * contain no unknown bits — the API never silently signs with every key the account controls.
     *
     * @return the signed transaction as CBOR hex
     * @throws IllegalArgumentException for an empty/unknown mask or blank transaction
     */
    public static String signTx(long handle, String txCborHex, int roleMask) {
        // Handle lookup first: unknown/closed-handle semantics (-11) take precedence over
        // argument validation, matching exportRecoveryPhrase — wrapper recovery keyed on the
        // typed handle error must always trigger.
        Account managed = lookup(handle);
        if (txCborHex == null || txCborHex.isBlank()) {
            throw new IllegalArgumentException("Transaction CBOR hex is required");
        }
        if (roleMask == 0) {
            throw new IllegalArgumentException("Role mask must select at least one signing role");
        }
        if ((roleMask & ~ALL_ROLES) != 0) {
            throw new IllegalArgumentException("Unknown bits in role mask: " + roleMask);
        }
        byte[] txBytes;
        try {
            txBytes = com.bloxbean.cardano.client.util.HexUtil.decodeHexString(txCborHex.trim());
        } catch (IllegalArgumentException e) {
            // Corrupt hex is a corrupt transaction (-9), the same class as valid-hex-bad-CBOR —
            // not an invalid argument (-2).
            throw new IllegalStateException("Transaction signing failed: " + e.getMessage(), e);
        }
        try {
            com.bloxbean.cardano.client.transaction.spec.Transaction tx =
                    com.bloxbean.cardano.client.transaction.spec.Transaction.deserialize(txBytes);
            if ((roleMask & ROLE_PAYMENT) != 0) {
                tx = managed.cclAccount().sign(tx);
            }
            if ((roleMask & ROLE_STAKE) != 0) {
                tx = managed.cclAccount().signWithStakeKey(tx);
            }
            if ((roleMask & ROLE_DREP) != 0) {
                tx = managed.cclAccount().signWithDRepKey(tx);
            }
            if ((roleMask & ROLE_COMMITTEE_COLD) != 0) {
                tx = managed.cclAccount().signWithCommitteeColdKey(tx);
            }
            if ((roleMask & ROLE_COMMITTEE_HOT) != 0) {
                tx = managed.cclAccount().signWithCommitteeHotKey(tx);
            }
            return tx.serializeToHex();
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("Transaction signing failed: " + e.getMessage(), e);
        }
    }

    /** Closes a handle. Idempotent: closing an unknown or already-closed handle is a no-op. */
    public static void close(long handle) {
        accounts.remove(handle);
        pendingRecoveryPhrases.remove(handle);
        infoJsonCache.remove(handle);
    }

    /** Number of currently open handles (test/diagnostic aid). */
    public static int openCount() {
        return accounts.size();
    }

    /** Number of unexported recovery phrases pending (test/diagnostic aid). */
    static int pendingPhraseCount() {
        return pendingRecoveryPhrases.size();
    }

    /** Number of memoized info entries (test/diagnostic aid). */
    static int infoCacheCount() {
        return infoJsonCache.size();
    }

    static Account lookup(long handle) {
        Account managed = accounts.get(handle);
        if (managed == null) {
            throw new UnknownHandleException(handle);
        }
        return managed;
    }
}
