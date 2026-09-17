import json
import pytest
from mesmo._ffi import MesmoError
from mesmo.network import Network

# A known valid transaction CBOR hex (built from Java tests)
SAMPLE_TX_CBOR = "84a300d901028182582073198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002010181825839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc1a001e8480021a00029810a0f5f6"


def test_tx_hash(mesmo):
    tx_hash = mesmo.tx.hash(SAMPLE_TX_CBOR)
    assert len(tx_hash) == 64  # 32 bytes = 64 hex chars
    assert tx_hash == "7af07f974db1d004305d29670d04faeef0e9670e8cf95e4b54a06f668eed8de4"


def test_tx_to_json(mesmo):
    tx_json = mesmo.tx.to_json(SAMPLE_TX_CBOR)
    assert 'body' in tx_json
    assert 'inputs' in tx_json['body']
    assert len(tx_json['body']['inputs']) == 1


def test_tx_deserialize(mesmo):
    result = mesmo.tx.deserialize(SAMPLE_TX_CBOR)
    assert 'body' in result
    assert 'inputs' in result['body']


def test_account_sign_tx(mesmo):
    with mesmo.accounts.create(Network.TESTNET) as acct:
        signed_tx = acct.sign_tx(SAMPLE_TX_CBOR)
    assert len(signed_tx) > len(SAMPLE_TX_CBOR)


@pytest.mark.skip(reason="tx_from_json has GraalVM reflection config issue with NativeScriptDeserializer")
def test_tx_from_json(mesmo):
    tx_json = mesmo.tx.to_json(SAMPLE_TX_CBOR)
    cbor_hex = mesmo.tx.from_json(json.dumps(tx_json))
    assert len(cbor_hex) > 0


@pytest.mark.skip(reason="tx_sign_with_secret_key expects CBOR-encoded SecretKey, not raw private key hex")
def test_tx_sign_with_secret_key(mesmo):
    mnemonic = mesmo.crypto.generate_mnemonic(24)
    private_key = mesmo.crypto.derive_key(mnemonic)['private_key']
    signed_tx = mesmo.tx.sign_with_secret_key(SAMPLE_TX_CBOR, private_key)
    assert len(signed_tx) > len(SAMPLE_TX_CBOR)


# --- Negative / Error Tests ---

def test_tx_hash_malformed_cbor(mesmo):
    try:
        mesmo.tx.hash("deadbeef")
        assert False, "Should have raised MesmoError"
    except MesmoError:
        pass  # expected


def test_tx_hash_invalid_hex(mesmo):
    try:
        mesmo.tx.hash("not_hex!")
        assert False, "Should have raised MesmoError"
    except MesmoError:
        pass  # expected


def test_tx_deserialize_malformed(mesmo):
    try:
        mesmo.tx.deserialize("deadbeef")
        assert False, "Should have raised MesmoError"
    except MesmoError:
        pass  # expected
