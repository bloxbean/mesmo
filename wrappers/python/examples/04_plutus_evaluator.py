"""Build a Plutus-script transaction and get its execution units two ways.

A Plutus build needs each redeemer's execution units. This example mints a token with an
always-succeeds validator and shows both ways to obtain them:

  1. the offline default — the lib computes the units in-process with Scalus (no network); and
  2. a remote TransactionEvaluator (Blockfrost) — illustrative, requires a project id.

libmesmo never makes HTTP calls (ADR-0013 / ADR-0002), so a remote evaluator lives here in the
wrapper: ``build_with`` runs a two-pass (draft -> evaluate -> rebuild).

Run from the repo root:

    LIB_DIR=core/build/native/nativeCompile
    PYTHONPATH=wrappers/python MESMO_LIB_PATH=$LIB_DIR \
    DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
      python3 wrappers/python/examples/04_plutus_evaluator.py
"""
import json
from pathlib import Path

from mesmo import Mesmo, BlockfrostEvaluator  # noqa: F401 (BlockfrostEvaluator used in the snippet below)

# Shared fixtures: an always-succeeds mint (TxPlan YAML), the sender's UTXOs, and protocol
# parameters *with cost models* (Scalus needs them to run the UPLC machine).
FIXTURES = Path(__file__).resolve().parents[3] / "test-fixtures" / "plutus-mint-scalus"
YAML = (FIXTURES / "mint.yaml").read_text()
UTXOS = json.loads((FIXTURES / "utxos.json").read_text())
PARAMS = json.loads((FIXTURES / "protocol-params.json").read_text())
SENDER = UTXOS[0]["address"]


class LocalProvider:
    """A trivial provider that returns the fixtures above (stands in for Blockfrost/Yaci/…)."""

    def utxos(self, address):
        return UTXOS

    def protocol_params(self):
        return PARAMS


def main():
    lib = Mesmo()

    # 1) Offline default: no evaluator -> the lib runs the validator with Scalus and stamps the
    #    computed units. Just works, no network.
    result = lib.quicktx.build_with(YAML, LocalProvider(), [SENDER])
    print("offline (Scalus) — fee:", result["fee"], "tx_hash:", result["tx_hash"])

    # 2) Remote evaluator (illustrative — needs a Blockfrost project id). The two-pass builds a
    #    draft, POSTs it to /utils/txs/evaluate, and rebuilds with the returned units:
    #
    #     evaluator = BlockfrostEvaluator("preprod_your_project_id", network="preprod")
    #     result = lib.quicktx.build_with(YAML, LocalProvider(), [SENDER], evaluator=evaluator)
    #
    # To supply units you computed yourself, skip the evaluator and call build() directly:
    #     lib.quicktx.build(YAML, UTXOS, PARAMS, exec_units=[{"mem": 2000000, "steps": 500000000}])


if __name__ == "__main__":
    main()
