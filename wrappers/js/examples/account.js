// Account creation and key derivation (offline).
//
// Run from wrappers/js:
//
//   LIB_DIR=../../core/build/native/nativeCompile
//   CCL_LIB_PATH=$LIB_DIR DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
//     bun examples/account.js
import { CclBridge, TESTNET } from '../src/index.js';

const bridge = new CclBridge();
try {
  // 1. Create a brand-new testnet account (managed handle; the recovery phrase is
  //    exported once, deliberately — it is never part of the account's info).
  using account = bridge.accounts.create(TESTNET);
  const { base_address, drep_id } = account.info;
  const mnemonic = account.exportRecoveryPhrase();
  console.log('Created account');
  console.log('  base address:', base_address);
  console.log('  DRep ID     :', drep_id);
  console.log('  mnemonic    :', mnemonic);

  // 2. Restore the same account from its phrase — the address must match.
  using restored = bridge.accounts.fromMnemonic(mnemonic, TESTNET, 0, 0);
  const restoredAddress = restored.info.base_address;
  if (restoredAddress !== base_address) throw new Error('address mismatch');
  console.log('Restored from mnemonic — address matches:', restoredAddress);

  // 3. Raw key material, when interop genuinely needs it, comes from the stateless
  //    derivation utility — handles never expose key bytes.
  const key = bridge.crypto.deriveKey(mnemonic);
  console.log('  private key (extended, hex):', key.private_key);
  console.log('  public key (hex)           :', key.public_key);
} finally {
  bridge.close();
}
