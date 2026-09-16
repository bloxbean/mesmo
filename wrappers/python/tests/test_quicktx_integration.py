"""Integration tests for QuickTx (TxPlan YAML) with Yaci DevKit.

Requires:
- Yaci DevKit running on port 10000
- Native library built: ./gradlew :core:nativeCompile

Run with:
    PYTHONPATH=wrappers/python MESMO_LIB_PATH=core/build/native/nativeCompile \
        pytest wrappers/python/tests/test_quicktx_integration.py -v
"""
import re
import time
from pathlib import Path

import pytest

from mesmo import SigningRole
from mesmo._ffi import Mesmo, MesmoError
from mesmo.network import Network
from tests.devkit_helper import DevKitHelper

# The fixed test account the quicktx-intents fixtures are derived from (account 0/0).
INTENT_MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice"

_ROLE_MASKS = {"payment": SigningRole.PAYMENT, "stake": SigningRole.STAKE, "drep": SigningRole.DREP}


def _roles_mask(keys):
    mask = _ROLE_MASKS[keys[0]]
    for k in keys[1:]:
        mask |= _ROLE_MASKS[k]
    return mask


def _intent_sign(mesmo_lib, tx_cbor, keys=("payment",), address_index=0):
    """Sign with the fixture mnemonic through a managed handle (opened per call, closed after)."""
    with mesmo_lib.accounts.from_mnemonic(INTENT_MNEMONIC, Network.TESTNET, 0, address_index) as acct:
        return acct.sign_tx(tx_cbor, _roles_mask(list(keys)))


def _fresh_addr(mesmo_lib):
    """A fresh testnet address (managed handle, closed immediately)."""
    with mesmo_lib.accounts.create(Network.TESTNET) as acct:
        return acct.info["base_address"]

INTENT_SENDER = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp"
FIXTURES = Path(__file__).parent / "../../../test-fixtures/quicktx-intents"

# The address the mint fixtures pay the minted asset to (account.enterprise_address).
MINT_RECEIVER = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz"

# The deterministic always-succeeds-V2 script address + datum hash used by the Plutus spend fixtures,
# and the placeholder tx hash baked into script_collect_from.yaml (repointed at the real locked UTXO).
SCRIPT_ADDR = "addr_test1wpunlryvl7aqsxe22erzlsseej87v5kk5vutvtrmzdy8dect48z0w"
SCRIPT_DATUM_HASH = "9e1199a988ba72ffd6e9c269cadb3b53b5f360ff99f112d9b2ee30c4d74ad88b"
SCRIPT_TX_HASH = "b" * 64
EXEC_UNITS = [{"mem": 2000000, "steps": 500000000}]

# The gov_action_tx_hash baked into voting.yaml; the voting test repoints it at the real proposal it
# submits.
GOV_ACTION_PLACEHOLDER = "12745f09b138d4d0a11a560b4591ebb830cf12336347606d2edbbf1893d395c6"

# The pool id baked into stake_delegation.yaml, and the pool id keyed to the account's stake key in
# pool_registration.yaml. The delegation test registers that pool and repoints the placeholder at it.
POOL_PLACEHOLDER = "pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy"
ACCOUNT_POOL_ID = "pool1xtrj35uxrctye2egew8sqezgzwwg796ql7uw02572gedcpgmwck"


def _read_fixture(rel):
    return (FIXTURES / rel).read_text()


def _devnet_pp(devkit):
    """Fetch the devnet protocol params and fill in the Conway deposits DevKit returns as null (the
    node validates the actual values on submit)."""
    pp = devkit.get_protocol_params()
    pp["drep_deposit"] = "500000000"
    pp["gov_action_deposit"] = "1000000000"
    pp["pool_deposit"] = "500000000"
    return pp


def _reset_and_fund(devkit):
    """Reset the devnet, fund the fixed account with 6000 ADA, and return the devnet protocol params."""
    devkit.reset()
    devkit.wait_for_block(3)
    devkit.topup(INTENT_SENDER, 6000)
    devkit.wait_for_block(3)
    return _devnet_pp(devkit)


def _sign_submit(mesmo_lib, devkit, yaml_str, utxos, pp, keys, exec_units=None,
                 additional_signers=None):
    """Build the YAML with the given UTXOs + params, sign with the key roles, and submit.

    ``additional_signers`` (the fee's witness budget beyond the input-implied payment key) defaults
    to ``len(keys) - 1`` — the signer count is known here, exactly as it is for a real caller. Pass
    it explicitly where the inputs imply no payment key (e.g. a script-only-input spend).

    The devnet's /tx/submit returns 200/202 only after the node has validated and accepted the tx (a
    rejected tx raises RuntimeError with the ledger error) — that acceptance is the proof.
    """
    if additional_signers is None:
        additional_signers = max(0, len(keys) - 1)
    result = mesmo_lib.quicktx.build(yaml_str, utxos, pp, exec_units=exec_units,
                                   additional_signers=additional_signers)
    signed = _intent_sign(mesmo_lib, result["tx_cbor"], keys)
    tx_hash = devkit.submit_tx(signed)
    assert tx_hash
    return tx_hash


