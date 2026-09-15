import json

import yaml


class QuickTx:
    """Builds unsigned transactions from a CCL TxPlan (YAML), fully offline.

    The transaction is defined by a TxPlan YAML document; the caller supplies the chain data
    (UTXOs and protocol parameters). Nothing is fetched and nothing is submitted — the result
    is the unsigned transaction CBOR plus its hash and fee.
    """

    def __init__(self, bridge):
        self._bridge = bridge

    def build(self, txplan_yaml, utxos, protocol_params, exec_units=None, additional_signers=0):
        """Build an unsigned transaction from a TxPlan YAML document.

        Args:
            txplan_yaml: the TxPlan YAML string defining the transaction(s).
            utxos: list of UTXO dicts (CCL ``Utxo`` model) available to the sender.
            protocol_params: protocol parameters dict (CCL ``ProtocolParams`` model).
            exec_units: optional list of redeemer execution units (``[{"mem","steps"}]``), one per
                redeemer in transaction order, for Plutus script transactions. Compute these with any
                evaluator (Ogmios, Blockfrost, Aiken, Scalus); the bridge does not run the script.
            additional_signers: number of vkey witnesses the fee must budget beyond those implied by
                the input UTXOs (one per sender). You know how many keys will sign: ``0`` for a plain
                payment, ``1`` for a stake or DRep certificate (``["payment", "stake"]`` signing),
                ``2`` for stake + DRep in one tx, the number of ``sig`` keys for a native-script
                spend, plus one per plan-level required signer. Undercounting yields a fee the node
                rejects with ``FeeTooSmallUTxO``; overcounting only overpays (~4,400 lovelace per
                extra witness).

        Returns:
            dict with ``tx_cbor``, ``tx_hash`` and ``fee`` (parsed from the YAML result).
        """
        utxos_json = json.dumps(utxos)
        pp_json = json.dumps(protocol_params)
        exec_units_json = json.dumps(exec_units) if exec_units is not None else None
        rc = self._bridge._lib.mesmo_quicktx_build(
            self._bridge._thread,
            self._bridge._encode(txplan_yaml),
            self._bridge._encode(utxos_json),
            self._bridge._encode(pp_json),
            self._bridge._encode(exec_units_json),
            int(additional_signers),
        )
        return yaml.safe_load(self._bridge._check(rc))

    def build_with(self, txplan_yaml, provider, senders, evaluator=None, additional_signers=0):
        """Fetch chain data from ``provider`` (and, optionally, execution units from ``evaluator``),
        then build — in one call.

        Composes ``provider.utxos(sender)`` for every sender + ``provider.protocol_params()``
        with :meth:`build`. UTXOs are de-duplicated by ``(tx_hash, output_index)``, so overlapping
        senders can't double-fund the build. For multi-sender transactions, TxPlan's
        ``context.fee_payer`` decides who pays the fee.
        The bridge stays offline — this only moves the optional HTTP fetch into wrapper code. See
        :mod:`ccl.providers` for available providers (Yaci DevKit, Blockfrost) or implement your own.

        Execution units for Plutus scripts:
          - with an ``evaluator``: a remote two-pass — build a draft, ask the evaluator to compute the
            units (e.g. Blockfrost ``/utils/txs/evaluate``), rebuild with them;
          - without one: the native library's offline Scalus default.

        To supply units yourself, call :meth:`build` directly with ``exec_units``.

        Args:
            txplan_yaml: the TxPlan YAML string defining the transaction(s).
            provider: a :class:`ccl.providers.ChainDataProvider` (``utxos(address)`` + ``protocol_params()``).
            senders: list of addresses whose UTXOs fund the transaction(s).
            evaluator: optional :class:`ccl.providers.TransactionEvaluator` (``evaluate(tx_cbor, utxos)``)
                to compute the units remotely; when omitted, the offline Scalus default is used.

        Returns:
            dict with ``tx_cbor``, ``tx_hash`` and ``fee``.
        """
        utxos = []
        seen = set()
        for sender in senders:
            for u in provider.utxos(sender):
                key = (u.get("tx_hash"), u.get("output_index"))
                if key not in seen:
                    seen.add(key)
                    utxos.append(u)
        protocol_params = provider.protocol_params()
        exec_units = None
        if evaluator is not None:
            # Two-pass: draft (units computed offline by Scalus) → remote evaluate → rebuild.
            draft = self.build(txplan_yaml, utxos, protocol_params,
                               additional_signers=additional_signers)
            exec_units = evaluator.evaluate(draft["tx_cbor"], utxos)
        return self.build(txplan_yaml, utxos, protocol_params, exec_units,
                          additional_signers=additional_signers)
