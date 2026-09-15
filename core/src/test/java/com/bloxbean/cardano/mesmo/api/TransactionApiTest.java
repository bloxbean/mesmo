package com.bloxbean.cardano.mesmo.api;

import com.bloxbean.cardano.mesmo.util.ResultState;
import com.bloxbean.cardano.mesmo.util.ErrorState;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.cbor.CborSerializationUtil;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.transaction.spec.*;
import com.bloxbean.cardano.client.util.HexUtil;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class TransactionApiTest {

    private static final String TEST_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";

    @BeforeEach
    void setUp() {
        ResultState.clear();
        ErrorState.clear();
    }

    @Test
    void testTransactionSerializeDeserialize() throws Exception {
        // Build a simple transaction
        TransactionInput input = new TransactionInput(
            "73198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002",
            1
        );

        TransactionOutput output = TransactionOutput.builder()
            .address("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp")
            .value(new Value(BigInteger.valueOf(2000000), null))
            .build();

        TransactionBody body = TransactionBody.builder()
            .inputs(List.of(input))
            .outputs(List.of(output))
            .fee(BigInteger.valueOf(170000))
            .build();

        Transaction tx = Transaction.builder()
            .body(body)
            .build();

        String cborHex = tx.serializeToHex();
        assertNotNull(cborHex);
        assertTrue(cborHex.length() > 0);

        // Deserialize
        Transaction deserialized = Transaction.deserialize(HexUtil.decodeHexString(cborHex));
        assertNotNull(deserialized);
        assertEquals(1, deserialized.getBody().getInputs().size());
        assertEquals(1, deserialized.getBody().getOutputs().size());
    }

    @Test
    void testTransactionHash() throws Exception {
        TransactionInput input = new TransactionInput(
            "73198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002",
            1
        );

        TransactionOutput output = TransactionOutput.builder()
            .address("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp")
            .value(new Value(BigInteger.valueOf(2000000), null))
            .build();

        TransactionBody body = TransactionBody.builder()
            .inputs(List.of(input))
            .outputs(List.of(output))
            .fee(BigInteger.valueOf(170000))
            .build();

        byte[] bodyBytes = CborSerializationUtil.serialize(body.serialize());
        byte[] hash = Blake2bUtil.blake2bHash256(bodyBytes);
        assertNotNull(hash);
        assertEquals(32, hash.length);
    }

    @Test
    void testTransactionSign() throws Exception {
        TransactionInput input = new TransactionInput(
            "73198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002",
            1
        );

        TransactionOutput output = TransactionOutput.builder()
            .address("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp")
            .value(new Value(BigInteger.valueOf(2000000), null))
            .build();

        TransactionBody body = TransactionBody.builder()
            .inputs(List.of(input))
            .outputs(List.of(output))
            .fee(BigInteger.valueOf(170000))
            .build();

        Transaction tx = Transaction.builder()
            .body(body)
            .build();

        Account account = Account.createFromMnemonic(Networks.testnet(), TEST_MNEMONIC, 0, 0);
        Transaction signedTx = account.sign(tx);

        assertNotNull(signedTx);
        assertNotNull(signedTx.getWitnessSet());
        assertFalse(signedTx.getWitnessSet().getVkeyWitnesses().isEmpty());
    }

    // --- Negative / Error Tests ---

    @Test
    void testDeserializeMalformedCbor() {
        assertThrows(Exception.class, () ->
            Transaction.deserialize(HexUtil.decodeHexString("deadbeef"))
        );
    }

    @Test
    void testDeserializeEmptyCbor() {
        assertThrows(Exception.class, () ->
            Transaction.deserialize(new byte[0])
        );
    }

    @Test
    void testDeserializeInvalidHex() {
        assertThrows(Exception.class, () ->
            Transaction.deserialize(HexUtil.decodeHexString("zzzz"))
        );
    }

    @Test
    void testTransactionHashDeterministic() throws Exception {
        TransactionInput input = new TransactionInput(
            "73198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002",
            1
        );

        TransactionOutput output = TransactionOutput.builder()
            .address("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp")
            .value(new Value(BigInteger.valueOf(2000000), null))
            .build();

        TransactionBody body = TransactionBody.builder()
            .inputs(List.of(input))
            .outputs(List.of(output))
            .fee(BigInteger.valueOf(170000))
            .build();

        byte[] bodyBytes = CborSerializationUtil.serialize(body.serialize());
        byte[] hash1 = Blake2bUtil.blake2bHash256(bodyBytes);
        byte[] hash2 = Blake2bUtil.blake2bHash256(bodyBytes);
        assertArrayEquals(hash1, hash2);
    }
}