def _build_sign_submit(mesmo_lib, devkit, fixture, keys, exec_units=None):
    """Reset the devnet, fund the fixed account, build the fixture with its real UTXOs, sign with the
    given key roles, submit, and verify the node accepted it."""
    pp = _reset_and_fund(devkit)
    utxos = devkit.get_utxos(INTENT_SENDER)
    return _sign_submit(mesmo_lib, devkit, _read_fixture(fixture), utxos, pp, keys, exec_units)


def _setup_then_submit(mesmo_lib, devkit, setup_fixture, setup_keys, fixture, keys):
    """Reset+fund the devnet, submit a prerequisite fixture (e.g. registering a stake address or
    DRep), then submit the target fixture in the next block. Used for intents whose certificate
    depends on prior on-chain state."""
    pp = _reset_and_fund(devkit)
    u = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture(setup_fixture), u, pp, setup_keys)
    devkit.wait_for_block(3)
    u2 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture(fixture), u2, pp, keys)


def _assert_minted_asset_at(devkit, address):
    """Confirm a mint actually landed on-chain: the receiver holds a non-lovelace asset. ("Submit
    accepted" alone doesn't prove the intended effect; this does.)"""
    devkit.wait_for_block(3)
    for u in devkit.get_utxos(address):
        for a in u.get("amount", []):
            unit = a.get("unit")
            if unit and unit != "lovelace":
                return
    raise AssertionError(f"expected a minted asset at {address}, found none")


def _assert_utxo_consumed(devkit, address, tx_hash):
    """Confirm the given UTXO is no longer present at an address (it was spent)."""
    devkit.wait_for_block(3)
    for u in devkit.get_utxos(address):
        if u.get("tx_hash") == tx_hash:
            raise AssertionError(f"UTXO {tx_hash} at {address} was not consumed")


@pytest.fixture(scope="module")
def devkit():
    helper = DevKitHelper()
    if not helper.is_available():
        pytest.skip("Yaci DevKit is not running on port 10000")
    helper.reset()
    time.sleep(3)
    return helper


@pytest.fixture(scope="module")
def mesmo_lib():
    lib = Mesmo()
    yield lib
    lib.close()


@pytest.fixture
def funded_sender(mesmo_lib, devkit):
    with mesmo_lib.accounts.create(Network.TESTNET) as acct:
        devkit.topup(acct.info["base_address"], 150)
        devkit.wait_for_block(2)
        yield acct


def _payment_yaml(from_addr, to_addr, quantity):
    return f"""
version: 1.0
transaction:
  - tx:
      from: {from_addr}
      intents:
        - type: payment
          address: {to_addr}
          amounts:
            - unit: lovelace
              quantity: "{quantity}"
"""


def test_simple_ada_transfer(mesmo_lib, devkit, funded_sender):
    """Build a 5 ADA payment from TxPlan YAML, sign, submit, and verify on-chain."""
    receiver = _fresh_addr(mesmo_lib)

    utxos = devkit.get_utxos(funded_sender.info["base_address"])
    pp = devkit.get_protocol_params()

    yaml_str = _payment_yaml(funded_sender.info["base_address"], receiver, "5000000")
    result = mesmo_lib.quicktx.build(yaml_str, utxos, pp)
    assert len(result["tx_cbor"]) > 0
    assert len(result["tx_hash"]) == 64
    assert int(result["fee"]) > 0

    signed_tx = funded_sender.sign_tx(result["tx_cbor"])
    tx_hash = devkit.submit_tx(signed_tx)
    assert tx_hash

    devkit.wait_for_block(3)
    receiver_utxos = devkit.get_utxos(receiver)
    total = sum(int(a["quantity"]) for u in receiver_utxos
                for a in u["amount"] if a["unit"] == "lovelace")
    assert total == 5_000_000


