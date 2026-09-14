package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.ErrorCodes;
import com.bloxbean.cardano.bridge.util.ErrorState;
import com.bloxbean.cardano.bridge.util.JsonHelper;
import com.bloxbean.cardano.bridge.util.NativeString;
import com.bloxbean.cardano.bridge.util.ResultState;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.MnemonicUtil;
import com.bloxbean.cardano.client.crypto.bip39.Words;
import com.bloxbean.cardano.client.crypto.cip1852.CIP1852;
import com.bloxbean.cardano.client.crypto.cip1852.DerivationPath;
import com.bloxbean.cardano.client.crypto.cip1852.Segment;
import com.bloxbean.cardano.client.crypto.config.CryptoConfiguration;
import com.bloxbean.cardano.client.util.HexUtil;

import java.util.LinkedHashMap;
import java.util.Map;
import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;

/**
 * Cryptographic primitives: Blake2b hashing, BIP-39 mnemonics, and Ed25519 sign/verify.
 *
 * <p>Hashing and signing take/return <em>hex-encoded</em> bytes. See
 * {@link com.bloxbean.cardano.bridge.CclBridge} for the calling convention. Every entry point here
 * is a static GraalVM {@code @CEntryPoint}.
 */
public final class CryptoApi {

    private CryptoApi() {}

