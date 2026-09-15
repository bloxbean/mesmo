package com.bloxbean.cardano.mesmo.api.quicktx;

import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.common.OrderEnum;
import com.bloxbean.cardano.client.api.model.Utxo;

import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * A UtxoSupplier backed by a pre-supplied list of UTXOs.
 * Used for offline transaction building where UTXOs are provided
 * by the caller rather than fetched from a backend.
 */
public class StaticUtxoSupplier implements UtxoSupplier {

    private final List<Utxo> utxos;

    public StaticUtxoSupplier(List<Utxo> utxos) {
        this.utxos = utxos != null ? utxos : Collections.emptyList();
    }

    @Override
    public List<Utxo> getPage(String address, Integer nrOfItems, Integer page, OrderEnum order) {
        List<Utxo> filtered = utxos.stream()
                .filter(u -> address == null || address.equals(u.getAddress()))
                .collect(Collectors.toList());

        if (order == OrderEnum.desc) {
            Collections.reverse(filtered);
        }

        int pageSize = (nrOfItems != null && nrOfItems > 0) ? nrOfItems : 100;
        int pageNum = (page != null && page >= 0) ? page : 0;
        int fromIndex = pageNum * pageSize;

        if (fromIndex >= filtered.size()) {
            return Collections.emptyList();
        }

        int toIndex = Math.min(fromIndex + pageSize, filtered.size());
        return filtered.subList(fromIndex, toIndex);
    }

    @Override
    public Optional<Utxo> getTxOutput(String txHash, int outputIndex) {
        return utxos.stream()
                .filter(u -> txHash.equals(u.getTxHash()) && u.getOutputIndex() == outputIndex)
                .findFirst();
    }
}
