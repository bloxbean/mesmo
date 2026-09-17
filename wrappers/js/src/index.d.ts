// TypeScript declarations for @bloxbean/mesmo.
//
// These mirror the runtime surface of `src/index.js` exactly: a `Mesmo` with *namespaced* APIs
// (`lib.accounts.create(...)`, `lib.quicktx.build(...)`, …). `test/types.test-d.ts` compiles
// against this file (`bun run typecheck`) so the two cannot drift apart.

// --- Network -------------------------------------------------------------------------------------

/**
 * A network selector: {@link MAINNET} (0) or {@link TESTNET} (1).
 *
 * ⚠️ These are CCL's `Network` **enum ordinals**, *not* Cardano's on-chain network id — and they are
 * inverted with respect to it. On-chain, `0 = testnet` and `1 = mainnet`; here `MAINNET = 0` and
 * `TESTNET = 1`. Never pass a raw number: `account.create(0)` derives a **mainnet** key. Always pass
 * one of the exported constants.
 *
 * The genuine on-chain id is {@link AddressInfo.network_id}, returned by `address.info()`: an
 * account created with `MAINNET` (ordinal 0) has `network_id === 1`; one created with `TESTNET`
 * (ordinal 1) has `network_id === 0`.
 */
export type Network = 0 | 1;

/** CCL enum ordinal for mainnet. NOT the on-chain network id (which is 1 for mainnet). */
export declare const MAINNET: 0;
/** CCL enum ordinal for testnet. NOT the on-chain network id (which is 0 for testnet). */
export declare const TESTNET: 1;

// --- Data shapes ---------------------------------------------------------------------------------

export interface AddressInfo {
    /** 'Base' | 'Enterprise' | 'Pointer' | 'Reward' (as reported by CCL). */
    type: string;
    /**
     * Cardano's genuine **on-chain** network id: `0` = testnet, `1` = mainnet. This is the inverse
     * of the {@link Network} ordinals taken by the `network` parameters of this API — do not feed it
     * back into `account.create()` / `wallet.create()`.
     */
    network_id: number;
    payment_credential_hash?: string;
    delegation_credential_hash?: string;
    is_pubkey_payment: boolean;
    is_script_payment: boolean;
}

/** A single asset quantity inside a {@link Utxo}. `unit` is 'lovelace' or a policy-id + asset-name hex. */
export interface Amount {
    unit: string;
    quantity: string | number;
}

/** An unspent transaction output (CCL `Utxo` model), as consumed by {@link QuickTxApi.build}. */
export interface Utxo {
    tx_hash: string;
    output_index: number;
    address: string;
    amount: Amount[];
    data_hash?: string | null;
    inline_datum?: string | null;
    reference_script_hash?: string | null;
    [key: string]: unknown;
}

/**
 * Protocol parameters (CCL `ProtocolParams` model). Deliberately open — providers return supersets
 * of the fields CCL reads, and unknown fields are ignored by the native library.
 */
export interface ProtocolParams {
    min_fee_a?: number;
    min_fee_b?: number;
    max_tx_size?: number;
    key_deposit?: string | number;
    pool_deposit?: string | number;
    coins_per_utxo_size?: string | number;
    price_mem?: number;
    price_step?: number;
    /** Preferred, order-stable cost-model form (per-language ordered arrays). */
    cost_models_raw?: Record<string, Array<number | string>>;
    /** Deprecated map form; {@link normalizeCostModels} converts it to `cost_models_raw`. */
    cost_models?: Record<string, Record<string, number | string> | Array<number | string>>;
    [key: string]: unknown;
}

/** A redeemer's execution-unit budget. */
export interface ExecUnits {
    mem: number | string;
    steps: number | string;
}

/** The result of a QuickTx build. */
export interface TxResult {
    tx_cbor: string;
    tx_hash: string;
    fee: string;
}

/** @deprecated Alias of {@link TxResult}, kept for backwards compatibility. */
export type QuickTxResult = TxResult;

/** A deserialized transaction (`lib.tx.deserialize()`); shape follows CCL's transaction JSON. */
export type TransactionJson = Record<string, unknown>;

// --- Errors --------------------------------------------------------------------------------------

/** Thrown when the native library returns a non-zero status. */
export declare class MesmoError extends Error {
    code: number;
    constructor(code: number, message: string);
}

/** Thrown when a {@link Mesmo} is used after `close()`. */
export declare class MesmoClosedError extends Error {
    constructor();
}

// --- Namespaces ----------------------------------------------------------------------------------
//
// Reached through a Mesmo instance: `lib.account`, `lib.address`, … They are not
// constructible from outside, so they are declared as interfaces (no runtime export) — except
// QuickTxApi, which the module does export.

export interface AddressApi {
    /** Decode a bech32 address. Its `network_id` is the genuine **on-chain** id (0 = testnet, 1 = mainnet). */
    info(bech32: string): AddressInfo;
    validate(bech32: string): boolean;
    toBytes(bech32: string): string;
    fromBytes(hexBytes: string): string;
}

