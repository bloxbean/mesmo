import json


class Script:
    """Script namespace for CCL operations."""

    def __init__(self, bridge):
        self._b = bridge

    def native_from_json(self, json_str):
        """Parse native script from JSON. Returns JSON string with policy_id, script_hash, cbor_hex."""
        if isinstance(json_str, dict):
            json_str = json.dumps(json_str)
        rc = self._b._lib.mesmo_script_native_from_json(self._b._thread, self._b._encode(json_str))
        return self._b._check(rc)

    def hash(self, script_cbor_hex, script_type=0):
        """Compute script hash from CBOR hex. Returns hex string."""
        rc = self._b._lib.mesmo_script_hash(
            self._b._thread, self._b._encode(script_cbor_hex), script_type)
        return self._b._check(rc)
