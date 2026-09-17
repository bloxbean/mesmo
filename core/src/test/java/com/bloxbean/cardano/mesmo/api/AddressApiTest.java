package com.bloxbean.cardano.mesmo.api;

import com.bloxbean.cardano.mesmo.util.ResultState;
import com.bloxbean.cardano.mesmo.util.ErrorState;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressType;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.util.HexUtil;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class AddressApiTest {

    private static final String TEST_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";

    @BeforeEach
    void setUp() {
        ResultState.clear();
        ErrorState.clear();
    }

    @Test
    void testAddressInfo() {
        Account account = Account.createFromMnemonic(Networks.mainnet(), TEST_MNEMONIC, 0, 0);
        Address address = new Address(account.baseAddress());

        assertEquals(AddressType.Base, address.getAddressType());
        assertEquals(1, address.getNetwork().getNetworkId());
        assertTrue(address.getPaymentCredentialHash().isPresent());
        assertTrue(address.getDelegationCredentialHash().isPresent());
    }

    @Test
    void testAddressToAndFromBytes() {
        Account account = Account.createFromMnemonic(Networks.mainnet(), TEST_MNEMONIC, 0, 0);
        String bech32 = account.baseAddress();

        Address address = new Address(bech32);
        byte[] bytes = address.getBytes();
        assertNotNull(bytes);
        assertTrue(bytes.length > 0);

        Address restored = new Address(bytes);
        assertEquals(bech32, restored.toBech32());
    }

    @Test
    void testAddressValidation() {
        Account account = Account.createFromMnemonic(Networks.mainnet(), TEST_MNEMONIC, 0, 0);

        // Valid address - should not throw
        assertDoesNotThrow(() -> new Address(account.baseAddress()));
    }

    @Test
    void testEnterpriseAddress() {
        Account account = Account.createFromMnemonic(Networks.mainnet(), TEST_MNEMONIC, 0, 0);
        Address address = new Address(account.enterpriseAddress());

        assertEquals(AddressType.Enterprise, address.getAddressType());
        assertTrue(address.getPaymentCredentialHash().isPresent());
    }

    @Test
    void testStakeAddress() {
        Account account = Account.createFromMnemonic(Networks.mainnet(), TEST_MNEMONIC, 0, 0);
        Address address = new Address(account.stakeAddress());

        assertEquals(AddressType.Reward, address.getAddressType());
    }

    // --- Negative / Error Tests ---

    @Test
    void testInvalidBech32Address() {
        assertThrows(Exception.class, () -> new Address("not_a_valid_bech32_address"));
    }

    @Test
    void testEmptyAddressBytes() {
        assertThrows(Exception.class, () -> new Address(new byte[0]));
    }

    @Test
    void testMalformedHexBytes() {
        assertThrows(Exception.class, () ->
            new Address(HexUtil.decodeHexString("deadbeef"))
        );
    }
}