export interface CryptoApi {
    blake2b256(dataHex: string): string;
    blake2b224(dataHex: string): string;
    generateMnemonic(wordCount?: number): string;
    validateMnemonic(mnemonic: string): boolean;
    /** skHex: a 32-byte seed (64 hex) or a 64-byte extended key (128 hex, from deriveKey) — detected by length. */
    sign(messageHex: string, skHex: string): string;
    verify(signatureHex: string, messageHex: string, pkHex: string): boolean;
    /**
     * Stateless CIP-1852 key derivation — the explicit "raw key material" utility. Key derivation
     * is network-independent. Prefer managed accounts for signing; handles never expose key bytes.
     */
    deriveKey(mnemonic: string, accountIndex?: number, addressIndex?: number, role?: DeriveKeyRole): DerivedKey;
}

// --- Managed accounts (ADR-0016) -----------------------------------------------------------------

/** Typed signing-role bit mask values. Combine with `|`; witnesses apply in canonical order. */
export declare const SigningRole: Readonly<{
    PAYMENT: 1;
    STAKE: 2;
    DREP: 4;
    COMMITTEE_COLD: 8;
    COMMITTEE_HOT: 16;
}>;

/** Public data of a managed account. Never contains the mnemonic or any private key. */
export interface AccountPublicInfo {
    base_address: string;
    enterprise_address: string;
    stake_address: string;
    /** The CIP-1852 role-1 (internal/change) leaf at this account's address index. */
    change_address: string;
    /** The CCL enum ordinal the account was opened with — NOT the on-chain network id. */
    network: number;
    account_index: number;
    address_index: number;
    drep_id: string;
    /** bech32 committee ids and hex credentials (blake2b-224 verification-key hashes). */
    committee_cold_id: string;
    committee_cold_credential: string;
    committee_hot_id: string;
    committee_hot_credential: string;
}

/**
 * A managed account (ADR-0016) bound to one CIP-1852 payment leaf. Close explicitly, or use
 * `using` / `Symbol.dispose`; any use after close throws with code -11.
 */
export declare class Account {
    readonly info: AccountPublicInfo;
    signTx(txCborHex: string, roles?: number): string;
    /** One-shot: only for accounts from {@link AccountsApi.create}, and only once. */
    exportRecoveryPhrase(): string;
    close(): void;
    [Symbol.dispose](): void;
}

/** Managed-accounts namespace (`lib.accounts`). */
export declare class AccountsApi {
    constructor(lib: Mesmo);
    /** The mnemonic crosses the FFI boundary once, here; no later operation needs it. */
    fromMnemonic(mnemonic: string, network: Network, accountIndex?: number, addressIndex?: number): Account;
    /** Fresh 24-word account; no secret in the result — export the phrase once, deliberately. */
    create(network: Network): Account;
}

/** Roles accepted by {@link CryptoApi.deriveKey}. */
export type DeriveKeyRole =
    | 'payment' | 'change' | 'stake' | 'drep' | 'committee_cold' | 'committee_hot';

/** Result of {@link CryptoApi.deriveKey}. Pass private_key whole to sign() — the extended form is detected by length. */
export interface DerivedKey {
    path: string;
    private_key: string;
    public_key: string;
    public_key_hash: string;
    /** CIP-105 bech32 encodings — present only for the governance roles (drep, committee_cold, committee_hot). */
    bech32_verification_key?: string;
    bech32_verification_key_hash?: string;
}

export interface TxApi {
    hash(txCborHex: string): string;
    signWithSecretKey(txCborHex: string, skCborHex: string): string;
    toJson(txCborHex: string): string;
    fromJson(txJson: string): string;
    deserialize(txCborHex: string): TransactionJson;
}

export interface PlutusApi {
    dataHash(datumCborHex: string): string;
    dataToJson(cborHex: string): string;
    dataFromJson(json: string): string;
}

export interface ScriptApi {
    nativeFromJson(json: string): string;
    /** @param scriptType 0 = native, 1 = PlutusV1, 2 = PlutusV2, 3 = PlutusV3 (defaults to 0). */
    hash(scriptCborHex: string, scriptType?: number): string;
}

export declare class QuickTxApi {
    constructor(lib: Mesmo);

    /**
     * Build an unsigned transaction from a CCL TxPlan (YAML), fully offline.
     *
     * @param txplanYaml the TxPlan YAML document defining the transaction(s)
     * @param utxos UTXOs available to the sender (CCL Utxo model)
     * @param protocolParams protocol parameters (CCL ProtocolParams model)
     * @param execUnits optional redeemer execution units (one per redeemer, in transaction order)
     *   for Plutus script transactions; when omitted the native library computes them offline with
     *   Scalus
     */
    build(
        txplanYaml: string,
        utxos: Utxo[],
        protocolParams: ProtocolParams,
        execUnits?: ExecUnits[] | null,
    ): TxResult;

