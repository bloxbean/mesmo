// Managed-account object tests (ADR-0016 slice 7): lifecycle, typed-role signing parity with the
// mnemonic-per-call path, one-shot recovery-phrase export, and secret hygiene. Fully offline.
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import {
  CclBridge, CclError, CCL_ERROR_INVALID_HANDLE, SigningRole, TESTNET,
} from '../src/index.js';

const TEST_MNEMONIC = 'test walk nut penalty hip pave soap entry language right filter choice';

const PROTOCOL_PARAMS = {
  min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384,
  key_deposit: '2000000', pool_deposit: '500000000',
  coins_per_utxo_size: '4310', max_val_size: '5000',
  max_tx_ex_mem: '10000000', max_tx_ex_steps: '10000000000',
  price_mem: 0.0577, price_step: 0.0000721, collateral_percent: 150,
  max_collateral_inputs: 3,
};

let bridge;

beforeAll(() => { bridge = new CclBridge(); });
afterAll(() => bridge.close());

function unsignedStakeReg(info) {
  const yaml = `
version: 1.0
transaction:
  - tx:
      from: ${info.base_address}
      intents:
        - type: stake_registration
          stake_address: ${info.stake_address}
`;
  const utxos = [{
    tx_hash: 'a'.repeat(64), output_index: 0, address: info.base_address,
    amount: [{ unit: 'lovelace', quantity: '2000000000' }],
  }];
  return bridge.quicktx.build(yaml, utxos, PROTOCOL_PARAMS, null, 1).tx_cbor;
}

describe('managed accounts', () => {
  it('open info matches the pinned derivation and carries no secret', () => {
    const acct = bridge.accounts.fromMnemonic(TEST_MNEMONIC, TESTNET);
    try {
      const info = acct.info;
      // Pinned CIP-1852 derivation for the standard CCL test mnemonic at testnet 0/0; the
      // mnemonic-path equivalence proof lives in the core's AccountKeyDerivationParityTest.
      expect(info.base_address).toBe(
        'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer' +
        '3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp');
      expect(info.stake_address).toBe(
        'stake_test1uqevw2xnsc0pvn9t9r9c7qryfqfeerchgrlm3ea2nefr9hqp8n5xl');
      expect(info.change_address).toBe(
        'addr_test1qz4kjk0as0x7ptt54l6cnfyzejqg22cku0qhqx6al4g2xe' +
        'pjcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq5hxe5g');
      expect(info.network).toBe(TESTNET);
      expect(info.mnemonic).toBeUndefined();
    } finally {
      acct.close();
    }
  });

  it('signing is deterministic, adds role witnesses, mask order irrelevant', () => {
    const acct = bridge.accounts.fromMnemonic(TEST_MNEMONIC, TESTNET);
    try {
      const unsigned = unsignedStakeReg(acct.info);

      // Deterministic: signing twice yields byte-identical output.
      expect(acct.signTx(unsigned)).toBe(acct.signTx(unsigned));
      const both = acct.signTx(unsigned, SigningRole.PAYMENT | SigningRole.STAKE);
      // The stake role adds a second witness.
      expect(both.length).toBeGreaterThan(acct.signTx(unsigned).length);
      expect(acct.signTx(unsigned, SigningRole.STAKE | SigningRole.PAYMENT)).toBe(both);
    } finally {
      acct.close();
    }
  });

  it('rejects an empty role mask', () => {
    const acct = bridge.accounts.fromMnemonic(TEST_MNEMONIC, TESTNET);
    try {
      const unsigned = unsignedStakeReg(acct.info);
      expect(() => acct.signTx(unsigned, 0)).toThrow(CclError);
    } finally {
      acct.close();
    }
  });

  it('close is idempotent; use-after-close throws -11', () => {
    const acct = bridge.accounts.fromMnemonic(TEST_MNEMONIC, TESTNET);
    acct.close();
    acct.close(); // idempotent
    try {
      acct.info;
      throw new Error('expected use-after-close to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CclError);
      expect(e.code).toBe(CCL_ERROR_INVALID_HANDLE);
    }
  });

  it('create → export once → restore; imported accounts never export', () => {
    const acct = bridge.accounts.create(TESTNET);
    try {
      const base = acct.info.base_address;
      const phrase = acct.exportRecoveryPhrase();
      expect(phrase.trim().split(/\s+/).length).toBe(24);

      const restored = bridge.accounts.fromMnemonic(phrase, TESTNET);
      try {
        expect(restored.info.base_address).toBe(base);
        expect(() => restored.exportRecoveryPhrase()).toThrow(CclError);
      } finally {
        restored.close();
      }
      expect(() => acct.exportRecoveryPhrase()).toThrow(CclError); // one-shot
    } finally {
      acct.close();
    }
  });

  it('toString never contains secrets, before or after close', () => {
    const acct = bridge.accounts.create(TESTNET);
    const phrase = acct.exportRecoveryPhrase();
    expect(String(acct)).not.toContain('addr'); // not even public data, just the handle
    expect(String(acct)).not.toContain(phrase.split(/\s+/)[0]);
    acct.close();
    expect(String(acct)).toBe('<ccl.Account closed>');
  });

  it('Symbol.dispose closes the account (using-declaration support)', () => {
    let leaked;
    {
      const acct = bridge.accounts.fromMnemonic(TEST_MNEMONIC, TESTNET);
      leaked = acct;
      acct[Symbol.dispose]();
    }
    expect(() => leaked.info).toThrow(CclError);
  });
});

describe('GC fallback', () => {
  // A dropped Account (no close/using) must be reclaimed best-effort: leaked registry
  // entries pin key material Java-side until process exit. Deterministic close remains
  // the contract — this pins only that leaks are eventually narrowed (ADR-0016).
  function leakAccountHandle() {
    const acct = bridge.accounts.create(TESTNET);
    return acct._handle; // BigInt copy; the Account object itself is dropped
  }

  it('a dropped account is reclaimed by the finalizer', async () => {
    const handle = leakAccountHandle();
    for (let i = 0; i < 100; i++) {
      Bun.gc(true);
      await new Promise((r) => setTimeout(r, 10)); // let finalizer tasks run
      const rc = bridge._lib.ccl_account_get_info(bridge._thread, handle);
      if (rc === -11) return; // finalizer closed it
      if (rc === 0) bridge._check(rc); // drain the parked info so the slot stays clean
    }
    throw new Error('dropped Account was never reclaimed — no GC fallback closes leaked handles');
  });
});
