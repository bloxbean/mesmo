import json


class Address:
    """Address namespace for CCL operations."""

    def __init__(self, bridge):
        self._b = bridge

    def info(self, bech32_address):
        """Get address info. Returns dict with type, network_id, credential hashes.

        ``network_id`` is Cardano's genuine **on-chain** network id (1 = mainnet, 0 = testnet). It is
        not the same number as the :class:`mesmo.Network` ordinal used to derive the address, and must
        not be passed back into the ``network`` parameter of the account/wallet/gov calls — the two
        are inverted for mainnet/testnet. See ``ccl/network.py``.
        """
        rc = self._b._lib.mesmo_address_info(self._b._thread, self._b._encode(bech32_address))
        return json.loads(self._b._check(rc))

    def to_bytes(self, bech32_address):
        """Convert bech32 address to hex bytes."""
        rc = self._b._lib.mesmo_address_to_bytes(self._b._thread, self._b._encode(bech32_address))
        return self._b._check(rc)

    def from_bytes(self, hex_bytes):
        """Convert hex bytes to bech32 address."""
        rc = self._b._lib.mesmo_address_from_bytes(self._b._thread, self._b._encode(hex_bytes))
        return self._b._check(rc)

    def validate(self, bech32_address):
        """Validate a bech32 address. Returns True if valid."""
        rc = self._b._lib.mesmo_address_validate(self._b._thread, self._b._encode(bech32_address))
        from mesmo._ffi import MesmoLib
        if rc == MesmoLib.MESMO_SUCCESS:
            return True
        return False
