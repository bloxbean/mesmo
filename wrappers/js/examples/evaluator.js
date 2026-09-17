// Build a Plutus-script transaction and get its execution units two ways.
//
// A Plutus build needs each redeemer's execution units. This example mints a token with an
// always-succeeds validator and shows both ways to obtain them:
//   1. the offline default — the lib computes the units in-process with Scalus (no network); and
//   2. a remote TransactionEvaluator (Blockfrost) — illustrative, requires a project id.
//
// libmesmo never makes HTTP calls (ADR-0013 / ADR-0002), so a remote evaluator lives here in the
// wrapper: buildWith runs a two-pass (draft -> evaluate -> rebuild).
//
// Run from wrappers/js:
//
//   LIB_DIR=../../core/build/native/nativeCompile
//   MESMO_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
//     bun examples/evaluator.js
import { readFileSync } from 'fs';
import { Mesmo, BlockfrostEvaluator } from '../src/index.js'; // BlockfrostEvaluator: see snippet below

// Shared fixtures: an always-succeeds mint (TxPlan YAML), the sender's UTXOs, and protocol
// parameters *with cost models* (Scalus needs them to run the UPLC machine).
const FIXTURES = `${import.meta.dir}/../../../test-fixtures/plutus-mint-scalus`;
const yaml = readFileSync(`${FIXTURES}/mint.yaml`, 'utf8');
const utxos = JSON.parse(readFileSync(`${FIXTURES}/utxos.json`, 'utf8'));
const params = JSON.parse(readFileSync(`${FIXTURES}/protocol-params.json`, 'utf8'));
const sender = utxos[0].address;

// A trivial provider that returns the fixtures above (stands in for Blockfrost/Yaci/…).
const provider = {
  utxos: async () => utxos,
  protocolParams: async () => params,
};

const lib = new Mesmo();
try {
  // 1) Offline default: no evaluator -> the lib runs the validator with Scalus and stamps the
  //    computed units. Just works, no network.
  const result = await lib.quicktx.buildWith(yaml, provider, [sender]);
  console.log('offline (Scalus) — fee:', result.fee, 'tx_hash:', result.tx_hash);

  // 2) Remote evaluator (illustrative — needs a Blockfrost project id). The two-pass builds a
  //    draft, POSTs it to /utils/txs/evaluate, and rebuilds with the returned units:
  //
  //   const evaluator = new BlockfrostEvaluator('preprod_your_project_id', { network: 'preprod' });
  //   const result = await lib.quicktx.buildWith(yaml, provider, [sender], evaluator);
  //
  // To supply units you computed yourself, skip the evaluator and call build() directly:
  //   lib.quicktx.build(yaml, utxos, params, [{ mem: 2000000, steps: 500000000 }]);
} finally {
  lib.close();
}