def test_multiple_receivers(mesmo_lib, devkit, funded_sender):
    r1 = _fresh_addr(mesmo_lib)
    r2 = _fresh_addr(mesmo_lib)

    sender_address = funded_sender.info["base_address"]
    utxos = devkit.get_utxos(sender_address)
    pp = devkit.get_protocol_params()

    yaml_str = f"""
version: 1.0
transaction:
  - tx:
      from: {sender_address}
      intents:
        - type: payment
          address: {r1}
          amounts:
            - unit: lovelace
              quantity: "3000000"
        - type: payment
          address: {r2}
          amounts:
            - unit: lovelace
              quantity: "2000000"
"""
    result = mesmo_lib.quicktx.build(yaml_str, utxos, pp)
    signed_tx = funded_sender.sign_tx(result["tx_cbor"])
    assert devkit.submit_tx(signed_tx)

    devkit.wait_for_block(3)
    r1_utxos = devkit.get_utxos(r1)
    total = sum(int(a["quantity"]) for u in r1_utxos
                for a in u["amount"] if a["unit"] == "lovelace")
    assert total == 3_000_000
    r2_utxos = devkit.get_utxos(r2)
    total2 = sum(int(a["quantity"]) for u in r2_utxos
                 for a in u["amount"] if a["unit"] == "lovelace")
    assert total2 == 2_000_000


def test_insufficient_funds(mesmo_lib, devkit):
    sender = _fresh_addr(mesmo_lib)
    devkit.topup(sender, 2)
    devkit.wait_for_block(2)
    receiver = _fresh_addr(mesmo_lib)

    utxos = devkit.get_utxos(sender)
    pp = devkit.get_protocol_params()

    yaml_str = _payment_yaml(sender, receiver, "100000000")
    with pytest.raises(MesmoError):
        mesmo_lib.quicktx.build(yaml_str, utxos, pp)


def test_build_with_yaci_provider(mesmo_lib, devkit, funded_sender):
    """The shipped YaciProvider fetches the devnet's real chain data and feeds build()."""
    from mesmo.providers import YaciProvider

    receiver = _fresh_addr(mesmo_lib)
    provider = YaciProvider()  # defaults to the local DevKit cluster
    yaml_str = _payment_yaml(funded_sender.info["base_address"], receiver, "5000000")

    result = mesmo_lib.quicktx.build_with(yaml_str, provider, [funded_sender.info["base_address"]])

    assert len(result["tx_cbor"]) > 0
    assert len(result["tx_hash"]) == 64
    assert int(result["fee"]) > 0


def test_donation_treasury(mesmo_lib, devkit):
    """Submit a treasury donation.

    Conway validates the tx's declared current_treasury_value against the node's live ledger treasury
    *exactly* (ConwayTreasuryValueMismatch otherwise), so the donation.yaml fixture's hardcoded
    current_treasury_value: 0 no longer works on Yaci DevKit 0.12 (non-zero, epoch-varying treasury).

    We deliberately do NOT read the treasury from an endpoint and declare it — and not for lack of
    trying. The obvious "clean" design was to read yaci-store's /network endpoint
    (http://localhost:8080/api/v1/network -> supply.treasury) and submit that exact value. It does not
    work reliably: yaci-store computes the treasury off-chain and its value drifts from the node's
    ledger — in CI it returned 21,599,698,134,578 while the node held 43,186,776,312,112 (an epoch of
    indexing lag), so the fetched value was rejected. The node is the sole authority on its own
    treasury, and the only channel that reports its exact current value is the rejection itself.

    So: submit, read "expected: Coin N" out of the ConwayTreasuryValueMismatch, rebuild with N, and
    resubmit. Retrying also absorbs an epoch boundary landing between attempts. The offline donation
    build is covered separately by the intents build tests.
    """
    devkit.reset()
    devkit.wait_for_block(3)
    devkit.topup(INTENT_SENDER, 6000)
    devkit.wait_for_block(3)

    utxos = devkit.get_utxos(INTENT_SENDER)
    pp = devkit.get_protocol_params()
    base_yaml = (FIXTURES / "donation.yaml").read_text()

    treasury = "0"
    last_err = None
    for _ in range(5):
        yaml_str = base_yaml.replace("current_treasury_value: 0", f"current_treasury_value: {treasury}")
        result = mesmo_lib.quicktx.build(yaml_str, utxos, pp)
        signed = _intent_sign(mesmo_lib, result["tx_cbor"])
        try:
            tx_hash = devkit.submit_tx(signed)
            assert tx_hash
            return  # accepted
        except RuntimeError as e:
            last_err = str(e)
            m = re.search(r"expected:\s*Coin\s*(\d+)", last_err)
            if not m:
                raise
            treasury = m.group(1)
    raise AssertionError(f"donation submit failed after retries: {last_err}")


# --- Metadata / minting suite (mirrors intents_integration_test.go) ---

def test_metadata(mesmo_lib, devkit):
    """Submit a transaction carrying auxiliary metadata. Mirrors TestIntegrationMetadata."""
    _build_sign_submit(mesmo_lib, devkit, "metadata.yaml", ["payment"])


