// Type-level tests for the shipped declarations (src/index.d.ts).
//
// Compiled — never executed — by `bun run typecheck` (tsc --noEmit). They exercise the *real*
// runtime API (namespaced: `lib.accounts.create(...)`), so a .d.ts that describes some other shape
// (e.g. the old flat `lib.accountCreate(...)`) fails the check instead of shipping.
//
// `@ts-expect-error` lines are assertions too: each marks code that MUST NOT compile (a wrong
// network value, a missing required `network`, a method that does not exist). If any of them starts
// compiling, tsc reports the unused directive and the check fails.

import {
    Mesmo,
    MesmoError,
    MesmoClosedError,
    QuickTxApi,
    YaciProvider,
    BlockfrostProvider,
    BlockfrostEvaluator,
    ChainDataProvider,
    TransactionEvaluator,
    normalizeCostModels,
    parseEvaluation,
    resolveLibFile,
    platformSuffix,
    MAINNET,
    TESTNET,
    MESMO_SUCCESS,
    MESMO_ERROR_TX_BUILD,
    type Network,
    type Account,
    type AccountPublicInfo,
    type DerivedKey,
    SigningRole,
    type AddressInfo,
    type Utxo,
    type Amount,
    type ProtocolParams,
    type ExecUnits,
    type TxResult,
} from '../src/index.js';

// Compile-time assertion helpers.
declare function expectType<T>(value: T): void;
declare function assignable<T>(): <U extends T>(value: U) => void;

// --- Constants: closed, literal-typed, and inverted w.r.t. the on-chain id -----------------------

expectType<0>(MAINNET);
expectType<1>(TESTNET);
expectType<0>(MESMO_SUCCESS);
expectType<-10>(MESMO_ERROR_TX_BUILD);
assignable<Network>()(MAINNET);
assignable<Network>()(TESTNET);

// --- Lifecycle -----------------------------------------------------------------------------------

const lib: Mesmo = new Mesmo();
const libWithPath: Mesmo = new Mesmo('/opt/mesmo/lib');
expectType<string>(lib.version());
expectType<void>(lib.close());
expectType<void>(lib[Symbol.dispose]());
void libWithPath;

// --- accounts (managed handles — the shape the README teaches) -----------------------------------

const acct: Account = lib.accounts.create(TESTNET);
const info: AccountPublicInfo = acct.info;
expectType<string>(info.base_address);
expectType<string>(info.enterprise_address);
expectType<string>(info.stake_address);
expectType<string>(info.drep_id);
expectType<string>(info.committee_cold_id);
expectType<string>(info.committee_cold_credential);
expectType<string>(info.committee_hot_id);
expectType<string>(info.committee_hot_credential);
expectType<number>(info.network);
// @ts-expect-error info never contains the mnemonic
info.mnemonic;
const mnemonic: string = acct.exportRecoveryPhrase();

expectType<Account>(lib.accounts.fromMnemonic(mnemonic, MAINNET));
expectType<Account>(lib.accounts.fromMnemonic(mnemonic, TESTNET, 0, 0));
expectType<string>(acct.signTx('deadbeef'));
expectType<string>(acct.signTx('deadbeef', SigningRole.PAYMENT | SigningRole.STAKE));
acct.close();

const account = { mnemonic, base_address: info.base_address };

// `network` is required — no silent mainnet default.
// @ts-expect-error network is required
lib.accounts.create();
// Out-of-range networks are a type error (the values are CCL enum ordinals, 0..3).
// @ts-expect-error 99 is not a Network
lib.accounts.create(99);
// @ts-expect-error 'mainnet' is not a Network
lib.accounts.create('mainnet');
// The old flat API is gone; only the namespaced one exists.
// @ts-expect-error accountCreate() does not exist at runtime
lib.accountCreate(TESTNET);

// --- address: network_id is the GENUINE on-chain id (0 = testnet, 1 = mainnet) -------------------

const addressInfo: AddressInfo = lib.address.info(account.base_address);
expectType<number>(addressInfo.network_id);
expectType<string>(addressInfo.type);
expectType<boolean>(addressInfo.is_pubkey_payment);
expectType<boolean>(addressInfo.is_script_payment);
expectType<string | undefined>(addressInfo.payment_credential_hash);
expectType<boolean>(lib.address.validate(account.base_address));
expectType<string>(lib.address.toBytes(account.base_address));
expectType<string>(lib.address.fromBytes('00deadbeef'));

// --- crypto --------------------------------------------------------------------------------------

