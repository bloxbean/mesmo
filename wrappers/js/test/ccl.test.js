import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { CclBridge, CclError, MAINNET, TESTNET, normalizeCostModels } from '../src/index.js';

// A known valid transaction CBOR hex (built from Java tests)
const SAMPLE_TX_CBOR = '84a300d901028182582073198b7ad003862b9798106b88fbccfca464b1a38afb34958275c4a7d7d8d002010181825839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc1a001e8480021a00029810a0f5f6';

// Create a managed account; return its public info plus the one-shot recovery phrase.
function createManaged(bridge, network) {
    const acct = bridge.accounts.create(network);
    const info = acct.info;
    const mnemonic = acct.exportRecoveryPhrase();
    acct.close();
    return { ...info, mnemonic };
}

describe('Cardano Client Bindings', () => {
    let bridge;

    beforeAll(() => {
        bridge = new CclBridge();
    });

    afterAll(() => {
        bridge.close();
    });

    it('should return version', () => {
        const version = bridge.version();
        expect(version).toBe('0.1.0');
    });

    // --- Account ---

    it('should create mainnet account', () => {
        const account = createManaged(bridge, MAINNET);
        expect(account.base_address).toStartWith('addr1');
        expect(account.mnemonic.split(' ').length).toBe(24);
    });

    it('should create testnet account', () => {
        const account = createManaged(bridge, TESTNET);
        expect(account.base_address).toStartWith('addr_test1');
    });

    it('should restore account from mnemonic', () => {
        const created = createManaged(bridge, MAINNET);
        using restored = bridge.accounts.fromMnemonic(created.mnemonic, MAINNET);
        expect(restored.info.base_address).toBe(created.base_address);
        expect(restored.info.enterprise_address).toBe(created.enterprise_address);
    });

    it('should get public key', () => {
        const account = createManaged(bridge, MAINNET);
        const pubKey = bridge.crypto.deriveKey(account.mnemonic).public_key;
        expect(pubKey.length).toBe(64); // 32 bytes hex
    });

    it('should get private key', () => {
        const account = createManaged(bridge, MAINNET);
        const privKey = bridge.crypto.deriveKey(account.mnemonic).private_key;
        expect(privKey.length).toBe(128); // 64 bytes extended BIP32-ED25519
    });

    it('should get DRep ID', () => {
        const account = createManaged(bridge, MAINNET);
        expect(account.drep_id).toStartWith('drep1');
    });

    it('should sign transaction with mnemonic', () => {
        const account = createManaged(bridge, TESTNET);
        using acct = bridge.accounts.fromMnemonic(account.mnemonic, TESTNET);
        const signed = acct.signTx(SAMPLE_TX_CBOR);
        expect(signed.length).toBeGreaterThan(SAMPLE_TX_CBOR.length);
    });

    // --- Network constants ---
    //
    // Pins the confusing-but-correct relationship, so nobody "fixes" it back: MAINNET/TESTNET/… are
    // CCL's *enum ordinals* (MAINNET === 0), while `address.info().network_id` is Cardano's genuine
    // *on-chain* network id (mainnet === 1) — the two are inverted. Renumbering the constants to
    // match the on-chain id would derive keys for the wrong network.

    it('MAINNET (ordinal 0) yields an address whose on-chain network_id is 1', () => {
        expect(MAINNET).toBe(0);
        const account = createManaged(bridge, MAINNET);
        expect(bridge.address.info(account.base_address).network_id).toBe(1);
        expect(account.base_address).toStartWith('addr1');
    });

    it('TESTNET (ordinal 1) yields an address whose on-chain network_id is 0', () => {
        expect(TESTNET).toBe(1);
        const account = createManaged(bridge, TESTNET);
        expect(bridge.address.info(account.base_address).network_id).toBe(0);
        expect(account.base_address).toStartWith('addr_test1');
    });

    it('should reject an out-of-range network with a JS error, not an opaque native one', () => {
        expect(() => bridge.accounts.create(99)).toThrow(RangeError);
        expect(() => bridge.accounts.create(-1)).toThrow(RangeError);
        expect(() => bridge.accounts.create('mainnet')).toThrow(RangeError);
        expect(() => bridge.accounts.fromMnemonic('x', 4)).toThrow(RangeError);
    });

    it('should require an explicit network (no mainnet default)', () => {
        expect(() => bridge.accounts.create()).toThrow(TypeError);
        expect(() => bridge.accounts.fromMnemonic('x')).toThrow(TypeError);
    });

    // --- Address ---

    it('should validate addresses', () => {
        const account = createManaged(bridge, MAINNET);
        expect(bridge.address.validate(account.base_address)).toBe(true);
        expect(bridge.address.validate('invalid_address')).toBe(false);
    });

    it('should get address info', () => {
        const account = createManaged(bridge, MAINNET);
        const info = bridge.address.info(account.base_address);
        expect(info.type).toBe('Base');
        expect(info.network_id).toBe(1);
    });

    it('should convert address to/from bytes', () => {
        const account = createManaged(bridge, MAINNET);
        const hexBytes = bridge.address.toBytes(account.base_address);
        expect(hexBytes.length).toBeGreaterThan(0);
        const restored = bridge.address.fromBytes(hexBytes);
        expect(restored).toBe(account.base_address);
    });

    // --- Crypto ---

    it('should compute blake2b-256', () => {
        const hash = bridge.crypto.blake2b256('48656c6c6f');
        expect(hash.length).toBe(64);
    });

    it('should compute blake2b-224', () => {
        const hash = bridge.crypto.blake2b224('48656c6c6f');
        expect(hash.length).toBe(56);
    });

    it('should generate and validate mnemonic', () => {
        const mnemonic = bridge.crypto.generateMnemonic(24);
        expect(mnemonic.split(' ').length).toBe(24);
        expect(bridge.crypto.validateMnemonic(mnemonic)).toBe(true);
        expect(bridge.crypto.validateMnemonic('invalid mnemonic')).toBe(false);
    });

    it('should generate 12-word mnemonic', () => {
        const mnemonic = bridge.crypto.generateMnemonic(12);
        expect(mnemonic.split(' ').length).toBe(12);
    });

    it('should sign with 32-byte key', () => {
        const account = createManaged(bridge, MAINNET);
        const key = bridge.crypto.deriveKey(account.mnemonic);
        // Round-trip regression pin: the whole extended key must sign AND verify against
        // the key's own public_key; half of it (a clamped scalar, not a seed) must not.

        const messageHex = '68656c6c6f';
        const signature = bridge.crypto.sign(messageHex, key.private_key);
        expect(signature.length).toBe(128); // 64 bytes
        expect(bridge.crypto.verify(signature, messageHex, key.public_key)).toBe(true);

        const wrong = bridge.crypto.sign(messageHex, key.private_key.substring(0, 64));
        expect(bridge.crypto.verify(wrong, messageHex, key.public_key)).toBe(false);
    });

    it('should reject wrong signature in verify', () => {
        const account = createManaged(bridge, MAINNET);
        const pubKey = bridge.crypto.deriveKey(account.mnemonic).public_key;
        const fakeSig = '00'.repeat(64);
        expect(bridge.crypto.verify(fakeSig, '68656c6c6f', pubKey)).toBe(false);
    });

    // --- Transaction ---

    it('should compute tx hash', () => {
        const hash = bridge.tx.hash(SAMPLE_TX_CBOR);
        expect(hash.length).toBe(64);
        expect(hash).toBe('7af07f974db1d004305d29670d04faeef0e9670e8cf95e4b54a06f668eed8de4');
    });

    it('should convert tx to JSON', () => {
        const json = bridge.tx.toJson(SAMPLE_TX_CBOR);
        expect(json).toStartWith('{');
    });

    it('should deserialize tx', () => {
        const result = bridge.tx.deserialize(SAMPLE_TX_CBOR);
        expect(result.body).toBeDefined();
        expect(result.body.inputs).toBeDefined();
    });

    // --- Plutus ---

    it('should hash plutus data', () => {
        const hash = bridge.plutus.dataHash('182a');
        expect(hash.length).toBe(64);
        expect(hash).toBe('9e1199a988ba72ffd6e9c269cadb3b53b5f360ff99f112d9b2ee30c4d74ad88b');
    });

    // --- Script ---

    it('should parse native script from JSON', () => {
        const account = createManaged(bridge, MAINNET);
        const info = bridge.address.info(account.base_address);
        const keyHash = info.payment_credential_hash;

        const scriptJson = JSON.stringify({ type: 'sig', keyHash });
        const result = JSON.parse(bridge.script.nativeFromJson(scriptJson));
        expect(result.policy_id).toBeDefined();
        expect(result.script_hash).toBeDefined();
        expect(result.cbor_hex).toBeDefined();
        expect(result.script_hash.length).toBe(56);
    });

    it('should hash script', () => {
        const account = createManaged(bridge, MAINNET);
        const info = bridge.address.info(account.base_address);
        const keyHash = info.payment_credential_hash;

        const scriptJson = JSON.stringify({ type: 'sig', keyHash });
        const parsed = JSON.parse(bridge.script.nativeFromJson(scriptJson));

        const hash = bridge.script.hash(parsed.cbor_hex, 0);
        expect(hash.length).toBe(56);
    });

    // --- Governance ---

    it('should expose governance identifiers in account info', () => {
        const account = createManaged(bridge, MAINNET);
        expect(account.drep_id).toStartWith('drep1');
        expect(account.committee_cold_id).toStartWith('cc_cold1');
        expect(account.committee_hot_id).toStartWith('cc_hot1');
        expect(account.committee_cold_credential.length).toBe(56);
        expect(account.committee_hot_credential.length).toBe(56);
    });

    it('should derive governance keys with the stateless utility', () => {
        const account = createManaged(bridge, MAINNET);
        const cold = bridge.crypto.deriveKey(account.mnemonic, 0, 0, 'committee_cold');
        expect(cold.public_key_hash).toBe(account.committee_cold_credential);
        expect(cold.bech32_verification_key).toStartWith('cc_cold_vk1');
        expect(cold.bech32_verification_key_hash).toStartWith('cc_cold_vkh1');
        const drep = bridge.crypto.deriveKey(account.mnemonic, 0, 0, 'drep');
        expect(drep.public_key.length).toBe(64);
        expect(drep.path).toBe("m/1852'/1815'/0'/3/0");
        expect(drep.bech32_verification_key).toStartWith('drep_vk1');
        // Non-governance roles carry no CIP-105 encodings by design.
        expect(bridge.crypto.deriveKey(account.mnemonic).bech32_verification_key).toBeUndefined();
    });

    // --- Wallet ---

    it('should create wallet', () => {
        const wallet = createManaged(bridge, MAINNET);
        expect(wallet.mnemonic).toBeDefined();
        expect(wallet.mnemonic.split(' ').length).toBe(24);
    });

    it('should restore wallet from mnemonic', () => {
        const wallet = createManaged(bridge, MAINNET);
        using restoredAcct = bridge.accounts.fromMnemonic(wallet.mnemonic, MAINNET);
        const restored = restoredAcct.info;
        expect(restored.stake_address).toBe(wallet.stake_address);
    });

    it('should get wallet address', () => {
        const wallet = createManaged(bridge, MAINNET);
        using a0 = bridge.accounts.fromMnemonic(wallet.mnemonic, MAINNET, 0, 0);
        const address = a0.info.base_address;
        expect(address).toStartWith('addr1');
    });

    it('should get different wallet addresses at different indices', () => {
        const wallet = createManaged(bridge, MAINNET);
        using a0 = bridge.accounts.fromMnemonic(wallet.mnemonic, MAINNET, 0, 0);
        using a1 = bridge.accounts.fromMnemonic(wallet.mnemonic, MAINNET, 0, 1);
        const addr0 = a0.info.base_address;
        const addr1 = a1.info.base_address;
        expect(addr0).not.toBe(addr1);
    });

    // --- QuickTx ---

    const PROTOCOL_PARAMS = {
        min_fee_a: 44,
        min_fee_b: 155381,
        max_block_size: 65536,
        max_tx_size: 16384,
        max_block_header_size: 1100,
        key_deposit: "2000000",
        pool_deposit: "500000000",
        e_max: 18,
        n_opt: 500,
        a0: 0.3,
        rho: 0.003,
        tau: 0.2,
        min_utxo: "34482",
        min_pool_cost: "340000000",
        price_mem: 0.0577,
        price_step: 0.0000721,
        max_tx_ex_mem: "10000000",
        max_tx_ex_steps: "10000000000",
        max_block_ex_mem: "50000000",
        max_block_ex_steps: "40000000000",
        max_val_size: "5000",
        collateral_percent: 150,
        max_collateral_inputs: 3,
        coins_per_utxo_size: "4310",
        coins_per_utxo_word: "34482",
        pvt_motion_no_confidence: 0.51,
        pvt_committee_normal: 0.51,
        pvt_committee_no_confidence: 0.51,
        pvt_hard_fork_initiation: 0.51,
        dvt_motion_no_confidence: 0.51,
        dvt_committee_normal: 0.51,
        dvt_committee_no_confidence: 0.51,
        dvt_update_to_constitution: 0.51,
        dvt_hard_fork_initiation: 0.51,
        dvt_ppnetwork_group: 0.51,
        dvt_ppeconomic_group: 0.51,
        dvt_pptechnical_group: 0.51,
        dvt_ppgov_group: 0.51,
        dvt_treasury_withdrawal: 0.51,
        committee_min_size: 0,
        committee_max_term_length: 200,
        gov_action_lifetime: 10,
        gov_action_deposit: 1000000000,
        drep_deposit: 2000000,
        drep_activity: 20,
        min_fee_ref_script_cost_per_byte: 44,
    };

    const FAKE_TX_HASH = 'a'.repeat(64);

    function makeUtxos(address, lovelace = 100_000_000) {
        return [{
            tx_hash: FAKE_TX_HASH,
            output_index: 0,
            address,
            amount: [{ unit: 'lovelace', quantity: String(lovelace) }],
        }];
    }

    function paymentYaml(from, to, quantity) {
        return `
version: 1.0
transaction:
  - tx:
      from: ${from}
      intents:
        - type: payment
          address: ${to}
          amounts:
            - unit: lovelace
              quantity: "${quantity}"
`;
    }

    function assertBuilt(result) {
        expect(result.tx_cbor.length).toBeGreaterThan(0);
        expect(result.tx_hash.length).toBe(64);
        expect(parseInt(result.fee, 10)).toBeGreaterThan(0);
    }

    it('should build a simple payment from TxPlan YAML', () => {
        const sender = createManaged(bridge, TESTNET);
        const receiver = createManaged(bridge, TESTNET);
        const yaml = paymentYaml(sender.base_address, receiver.base_address, '5000000');
        assertBuilt(bridge.quicktx.build(yaml, makeUtxos(sender.base_address), PROTOCOL_PARAMS));
    });

    it('should build multiple payments', () => {
        const sender = createManaged(bridge, TESTNET);
        const r1 = createManaged(bridge, TESTNET);
        const r2 = createManaged(bridge, TESTNET);
        const yaml = `
version: 1.0
transaction:
  - tx:
      from: ${sender.base_address}
      intents:
        - type: payment
          address: ${r1.base_address}
          amounts:
            - unit: lovelace
              quantity: "5000000"
        - type: payment
          address: ${r2.base_address}
          amounts:
            - unit: lovelace
              quantity: "3000000"
`;
        assertBuilt(bridge.quicktx.build(yaml, makeUtxos(sender.base_address), PROTOCOL_PARAMS));
    });

    it('should substitute variables', () => {
        const sender = createManaged(bridge, TESTNET);
        const receiver = createManaged(bridge, TESTNET);
        const yaml = `
version: 1.0
variables:
  to: ${receiver.base_address}
  amount: "4000000"
transaction:
  - tx:
      from: ${sender.base_address}
      intents:
        - type: payment
          address: \${to}
          amounts:
            - unit: lovelace
              quantity: \${amount}
`;
        assertBuilt(bridge.quicktx.build(yaml, makeUtxos(sender.base_address), PROTOCOL_PARAMS));
    });

    it('should throw on insufficient funds', () => {
        const sender = createManaged(bridge, TESTNET);
        const receiver = createManaged(bridge, TESTNET);
        const yaml = paymentYaml(sender.base_address, receiver.base_address, '200000000');
        expect(() => bridge.quicktx.build(yaml, makeUtxos(sender.base_address, 1_000_000), PROTOCOL_PARAMS)).toThrow();
    });

    // --- Negative / Error Tests ---

    it('should throw on invalid mnemonic restore', () => {
        expect(() => {
            bridge.accounts.fromMnemonic('invalid words that are not a valid mnemonic phrase at all', MAINNET);
        }).toThrow();
    });

    it('should throw on empty mnemonic restore', () => {
        expect(() => {
            bridge.accounts.fromMnemonic('', MAINNET);
        }).toThrow();
    });

    it('should throw on invalid address info', () => {
        expect(() => {
            bridge.address.info('not_a_valid_address');
        }).toThrow();
    });

    it('should throw on malformed tx CBOR hash', () => {
        expect(() => {
            bridge.tx.hash('deadbeef');
        }).toThrow();
    });

    it('should throw on invalid hex in tx hash', () => {
        expect(() => {
            bridge.tx.hash('not_hex!');
        }).toThrow();
    });

    it('should throw on malformed tx deserialize', () => {
        expect(() => {
            bridge.tx.deserialize('deadbeef');
        }).toThrow();
    });

    it('should throw on invalid plutus data hash', () => {
        expect(() => {
            bridge.plutus.dataHash('zzzz');
        }).toThrow();
    });

    it('should throw on sign tx with invalid CBOR', () => {
        const account = createManaged(bridge, TESTNET);
        expect(() => {
            using acct = bridge.accounts.fromMnemonic(account.mnemonic, TESTNET);
            acct.signTx('deadbeef');
        }).toThrow();
    });

    it('should throw on blake2b with invalid hex', () => {
        expect(() => {
            bridge.crypto.blake2b256('not_valid_hex!');
        }).toThrow();
    });

    it('should reject invalid mnemonic validation', () => {
        expect(bridge.crypto.validateMnemonic('zzz xxx yyy www vvv uuu ttt sss rrr qqq ppp ooo')).toBe(false);
    });
});

