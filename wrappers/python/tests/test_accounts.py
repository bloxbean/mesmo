"""Managed-account object tests (ADR-0016 slice 4): lifecycle, typed-role signing parity with the
mnemonic-per-call path, one-shot recovery-phrase export, and secret hygiene. Fully offline."""
import pytest

from ccl import CclInvalidHandleError, Network, SigningRole
from ccl._ffi import CclError

TEST_MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice"

PROTOCOL_PARAMS = {
    "min_fee_a": 44, "min_fee_b": 155381, "max_tx_size": 16384,
    "key_deposit": "2000000", "pool_deposit": "500000000",
    "coins_per_utxo_size": "4310", "max_val_size": "5000",
    "max_tx_ex_mem": "10000000", "max_tx_ex_steps": "10000000000",
    "price_mem": 0.0577, "price_step": 0.0000721, "collateral_percent": 150,
    "max_collateral_inputs": 3,
}


def _unsigned_stake_reg(ccl, sender_info):
    yaml = f"""
version: 1.0
transaction:
  - tx:
      from: {sender_info["base_address"]}
      intents:
        - type: stake_registration
          stake_address: {sender_info["stake_address"]}
"""
    utxos = [{"tx_hash": "a" * 64, "output_index": 0, "address": sender_info["base_address"],
              "amount": [{"unit": "lovelace", "quantity": "2000000000"}]}]
    return ccl.quicktx.build(yaml, utxos, PROTOCOL_PARAMS, additional_signers=1)["tx_cbor"]


def test_open_info_matches_pinned_derivation(ccl):
    # Pinned CIP-1852 derivation for the standard CCL test mnemonic at testnet 0/0. The
    # mnemonic-path equivalence proof lives in the core's AccountKeyDerivationParityTest;
    # these literals guard the wrapper against derivation regressions.
    with ccl.accounts.from_mnemonic(TEST_MNEMONIC, Network.TESTNET) as acct:
        info = acct.info
        assert info["base_address"] == (
            "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer"
            "3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp")
        assert info["enterprise_address"] == (
            "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz")
        assert info["stake_address"] == (
            "stake_test1uqevw2xnsc0pvn9t9r9c7qryfqfeerchgrlm3ea2nefr9hqp8n5xl")
        assert info["change_address"] == (
            "addr_test1qz4kjk0as0x7ptt54l6cnfyzejqg22cku0qhqx6al4g2xe"
            "pjcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq5hxe5g")
        assert info["network"] == int(Network.TESTNET)
        assert info["account_index"] == 0 and info["address_index"] == 0
        assert "mnemonic" not in info


def test_sign_is_deterministic_and_mask_order_free(ccl):
    with ccl.accounts.from_mnemonic(TEST_MNEMONIC, Network.TESTNET) as acct:
        unsigned = _unsigned_stake_reg(ccl, acct.info)

        # Deterministic: signing twice yields byte-identical output.
        assert acct.sign_tx(unsigned) == acct.sign_tx(unsigned)
        # A stake registration gains a second witness with the stake role.
        assert len(acct.sign_tx(unsigned, SigningRole.PAYMENT | SigningRole.STAKE)) > \
            len(acct.sign_tx(unsigned))
        # Mask order is irrelevant — canonical application order fixes the output.
        assert acct.sign_tx(unsigned, SigningRole.STAKE | SigningRole.PAYMENT) == \
            acct.sign_tx(unsigned, SigningRole.PAYMENT | SigningRole.STAKE)


def test_empty_role_mask_rejected(ccl):
    with ccl.accounts.from_mnemonic(TEST_MNEMONIC, Network.TESTNET) as acct:
        unsigned = _unsigned_stake_reg(ccl, acct.info)
        with pytest.raises(CclError):
            acct.sign_tx(unsigned, 0)


def test_lifecycle_close_idempotent_use_after_close_typed(ccl):
    acct = ccl.accounts.from_mnemonic(TEST_MNEMONIC, Network.TESTNET)
    acct.close()
    acct.close()  # idempotent
    with pytest.raises(CclInvalidHandleError):
        _ = acct.info
    with pytest.raises(CclInvalidHandleError):
        acct.sign_tx("84a400", SigningRole.PAYMENT)


def test_create_export_once_and_restore(ccl):
    with ccl.accounts.create(Network.TESTNET) as acct:
        base = acct.info["base_address"]
        phrase = acct.export_recovery_phrase()
        assert len(phrase.split()) == 24
        with ccl.accounts.from_mnemonic(phrase, Network.TESTNET) as restored:
            assert restored.info["base_address"] == base
        with pytest.raises(CclError):
            acct.export_recovery_phrase()  # one-shot