expectType<string>(lib.crypto.blake2b256('48656c6c6f'));
expectType<string>(lib.crypto.blake2b224('48656c6c6f'));
expectType<string>(lib.crypto.generateMnemonic());
expectType<string>(lib.crypto.generateMnemonic(12));
expectType<boolean>(lib.crypto.validateMnemonic(account.mnemonic));
expectType<string>(lib.crypto.sign('48656c6c6f', 'aa'));
expectType<boolean>(lib.crypto.verify('sig', '48656c6c6f', 'pk'));

// --- tx ------------------------------------------------------------------------------------------

expectType<string>(lib.tx.hash('84a3'));
expectType<string>(lib.tx.signWithSecretKey('84a3', 'aa'));
expectType<string>(lib.tx.toJson('84a3'));
expectType<string>(lib.tx.fromJson('{}'));
expectType<Record<string, unknown>>(lib.tx.deserialize('84a3'));

// --- plutus / script -----------------------------------------------------------------------------

expectType<string>(lib.plutus.dataHash('d8799f0aff'));
expectType<string>(lib.plutus.dataToJson('d8799f0aff'));
expectType<string>(lib.plutus.dataFromJson('{"int":1}'));
expectType<string>(lib.script.nativeFromJson('{"type":"sig"}'));
expectType<string>(lib.script.hash('4d01'));
expectType<string>(lib.script.hash('4d01', 3));

// --- crypto.deriveKey ----------------------------------------------------------------------------

const drepKey: DerivedKey = lib.crypto.deriveKey(account.mnemonic, 0, 0, 'drep');
expectType<string>(drepKey.path);
expectType<string>(drepKey.private_key);
expectType<string>(drepKey.public_key);
expectType<string>(drepKey.public_key_hash);
expectType<DerivedKey>(lib.crypto.deriveKey(account.mnemonic));
expectType<DerivedKey>(lib.crypto.deriveKey(account.mnemonic, 0, 0, 'committee_cold'));
// @ts-expect-error unknown role is rejected at the type level
lib.crypto.deriveKey(account.mnemonic, 0, 0, 'bogus');

// --- quicktx -------------------------------------------------------------------------------------

const amount: Amount = { unit: 'lovelace', quantity: '5000000' };
const utxos: Utxo[] = [
    { tx_hash: 'aa'.repeat(32), output_index: 0, address: account.base_address, amount: [amount] },
];
const protocolParams: ProtocolParams = { min_fee_a: 44, min_fee_b: 155381 };
const execUnits: ExecUnits[] = [{ mem: 2_000_000, steps: 500_000_000 }];

const built: TxResult = lib.quicktx.build('version: 1.0', utxos, protocolParams);
expectType<string>(built.tx_cbor);
expectType<string>(built.tx_hash);
expectType<string>(built.fee);
expectType<TxResult>(lib.quicktx.build('version: 1.0', utxos, protocolParams, execUnits));
expectType<QuickTxApi>(lib.quicktx);

expectType<ProtocolParams>(normalizeCostModels(protocolParams));

// --- providers / evaluators ----------------------------------------------------------------------

const yaci: ChainDataProvider = new YaciProvider();
const blockfrost: ChainDataProvider = new BlockfrostProvider('id', { network: 'preprod' });
const evaluator: TransactionEvaluator = new BlockfrostEvaluator('id', { network: 'preprod' });

// A plain object is a provider too — the type is structural.
const custom: ChainDataProvider = {
    utxos: async () => utxos,
    protocolParams: async () => protocolParams,
};

expectType<Promise<TxResult>>(lib.quicktx.buildWith('version: 1.0', yaci, [account.base_address]));
expectType<Promise<TxResult>>(lib.quicktx.buildWith('version: 1.0', blockfrost, [account.base_address], evaluator));
expectType<Promise<TxResult>>(lib.quicktx.buildWith('version: 1.0', custom, [account.base_address]));
expectType<Promise<Utxo[]>>(yaci.utxos(account.base_address));
expectType<Promise<ProtocolParams>>(yaci.protocolParams());
expectType<Promise<ExecUnits[]>>(evaluator.evaluate(built.tx_cbor, utxos));
expectType<ExecUnits[]>(parseEvaluation({}));
// @ts-expect-error 'testnet' is not a Blockfrost network
new BlockfrostProvider('id', { network: 'testnet' });

// --- errors and lib resolution -------------------------------------------------------------------

const err: MesmoError = new MesmoError(MESMO_ERROR_TX_BUILD, 'boom');
expectType<number>(err.code);
expectType<string>(err.message);
expectType<MesmoClosedError>(new MesmoClosedError());
expectType<string>(resolveLibFile());
expectType<string>(resolveLibFile('/opt/mesmo/lib'));
expectType<string>(platformSuffix());

// @ts-expect-error senders is an array — a bare string is the old single-sender signature
lib.quicktx.buildWith('version: 1.0', yaci, account.base_address);