    /**
     * Computes a Blake2b-256 hash.
     *
     * <p>Exported as {@code ccl_crypto_blake2b_256}. Hex in, hex out; the result is a 32-byte digest
     * (64 hex chars).
     *
     * @param thread     the current isolate thread
     * @param dataHexPtr the input bytes as hex (UTF-8 C string)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_CRYPTO}
     */
    @CEntryPoint(name = "ccl_crypto_blake2b_256")
    public static int blake2b256(IsolateThread thread, CCharPointer dataHexPtr) {
        try {
            String dataHex = NativeString.toJavaString(dataHexPtr);
            if (dataHex == null || dataHex.isEmpty()) {
                ErrorState.set("Data hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            byte[] data = HexUtil.decodeHexString(dataHex);
            byte[] hash = Blake2bUtil.blake2bHash256(data);
            ResultState.set(HexUtil.encodeHexString(hash));
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_CRYPTO;
        }
    }

    /**
     * Computes a Blake2b-224 hash (the size used for Cardano credential/key hashes).
     *
     * <p>Exported as {@code ccl_crypto_blake2b_224}. Hex in, hex out; the result is a 28-byte digest
     * (56 hex chars).
     *
     * @param thread     the current isolate thread
     * @param dataHexPtr the input bytes as hex (UTF-8 C string)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_CRYPTO}
     */
    @CEntryPoint(name = "ccl_crypto_blake2b_224")
    public static int blake2b224(IsolateThread thread, CCharPointer dataHexPtr) {
        try {
            String dataHex = NativeString.toJavaString(dataHexPtr);
            if (dataHex == null || dataHex.isEmpty()) {
                ErrorState.set("Data hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            byte[] data = HexUtil.decodeHexString(dataHex);
            byte[] hash = Blake2bUtil.blake2bHash224(data);
            ResultState.set(HexUtil.encodeHexString(hash));
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_CRYPTO;
        }
    }

    /**
     * Generates a new BIP-39 mnemonic.
     *
     * <p>Exported as {@code ccl_crypto_generate_mnemonic}. On success the result is the
     * space-separated mnemonic phrase.
     *
     * @param thread    the current isolate thread
     * @param wordCount number of words: 12, 15, 18, 21, or 24
     * @return {@link ErrorCodes#CCL_SUCCESS}, {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT}
     *         (bad word count), or {@link ErrorCodes#CCL_ERROR_CRYPTO}
     */
    @CEntryPoint(name = "ccl_crypto_generate_mnemonic")
    public static int generateMnemonic(IsolateThread thread, int wordCount) {
        try {
            Words words;
            switch (wordCount) {
                case 12: words = Words.TWELVE; break;
                case 15: words = Words.FIFTEEN; break;
                case 18: words = Words.EIGHTEEN; break;
                case 21: words = Words.TWENTY_ONE; break;
                case 24: words = Words.TWENTY_FOUR; break;
                default:
                    ErrorState.set("Invalid word count. Must be 12, 15, 18, 21, or 24");
                    return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            String mnemonic = MnemonicUtil.generateNew(words);
            ResultState.set(mnemonic);

            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_CRYPTO;
        }
    }

    /**
     * Validates a BIP-39 mnemonic (word list and checksum).
     *
     * <p>Exported as {@code ccl_crypto_validate_mnemonic}. Reported via the status code only (no
     * result string).
     *
     * @param thread      the current isolate thread
     * @param mnemonicPtr the mnemonic phrase to validate (UTF-8 C string)
     * @return {@link ErrorCodes#CCL_SUCCESS} (valid) or {@link ErrorCodes#CCL_ERROR_INVALID_MNEMONIC}
     */
    @CEntryPoint(name = "ccl_crypto_validate_mnemonic")
    public static int validateMnemonic(IsolateThread thread, CCharPointer mnemonicPtr) {
        try {
            String mnemonic = NativeString.toJavaString(mnemonicPtr);
            if (mnemonic == null || mnemonic.isEmpty()) {
                ErrorState.set("Mnemonic is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            MnemonicUtil.validateMnemonic(mnemonic);
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_INVALID_MNEMONIC;
        }
    }

    /**
     * Produces an Ed25519 signature. The key form is dispatched on length:
     *
     * <ul>
     *   <li><b>32 bytes (64 hex chars)</b> — a standard Ed25519 <em>seed</em>: it is SHA-512
     *       hashed and clamped per RFC 8032 before signing.</li>
     *   <li><b>64 bytes (128 hex chars)</b> — a BIP32-Ed25519 <em>extended</em> key (kL‖kR), as
     *       returned by {@code ccl_crypto_derive_key}: kL is already the final clamped scalar, so
     *       CCL's {@code signExtended} is used. Never pass the first half of an extended key as a
     *       seed — the clamping would be applied twice and the signature would verify against a
     *       different public key.</li>
     * </ul>
     *
     * <p>Exported as {@code ccl_crypto_sign}. On success the result is the hex-encoded 64-byte
     * signature, verifiable with {@code ccl_crypto_verify} against the key's public key.
     *
     * @param thread        the current isolate thread
     * @param messageHexPtr the message bytes as hex (UTF-8 C string)
     * @param skHexPtr      the secret key as hex: 64 hex chars (seed) or 128 hex chars (extended)
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT} /
     *         {@link ErrorCodes#CCL_ERROR_CRYPTO}
     */
    @CEntryPoint(name = "ccl_crypto_sign")
    public static int sign(IsolateThread thread, CCharPointer messageHexPtr, CCharPointer skHexPtr) {
        try {
            String messageHex = NativeString.toJavaString(messageHexPtr);
            String skHex = NativeString.toJavaString(skHexPtr);

            if (messageHex == null || messageHex.isEmpty()) {
                ErrorState.set("Message hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            if (skHex == null || skHex.isEmpty()) {
                ErrorState.set("Secret key hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            byte[] message = HexUtil.decodeHexString(messageHex);
            byte[] sk = HexUtil.decodeHexString(skHex);
            byte[] signature;
            if (sk.length == 32) {
                // Standard Ed25519 seed: hashed + clamped by the provider.
                signature = CryptoConfiguration.INSTANCE.getSigningProvider().sign(message, sk);
            } else if (sk.length == 64) {
                // BIP32-Ed25519 extended key (kL already clamped): must NOT re-derive the scalar.
                signature = CryptoConfiguration.INSTANCE.getSigningProvider().signExtended(message, sk);
            } else {
                ErrorState.set("Secret key must be 32 bytes (Ed25519 seed) or 64 bytes "
                        + "(BIP32-Ed25519 extended key); got " + sk.length + " bytes");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            ResultState.set(HexUtil.encodeHexString(signature));
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_CRYPTO;
        }
    }

    /**
     * Verifies an Ed25519 signature.
     *
     * <p>Exported as {@code ccl_crypto_verify}. Reported via the status code only:
     * {@link ErrorCodes#CCL_SUCCESS} if the signature is valid,
     * {@link ErrorCodes#CCL_ERROR_CRYPTO} if it is not.
     *
     * @param thread          the current isolate thread
     * @param signatureHexPtr the 64-byte signature as hex (UTF-8 C string)
     * @param messageHexPtr   the message bytes as hex (UTF-8 C string)
     * @param pkHexPtr        the 32-byte Ed25519 public key as hex (UTF-8 C string)
     * @return {@link ErrorCodes#CCL_SUCCESS} (valid) or {@link ErrorCodes#CCL_ERROR_CRYPTO}
     */
    @CEntryPoint(name = "ccl_crypto_verify")
    public static int verify(IsolateThread thread, CCharPointer signatureHexPtr,
                             CCharPointer messageHexPtr, CCharPointer pkHexPtr) {
        try {
            String signatureHex = NativeString.toJavaString(signatureHexPtr);
            String messageHex = NativeString.toJavaString(messageHexPtr);
            String pkHex = NativeString.toJavaString(pkHexPtr);

            if (signatureHex == null || signatureHex.isEmpty()) {
                ErrorState.set("Signature hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            if (messageHex == null || messageHex.isEmpty()) {
                ErrorState.set("Message hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            if (pkHex == null || pkHex.isEmpty()) {
                ErrorState.set("Public key hex is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }

            byte[] signature = HexUtil.decodeHexString(signatureHex);
            byte[] message = HexUtil.decodeHexString(messageHex);
            byte[] pk = HexUtil.decodeHexString(pkHex);
            boolean valid = CryptoConfiguration.INSTANCE.getSigningProvider().verify(signature, message, pk);

            if (valid) {
                return ErrorCodes.CCL_SUCCESS;
            } else {
                ErrorState.set("Signature verification failed");
                return ErrorCodes.CCL_ERROR_CRYPTO;
            }
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_CRYPTO;
        }
    }

    // CIP-1852 role indices accepted by ccl_crypto_derive_key.
    private static final Map<String, Integer> DERIVE_ROLES = Map.of(
            "payment", 0,
            "change", 1,
            "stake", 2,
            "drep", 3,
            "committee_cold", 4,
            "committee_hot", 5);

    /**
     * Stateless CIP-1852 key derivation: mnemonic in, one role's key pair out. This is the explicit
     * "give me raw key material" utility — deliberately a pure crypto function, not an operation on
     * a managed account handle (handles sign; they never hand out key bytes).
     *
     * <p>Exported as {@code ccl_crypto_derive_key}. On success the result is a JSON object:
     * <pre>{@code {"path","private_key","public_key","public_key_hash"}}</pre>
     * For the governance roles ({@code drep}, {@code committee_cold}, {@code committee_hot}) the
     * result additionally carries the CIP-105 bech32 encodings {@code bech32_verification_key}
     * ({@code drep_vk1…}/{@code cc_cold_vk1…}/{@code cc_hot_vk1…}) and
     * {@code bech32_verification_key_hash} ({@code …_vkh1…}) — the forms cardano-cli and GovTool
     * accept for registration.
     * {@code private_key} is the hex-encoded 64-byte extended BIP32-Ed25519 private key — pass it
     * <b>whole</b> to {@code ccl_crypto_sign} (which detects the extended form by length); its
     * first half is a clamped scalar, not a seed, and must never be used as one;
     * {@code public_key} is the 32-byte verification key; {@code public_key_hash} its blake2b-224
     * hash — for the committee roles this is the credential used in committee certificates.
     *
     * <p>Key derivation is network-independent, so no network id is taken. Use {@code addressIndex}
     * 0 for the stake/drep/committee roles (their conventional CIP-1852 leaf).
     *
     * @param thread       the current isolate thread
     * @param mnemonicPtr  the BIP-39 mnemonic phrase (UTF-8 C string)
     * @param accountIndex HD account index (hardened)
     * @param addressIndex HD address index within the role
     * @param rolePtr      one of {@code payment}, {@code change}, {@code stake}, {@code drep},
     *                     {@code committee_cold}, {@code committee_hot}
     * @return {@link ErrorCodes#CCL_SUCCESS}, or {@link ErrorCodes#CCL_ERROR_INVALID_ARGUMENT} /
     *         {@link ErrorCodes#CCL_ERROR_INVALID_MNEMONIC} / {@link ErrorCodes#CCL_ERROR_CRYPTO}
     */
    @CEntryPoint(name = "ccl_crypto_derive_key")
    public static int deriveKey(IsolateThread thread, CCharPointer mnemonicPtr,
                                int accountIndex, int addressIndex, CCharPointer rolePtr) {
        try {
            String mnemonic = NativeString.toJavaString(mnemonicPtr);
            if (mnemonic == null || mnemonic.isEmpty()) {
                ErrorState.set("Mnemonic is required");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            String role = NativeString.toJavaString(rolePtr);
            Integer roleIndex = role == null ? null : DERIVE_ROLES.get(role);
            if (roleIndex == null) {
                ErrorState.set("Unknown role: " + role + " (expected one of "
                        + String.join(", ", DERIVE_ROLES.keySet().stream().sorted().toList()) + ")");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            if (accountIndex < 0 || addressIndex < 0) {
                ErrorState.set("Account and address indices must be >= 0");
                return ErrorCodes.CCL_ERROR_INVALID_ARGUMENT;
            }
            try {
                MnemonicUtil.validateMnemonic(mnemonic);
            } catch (Exception e) {
                ErrorState.set("Invalid mnemonic: " + e.getMessage());
                return ErrorCodes.CCL_ERROR_INVALID_MNEMONIC;
            }

            DerivationPath path = DerivationPath.builder()
                    .purpose(new Segment(1852, true))
                    .coinType(new Segment(1815, true))
                    .account(new Segment(accountIndex, true))
                    .role(new Segment(roleIndex, false))
                    .index(new Segment(addressIndex, false))
                    .build();
            var keyPair = new CIP1852().getKeyPairFromMnemonic(mnemonic, path);
            byte[] publicKey = keyPair.getPublicKey().getKeyData();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("path", "m/1852'/1815'/" + accountIndex + "'/" + roleIndex + "/" + addressIndex);
            result.put("private_key", HexUtil.encodeHexString(keyPair.getPrivateKey().getKeyData()));
            result.put("public_key", HexUtil.encodeHexString(publicKey));
            result.put("public_key_hash", HexUtil.encodeHexString(Blake2bUtil.blake2bHash224(publicKey)));
            // CIP-105 bech32 encodings for the governance roles — the forms cardano-cli and
            // GovTool take for DRep/committee registration. Non-governance roles have no
            // CIP-105 key encoding, so the fields are deliberately absent there.
            switch (role) {
                case "drep" -> {
                    var k = com.bloxbean.cardano.client.governance.keys.DRepKey.from(keyPair);
                    result.put("bech32_verification_key", k.bech32VerificationKey());
                    result.put("bech32_verification_key_hash", k.bech32VerificationKeyHash());
                }
                case "committee_cold" -> {
                    var k = com.bloxbean.cardano.client.governance.keys.CommitteeColdKey.from(keyPair);
                    result.put("bech32_verification_key", k.bech32VerificationKey());
                    result.put("bech32_verification_key_hash", k.bech32VerificationKeyHash());
                }
                case "committee_hot" -> {
                    var k = com.bloxbean.cardano.client.governance.keys.CommitteeHotKey.from(keyPair);
                    result.put("bech32_verification_key", k.bech32VerificationKey());
                    result.put("bech32_verification_key_hash", k.bech32VerificationKeyHash());
                }
                default -> { /* payment/change/stake: no CIP-105 encoding */ }
            }
            ResultState.set(JsonHelper.toJson(result));
            return ErrorCodes.CCL_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.CCL_ERROR_CRYPTO;
        }
    }
}
