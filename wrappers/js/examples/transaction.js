// Build and sign a payment transaction fully offline from a TxPlan (YAML).
//
// The transaction is defined as a TxPlan YAML document; we supply the UTXOs and protocol
// parameters ourselves (no node / no provider), build the unsigned CBOR, then sign it locally.
// Submitting it is a separate, online step.
//
// Run from wrappers/js:
//
//   LIB_DIR=../../core/build/native/nativeCompile
//   CCL_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
//     bun examples/transaction.js
import { CclBridge, TESTNET } from '../src/index.js';

// Minimal protocol parameters (CCL test-resource values).
const protocolParams = {
  min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384,
  key_deposit: '2000000', pool_deposit: '500000000',
  coins_per_utxo_size: '4310', max_val_size: '5000',
  max_tx_ex_mem: '10000000', max_tx_ex_steps: '10000000000',
  price_mem: 0.0577, price_step: 0.0000721, collateral_percent: 150,
  max_collateral_inputs: 3,
};

const bridge = new CclBridge();
try {
  using sender = bridge.accounts.create(TESTNET); // managed handle — signs below
  using receiver = bridge.accounts.create(TESTNET);
  const senderAddress = sender.info.base_address;
  const receiverAddress = receiver.info.base_address;

  // A static UTXO the sender controls (100 ADA), instead of querying a node.
  const utxos = [{
    tx_hash: 'a'.repeat(64),
    output_index: 0,
    address: senderAddress,
    amount: [{ unit: 'lovelace', quantity: '100000000' }],
  }];

  // Define the transaction as a TxPlan YAML document: pay 5 ADA to the receiver.
  const yaml = `
version: 1.0
transaction:
  - tx:
      from: ${senderAddress}
      intents:
        - type: payment
          address: ${receiverAddress}
          amounts:
            - unit: lovelace
              quantity: "5000000"
`;

  // Build the unsigned transaction offline.
  const result = bridge.quicktx.build(yaml, utxos, protocolParams);
  console.log('Built unsigned transaction from TxPlan YAML');
  console.log('  tx hash:', result.tx_hash);
  console.log('  fee    :', result.fee);
  console.log('  cbor   :', result.tx_cbor.slice(0, 80), '...');

  // Sign it with the sender's managed handle — no mnemonic in the call.
  const signed = sender.signTx(result.tx_cbor);
  console.log('Signed transaction cbor:', signed.slice(0, 80), '...');
  console.log('\nNext step (not shown): submit `signed` to a Cardano node over HTTP.');
} finally {
  bridge.close();
}
