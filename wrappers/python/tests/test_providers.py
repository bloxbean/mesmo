"""Unit tests for the optional chain-data provider helpers.

These exercise the HTTP-shaping logic (URLs, headers, pagination, address injection) and the
build_with composition without a live backend — the actual Yaci round-trip is covered by
the DevKit integration tests.
"""
from unittest import mock

from ccl.providers import YaciProvider, BlockfrostProvider, ChainDataProvider
from ccl.quicktx import QuickTx


def test_yaci_provider_urls():
    with mock.patch("ccl.providers._http_get_json") as get:
        get.return_value = {"ok": True}
        p = YaciProvider()
        p.utxos("addr_test1xyz")
        p.protocol_params()
    assert get.call_args_list[0].args[0] == \
        "http://localhost:10000/local-cluster/api/addresses/addr_test1xyz/utxos"
    assert get.call_args_list[1].args[0] == \
        "http://localhost:10000/local-cluster/api/epochs/parameters"


def test_yaci_provider_custom_base_url_trailing_slash():
    with mock.patch("ccl.providers._http_get_json") as get:
        get.return_value = []
        YaciProvider(base_url="http://host:9999/api/").utxos("addrX")
    assert get.call_args.args[0] == "http://host:9999/api/addresses/addrX/utxos"


def test_blockfrost_network_url_and_project_id_header():
    with mock.patch("ccl.providers._http_get_json") as get:
        get.return_value = {}
        BlockfrostProvider("proj123", network="preprod").protocol_params()
    url = get.call_args.args[0]
    headers = get.call_args.kwargs["headers"]
    assert url == "https://cardano-preprod.blockfrost.io/api/v0/epochs/latest/parameters"
    assert headers == {"project_id": "proj123"}


def test_blockfrost_unknown_network_raises():
    try:
        BlockfrostProvider("p", network="nope")
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_blockfrost_utxos_paginate_and_inject_address():
    page1 = [{"tx_hash": f"{i:064x}", "output_index": 0,
              "amount": [{"unit": "lovelace", "quantity": "1000000"}]} for i in range(100)]
    page2 = [{"tx_hash": "ff" * 32, "output_index": 1,
              "amount": [{"unit": "lovelace", "quantity": "2000000"}]}]

    def fake_get(url, headers=None, timeout=30):
        return page1 if "page=1" in url else page2 if "page=2" in url else []

    with mock.patch("ccl.providers._http_get_json", side_effect=fake_get):
        utxos = BlockfrostProvider("p", network="preview").utxos("addr_test1abc")

    assert len(utxos) == 101                       # paged until a short page
    assert all(u["address"] == "addr_test1abc" for u in utxos)   # address injected on every UTXO


def test_build_with_composes_fetch_and_build():
    sentinel_utxos = [{"tx_hash": "a" * 64, "output_index": 0, "address": "addrX",
                       "amount": [{"unit": "lovelace", "quantity": "9"}]}]
    sentinel_pp = {"min_fee_a": 44}

    class StubProvider(ChainDataProvider):
        def utxos(self, address):
            assert address == "addrX"
            return sentinel_utxos

        def protocol_params(self):
            return sentinel_pp

    qt = QuickTx(bridge=None)
    calls = []
    qt.build = lambda y, u, p, e=None, additional_signers=0: (
        calls.append((y, u, p, e, additional_signers)), {"tx_cbor": "DRAFT"})[1]

    # No evaluator → fetch chain data, then build once with no units (the offline Scalus default).
    qt.build_with("YAML", StubProvider(), ["addrX"])
    assert calls == [("YAML", sentinel_utxos, sentinel_pp, None, 0)]

    # With an evaluator → two-pass: draft build, evaluate(draft), rebuild with the returned units.
    calls.clear()

    class StubEvaluator:
        def evaluate(self, tx_cbor, utxos=None):
            assert tx_cbor == "DRAFT"
            assert utxos == sentinel_utxos
            return [{"mem": 1, "steps": 2}]

    qt.build_with("YAML", StubProvider(), ["addrX"], evaluator=StubEvaluator())
    assert calls == [
        ("YAML", sentinel_utxos, sentinel_pp, None, 0),                      # draft
        ("YAML", sentinel_utxos, sentinel_pp, [{"mem": 1, "steps": 2}], 0),  # rebuild
    ]


def test_build_with_merges_and_dedupes_utxos_across_senders():
    """Multi-sender fetch: UTXOs are merged per sender and de-duplicated by
    (tx_hash, output_index) — overlapping senders must not double-fund the build."""
    shared = {"tx_hash": "a" * 64, "output_index": 0, "address": "addrA",
              "amount": [{"unit": "lovelace", "quantity": "9"}]}
    only_b = {"tx_hash": "b" * 64, "output_index": 1, "address": "addrB",
              "amount": [{"unit": "lovelace", "quantity": "7"}]}

    class TwoSenderProvider(ChainDataProvider):
        def utxos(self, address):
            return [shared] if address == "addrA" else [shared, only_b]

        def protocol_params(self):
            return {"min_fee_a": 44}

    qt = QuickTx(bridge=None)
    calls = []
    qt.build = lambda y, u, p, e=None, additional_signers=0: (
        calls.append(u), {"tx_cbor": "DRAFT"})[1]

    qt.build_with("YAML", TwoSenderProvider(), ["addrA", "addrB"])
    assert calls == [[shared, only_b]], "the shared UTXO must appear exactly once"