def test_native_mint(mesmo_lib, devkit):
    """Mint a native asset under an empty ScriptAll policy (no signature needed beyond the fee
    payer), then confirm the asset landed at the receiver. Mirrors TestIntegrationNativeMint."""
    _build_sign_submit(mesmo_lib, devkit, "minting.yaml", ["payment"])
    _assert_minted_asset_at(devkit, MINT_RECEIVER)


def test_plutus_mint(mesmo_lib, devkit):
    """Mint under a Plutus V2 policy (supplying execution units), then confirm the asset landed at
    the receiver. Mirrors TestIntegrationPlutusMint."""
    _build_sign_submit(mesmo_lib, devkit, "plutus/script_minting.yaml", ["payment"],
                       exec_units=EXEC_UNITS)
    _assert_minted_asset_at(devkit, MINT_RECEIVER)


def test_plutus_spend(mesmo_lib, devkit):
    """Lock a UTXO at the script address (with the datum hash), then spend it. The spend fixture
    references a placeholder UTXO; we repoint it at the real on-chain locked UTXO. Mirrors
    TestIntegrationPlutusSpend.
    """
    pp = _reset_and_fund(devkit)

    # Step 1: lock 10 ADA at the script address with the datum hash.
    utxos = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("plutus/plutus_lock.yaml"), utxos, pp, ["payment"])
    devkit.wait_for_block(3)

    # Step 2: find the locked UTXO at the script address.
    script_utxos = devkit.get_utxos(SCRIPT_ADDR)
    assert script_utxos, "no locked UTXO at script address"
    locked = script_utxos[0]
    lock_hash = locked["tx_hash"]
    lock_idx = int(locked.get("output_index", 0))

    # Step 3: repoint the spend fixture's utxo_ref at the real locked UTXO.
    spend_yaml = _read_fixture("plutus/script_collect_from.yaml").replace(SCRIPT_TX_HASH, lock_hash)
    if lock_idx != 0:
        spend_yaml = spend_yaml.replace("output_index: 0", f"output_index: {lock_idx}", 1)

    # Step 4: spend it — supply the locked UTXO (with its datum hash) + a fee/collateral UTXO.
    spend_utxos = [{
        "tx_hash": lock_hash,
        "output_index": lock_idx,
        "address": SCRIPT_ADDR,
        "amount": [{"unit": "lovelace", "quantity": "10000000"}],
        "data_hash": SCRIPT_DATUM_HASH,
    }]
    spend_utxos.extend(devkit.get_utxos(INTENT_SENDER))

    _sign_submit(mesmo_lib, devkit, spend_yaml, spend_utxos, pp, ["payment"], exec_units=EXEC_UNITS)

    # Confirm the spend actually consumed the locked script UTXO.
    _assert_utxo_consumed(devkit, SCRIPT_ADDR, lock_hash)


# --- Governance / staking suite (mirrors intents_integration_test.go) ---

def test_managed_account_handle_sign_submit(mesmo_lib, devkit):
    """ADR-0016 end-to-end: build offline, sign with a managed Account handle (typed role mask,
    no mnemonic in the signing call), and have the node accept the transaction. The handle-based
    signature must be as node-acceptable as the mnemonic-per-call path it replaces."""
    pp = _reset_and_fund(devkit)
    utxos = devkit.get_utxos(INTENT_SENDER)
    built = mesmo_lib.quicktx.build(_read_fixture("stake_registration.yaml"), utxos, pp,
                                  additional_signers=1)
    with mesmo_lib.accounts.from_mnemonic(INTENT_MNEMONIC, Network.TESTNET) as acct:
        signed = acct.sign_tx(built["tx_cbor"], SigningRole.PAYMENT | SigningRole.STAKE)
    assert devkit.submit_tx(signed)


def test_stake_registration(mesmo_lib, devkit):
    """Register a stake address (witnessed by payment + stake keys). Mirrors
    TestIntegrationStakeRegistration."""
    _build_sign_submit(mesmo_lib, devkit, "stake_registration.yaml", ["payment", "stake"])


def test_drep_registration(mesmo_lib, devkit):
    """Register a DRep (witnessed by payment + drep keys). Mirrors
    TestIntegrationDRepRegistration."""
    _build_sign_submit(mesmo_lib, devkit, "drep_registration.yaml", ["payment", "drep"])