// normalizeCostModels: numerically-keyed cost models (Yaci DevKit / Blockfrost-style providers) must
// be converted to the ordered cost_models_raw array form, because JS object iteration reorders the
// canonical integer-string keys ahead of the zero-padded ones, which would corrupt the Plutus
// script-integrity hash. See the comment on normalizeCostModels in src/index.js.
describe('normalizeCostModels', () => {
    it('converts numeric-keyed cost models to ordered cost_models_raw arrays', () => {
        // 0..120 inclusive: spans zero-padded keys ("000".."099") and canonical-integer keys
        // ("100".."120"), which is exactly the pair JS would otherwise reorder.
        const model = {};
        for (let i = 0; i <= 120; i++) model[String(i).padStart(3, '0')] = 1000 + i;

        const out = normalizeCostModels({ min_fee_a: 44, cost_models: { PlutusV2: model } });

        // Array is in ascending numeric-key order regardless of the source object's iteration order.
        expect(out.cost_models_raw.PlutusV2).toHaveLength(121);
        expect(out.cost_models_raw.PlutusV2[0]).toBe(1000);
        expect(out.cost_models_raw.PlutusV2[100]).toBe(1100);
        expect(out.cost_models_raw.PlutusV2[120]).toBe(1120);
        expect(out.cost_models_raw.PlutusV2).toEqual(
            Array.from({ length: 121 }, (_, i) => 1000 + i));
        // The numeric-keyed cost_models map is removed once converted; other params are preserved.
        expect(out.cost_models).toBeUndefined();
        expect(out.min_fee_a).toBe(44);
    });

    it('prefers an existing cost_models_raw and passes params through untouched', () => {
        // cost_models_raw is the preferred (ordered) form; the deprecated cost_models must be ignored.
        const pp = {
            min_fee_a: 44,
            cost_models_raw: { PlutusV2: [100, 200, 300] },
            cost_models: { PlutusV2: { '0': 1, '1': 2 } },
        };
        const out = normalizeCostModels(pp);
        expect(out).toBe(pp);                                  // same object, unchanged
        expect(out.cost_models_raw.PlutusV2).toEqual([100, 200, 300]);
    });

    it('leaves named-operation cost models (which JS does not reorder) as a cost_models map', () => {
        const named = { 'addInteger-cpu-arguments-intercept': 205665, 'addInteger-cpu-arguments-slope': 812 };
        const out = normalizeCostModels({ cost_models: { PlutusV2: named } });
        expect(out.cost_models.PlutusV2).toEqual(named);
        expect(out.cost_models_raw).toBeUndefined();
    });

    it('passes through params with no cost models unchanged', () => {
        const pp = { min_fee_a: 44, min_fee_b: 155381 };
        expect(normalizeCostModels(pp)).toEqual(pp);
    });
});
