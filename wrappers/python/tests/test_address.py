from mesmo.network import Network


def test_address_info(mesmo):
    # Create an account to get a valid address
    with mesmo.accounts.create(Network.MAINNET) as acct:
        base_address = acct.info['base_address']
    info = mesmo.address.info(base_address)

    assert info['type'] == 'Base'
    assert info['network_id'] == 1
    assert 'payment_credential_hash' in info


def test_address_to_and_from_bytes(mesmo):
    with mesmo.accounts.create(Network.MAINNET) as acct:
        addr = acct.info['base_address']

    hex_bytes = mesmo.address.to_bytes(addr)
    assert len(hex_bytes) > 0

    restored = mesmo.address.from_bytes(hex_bytes)
    assert restored == addr


def test_address_validate(mesmo):
    with mesmo.accounts.create(Network.MAINNET) as acct:
        addr = acct.info['base_address']
    assert mesmo.address.validate(addr) is True
    assert mesmo.address.validate("invalid_address") is False


# --- Negative / Error Tests ---

def test_address_info_invalid(mesmo):
    from mesmo._ffi import MesmoError
    try:
        mesmo.address.info("not_a_valid_address")
        assert False, "Should have raised MesmoError"
    except MesmoError:
        pass  # expected


def test_address_from_bytes_invalid(mesmo):
    from mesmo._ffi import MesmoError
    try:
        mesmo.address.from_bytes("zzzz")
        assert False, "Should have raised MesmoError"
    except MesmoError:
        pass  # expected