def test_drep_key_required(mesmo_lib, devkit):
    """Negative test: a DRep registration certificate must be witnessed by the DRep key, so signing
    with the payment key alone must be rejected by the node (MissingVKeyWitnessesUTXOW). This proves
    the extra witness the stake role adds is genuinely required — not cosmetic — and complements
    the positive test_drep_registration (payment+drep) above. Mirrors TestIntegrationDRepKeyRequired.
    """
    pp = _reset_and_fund(devkit)
    utxos = devkit.get_utxos(INTENT_SENDER)
    built = mesmo_lib.quicktx.build(_read_fixture("drep_registration.yaml"), utxos, pp,
                                  additional_signers=1)

    # Sign with the payment key ONLY (sign_tx), omitting the DRep-key witness.
    signed_payment_only = _intent_sign(mesmo_lib, built["tx_cbor"])
    with pytest.raises(RuntimeError):
        devkit.submit_tx(signed_payment_only)


def test_drep_update(mesmo_lib, devkit):
    """Register a DRep, then update it. Mirrors TestIntegrationDRepUpdate."""
    _setup_then_submit(mesmo_lib, devkit,
                       "drep_registration.yaml", ["payment", "drep"],
                       "drep_update.yaml", ["payment", "drep"])


def test_drep_deregistration(mesmo_lib, devkit):
    """Register a DRep, then deregister it. Mirrors TestIntegrationDRepDeregistration."""
    _setup_then_submit(mesmo_lib, devkit,
                       "drep_registration.yaml", ["payment", "drep"],
                       "drep_deregistration.yaml", ["payment", "drep"])


def test_voting_delegation(mesmo_lib, devkit):
    """Delegate voting power (requires the stake address to be registered; vote target is abstain).
    Mirrors TestIntegrationVotingDelegation."""
    _setup_then_submit(mesmo_lib, devkit,
                       "stake_registration.yaml", ["payment", "stake"],
                       "voting_delegation.yaml", ["payment", "stake"])


def test_pool_registration(mesmo_lib, devkit):
    """Register a stake pool keyed to the account's stake key (operator, owner, reward account), so
    signing with the stake key witnesses it. The reward account must be a registered stake address,
    so register it first. Mirrors TestIntegrationPoolRegistration.
    """
    _setup_then_submit(mesmo_lib, devkit,
                       "stake_registration.yaml", ["payment", "stake"],
                       "pool_registration.yaml", ["payment", "stake"])


def test_stake_deregistration(mesmo_lib, devkit):
    """Register the stake address, then deregister it. The deregistration certificate is witnessed
    by the stake key (the refund address receives the deposit back). Mirrors the JS suite's
    register-then-deregister test.
    """
    _setup_then_submit(mesmo_lib, devkit,
                       "stake_registration.yaml", ["payment", "stake"],
                       "stake_deregistration.yaml", ["payment", "stake"])


def test_pool_retirement(mesmo_lib, devkit):
    """Register the account-keyed pool, then retire it. The retirement certificate is witnessed by
    the pool's operator key — which pool_registration.yaml keys to the account's stake key. Conway
    bounds the retirement epoch to (current, current+e_max]; the fixture's hardcoded 500 is out of
    range on a young devnet, so repoint it at current+2.
    """
    pp = _reset_and_fund(devkit)

    u = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    u2 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("pool_registration.yaml"), u2, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    epoch = devkit.get_latest_epoch()
    retire_yaml = (_read_fixture("pool_retirement.yaml")
                   .replace(POOL_PLACEHOLDER, ACCOUNT_POOL_ID)
                   .replace("retirement_epoch: 500", f"retirement_epoch: {epoch + 2}"))

    u3 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, retire_yaml, u3, pp, ["payment", "stake"])


def test_aiken_mint_accepts(mesmo_lib, devkit):
    """The Aiken redeemer_check validator (test-fixtures/aiken/redeemer-check) passes iff the
    redeemer is the integer 42. Happy path: redeemer 42 → the node accepts and the asset lands.
    """
    _build_sign_submit(mesmo_lib, devkit, "plutus/aiken_mint_pass.yaml", ["payment"],
                       exec_units=EXEC_UNITS)
    _assert_minted_asset_at(devkit, MINT_RECEIVER)


def test_aiken_mint_rejects(mesmo_lib, devkit):
    """Negative validation: redeemer 0 makes the same validator evaluate to false, so phase-2
    validation fails and the node must reject the tx. Exec units are supplied manually — the
    lib's StaticTransactionEvaluator stamps them without running the script, which is exactly
    what lets a validation-failing tx reach the node.
    """
    pp = _reset_and_fund(devkit)

    utxos = devkit.get_utxos(INTENT_SENDER)
    result = mesmo_lib.quicktx.build(_read_fixture("plutus/aiken_mint_fail.yaml"),
                                   utxos, pp, exec_units=EXEC_UNITS)
    signed = _intent_sign(mesmo_lib, result["tx_cbor"], ["payment"])
    with pytest.raises(RuntimeError):
        devkit.submit_tx(signed)


