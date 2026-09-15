import pytest


def test_plutus_data_hash(ccl):
    # Integer 42 in CBOR is "182a"
    datum_cbor_hex = "182a"
    hash_result = ccl.plutus.data_hash(datum_cbor_hex)
    assert len(hash_result) == 64  # 32 bytes = 64 hex chars
    assert hash_result == "9e1199a988ba72ffd6e9c269cadb3b53b5f360ff99f112d9b2ee30c4d74ad88b"


@pytest.mark.skip(reason="plutus_data_to_json has GraalVM reflection config issue with BigIntDataJsonSerializer")
def test_plutus_data_to_json(ccl):
    datum_cbor_hex = "182a"
    json_str = ccl.plutus.data_to_json(datum_cbor_hex)
    assert json_str is not None
    assert len(json_str) > 0


@pytest.mark.skip(reason="plutus_data_from_json has GraalVM reflection config issue")
def test_plutus_data_from_json(ccl):
    datum_cbor_hex = "182a"
    json_str = ccl.plutus.data_to_json(datum_cbor_hex)
    cbor_hex = ccl.plutus.data_from_json(json_str)
    assert len(cbor_hex) > 0


@pytest.mark.skip(reason="plutus_data_to_json/from_json have GraalVM reflection config issues")
def test_plutus_data_json_roundtrip(ccl):
    original_cbor = "182a"
    original_hash = ccl.plutus.data_hash(original_cbor)
    json_str = ccl.plutus.data_to_json(original_cbor)
    roundtrip_cbor = ccl.plutus.data_from_json(json_str)
    roundtrip_hash = ccl.plutus.data_hash(roundtrip_cbor)
    assert original_hash == roundtrip_hash


# --- Negative / Error Tests ---

def test_plutus_data_hash_invalid_cbor(ccl):
    from mesmo._ffi import MesmoError
    try:
        ccl.plutus.data_hash("zzzz")
        assert False, "Should have raised MesmoError"
    except MesmoError:
        pass  # expected


def test_plutus_data_hash_empty(ccl):
    from mesmo._ffi import MesmoError
    try:
        ccl.plutus.data_hash("")
        assert False, "Should have raised MesmoError"
    except MesmoError:
        pass  # expected
