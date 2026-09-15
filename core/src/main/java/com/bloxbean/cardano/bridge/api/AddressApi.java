package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.ErrorCodes;
import com.bloxbean.cardano.bridge.util.*;
import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressType;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.util.HexUtil;
import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Address entry points: parse, validate, and convert Cardano addresses.
 *
 * <p>Operates on bech32 addresses ({@code addr1...}, {@code addr_test1...}, {@code stake1...}) and
 * their raw byte (hex) form. See {@link com.bloxbean.cardano.bridge.MesmoBridge} for the calling
 * convention. Every entry point here is a static GraalVM {@code @CEntryPoint}.
 */
public final class AddressApi {

    private AddressApi() {}

    /**
     * Parses an address into its components.
     *
     * <p>Exported as {@code mesmo_address_info}. On success the result is a JSON object:
     * <pre>{@code {"type","network_id","payment_credential_hash"?,"delegation_credential_hash"?,
     *  "is_pubkey_payment","is_script_payment"}}</pre>
     * The credential-hash fields are present only when applicable to the address type.
     *
     * @param thread    the current isolate thread
     * @param bech32Ptr the bech32 address (UTF-8 C string)
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_INVALID_ADDRESS}
     */
    @CEntryPoint(name = "mesmo_address_info")
    public static int info(IsolateThread thread, CCharPointer bech32Ptr) {
        try {
            String bech32 = NativeString.toJavaString(bech32Ptr);
            if (bech32 == null || bech32.isEmpty()) {
                ErrorState.set("Address is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            Address address = new Address(bech32);
            Map<String, Object> result = new LinkedHashMap<>();

            AddressType type = address.getAddressType();
            result.put("type", type != null ? type.name() : "Unknown");

            Network network = address.getNetwork();
            result.put("network_id", network != null ? network.getNetworkId() : -1);

            address.getPaymentCredentialHash().ifPresent(hash ->
                result.put("payment_credential_hash", HexUtil.encodeHexString(hash))
            );

            address.getDelegationCredentialHash().ifPresent(hash ->
                result.put("delegation_credential_hash", HexUtil.encodeHexString(hash))
            );

            result.put("is_pubkey_payment", address.isPubKeyHashInPaymentPart());
            result.put("is_script_payment", address.isScriptHashInPaymentPart());

            ResultState.set(JsonHelper.toJson(result));
            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_INVALID_ADDRESS;
        }
    }

    /**
     * Converts a bech32 address to its raw bytes.
     *
     * <p>Exported as {@code mesmo_address_to_bytes}. On success the result is the hex-encoded address
     * bytes.
     *
     * @param thread    the current isolate thread
     * @param bech32Ptr the bech32 address (UTF-8 C string)
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_INVALID_ADDRESS}
     */
    @CEntryPoint(name = "mesmo_address_to_bytes")
    public static int toBytes(IsolateThread thread, CCharPointer bech32Ptr) {
        try {
            String bech32 = NativeString.toJavaString(bech32Ptr);
            if (bech32 == null || bech32.isEmpty()) {
                ErrorState.set("Address is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            Address address = new Address(bech32);
            ResultState.set(HexUtil.encodeHexString(address.getBytes()));
            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_INVALID_ADDRESS;
        }
    }

    /**
     * Converts raw address bytes back to a bech32 address.
     *
     * <p>Exported as {@code mesmo_address_from_bytes}. On success the result is the bech32 address.
     *
     * @param thread      the current isolate thread
     * @param hexBytesPtr the hex-encoded address bytes (UTF-8 C string)
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_INVALID_ADDRESS}
     */
    @CEntryPoint(name = "mesmo_address_from_bytes")
    public static int fromBytes(IsolateThread thread, CCharPointer hexBytesPtr) {
        try {
            String hexBytes = NativeString.toJavaString(hexBytesPtr);
            if (hexBytes == null || hexBytes.isEmpty()) {
                ErrorState.set("Hex bytes are required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            byte[] bytes = HexUtil.decodeHexString(hexBytes);
            Address address = new Address(bytes);
            ResultState.set(address.toBech32());
            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_INVALID_ADDRESS;
        }
    }

    /**
     * Validates an address by attempting to parse it.
     *
     * <p>Exported as {@code mesmo_address_validate}. This reports the result via the status code only
     * (no result string): {@link ErrorCodes#MESMO_SUCCESS} if valid,
     * {@link ErrorCodes#MESMO_ERROR_INVALID_ADDRESS} if not.
     *
     * @param thread    the current isolate thread
     * @param bech32Ptr the bech32 address to validate (UTF-8 C string)
     * @return {@link ErrorCodes#MESMO_SUCCESS} (valid) or {@link ErrorCodes#MESMO_ERROR_INVALID_ADDRESS}
     */
    @CEntryPoint(name = "mesmo_address_validate")
    public static int validate(IsolateThread thread, CCharPointer bech32Ptr) {
        try {
            String bech32 = NativeString.toJavaString(bech32Ptr);
            if (bech32 == null || bech32.isEmpty()) {
                ErrorState.set("Address is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            // Try to parse - if it doesn't throw, it's valid
            new Address(bech32);
            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_INVALID_ADDRESS;
        }
    }
}