def test_stake_delegation(mesmo_lib, devkit):
    """Register the stake address, register a pool keyed to the account, then delegate to that pool.
    (DevKit exposes no pool-list endpoint, so we delegate to a pool we create rather than discover.)
    Mirrors TestIntegrationStakeDelegation.
    """
    pp = _reset_and_fund(devkit)

    u = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    u2 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("pool_registration.yaml"), u2, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    u3 = devkit.get_utxos(INTENT_SENDER)
    deleg_yaml = _read_fixture("stake_delegation.yaml").replace(POOL_PLACEHOLDER, ACCOUNT_POOL_ID)
    _sign_submit(mesmo_lib, devkit, deleg_yaml, u3, pp, ["payment", "stake"])


def test_stake_withdrawal(mesmo_lib, devkit):
    """Conway requires a stake address to be vote-delegated to a DRep before it can withdraw, so the
    sequence is: register stake -> delegate voting power -> withdraw the (zero) reward balance.
    Mirrors TestIntegrationStakeWithdrawal.
    """
    pp = _reset_and_fund(devkit)

    u = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    u2 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("voting_delegation.yaml"), u2, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    u3 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("stake_withdrawal.yaml"), u3, pp,
                 ["payment", "stake"])


def test_info_proposal(mesmo_lib, devkit):
    """A Conway proposal's deposit-return account must be a registered stake address, so register it
    first, then submit the proposal in the next block. Mirrors TestIntegrationInfoProposal.
    """
    pp = _reset_and_fund(devkit)

    utxos = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), utxos, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    utxos2 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("governance_proposal.yaml"), utxos2, pp, ["payment"])


def test_voting(mesmo_lib, devkit):
    """A vote needs a registered DRep (the voter), a registered stake address (the proposal's return
    account), a live gov action to vote on, and the vote referencing it. Mirrors
    TestIntegrationVoting.
    """
    pp = _reset_and_fund(devkit)

    u = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("drep_registration.yaml"), u, pp,
                 ["payment", "drep"])
    devkit.wait_for_block(3)

    u2 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u2, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    # Submit an info proposal. Its tx hash (from the build result, not the garbled submit response)
    # is the gov action id we vote on.
    u3 = devkit.get_utxos(INTENT_SENDER)
    proposal = mesmo_lib.quicktx.build(_read_fixture("governance_proposal.yaml"), u3, pp)
    action_tx_hash = proposal["tx_hash"]
    signed_proposal = _intent_sign(mesmo_lib, proposal["tx_cbor"], ["payment"])
    assert devkit.submit_tx(signed_proposal)
    devkit.wait_for_block(3)

    # Vote on the proposal we just submitted.
    u4 = devkit.get_utxos(INTENT_SENDER)
    vote_yaml = _read_fixture("voting.yaml").replace(GOV_ACTION_PLACEHOLDER, action_tx_hash)
    _sign_submit(mesmo_lib, devkit, vote_yaml, u4, pp, ["payment", "drep"])


# --- Ledger-effect helpers (balance-delta read-backs) ---

# The compose fixture's second sender: same mnemonic, address_index 1.
INTENT_SENDER2 = ("addr_test1qz7svwszky8gcmhrfza7a89z9u0dfzd3l7h23sqlc5yml7e"
                  "jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwqcqrvr0")


def _balance_at(devkit, address):
    return sum(int(a["quantity"]) for u in devkit.get_utxos(address)
               for a in u["amount"] if a["unit"] == "lovelace")


def _sign_submit_fee(mesmo_lib, devkit, yaml_str, utxos, pp, keys, exec_units=None):
    """_sign_submit, additionally returning the tx fee so callers can assert the sender's exact
    balance change (the ledger read-back "submit accepted" alone can't give)."""
    result = mesmo_lib.quicktx.build(yaml_str, utxos, pp, exec_units=exec_units,
                                   additional_signers=max(0, len(keys) - 1))
    signed = _intent_sign(mesmo_lib, result["tx_cbor"], keys)
    assert devkit.submit_tx(signed)
    return int(result["fee"])


# --- Ledger-effect tests: certificate deposits must move the sender's balance exactly ---

def test_stake_deposit_round_trip(mesmo_lib, devkit):
    """The stake-key deposit must leave on registration and come back on deregistration."""
    pp = _reset_and_fund(devkit)
    key_deposit = int(pp["key_deposit"])
    start = _balance_at(devkit, INTENT_SENDER)

    u = devkit.get_utxos(INTENT_SENDER)
    fee1 = _sign_submit_fee(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u, pp,
                            ["payment", "stake"])
    devkit.wait_for_block(3)
    assert _balance_at(devkit, INTENT_SENDER) == start - fee1 - key_deposit

    u2 = devkit.get_utxos(INTENT_SENDER)
    fee2 = _sign_submit_fee(mesmo_lib, devkit, _read_fixture("stake_deregistration.yaml"), u2, pp,
                            ["payment", "stake"])
    devkit.wait_for_block(3)
    assert _balance_at(devkit, INTENT_SENDER) == start - fee1 - fee2  # deposit refunded