def test_export_on_imported_account_fails(ccl):
    with ccl.accounts.from_mnemonic(TEST_MNEMONIC, Network.TESTNET) as acct:
        with pytest.raises(CclError):
            acct.export_recovery_phrase()


def test_repr_never_contains_secrets(ccl):
    with ccl.accounts.create(Network.TESTNET) as acct:
        assert "addr" not in repr(acct)  # not even public data, just the handle
        phrase = acct.export_recovery_phrase()
        assert phrase.split()[0] not in repr(acct)
    assert repr(acct) == "<ccl.Account closed>"


def test_two_handles_same_leaf_independent_lifecycle(ccl):
    a = ccl.accounts.from_mnemonic(TEST_MNEMONIC, Network.TESTNET)
    b = ccl.accounts.from_mnemonic(TEST_MNEMONIC, Network.TESTNET)
    try:
        assert a.info["base_address"] == b.info["base_address"]
        a.close()
        with pytest.raises(CclInvalidHandleError):
            _ = a.info
        assert b.info["base_address"]  # sibling unaffected
    finally:
        b.close()


# --- close() must never touch the read-once result slot -------------------------------------
#
# Results travel through a thread-local, READ-ONCE slot: a successful native call parks its
# result there, and the wrapper fetches it with a second FFI call. Account.close() runs not
# only explicitly but also from __del__ during cyclic GC — which can fire between another
# call's native return and its result fetch, on the same thread. If close() drains the slot
# (it produces no result of its own), it steals that in-flight result: sign_tx silently
# returns None. These tests pin the invariant from both directions.

BLAKE2B_HELLO = "8b7ca7d27d9fc55fa30abfe515b3afb24e3fe89fdd02e2ac92bca2c96680642e"


def test_close_never_drains_the_pending_result_slot(ccl):
    acct = ccl.accounts.create(Network.TESTNET)

    # Park a known result in the slot without fetching it — exactly how it sits
    # between a native call's return and its result read.
    rc = ccl._lib.ccl_crypto_blake2b_256(ccl._thread, b"48656c6c6f")  # "Hello"
    assert rc == 0

    acct.close()  # must not consume the parked result

    assert ccl._get_result() == BLAKE2B_HELLO


def test_gc_finalizer_cannot_steal_an_inflight_result(ccl):
    """The production bug shape: cyclic GC finalizes a dead Account mid-call."""
    import gc

    class Cycle:
        pass

    holder = Cycle()
    holder.self_ref = holder  # unreachable cycle: only gc.collect() can reap it
    holder.account = ccl.accounts.create(Network.TESTNET)
    del holder

    rc = ccl._lib.ccl_crypto_blake2b_256(ccl._thread, b"48656c6c6f")
    assert rc == 0

    gc.collect()  # runs Account.__del__ -> close() with the result parked

    assert ccl._get_result() == BLAKE2B_HELLO


def test_sign_tx_error_codes_are_typed_and_consistent(ccl):
    """Closed-handle recovery keys on CclInvalidHandleError (-11), and corrupt input maps to
    -9 (invalid transaction) whether the corruption is bad hex or bad CBOR — never -2."""
    import pytest
    from ccl import CclInvalidHandleError
    from ccl._ffi import CclError

    acct = ccl.accounts.create(Network.TESTNET)
    acct.close()
    with pytest.raises(CclInvalidHandleError):
        acct.sign_tx("", 0)

    with ccl.accounts.create(Network.TESTNET) as live:
        for corrupt in ("zz", "abc"):  # non-hex; odd length
            with pytest.raises(CclError) as excinfo:
                live.sign_tx(corrupt)
            assert excinfo.value.code == -9, f"{corrupt!r} → {excinfo.value.code}"


def test_foreign_handle_from_another_isolate_is_rejected():
    """Two bridges = two isolates. If every isolate counts handles from 1, bridge A's handle
    aliases a real account on bridge B, and signing through the C ABI with the wrong
    bridge/handle pairing silently uses the WRONG KEYS instead of failing with -11. The
    handle spaces must be disjoint (per-isolate randomized) so the documented foreign-handle
    failure actually happens."""
    from ccl._ffi import CclLib

    lib1, lib2 = CclLib(), CclLib()
    try:
        a1 = lib1.accounts.create(Network.TESTNET)
        a2 = lib2.accounts.create(Network.TESTNET)  # same allocation order on both isolates

        # Pass lib1's handle to lib2 through the raw ABI — the exact wrong-pairing mistake.
        rc = lib2._lib.ccl_account_get_info(lib2._thread, a1._handle)
        assert rc == -11, (
            f"foreign handle returned rc={rc}: it aliased a real account on the other "
            f"isolate (handles: lib1={a1._handle}, lib2={a2._handle})")
    finally:
        lib1.close()
        lib2.close()
