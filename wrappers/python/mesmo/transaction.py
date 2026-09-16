import json


class Transaction:
    """Transaction (tx) namespace for CCL operations."""

    def __init__(self, lib):
        self._b = lib

    def hash(self, tx_cbor_hex):
        """Get transaction hash (blake2b-256 of body). Returns hex string."""
        rc = self._b._lib.mesmo_tx_hash(self._b._thread, self._b._encode(tx_cbor_hex))
        return self._b._check(rc)

    def sign_with_secret_key(self, tx_cbor_hex, sk_cbor_hex):
        """Sign transaction with a secret key. Returns signed tx CBOR hex."""
        rc = self._b._lib.mesmo_tx_sign_with_secret_key(
            self._b._thread, self._b._encode(tx_cbor_hex), self._b._encode(sk_cbor_hex))
        return self._b._check(rc)

    def to_json(self, tx_cbor_hex):
        """Convert transaction CBOR to JSON representation."""
        rc = self._b._lib.mesmo_tx_to_json(self._b._thread, self._b._encode(tx_cbor_hex))
        return json.loads(self._b._check(rc))

    def from_json(self, tx_json):
        """Convert transaction JSON to CBOR hex."""
        if isinstance(tx_json, dict):
            tx_json = json.dumps(tx_json)
        rc = self._b._lib.mesmo_tx_from_json(self._b._thread, self._b._encode(tx_json))
        return self._b._check(rc)

    def deserialize(self, tx_cbor_hex):
        """Deserialize transaction CBOR hex to JSON dict."""
        rc = self._b._lib.mesmo_tx_deserialize(self._b._thread, self._b._encode(tx_cbor_hex))
        return json.loads(self._b._check(rc))
