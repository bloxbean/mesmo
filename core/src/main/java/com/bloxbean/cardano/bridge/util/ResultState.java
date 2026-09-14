package com.bloxbean.cardano.bridge.util;

/**
 * Thread-local transport for a call's result string, consumed by {@code ccl_get_result}.
 *
 * <p><b>Consumptive (ADR-0016):</b> {@link #get()} removes the value as it returns it, so a
 * secret-bearing result (a generated mnemonic, an exported private key) cannot linger as the
 * thread's "current result" after the wrapper has parsed it. Callers already read exactly once per
 * call by the calling convention; a second read now yields {@code null} instead of a stale value.
 */
public final class ResultState {

    private static final ThreadLocal<String> lastResult = new ThreadLocal<>();

    private ResultState() {}

    public static void set(String result) {
        lastResult.set(result);
    }

    /** Returns the pending result and removes it — read-once. */
    public static String get() {
        String result = lastResult.get();
        lastResult.remove();
        return result;
    }

    public static void clear() {
        lastResult.remove();
    }
}
