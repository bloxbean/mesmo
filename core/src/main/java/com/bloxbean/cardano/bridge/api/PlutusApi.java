package com.bloxbean.cardano.bridge.api;

import com.bloxbean.cardano.bridge.ErrorCodes;
import com.bloxbean.cardano.bridge.util.ErrorState;
import com.bloxbean.cardano.bridge.util.NativeString;
import com.bloxbean.cardano.bridge.util.ResultState;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.util.HexUtil;
import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;

/**
 * Plutus data (datum/redeemer) entry points: hashing and CBOR&#8596;JSON conversion.
 *
 * <p>The JSON form is CCL's PlutusData JSON schema (constructor/fields/bytes/int/list/map). See
 * {@link com.bloxbean.cardano.bridge.MesmoBridge} for the calling convention. Every entry point here
 * is a static GraalVM {@code @CEntryPoint}.
 */
public final class PlutusApi {

    private PlutusApi() {}

    /**
     * Computes the datum hash of a PlutusData value.
     *
     * <p>Exported as {@code mesmo_plutus_data_hash}. On success the result is the datum hash as hex
     * (the value you place in a transaction output's datum-hash field).
     *
     * @param thread          the current isolate thread
     * @param datumCborHexPtr the PlutusData as CBOR hex
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "mesmo_plutus_data_hash")
    public static int datumHash(IsolateThread thread, CCharPointer datumCborHexPtr) {
        try {
            String datumCborHex = NativeString.toJavaString(datumCborHexPtr);
            if (datumCborHex == null || datumCborHex.isEmpty()) {
                ErrorState.set("Datum CBOR hex is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            byte[] datumBytes = HexUtil.decodeHexString(datumCborHex);
            PlutusData plutusData = PlutusData.deserialize(datumBytes);
            String hash = plutusData.getDatumHash();
            ResultState.set(hash);

            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_SERIALIZATION;
        }
    }

    /**
     * Converts PlutusData CBOR to its JSON representation.
     *
     * <p>Exported as {@code mesmo_plutus_data_to_json}. On success the result is the PlutusData as JSON.
     *
     * @param thread     the current isolate thread
     * @param cborHexPtr the PlutusData as CBOR hex
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "mesmo_plutus_data_to_json")
    public static int toJson(IsolateThread thread, CCharPointer cborHexPtr) {
        try {
            String cborHex = NativeString.toJavaString(cborHexPtr);
            if (cborHex == null || cborHex.isEmpty()) {
                ErrorState.set("CBOR hex is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            byte[] bytes = HexUtil.decodeHexString(cborHex);
            PlutusData plutusData = PlutusData.deserialize(bytes);
            String json = com.bloxbean.cardano.bridge.util.JsonHelper.toJson(plutusData);
            ResultState.set(json);
            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_SERIALIZATION;
        }
    }

    /**
     * Builds PlutusData CBOR from its JSON representation.
     *
     * <p>Exported as {@code mesmo_plutus_data_from_json}. The inverse of
     * {@code mesmo_plutus_data_to_json}: on success the result is the PlutusData as CBOR hex.
     *
     * @param thread  the current isolate thread
     * @param jsonPtr the PlutusData as JSON (UTF-8 C string)
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "mesmo_plutus_data_from_json")
    public static int fromJson(IsolateThread thread, CCharPointer jsonPtr) {
        try {
            String json = NativeString.toJavaString(jsonPtr);
            if (json == null || json.isEmpty()) {
                ErrorState.set("JSON is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            PlutusData plutusData = com.bloxbean.cardano.bridge.util.JsonHelper.fromJson(json, PlutusData.class);
            ResultState.set(plutusData.serializeToHex());
            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_SERIALIZATION;
        }
    }
}
