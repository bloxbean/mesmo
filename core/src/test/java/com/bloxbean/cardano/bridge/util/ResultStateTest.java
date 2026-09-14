package com.bloxbean.cardano.bridge.util;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The result channel is consumptive (ADR-0016): a read removes the value, so secret-bearing
 * results cannot linger as the thread's "current result" after the wrapper has parsed them.
 */
class ResultStateTest {

    @Test
    void getConsumesTheResult() {
        ResultState.set("secret-bearing result");
        assertEquals("secret-bearing result", ResultState.get());
        assertNull(ResultState.get(), "second read must find nothing — read-once");
    }

    @Test
    void setReplacesUnreadValue() {
        ResultState.set("first");
        ResultState.set("second");
        assertEquals("second", ResultState.get());
        assertNull(ResultState.get());
    }
}
