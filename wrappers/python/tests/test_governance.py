"""Governance identifiers on the managed-accounts API plus the stateless key-derivation utility.

The mnemonic-per-call gov API is gone: governance *identity* (DRep id, committee ids and
credentials) is public data on `account.info`, governance *signing* is `sign_tx` with the
DREP / COMMITTEE_* roles, and raw governance key material comes from `crypto.derive_key`.
"""

from ccl.network import Network


def test_gov_identifiers_in_account_info(ccl):
    with ccl.accounts.create(Network.MAINNET) as acct:
        info = acct.info
        assert info['drep_id'].startswith('drep1')
        assert info['committee_cold_id'].startswith('cc_cold1')
        assert info['committee_hot_id'].startswith('cc_hot1')
        assert len(info['committee_cold_credential']) == 56  # blake2b-224 hex
        assert len(info['committee_hot_credential']) == 56


def test_derive_key_matches_account_credentials(ccl):
    """The stateless derivation utility and the handle agree on the committee credentials."""
    with ccl.accounts.create(Network.MAINNET) as acct:
        info = acct.info
        mnemonic = acct.export_recovery_phrase()

    cold = ccl.crypto.derive_key(mnemonic, role="committee_cold")
    hot = ccl.crypto.derive_key(mnemonic, role="committee_hot")
    assert cold['public_key_hash'] == info['committee_cold_credential']
    assert hot['public_key_hash'] == info['committee_hot_credential']
    assert cold['path'] == "m/1852'/1815'/0'/4/0"
    assert hot['path'] == "m/1852'/1815'/0'/5/0"


def test_derive_key_shapes(ccl):
    mnemonic = ccl.crypto.generate_mnemonic(24)
    drep = ccl.crypto.derive_key(mnemonic, role="drep")
    assert len(drep['private_key']) == 128  # 64-byte extended key
    assert len(drep['public_key']) == 64    # 32-byte verification key
    assert len(drep['public_key_hash']) == 56


def test_derive_key_returns_cip105_bech32_encodings_for_gov_roles(ccl):
    """cardano-cli / GovTool take governance verification keys in CIP-105 bech32 form
    (drep_vk1…, cc_cold_vk1…, cc_hot_vk1…, and the …_vkh hash forms). The deleted gov API
    returned them; derive_key must too, or the registration workflow needs a third-party
    bech32 library."""
    mnemonic = ccl.crypto.generate_mnemonic(24)

    for role, prefix in (("drep", "drep"), ("committee_cold", "cc_cold"), ("committee_hot", "cc_hot")):
        key = ccl.crypto.derive_key(mnemonic, role=role)
        assert key["bech32_verification_key"].startswith(f"{prefix}_vk1"), role
        assert key["bech32_verification_key_hash"].startswith(f"{prefix}_vkh1"), role

    # Non-governance roles carry no bech32 forms — the fields are gov-specific by design.
    payment = ccl.crypto.derive_key(mnemonic, role="payment")
    assert "bech32_verification_key" not in payment
