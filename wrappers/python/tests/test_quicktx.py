import pytest

from ccl._ffi import CclError
from ccl.network import Network

# Minimal protocol parameters (CCL ProtocolParams model).
def _addr(ccl):
    """A fresh testnet address (managed handle, closed immediately)."""
    with ccl.accounts.create(Network.TESTNET) as acct:
        return acct.info["base_address"]


PROTOCOL_PARAMS = {
    "min_fee_a": 44, "min_fee_b": 155381, "max_tx_size": 16384,
    "key_deposit": "2000000", "pool_deposit": "500000000",
    "coins_per_utxo_size": "4310", "max_val_size": "5000",
    "max_tx_ex_mem": "10000000", "max_tx_ex_steps": "10000000000",
    "price_mem": 0.0577, "price_step": 0.0000721, "collateral_percent": 150,
    "max_collateral_inputs": 3,
}

FAKE_TX_HASH = "a" * 64


def _utxos(address, lovelace=100_000_000):
    return [{
        "tx_hash": FAKE_TX_HASH,
        "output_index": 0,
        "address": address,
        "amount": [{"unit": "lovelace", "quantity": str(lovelace)}],
    }]


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


def _assert_built(result):
    assert isinstance(result, dict)
    assert len(result["tx_cbor"]) > 0
    assert len(result["tx_hash"]) == 64
    assert int(result["fee"]) > 0


def test_simple_payment(ccl):
    sender = _addr(ccl)
    receiver = _addr(ccl)
    yaml_str = _payment_yaml(sender, receiver, "5000000")
    _assert_built(ccl.quicktx.build(yaml_str, _utxos(sender), PROTOCOL_PARAMS))


def test_multiple_payments(ccl):
    sender = _addr(ccl)
    r1 = _addr(ccl)
    r2 = _addr(ccl)
    yaml_str = f"""
version: 1.0
transaction:
  - tx:
      from: {sender}
      intents:
        - type: payment
          address: {r1}
          amounts:
            - unit: lovelace
              quantity: "5000000"
        - type: payment
          address: {r2}
          amounts:
            - unit: lovelace
              quantity: "3000000"
"""
    _assert_built(ccl.quicktx.build(yaml_str, _utxos(sender), PROTOCOL_PARAMS))


def test_variable_substitution(ccl):
    sender = _addr(ccl)
    receiver = _addr(ccl)
    yaml_str = f"""
version: 1.0
variables:
  to: {receiver}
  amount: "4000000"
transaction:
  - tx:
      from: {sender}
      intents:
        - type: payment
          address: ${{to}}
          amounts:
            - unit: lovelace
              quantity: ${{amount}}
"""
    _assert_built(ccl.quicktx.build(yaml_str, _utxos(sender), PROTOCOL_PARAMS))


def test_insufficient_funds(ccl):
    sender = _addr(ccl)
    receiver = _addr(ccl)
    yaml_str = _payment_yaml(sender, receiver, "200000000")
    with pytest.raises(CclError):
        ccl.quicktx.build(yaml_str, _utxos(sender, 1_000_000), PROTOCOL_PARAMS)


# A Plutus mint TxPlan (always-succeeds V2 policy). The script is not executed offline; the
# caller-supplied execution units are stamped onto the redeemer by the static evaluator.
MINT_ADDR = ("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8"
             "ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp")
MINT_YAML = f"""
version: 1.0
context:
  fee_payer: {MINT_ADDR}
transaction:
- tx:
    from: {MINT_ADDR}
    intents:
    - policyId: 793f8c8cffba081b2a56462fc219cc8fe652d6a338b62c7b134876e7
      type: script_minting
      assets:
      - name: TestToken
        value: 1
      receiver: {MINT_ADDR}
      redeemer:
        int: 0
    scripts:
    - type: validator
      role: mint
      cbor_hex: 4e4d01000033222220051200120011
      version: v2
"""


def test_plutus_mint_with_exec_units(ccl):
    # One redeemer (the mint) -> one ExUnits, supplied by the caller.
    result = ccl.quicktx.build(
        MINT_YAML, _utxos(MINT_ADDR), PROTOCOL_PARAMS,
        exec_units=[{"mem": 2000000, "steps": 500000000}])
    _assert_built(result)


def test_plutus_mint_without_exec_units_fails(ccl):
    with pytest.raises(CclError):
        ccl.quicktx.build(MINT_YAML, _utxos(MINT_ADDR), PROTOCOL_PARAMS)
