package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.util.ResultState;
import com.bloxbean.cardano.bridge.util.ErrorState;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.MnemonicUtil;
import com.bloxbean.cardano.client.crypto.bip39.Words;
import com.bloxbean.cardano.client.crypto.config.CryptoConfiguration;
import com.bloxbean.cardano.client.util.HexUtil;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class CryptoApiTest {

    @BeforeEach
    void setUp() {
        ResultState.clear();
        ErrorState.clear();
    }

    @Test
    void testBlake2b256() {
        byte[] data = "hello".getBytes();
        byte[] hash = Blake2bUtil.blake2bHash256(data);
        assertNotNull(hash);
        assertEquals(32, hash.length);
    }

    @Test
    void testBlake2b224() {
        byte[] data = "hello".getBytes();
        byte[] hash = Blake2bUtil.blake2bHash224(data);
        assertNotNull(hash);
        assertEquals(28, hash.length);
    }

    @Test
    void testGenerateMnemonic24() {
        String mnemonic = MnemonicUtil.generateNew(Words.TWENTY_FOUR);
        assertNotNull(mnemonic);
        String[] words = mnemonic.split(" ");
        assertEquals(24, words.length);
    }

    @Test
    void testGenerateMnemonic12() {
        String mnemonic = MnemonicUtil.generateNew(Words.TWELVE);
        assertNotNull(mnemonic);
        String[] words = mnemonic.split(" ");
        assertEquals(12, words.length);
    }

    @Test
    void testValidateMnemonic() {
        String mnemonic = MnemonicUtil.generateNew(Words.TWENTY_FOUR);
        assertDoesNotThrow(() -> MnemonicUtil.validateMnemonic(mnemonic));
    }

    @Test
    void testInvalidMnemonic() {
        assertThrows(Exception.class, () ->
            MnemonicUtil.validateMnemonic("invalid mnemonic phrase that is not valid at all")
        );
    }

    @Test
    void testSignAndVerify() {
        // Generate a key pair from an account (uses BIP32-ED25519 extended 64-byte keys)
        com.bloxbean.cardano.client.account.Account account =
            new com.bloxbean.cardano.client.account.Account(
                com.bloxbean.cardano.client.common.model.Networks.mainnet());

        byte[] message = "test message".getBytes();
        byte[] privateKey = account.privateKeyBytes();
        byte[] publicKey = account.publicKeyBytes();

        // Use signExtended for BIP32-ED25519 extended private keys (64 bytes)
        byte[] signature = CryptoConfiguration.INSTANCE.getSigningProvider().signExtended(message, privateKey);
        assertNotNull(signature);
        assertEquals(64, signature.length);

        boolean valid = CryptoConfiguration.INSTANCE.getSigningProvider().verify(signature, message, publicKey);
        assertTrue(valid);
    }

    @Test
    void testVerifyWithWrongKey() {
        com.bloxbean.cardano.client.account.Account account1 =
            new com.bloxbean.cardano.client.account.Account(
                com.bloxbean.cardano.client.common.model.Networks.mainnet());
        com.bloxbean.cardano.client.account.Account account2 =
            new com.bloxbean.cardano.client.account.Account(
                com.bloxbean.cardano.client.common.model.Networks.mainnet());

        byte[] message = "test message".getBytes();
        byte[] signature = CryptoConfiguration.INSTANCE.getSigningProvider().signExtended(message, account1.privateKeyBytes());
        boolean valid = CryptoConfiguration.INSTANCE.getSigningProvider().verify(signature, message, account2.publicKeyBytes());
        assertFalse(valid);
    }

    // --- Negative / Error Tests ---

    @Test
    void testBlake2b256EmptyInput() {
        byte[] hash = Blake2bUtil.blake2bHash256(new byte[0]);
        assertNotNull(hash);
        assertEquals(32, hash.length);
    }

    @Test
    void testBlake2b224EmptyInput() {
        byte[] hash = Blake2bUtil.blake2bHash224(new byte[0]);
        assertNotNull(hash);
        assertEquals(28, hash.length);
    }

    @Test
    void testValidateMnemonicWithGibberish() {
        assertThrows(Exception.class, () ->
            MnemonicUtil.validateMnemonic("zzz xxx yyy www vvv uuu ttt sss rrr qqq ppp ooo")
        );
    }

    @Test
    void testValidateEmptyMnemonic() {
        assertThrows(Exception.class, () ->
            MnemonicUtil.validateMnemonic("")
        );
    }

    @Test
    void testVerifyWithWrongMessage() {
        com.bloxbean.cardano.client.account.Account account =
            new com.bloxbean.cardano.client.account.Account(
                com.bloxbean.cardano.client.common.model.Networks.mainnet());

        byte[] message = "original message".getBytes();
        byte[] wrongMessage = "tampered message".getBytes();
        byte[] signature = CryptoConfiguration.INSTANCE.getSigningProvider().signExtended(message, account.privateKeyBytes());
        boolean valid = CryptoConfiguration.INSTANCE.getSigningProvider().verify(signature, wrongMessage, account.publicKeyBytes());
        assertFalse(valid);
    }

    // --- Extended-key signing: the derive_key -> sign -> verify contract ---
    //
    // A CIP-1852-derived private key is a 64-byte BIP32-Ed25519 EXTENDED key: its first half (kL)
    // is already the final, clamped scalar. Signing must therefore use signExtended — feeding kL
    // to the seed-based sign() re-hashes and re-clamps it, producing a signature under a
    // DIFFERENT keypair. These tests pin both directions so the documented workflow
    // (derive_key -> ccl_crypto_sign with the whole 64-byte key -> ccl_crypto_verify against the
    // returned public_key) can never silently regress again.

    private com.bloxbean.cardano.client.crypto.bip32.HdKeyPair deriveTestKeyPair() {
        String mnemonic = MnemonicUtil.generateNew(Words.TWENTY_FOUR);
        var path = com.bloxbean.cardano.client.crypto.cip1852.DerivationPath.createExternalAddressDerivationPath(0);
        return new com.bloxbean.cardano.client.crypto.cip1852.CIP1852().getKeyPairFromMnemonic(mnemonic, path);
    }

    @Test
    void extendedKeySignatureVerifiesAgainstDerivedPublicKey() {
        var keyPair = deriveTestKeyPair();
        byte[] extendedKey = keyPair.getPrivateKey().getKeyData(); // 64 bytes: kL || kR
        byte[] publicKey = keyPair.getPublicKey().getKeyData();    // 32 bytes: kL·B
        byte[] message = "hello".getBytes();
        assertEquals(64, extendedKey.length, "CIP-1852 private keys are extended (64-byte) keys");

        var provider = CryptoConfiguration.INSTANCE.getSigningProvider();
        byte[] signature = provider.signExtended(message, extendedKey);

        assertTrue(provider.verify(signature, message, publicKey),
                "signExtended output must verify against the derived public key");
    }

    @Test
    void seedSigningWithHalfAnExtendedKeyDoesNotVerify_theBugTheDispatchPrevents() {
        var keyPair = deriveTestKeyPair();
        byte[] extendedKey = keyPair.getPrivateKey().getKeyData();
        byte[] publicKey = keyPair.getPublicKey().getKeyData();
        byte[] kL = java.util.Arrays.copyOfRange(extendedKey, 0, 32);
        byte[] message = "hello".getBytes();

        var provider = CryptoConfiguration.INSTANCE.getSigningProvider();
        byte[] wrongSignature = provider.sign(message, kL); // treats the clamped scalar as a seed

        assertFalse(provider.verify(wrongSignature, message, publicKey),
                "kL fed to the seed path signs under a different keypair — if this ever verifies, "
                        + "the seed/extended distinction has changed and the dispatch must be revisited");
    }

    @Test
    void seedSignatureStillVerifiesAgainstItsOwnPublicKey() {
        // The 32-byte seed path is unchanged: a genuine seed round-trips.
        byte[] seed = new byte[32];
        new java.security.SecureRandom().nextBytes(seed);
        byte[] message = "hello".getBytes();

        var provider = CryptoConfiguration.INSTANCE.getSigningProvider();
        byte[] signature = provider.sign(message, seed);
        byte[] publicKey = com.bloxbean.cardano.client.crypto.KeyGenUtil.getPublicKeyFromPrivateKey(seed);

        assertTrue(provider.verify(signature, message, publicKey),
                "seed-based signing must verify against the seed's derived public key");
    }

    @Test
    void governanceRolesCarryCip105Bech32Encodings() {
        // Pins the CIP-105 prefixes derive_key exposes for governance roles; if CCL ever changes
        // these encodings, the wrappers' registration workflows change with them — fail loudly.
        var keyPair = deriveTestKeyPair();
        assertTrue(com.bloxbean.cardano.client.governance.keys.DRepKey.from(keyPair)
                .bech32VerificationKey().startsWith("drep_vk1"));
        assertTrue(com.bloxbean.cardano.client.governance.keys.DRepKey.from(keyPair)
                .bech32VerificationKeyHash().startsWith("drep_vkh1"));
        assertTrue(com.bloxbean.cardano.client.governance.keys.CommitteeColdKey.from(keyPair)
                .bech32VerificationKeyHash().startsWith("cc_cold_vkh1"));
        assertTrue(com.bloxbean.cardano.client.governance.keys.CommitteeHotKey.from(keyPair)
                .bech32VerificationKeyHash().startsWith("cc_hot_vkh1"));
    }
}
