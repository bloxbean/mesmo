"""Native-image runtime check for the Scalus transaction evaluator.

Builds a real Plutus mint (always-succeeds validator) with **no caller-supplied execution units** —
so the core falls back to Scalus, which runs the UPLC evaluator to compute the units. This exercises
Scalus *inside the native library* (not just on the JVM), on whatever platform CI runs.
"""
import json
from pathlib import Path

FIXTURES = Path(__file__).parent / "../../../test-fixtures/plutus-mint-scalus"


def test_plutus_mint_falls_back_to_scalus(ccl):
    yaml = (FIXTURES / "mint.yaml").read_text()
    utxos = json.loads((FIXTURES / "utxos.json").read_text())
    # Params include cost models (Scalus needs them to run the UPLC machine).
    params = json.loads((FIXTURES / "protocol-params.json").read_text())

    # exec_units omitted → Scalus computes them offline by evaluating the validator in libccl.
    result = ccl.quicktx.build(yaml, utxos, params)

    assert result.get("tx_cbor"), "expected a built transaction"
    assert result.get("tx_hash")
    assert int(result["fee"]) > 0


def test_build_with_uses_supplied_evaluator(ccl):
    """A wrapper-side Evaluator (here a fake) overrides the Scalus default via the two-pass flow."""
    yaml = (FIXTURES / "mint.yaml").read_text()
    utxos = json.loads((FIXTURES / "utxos.json").read_text())
    params = json.loads((FIXTURES / "protocol-params.json").read_text())
    sender = utxos[0]["address"]

    class _FakeProvider:
        def utxos(self, address):
            return utxos

        def protocol_params(self):
            return params

    class _FakeEvaluator:
        def __init__(self):
            self.draft_cbor = None

        def evaluate(self, tx_cbor, utxos=None):
            self.draft_cbor = tx_cbor
            # Larger than Scalus's units (but within budget) so the resulting fee visibly differs.
            return [{"mem": 500000, "steps": 250000000}]

    scalus_fee = int(ccl.quicktx.build(yaml, utxos, params)["fee"])

    evaluator = _FakeEvaluator()
    result = ccl.quicktx.build_with(yaml, _FakeProvider(), [sender], evaluator=evaluator)

    assert evaluator.draft_cbor, "evaluator should be consulted with the draft transaction"
    assert result["tx_cbor"]
    # The evaluator-supplied (larger) units were stamped, not Scalus's -> higher fee.
    assert int(result["fee"]) > scalus_fee
