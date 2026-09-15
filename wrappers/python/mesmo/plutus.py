import json


class Plutus:
    """Plutus namespace for CCL operations."""

    def __init__(self, bridge):
        self._b = bridge

    def data_hash(self, datum_cbor_hex):
        """Compute datum hash from CBOR hex. Returns hex string."""
        rc = self._b._lib.mesmo_plutus_data_hash(self._b._thread, self._b._encode(datum_cbor_hex))
        return self._b._check(rc)

    def data_to_json(self, cbor_hex):
        """Convert PlutusData CBOR to JSON string."""
        rc = self._b._lib.mesmo_plutus_data_to_json(self._b._thread, self._b._encode(cbor_hex))
        return self._b._check(rc)

    def data_from_json(self, json_str):
        """Convert PlutusData JSON to CBOR hex."""
        if isinstance(json_str, dict):
            json_str = json.dumps(json_str)
        rc = self._b._lib.mesmo_plutus_data_from_json(self._b._thread, self._b._encode(json_str))
        return self._b._check(rc)
