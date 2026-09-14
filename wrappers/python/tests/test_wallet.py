"""The HD-wallet use case on the managed-accounts API.

There is no separate wallet API: a wallet is one recovery phrase, and each address is one
CIP-1852 payment leaf — one handle per leaf (`address_index` selects it). These tests pin
that the wallet workflows (create, restore, enumerate addresses) survive on handles alone.
"""

from ccl.network import Network


def test_wallet_create(ccl):
    with ccl.accounts.create(Network.MAINNET) as acct:
        info = acct.info
        assert info['stake_address'].startswith('stake1')
        words = acct.export_recovery_phrase().split()
        assert len(words) == 24


def test_wallet_restore_shares_stake_identity(ccl):
    with ccl.accounts.create(Network.MAINNET) as created:
        stake = created.info['stake_address']
        mnemonic = created.export_recovery_phrase()

    with ccl.accounts.from_mnemonic(mnemonic, Network.MAINNET) as restored:
        assert restored.info['stake_address'] == stake


def test_wallet_address_enumeration(ccl):
    with ccl.accounts.create(Network.MAINNET) as created:
        mnemonic = created.export_recovery_phrase()

    addresses = []
    for index in range(2):
        with ccl.accounts.from_mnemonic(mnemonic, Network.MAINNET, 0, index) as acct:
            addresses.append(acct.info['base_address'])

    assert all(a.startswith('addr1') for a in addresses)
    assert len(set(addresses)) == len(addresses)  # every leaf is a distinct address


def test_wallet_create_testnet(ccl):
    with ccl.accounts.create(Network.TESTNET) as acct:
        assert acct.info['stake_address'].startswith('stake_test1')
