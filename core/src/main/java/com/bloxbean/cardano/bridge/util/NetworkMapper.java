package com.bloxbean.cardano.bridge.util;

import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;

public final class NetworkMapper {

    public static final int MAINNET = 0;
    public static final int TESTNET = 1;

    private NetworkMapper() {}

    public static Network toNetwork(int networkId) {
        switch (networkId) {
            case MAINNET:
                return Networks.mainnet();
            case TESTNET:
                return Networks.testnet();
            default:
                return null;
        }
    }
}
