"""Unit tests for the transaction-evaluator helpers (no native lib / no network needed)."""
from mesmo.providers import (
    BlockfrostEvaluator,
    TransactionEvaluator,
    _parse_evaluation,
)


def test_parse_evaluation_map_form_orders_by_redeemer():
    # Older Ogmios / Blockfrost: map keyed by "<purpose>:<index>". spend (0) must come before mint (1).
    resp = {"result": {"EvaluationResult": {
        "mint:0": {"memory": 1400, "steps": 208100},
        "spend:0": {"memory": 700, "steps": 100000},
    }}}
    assert _parse_evaluation(resp) == [
        {"mem": 700, "steps": 100000},
        {"mem": 1400, "steps": 208100},
    ]


def test_parse_evaluation_ogmios_v6_list_form():
    resp = {"result": [
        {"validator": {"index": 0, "purpose": "mint"}, "budget": {"memory": 1400, "cpu": 208100}},
        {"validator": "spend:0", "budget": {"memory": 700, "cpu": 100000}},
    ]}
    assert _parse_evaluation(resp) == [
        {"mem": 700, "steps": 100000},
        {"mem": 1400, "steps": 208100},
    ]


def test_blockfrost_evaluator_setup():
    ev = BlockfrostEvaluator("proj_id", network="preprod")
    assert isinstance(ev, TransactionEvaluator)
    assert ev.base_url.endswith("cardano-preprod.blockfrost.io/api/v0")
    assert ev._headers["project_id"] == "proj_id"
    assert ev._headers["Content-Type"] == "application/cbor"


def test_blockfrost_evaluator_unknown_network_requires_base_url():
    import pytest

    with pytest.raises(ValueError):
        BlockfrostEvaluator("proj_id", network="does-not-exist")
