from ccl.network import Network


def test_account_create_mainnet(ccl):
    with ccl.accounts.create(Network.MAINNET) as acct:
        info = acct.info
        assert info['base_address'].startswith('addr1')
        assert 'mnemonic' not in info  # never part of the ordinary representation
        words = acct.export_recovery_phrase().split()
        assert len(words) == 24


def test_account_create_testnet(ccl):
    with ccl.accounts.create(Network.TESTNET) as acct:
        assert acct.info['base_address'].startswith('addr_test1')


def test_account_from_mnemonic(ccl):
    # Create an account and export its phrase; restoring must produce the same addresses.
    with ccl.accounts.create(Network.MAINNET) as created:
        info = created.info
        mnemonic = created.export_recovery_phrase()

    with ccl.accounts.from_mnemonic(mnemonic, Network.MAINNET) as restored:
        assert restored.info['base_address'] == info['base_address']
        assert restored.info['enterprise_address'] == info['enterprise_address']
        assert restored.info['stake_address'] == info['stake_address']


def test_account_different_indices(ccl):
    with ccl.accounts.create(Network.MAINNET) as created:
        mnemonic = created.export_recovery_phrase()

    with ccl.accounts.from_mnemonic(mnemonic, Network.MAINNET, 0, 0) as a0, \
            ccl.accounts.from_mnemonic(mnemonic, Network.MAINNET, 0, 1) as a1:
        assert a0.info['base_address'] != a1.info['base_address']


def test_account_drep_id(ccl):
    with ccl.accounts.create(Network.MAINNET) as acct:
        assert acct.info['drep_id'].startswith('drep1')


# --- Negative / Error Tests ---

def test_account_from_invalid_mnemonic(ccl):
    from ccl._ffi import CclError
    try:
        ccl.accounts.from_mnemonic(
            "invalid words that are not a valid mnemonic phrase at all", Network.MAINNET)
        assert False, "Should have raised CclError"
    except CclError:
        pass  # expected


def test_account_from_empty_mnemonic(ccl):
    from ccl._ffi import CclError
    try:
        ccl.accounts.from_mnemonic("", Network.MAINNET)
        assert False, "Should have raised CclError"
    except CclError:
        pass  # expected


def test_account_sign_tx_invalid_cbor(ccl):
    from ccl._ffi import CclError
    with ccl.accounts.create(Network.TESTNET) as acct:
        try:
            acct.sign_tx("deadbeef")
            assert False, "Should have raised CclError"
        except CclError:
            pass  # expected
