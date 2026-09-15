package com.bloxbean.cardano.mesmo.api;

import com.bloxbean.cardano.mesmo.ErrorCodes;
import com.bloxbean.cardano.mesmo.util.ErrorState;
import com.bloxbean.cardano.mesmo.util.NativeString;
import com.bloxbean.cardano.mesmo.util.ResultState;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.transaction.spec.script.NativeScript;
import com.bloxbean.cardano.client.util.HexUtil;
import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Script entry points: parse native scripts and compute script hashes.
 *
 * <p>See {@link com.bloxbean.cardano.mesmo.Mesmo} for the calling convention. Every entry
 * point here is a static GraalVM {@code @CEntryPoint}.
 */
public final class ScriptApi {

    private ScriptApi() {}

    /**
     * Parses a native script from its JSON form.
     *
     * <p>Exported as {@code mesmo_script_native_from_json}. Accepts the standard native-script JSON
     * (e.g. {@code {"type":"sig","keyHash":"..."}}, {@code all}/{@code any}/{@code atLeast},
     * {@code before}/{@code after}). On success the result is a JSON object:
     * <pre>{@code {"policy_id","script_hash","cbor_hex"}}</pre>
     *
     * @param thread  the current isolate thread
     * @param jsonPtr the native script as JSON (UTF-8 C string)
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "mesmo_script_native_from_json")
    public static int nativeScriptFromJson(IsolateThread thread, CCharPointer jsonPtr) {
        try {
            String json = NativeString.toJavaString(jsonPtr);
            if (json == null || json.isEmpty()) {
                ErrorState.set("JSON is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            NativeScript script = NativeScript.deserializeJson(json);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("policy_id", script.getPolicyId());
            result.put("script_hash", HexUtil.encodeHexString(script.getScriptHash()));
            result.put("cbor_hex", HexUtil.encodeHexString(script.serialize()));

            ResultState.set(com.bloxbean.cardano.mesmo.util.JsonHelper.toJson(result));
            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_SERIALIZATION;
        }
    }

    /**
     * Computes a script hash (policy id) from a script's CBOR.
     *
     * <p>Exported as {@code mesmo_script_hash}. The hash is Blake2b-224 of {@code (typeByte || scriptBytes)},
     * where {@code scriptType} is the language tag: {@code 0}=native, {@code 1}=Plutus V1,
     * {@code 2}=Plutus V2, {@code 3}=Plutus V3. On success the result is the 28-byte hash as hex.
     *
     * @param thread           the current isolate thread
     * @param scriptCborHexPtr the script as CBOR hex
     * @param scriptType       language tag (0=native, 1=PlutusV1, 2=PlutusV2, 3=PlutusV3)
     * @return {@link ErrorCodes#MESMO_SUCCESS}, or {@link ErrorCodes#MESMO_ERROR_SERIALIZATION}
     */
    @CEntryPoint(name = "mesmo_script_hash")
    public static int scriptHash(IsolateThread thread, CCharPointer scriptCborHexPtr, int scriptType) {
        try {
            String scriptCborHex = NativeString.toJavaString(scriptCborHexPtr);
            if (scriptCborHex == null || scriptCborHex.isEmpty()) {
                ErrorState.set("Script CBOR hex is required");
                return ErrorCodes.MESMO_ERROR_INVALID_ARGUMENT;
            }

            byte[] scriptBytes = HexUtil.decodeHexString(scriptCborHex);

            // For all scripts: hash is blake2b-224 of (type_byte || script_bytes)
            byte[] prefixed = new byte[scriptBytes.length + 1];
            prefixed[0] = (byte) scriptType;
            System.arraycopy(scriptBytes, 0, prefixed, 1, scriptBytes.length);
            byte[] hash = Blake2bUtil.blake2bHash224(prefixed);
            ResultState.set(HexUtil.encodeHexString(hash));

            return ErrorCodes.MESMO_SUCCESS;
        } catch (Exception e) {
            ErrorState.set(e.getMessage());
            return ErrorCodes.MESMO_ERROR_SERIALIZATION;
        }
    }
}
