import json
from ccl.network import Network


def test_script_native_from_json(ccl):
    # Create account to get a valid key hash for the native script
    with ccl.accounts.create(Network.MAINNET) as acct:
        base_address = acct.info['base_address']
    addr_info = ccl.address.info(base_address)
    key_hash = addr_info['payment_credential_hash']

    # Simple ScriptPubkey native script JSON
    script_json = json.dumps({
        "type": "sig",
        "keyHash": key_hash
    })

    result = ccl.script.native_from_json(script_json)
    # script_native_from_json returns a JSON string with policy_id, script_hash, cbor_hex
    parsed = json.loads(result)
    assert 'policy_id' in parsed
    assert 'script_hash' in parsed
    assert 'cbor_hex' in parsed
    assert len(parsed['script_hash']) == 56  # 28 bytes = 56 hex chars


def test_script_hash(ccl):
    # Create a native script to get some CBOR to hash
    with ccl.accounts.create(Network.MAINNET) as acct:
        base_address = acct.info['base_address']
    addr_info = ccl.address.info(base_address)
    key_hash = addr_info['payment_credential_hash']

    script_json = json.dumps({
        "type": "sig",
        "keyHash": key_hash
    })

    parsed = json.loads(ccl.script.native_from_json(script_json))
    cbor_hex = parsed['cbor_hex']

    # script_type 0 = native script
    hash_result = ccl.script.hash(cbor_hex, 0)
    assert len(hash_result) == 56  # 28 bytes = 56 hex chars