def test_drep_deposit_effect(mesmo_lib, devkit):
    """A DRep registration must take exactly fee + drep_deposit from the sender."""
    pp = _reset_and_fund(devkit)
    drep_deposit = int(pp["drep_deposit"])
    start = _balance_at(devkit, INTENT_SENDER)

    u = devkit.get_utxos(INTENT_SENDER)
    fee = _sign_submit_fee(mesmo_lib, devkit, _read_fixture("drep_registration.yaml"), u, pp,
                           ["payment", "drep"])
    devkit.wait_for_block(3)
    assert _balance_at(devkit, INTENT_SENDER) == start - fee - drep_deposit


def test_proposal_deposit_effect(mesmo_lib, devkit):
    """A governance proposal must take exactly fee + gov_action_deposit (after the stake
    registration takes fee + key_deposit for the deposit-return account)."""
    pp = _reset_and_fund(devkit)
    key_deposit = int(pp["key_deposit"])
    gov_deposit = int(pp["gov_action_deposit"])
    start = _balance_at(devkit, INTENT_SENDER)

    u = devkit.get_utxos(INTENT_SENDER)
    fee1 = _sign_submit_fee(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u, pp,
                            ["payment", "stake"])
    devkit.wait_for_block(3)

    u2 = devkit.get_utxos(INTENT_SENDER)
    fee2 = _sign_submit_fee(mesmo_lib, devkit, _read_fixture("governance_proposal.yaml"), u2, pp,
                            ["payment"])
    devkit.wait_for_block(3)

    assert _balance_at(devkit, INTENT_SENDER) == start - fee1 - key_deposit - fee2 - gov_deposit


def test_pool_deposit_effect(mesmo_lib, devkit):
    """A pool registration must take exactly fee + pool_deposit (after the stake registration)."""
    pp = _reset_and_fund(devkit)
    key_deposit = int(pp["key_deposit"])
    pool_deposit = int(pp["pool_deposit"])
    start = _balance_at(devkit, INTENT_SENDER)

    u = devkit.get_utxos(INTENT_SENDER)
    fee1 = _sign_submit_fee(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u, pp,
                            ["payment", "stake"])
    devkit.wait_for_block(3)

    u2 = devkit.get_utxos(INTENT_SENDER)
    fee2 = _sign_submit_fee(mesmo_lib, devkit, _read_fixture("pool_registration.yaml"), u2, pp,
                            ["payment", "stake"])
    devkit.wait_for_block(3)

    assert _balance_at(devkit, INTENT_SENDER) == start - fee1 - key_deposit - fee2 - pool_deposit


# --- Never-submitted intents from the coverage audit ---

def test_collect_from(mesmo_lib, devkit):
    """collect_from: spend exactly the named UTXO instead of automatic selection."""
    pp = _reset_and_fund(devkit)

    utxos = devkit.get_utxos(INTENT_SENDER)
    assert utxos
    target = utxos[0]
    yaml_str = _read_fixture("collect_from.yaml").replace("a" * 64, target["tx_hash"])
    idx = int(target.get("output_index", 0))
    if idx != 0:
        yaml_str = yaml_str.replace("output_index: 0", f"output_index: {idx}", 1)

    _sign_submit(mesmo_lib, devkit, yaml_str, utxos, pp, ["payment"])


def test_reference_input(mesmo_lib, devkit):
    """reference_input: a read-only reference input (CIP-31) must resolve to a real UTXO; fund the
    second intent address and reference its UTXO (it is not spent — its balance must not change)."""
    devkit.reset()
    devkit.wait_for_block(3)
    devkit.topup(INTENT_SENDER, 6000)
    devkit.topup(INTENT_SENDER2, 5)
    devkit.wait_for_block(3)
    pp = _devnet_pp(devkit)

    ref_utxos = devkit.get_utxos(INTENT_SENDER2)
    assert ref_utxos
    ref_balance = _balance_at(devkit, INTENT_SENDER2)
    yaml_str = _read_fixture("reference_input.yaml").replace("c" * 64, ref_utxos[0]["tx_hash"])

    utxos = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, yaml_str, utxos, pp, ["payment"])
    devkit.wait_for_block(3)

    assert _balance_at(devkit, INTENT_SENDER2) == ref_balance  # referenced, not spent


