package com.bloxbean.cardano.mesmo.util;

public final class ErrorState {

    private static final ThreadLocal<String> lastError = new ThreadLocal<>();

    private ErrorState() {}

    public static void set(String message) {
        lastError.set(message);
    }

    public static String get() {
        return lastError.get();
    }

    public static void clear() {
        lastError.remove();
    }
}
