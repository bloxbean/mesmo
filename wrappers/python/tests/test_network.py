"""The Network enum, and the inversion that makes it a footgun.

`Network` values are CCL's *enum ordinals*. Cardano's *on-chain* network id is a different number,
and for mainnet/testnet the two are inverted:

    Network.MAINNET == 0  ->  address.info()["network_id"] == 1
    Network.TESTNET == 1  ->  address.info()["network_id"] == 0

This looks like a bug and is not one, so it gets pinned here: anyone who "fixes" the enum by
renumbering it to match the on-chain ids will derive keys on the wrong network, and these tests will
stop them. The parameter is named `network`, never `network_id`, for exactly this reason — while the
`network_id` *returned* by `address.info()` is the genuine on-chain id and must keep that name.
"""

import pytest

from mesmo import Network


def test_members_are_mesmo_ordinals():
    assert (Network.MAINNET, Network.TESTNET) == (0, 1)


def test_mainnet_derives_an_address_whose_onchain_network_id_is_one(mesmo):
    """Network.MAINNET is 0 — but the address it produces reports on-chain network_id 1."""
    with mesmo.accounts.create(Network.MAINNET) as acct:
        base_address = acct.info["base_address"]

    assert int(Network.MAINNET) == 0
    assert base_address.startswith("addr1")
    assert mesmo.address.info(base_address)["network_id"] == 1


def test_testnet_derives_an_address_whose_onchain_network_id_is_zero(mesmo):
    """Network.TESTNET is 1 — but the address it produces reports on-chain network_id 0."""
    with mesmo.accounts.create(Network.TESTNET) as acct:
        base_address = acct.info["base_address"]

    assert int(Network.TESTNET) == 1
    assert base_address.startswith("addr_test1")
    assert mesmo.address.info(base_address)["network_id"] == 0


def test_plain_ints_still_work(mesmo):
    """IntEnum keeps the native call wire-compatible: an int of 0 or 1 is still accepted."""
    with mesmo.accounts.create(Network.TESTNET) as created:
        base_address = created.info["base_address"]
        mnemonic = created.export_recovery_phrase()

    with mesmo.accounts.from_mnemonic(mnemonic, 1) as from_int:
        assert from_int.info["base_address"] == base_address


@pytest.mark.parametrize("bad", [2, 3, 4, -1, 99])
def test_out_of_range_network_raises_valueerror(mesmo, bad):
    """Caught at the boundary, not deep inside the native library."""
    with pytest.raises(ValueError, match="Network"):
        mesmo.accounts.create(bad)


def test_network_is_required_and_never_defaults_to_mainnet(mesmo):
    """No default. Account creation used to silently mint a *mainnet* account."""
    with pytest.raises(TypeError):
        mesmo.accounts.create()

    mnemonic = mesmo.crypto.generate_mnemonic(24)
    with pytest.raises(TypeError):
        mesmo.accounts.from_mnemonic(mnemonic)