def test_native_script_spend(mesmo_lib, devkit):
    """native_script: a script witness may only be attached when the transaction actually uses the
    script — Conway rejects unused witnesses (ExtraneousScriptWitnessesUTXOW; the standalone
    "attach" fixture proved that on its first devnet submission, which is why it stays
    offline-build only). So exercise the real thing: lock funds at a sig(payment-key) native
    script address built at test time, then spend them with the script attached, witnessed by the
    payment key. This is the only test of native-script *spending* (minting is covered
    separately)."""
    import json as _json
    pp = _reset_and_fund(devkit)

    # Build a native script the sender's payment key satisfies, and its script address.
    info = mesmo_lib.address.info(INTENT_SENDER)
    script = _json.loads(mesmo_lib.script.native_from_json(
        _json.dumps({"type": "sig", "keyHash": info["payment_credential_hash"]})))
    # native_from_json's cbor_hex is the hash preimage (leading 0x00 language tag); the TxPlan
    # native_script block wants the bare script CBOR.
    script_hex = script["cbor_hex"][2:]
    script_address = mesmo_lib.address.from_bytes("70" + script["script_hash"])  # testnet script enterprise

    # Step 1: lock 5 ADA at the script address.
    lock_yaml = f"""
version: 1.0
transaction:
  - tx:
      from: {INTENT_SENDER}
      change_address: {INTENT_SENDER}
      intents:
        - type: payment
          address: {script_address}
          amounts:
            - unit: lovelace
              quantity: "5000000"
"""
    u = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, lock_yaml, u, pp, ["payment"])
    devkit.wait_for_block(3)

    # Step 2: spend the locked UTXO with the native script attached.
    script_utxos = devkit.get_utxos(script_address)
    assert script_utxos
    lock_hash = script_utxos[0]["tx_hash"]
    lock_idx = int(script_utxos[0].get("output_index", 0))

    spend_yaml = f"""
version: 1.0
context:
  fee_payer: {INTENT_SENDER}
transaction:
  - tx:
      from: {INTENT_SENDER}
      change_address: {INTENT_SENDER}
      inputs:
        - type: collect_from
          utxo_refs:
            - tx_hash: {lock_hash}
              output_index: {lock_idx}
      intents:
        - type: payment
          address: {INTENT_SENDER}
          amounts:
            - unit: lovelace
              quantity: "3000000"
      scripts:
        - type: native_script
          script_hex: {script_hex}
"""
    fee_utxos = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, spend_yaml, script_utxos + fee_utxos, pp, ["payment"],
                 additional_signers=1)

    _assert_utxo_consumed(devkit, script_address, lock_hash)


def test_pool_update(mesmo_lib, devkit):
    """pool_update: re-submit the pool's registration certificate with update semantics."""
    pp = _reset_and_fund(devkit)

    u = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("stake_registration.yaml"), u, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    u2 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("pool_registration.yaml"), u2, pp,
                 ["payment", "stake"])
    devkit.wait_for_block(3)

    u3 = devkit.get_utxos(INTENT_SENDER)
    _sign_submit(mesmo_lib, devkit, _read_fixture("pool_update.yaml"), u3, pp,
                 ["payment", "stake"])


def test_compose_two_senders(mesmo_lib, devkit):
    """compose: two senders' intents composed into ONE transaction, signed once per sender's
    payment key (same mnemonic, address_index 0 and 1); both payments must land at the receiver."""
    devkit.reset()
    devkit.wait_for_block(3)
    devkit.topup(INTENT_SENDER, 6000)
    devkit.topup(INTENT_SENDER2, 6000)
    devkit.wait_for_block(3)
    pp = _devnet_pp(devkit)

    utxos = devkit.get_utxos(INTENT_SENDER) + devkit.get_utxos(INTENT_SENDER2)
    result = mesmo_lib.quicktx.build(_read_fixture("compose.yaml"), utxos, pp)
    once = _intent_sign(mesmo_lib, result["tx_cbor"])
    twice = _intent_sign(mesmo_lib, once, address_index=1)
    assert devkit.submit_tx(twice)
    devkit.wait_for_block(3)

    # 5 ADA from sender1 + 3 ADA from sender2, both to the same receiver.
    assert _balance_at(devkit, MINT_RECEIVER) == 8_000_000


def test_scalus_computed_units(mesmo_lib, devkit):
    """The offline Scalus evaluator is the DEFAULT costing path: when a caller supplies no
    execution units, libmesmo computes them in-process (ADR-0013). Every other Plutus test supplies
    units manually (they must, to submit a failing script), so this is the only test proving the
    node accepts Scalus-computed budgets end-to-end — the path out-of-the-box users are on."""
    _build_sign_submit(mesmo_lib, devkit, "plutus/script_minting.yaml", ["payment"])
    _assert_minted_asset_at(devkit, MINT_RECEIVER)