    /**
     * Fetch chain data from a provider (and, optionally, execution units from an evaluator), then
     * build — in one call. Composes `provider.utxos(sender)` + `provider.protocolParams()` with
     * {@link QuickTxApi.build}. With an `evaluator`, runs a two-pass (draft → evaluate → rebuild).
     */
    buildWith(
        txplanYaml: string,
        provider: ChainDataProvider,
        /** Addresses whose UTXOs fund the transaction(s); de-duplicated across senders. */
        senders: string[],
        evaluator?: TransactionEvaluator | null,
    ): Promise<TxResult>;
}

// --- The lib ----------------------------------------------------------------------------------

export declare class Mesmo {
    /** @param libPath directory containing libmesmo.{dylib,so,dll}; falls back to MESMO_LIB_PATH, the bundled copy, then the platform package. */
    constructor(libPath?: string);

    readonly accounts: AccountsApi;
    readonly address: AddressApi;
    readonly crypto: CryptoApi;
    readonly tx: TxApi;
    readonly plutus: PlutusApi;
    readonly script: ScriptApi;
    readonly quicktx: QuickTxApi;

    /** The native library's version string. */
    version(): string;

    /** Tear down the GraalVM isolate. Idempotent; any later call throws {@link MesmoClosedError}. */
    close(): void;

    /** Enables `using lib = new Mesmo()`. */
    [Symbol.dispose](): void;
}

// --- Chain-data providers (optional) --------------------------------------------------------------

/**
 * Fetches the chain data {@link QuickTxApi.build} needs. Extend it, or just supply any object with
 * these two methods — the type is structural.
 */
export declare class ChainDataProvider {
    /** All UTXOs at `address` (no selection — the lib selects internally). */
    utxos(address: string): Promise<Utxo[]>;
    /** Current protocol parameters (CCL ProtocolParams shape). */
    protocolParams(): Promise<ProtocolParams>;
}

/** Chain-data provider backed by Yaci DevKit / yaci-store (Blockfrost-style REST). */
export declare class YaciProvider extends ChainDataProvider {
    static DEFAULT_URL: string;
    readonly baseUrl: string;
    constructor(baseUrl?: string);
}

/** Chain-data provider backed by the Blockfrost API. */
export declare class BlockfrostProvider extends ChainDataProvider {
    readonly baseUrl: string;
    constructor(projectId: string, opts?: { network?: 'mainnet' | 'preprod' | 'preview'; baseUrl?: string });
}

// --- Transaction evaluators (optional) ------------------------------------------------------------

/**
 * Computes a Plutus transaction's redeemer execution units. Extend it, or just supply any object
 * with an `evaluate` method — the type is structural.
 */
export declare class TransactionEvaluator {
    /** `[{ mem, steps }]`, one per redeemer in transaction order, for the draft `txCbor` (hex). */
    evaluate(txCbor: string, utxos?: Utxo[]): Promise<ExecUnits[]>;
}

/** Remote evaluator via a Blockfrost-compatible `/utils/txs/evaluate` endpoint. */
export declare class BlockfrostEvaluator extends TransactionEvaluator {
    readonly baseUrl: string;
    constructor(projectId: string, opts?: { network?: 'mainnet' | 'preprod' | 'preview'; baseUrl?: string });
}

/** Parse an Ogmios/Blockfrost EvaluateTx response into `[{ mem, steps }]` in redeemer order. */
export declare function parseEvaluation(resp: unknown): ExecUnits[];

// --- Module-level helpers -------------------------------------------------------------------------

/**
 * Convert a provider's deprecated numerically-keyed `cost_models` map into the order-stable
 * `cost_models_raw` array form CCL prefers. Params that already carry `cost_models_raw` pass through
 * unchanged.
 */
export declare function normalizeCostModels<T>(protocolParams: T): T;

/** Resolve the native library file this platform/runtime would load. */
export declare function resolveLibFile(libPath?: string): string;

/** The per-platform npm package suffix for the current runtime, e.g. 'macos-aarch64'. */
export declare function platformSuffix(): string;

// --- Status codes ---------------------------------------------------------------------------------

export declare const MESMO_SUCCESS: 0;
export declare const MESMO_ERROR_GENERAL: -1;
export declare const MESMO_ERROR_INVALID_ARGUMENT: -2;
export declare const MESMO_ERROR_SERIALIZATION: -3;
export declare const MESMO_ERROR_CRYPTO: -4;
export declare const MESMO_ERROR_INVALID_NETWORK: -5;
export declare const MESMO_ERROR_INVALID_MNEMONIC: -6;
export declare const MESMO_ERROR_INVALID_ADDRESS: -7;
export declare const MESMO_ERROR_INSUFFICIENT_FUNDS: -8;
export declare const MESMO_ERROR_INVALID_TRANSACTION: -9;
export declare const MESMO_ERROR_TX_BUILD: -10;
