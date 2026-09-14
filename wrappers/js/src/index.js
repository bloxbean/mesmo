import { dlopen, FFIType, ptr, CString } from 'bun:ffi';
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { stringify as losslessStringify } from 'lossless-json';

// Optional chain-data provider helpers (re-exported for convenience).
export { ChainDataProvider, YaciProvider, BlockfrostProvider } from './providers.js';
export { TransactionEvaluator, BlockfrostEvaluator } from './providers.js';

// Error codes
export const CCL_SUCCESS = 0;
export const CCL_ERROR_GENERAL = -1;
export const CCL_ERROR_INVALID_ARGUMENT = -2;
export const CCL_ERROR_SERIALIZATION = -3;
export const CCL_ERROR_CRYPTO = -4;
export const CCL_ERROR_INVALID_NETWORK = -5;
export const CCL_ERROR_INVALID_MNEMONIC = -6;
export const CCL_ERROR_INVALID_ADDRESS = -7;
export const CCL_ERROR_INSUFFICIENT_FUNDS = -8;
export const CCL_ERROR_INVALID_TRANSACTION = -9;
export const CCL_ERROR_TX_BUILD = -10;
export const CCL_ERROR_INVALID_HANDLE = -11;

// Network selectors.
//
// WARNING — these are CCL's `Network` *enum ordinals*, NOT Cardano's on-chain network id. They are
// inverted with respect to it: on-chain, testnet is 0 and mainnet is 1, whereas here MAINNET is 0
// and TESTNET is 1. Never pass a raw number: `accounts.create(0)` derives a **mainnet** key, not a
// testnet one. Always pass one of these constants.
//
// The genuine on-chain id is the `network_id` field returned by `address.info()` — an account made
// with MAINNET (0) has `address.info().network_id === 1`, and one made with TESTNET (1) has 0.
export const MAINNET = 0;
export const TESTNET = 1;

const NETWORKS = new Set([MAINNET, TESTNET]);

/**
 * Typed signing roles for managed accounts. Combine with `|`; witnesses are applied in canonical
 * order (payment, stake, DRep, committee cold, committee hot) regardless of combination order.
 */
export const SigningRole = Object.freeze({
  PAYMENT: 1,
  STAKE: 1 << 1,
  DREP: 1 << 2,
  COMMITTEE_COLD: 1 << 3,
  COMMITTEE_HOT: 1 << 4,
});

// Validate a `network` argument at the wrapper boundary. Without this an out-of-range value reaches
// the native library, which fails with an opaque error (or, for a valid-looking ordinal, silently
// derives keys for the wrong network).
function checkNetwork(network) {
  if (network === undefined || network === null) {
    throw new TypeError(
      'network is required: pass MAINNET or TESTNET. ' +
      'These are CCL enum ordinals (MAINNET === 0), not Cardano\'s on-chain network id.'
    );
  }
  if (!NETWORKS.has(network)) {
    throw new RangeError(
      `invalid network ${JSON.stringify(network)}: expected MAINNET (0) or TESTNET (1). ` +
      'These are CCL enum ordinals, not Cardano\'s on-chain network id ' +
      '(on-chain: 0 = testnet, 1 = mainnet — the inverse).'
    );
  }
  return network;
}

export class CclError extends Error {
  constructor(code, message) {
    super(`CCL Error ${code}: ${message}`);
    this.name = 'CclError';
    this.code = code;
  }
}

/**
 * Thrown when a CclBridge is used after close().
 *
 * Without it the stale isolate handle reaches the native library and GraalVM aborts the whole
 * process — uncatchable, with no JS stack trace.
 */
export class CclClosedError extends Error {
  constructor() {
    super('CclBridge is closed; create a new one (or move the call inside its `using`/try block)');
    this.name = 'CclClosedError';
  }
}

// Helper: encode a JS string to a null-terminated Buffer for FFI
function cstr(str) {
  return Buffer.from(str + '\0', 'utf-8');
}

// Plutus cost models: prefer the ordered `cost_models_raw` array form.
//
// Per upstream guidance (bloxbean/cardano-client-lib#633), `cost_models_raw` — a per-language ordered
// list of costs that CCL consumes directly — is the preferred way to carry cost models. The map form
// `cost_models` is deprecated: after recent cost-model changes its entries are no longer ordered, so
// relying on their order is unsafe. Providers that already return `cost_models_raw` (e.g. real
// Blockfrost, and yaci-store's own API) pass straight through here untouched.
//
// Only when a provider returns *just* the deprecated `cost_models` (a map keyed by numeric indices)
// do we convert it here: JavaScript object semantics iterate canonical integer-string keys ("100")
// ahead of zero-padded ones ("000"), so JSON.stringify would emit the map out of order and the node
// would reject Plutus txs with PPViewHashesDontMatch. We sort by numeric key and emit
// `cost_models_raw`, which serializes order-stably. (Go/Python are unaffected: Go's json.Marshal
// sorts keys, Python preserves the provider's order.) Languages with named-operation keys (which JS
// does not reorder) are left as a `cost_models` map untouched.
//
// This conversion is still load-bearing because the endpoint our tests/provider-helpers use — the
// Yaci DevKit :10000 local-cluster proxy — returns numeric `cost_models` only (empirically verified:
// no `cost_models_raw`), even though the DevKit's own yaci-store serves the ordered form on :8080.
// Remove this whole function once every endpoint we fetch params from returns `cost_models_raw` —
// tracked in bloxbean/cardano-client-bindings#11.
export function normalizeCostModels(protocolParams) {
  if (!protocolParams || typeof protocolParams !== 'object') return protocolParams;

  // Preferred form already present — CCL consumes cost_models_raw ahead of the deprecated map, so
  // pass the params through unchanged rather than touch the deprecated cost_models.
  const existingRaw = protocolParams.cost_models_raw ?? protocolParams.costModelsRaw;
  if (existingRaw && typeof existingRaw === 'object' && Object.keys(existingRaw).length > 0) {
    return protocolParams;
  }

  const costModels = protocolParams.cost_models ?? protocolParams.costModels;
  if (!costModels || typeof costModels !== 'object') return protocolParams;

  const raw = {};
  const named = {};
  let converted = false;
  for (const [lang, model] of Object.entries(costModels)) {
    const keys = model && typeof model === 'object' && !Array.isArray(model) ? Object.keys(model) : null;
    if (keys && keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      raw[lang] = keys.sort((a, b) => Number(a) - Number(b)).map((k) => model[k]);
      converted = true;
    } else {
      named[lang] = model;
    }
  }
  if (!converted) return protocolParams;

  const out = { ...protocolParams };
  delete out.cost_models;
  delete out.costModels;
  if (Object.keys(named).length > 0) out.cost_models = named;
  out.cost_models_raw = raw;
  return out;
}

function libFilename() {
  const platform = os.platform();
  if (platform === 'darwin') return 'libccl.dylib';
  if (platform === 'win32') return 'libccl.dll';
  return 'libccl.so';
}

// Is this a musl-based Linux (Alpine)? os.platform() reports "linux" for both glibc and musl, so —
// exactly as the Go loader does — detect musl by its dynamic loader, a file only musl systems ship.
// Without this an Alpine user resolves to the glibc package and gets a load failure, because the
// glibc libccl.so cannot load under musl.
function isMuslLinux() {
  if (os.platform() !== 'linux') return false;
  const loader = os.arch() === 'arm64'
    ? '/lib/ld-musl-aarch64.so.1'
    : '/lib/ld-musl-x86_64.so.1';
  return existsSync(loader);
}

// The per-platform npm package suffix for the current runtime, e.g. "macos-aarch64". Mirrors the
// native build/release matrix; used to locate the `@bloxbean/cardano-client-lib-<suffix>` optionalDependency.
export function platformSuffix() {
  const p = os.platform();
  const a = os.arch();
  if (p === 'darwin') return a === 'arm64' ? 'macos-aarch64' : 'macos-x86_64';
  if (p === 'win32') return 'windows-x86_64';
  if (isMuslLinux()) {
    // GraalVM's --libc=musl is x86_64-only (it hardcodes x86_64-linux-musl-gcc), so there is no
    // musl/aarch64 build to fall back to — say so, rather than handing back a glibc package that
    // cannot load here. See ADR-0008.
    if (a === 'arm64') {
      throw new Error(
        'No prebuilt libccl for musl/aarch64 (Alpine on ARM): GraalVM\'s --libc=musl is x86_64-only. ' +
        'Build libccl from source and set CCL_LIB_PATH.'
      );
    }
    return 'linux-musl-x86_64';
  }
  return a === 'arm64' ? 'linux-aarch64' : 'linux-x86_64';
}

// Locate the native library, in priority order:
//   1. an explicit `libPath` argument (a directory), if given;
//   2. the CCL_LIB_PATH env var (a directory) — for development against a locally built lib;
//   3. a copy bundled directly in this package (`libs/`) — a local `pack` or single-package install;
//   4. the `@bloxbean/cardano-client-lib-<platform>` optionalDependency package — the published layout;
//   5. the bare filename, letting the OS loader search its default paths.
export function resolveLibFile(libPath) {
  const name = libFilename();
  if (libPath) return path.join(libPath, name);
  if (process.env.CCL_LIB_PATH) return path.join(process.env.CCL_LIB_PATH, name);
  const bundled = path.join(import.meta.dir, '..', 'libs', name);
  if (existsSync(bundled)) return bundled;
  try {
    const fromPkg = Bun.resolveSync(`@bloxbean/cardano-client-lib-${platformSuffix()}/${name}`, import.meta.dir);
    if (fromPkg && existsSync(fromPkg)) return fromPkg;
  } catch {
    // platform package not installed — fall through to the bare filename
  }
  return name;
}

// Native libccl version this wrapper expects, kept in lockstep with the package version. On
// construction the wrapper compares it against ccl_version() and fails fast on a skew.
const EXPECTED_LIB_VERSION = '0.1.0';

// Strip any pre-release / build suffix: '0.1.0-preview1' -> '0.1.0'.
function baseVersion(v) {
  return v.split(/[-+]/, 1)[0].trim();
}
export class CclBridge {
  constructor(libPath) {
    const libFile = resolveLibFile(libPath);

    let lib;
    try {
      lib = dlopen(libFile, {
      graal_create_isolate: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      graal_tear_down_isolate: {
        args: [FFIType.ptr],
        returns: FFIType.i32,
      },
      ccl_version: { args: [FFIType.ptr], returns: FFIType.i32 },
      ccl_get_result: { args: [FFIType.ptr], returns: FFIType.ptr },
      ccl_get_last_error: { args: [FFIType.ptr], returns: FFIType.ptr },
      ccl_free_string: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },

      // Managed account handles (ADR-0016)
      ccl_account_open_mnemonic: { args: [FFIType.ptr, FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      ccl_account_get_info: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
      ccl_account_sign_tx_handle: { args: [FFIType.ptr, FFIType.i64, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      ccl_account_close: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
      ccl_account_create_handle: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      ccl_account_export_recovery_phrase: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },

      // Address
      ccl_address_info: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_address_validate: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_address_to_bytes: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_address_from_bytes: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },

      // Crypto
      ccl_crypto_blake2b_256: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_crypto_blake2b_224: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_crypto_generate_mnemonic: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      ccl_crypto_validate_mnemonic: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_crypto_sign: { args: [FFIType.ptr, FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
      ccl_crypto_verify: { args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
      ccl_crypto_derive_key: { args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },

      // Transaction
      ccl_tx_sign_with_secret_key: { args: [FFIType.ptr, FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
      ccl_tx_hash: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_tx_to_json: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_tx_from_json: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_tx_deserialize: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },

      // Plutus
      ccl_plutus_data_hash: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_plutus_data_to_json: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_plutus_data_from_json: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },

      // Script
      ccl_script_native_from_json: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      ccl_script_hash: { args: [FFIType.ptr, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },

      // QuickTx
      ccl_quicktx_build: { args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    });
    } catch (e) {
      throw new Error(
        `Failed to load the CCL native library (${libFile}): ${e.message}\n` +
        `Install a package that bundles it, or set CCL_LIB_PATH to the directory containing ${libFilename()}.`
      );
    }

    this._lib = lib.symbols;

    // Create isolate
    const isolateBuf = new BigInt64Array(1);
    const threadBuf = new BigInt64Array(1);
    const rc = this._lib.graal_create_isolate(null, ptr(isolateBuf), ptr(threadBuf));
    if (rc !== 0) {
      throw new Error(`Failed to create GraalVM isolate: ${rc}`);
    }
    this._threadPtr = Number(threadBuf[0]);

    this._checkVersion();

    // Namespace APIs
    this.address = new AddressApi(this);
    this.crypto = new CryptoApi(this);
    this.tx = new TxApi(this);
    this.plutus = new PlutusApi(this);
    this.script = new ScriptApi(this);
    this.quicktx = new QuickTxApi(this);
    this.accounts = new AccountsApi(this);
  }

  /**
   * The GraalVM isolate thread. Every FFI call in this file reads it, so it is the one place that
   * can catch use-after-close.
   *
   * close() tears the isolate down; passing its stale handle back to the native side makes GraalVM
   * abort the *process* ("Failed to enter the specified IsolateThread context") — not a JS
   * exception, so try/catch cannot see it and no stack points at the offending call. Any stray async
   * callback racing the `finally { bridge.close() }` that the examples teach would kill the process.
   * Throwing a real Error here turns that into something catchable and debuggable.
   *
   * @throws {CclClosedError} if the bridge has been closed
   */
  get _thread() {
    if (this._threadPtr === null) {
      throw new CclClosedError();
    }
    return this._threadPtr;
  }

  _getResult() {
    const resultPtr = this._lib.ccl_get_result(this._thread);
    if (!resultPtr) return '';
    const result = new CString(resultPtr);
    const str = result.toString();
    this._lib.ccl_free_string(this._thread, resultPtr);
    return str;
  }

  _getError() {
    const errorPtr = this._lib.ccl_get_last_error(this._thread);
    if (!errorPtr) return '';
    const error = new CString(errorPtr);
    const str = error.toString();
    this._lib.ccl_free_string(this._thread, errorPtr);
    return str;
  }

  _check(rc) {
    if (rc !== CCL_SUCCESS) {
      throw new CclError(rc, this._getError());
    }
    return this._getResult();
  }

  // Like _check, but never touches the read-once result slot — for calls whose result (if any)
  // is delivered out-of-band (out-params) or that produce none.
  _checkRc(rc) {
    if (rc !== CCL_SUCCESS) {
      throw new CclError(rc, this._getError());
    }
  }

  /** Tear down the isolate. Idempotent; any later call throws {@link CclClosedError}. */
  close() {
    if (this._threadPtr !== null) {
      this._lib.graal_tear_down_isolate(this._threadPtr);
      this._threadPtr = null;
    }
  }

  /** Enables `using bridge = new CclBridge()` — closes automatically at end of scope. */
  [Symbol.dispose]() {
    this.close();
  }

  version() {
    return this._check(this._lib.ccl_version(this._thread));
  }

  // Fail fast on a native-lib / wrapper version skew (bypass with CCL_SKIP_VERSION_CHECK).
  _checkVersion() {
    if (process.env.CCL_SKIP_VERSION_CHECK) return;
    const libVer = this.version();
    if (baseVersion(libVer) !== baseVersion(EXPECTED_LIB_VERSION)) {
      throw new Error(
        `libccl version '${libVer}' is incompatible with the @bloxbean/cardano-client-lib wrapper ` +
        `(expects '${EXPECTED_LIB_VERSION}'). The native library and wrapper must be the same version ` +
        `— reinstall the package, or set CCL_LIB_PATH to a matching libccl. ` +
        `Set CCL_SKIP_VERSION_CHECK=1 to bypass.`
      );
    }
  }
}

// --- Namespace API classes ---

class AddressApi {
  constructor(bridge) { this._b = bridge; }

  /**
   * Decode a bech32 address.
   *
   * The returned `network_id` is Cardano's genuine **on-chain** network id (0 = testnet, 1 =
   * mainnet) — the inverse of the MAINNET/TESTNET ordinals accepted by the `network` parameters
   * elsewhere in this API. Do not feed it back into `account.create()` / `wallet.create()`.
   *
   * @param {string} bech32
   * @returns {{type: string, network_id: 0|1, payment_credential_hash?: string, delegation_credential_hash?: string, is_pubkey_payment: boolean, is_script_payment: boolean}}
   */
  info(bech32) {
    return JSON.parse(this._b._check(this._b._lib.ccl_address_info(this._b._thread, cstr(bech32))));
  }

  validate(bech32) {
    return this._b._lib.ccl_address_validate(this._b._thread, cstr(bech32)) === CCL_SUCCESS;
  }

  toBytes(bech32) {
    return this._b._check(this._b._lib.ccl_address_to_bytes(this._b._thread, cstr(bech32)));
  }

  fromBytes(hexBytes) {
    return this._b._check(this._b._lib.ccl_address_from_bytes(this._b._thread, cstr(hexBytes)));
  }
}

class CryptoApi {
  constructor(bridge) { this._b = bridge; }

  blake2b256(dataHex) {
    return this._b._check(this._b._lib.ccl_crypto_blake2b_256(this._b._thread, cstr(dataHex)));
  }

  blake2b224(dataHex) {
    return this._b._check(this._b._lib.ccl_crypto_blake2b_224(this._b._thread, cstr(dataHex)));
  }

  generateMnemonic(wordCount = 24) {
    return this._b._check(this._b._lib.ccl_crypto_generate_mnemonic(this._b._thread, wordCount));
  }

  validateMnemonic(mnemonic) {
    return this._b._lib.ccl_crypto_validate_mnemonic(this._b._thread, cstr(mnemonic)) === CCL_SUCCESS;
  }

  /**
   * Ed25519 sign. `skHex` is a 32-byte seed (64 hex chars) or a 64-byte BIP32-Ed25519
   * extended key (128 hex chars, e.g. from {@link CryptoApi#deriveKey}) — detected by length.
   */
  sign(messageHex, skHex) {
    return this._b._check(this._b._lib.ccl_crypto_sign(this._b._thread, cstr(messageHex), cstr(skHex)));
  }

  verify(signatureHex, messageHex, pkHex) {
    return this._b._lib.ccl_crypto_verify(this._b._thread, cstr(signatureHex), cstr(messageHex), cstr(pkHex)) === CCL_SUCCESS;
  }

  /**
   * Stateless CIP-1852 key derivation — the explicit "raw key material" utility.
   *
   * `role` is one of "payment", "change", "stake", "drep", "committee_cold", "committee_hot".
   * Returns `{path, private_key, public_key, public_key_hash}`; pass `private_key` whole to
   * {@link CryptoApi#sign}, which detects the 64-byte extended form by length (never slice it —
   * its first half is a clamped scalar, not a seed). Key derivation is
   * network-independent. Prefer managed accounts for signing — handles never expose key bytes.
   */
  deriveKey(mnemonic, accountIndex = 0, addressIndex = 0, role = "payment") {
    return JSON.parse(this._b._check(this._b._lib.ccl_crypto_derive_key(
      this._b._thread, cstr(mnemonic), accountIndex, addressIndex, cstr(role))));
  }
}

class TxApi {
  constructor(bridge) { this._b = bridge; }

  hash(txCborHex) {
    return this._b._check(this._b._lib.ccl_tx_hash(this._b._thread, cstr(txCborHex)));
  }

  signWithSecretKey(txCborHex, skCborHex) {
    return this._b._check(this._b._lib.ccl_tx_sign_with_secret_key(this._b._thread, cstr(txCborHex), cstr(skCborHex)));
  }

  toJson(txCborHex) {
    return this._b._check(this._b._lib.ccl_tx_to_json(this._b._thread, cstr(txCborHex)));
  }

  fromJson(txJson) {
    return this._b._check(this._b._lib.ccl_tx_from_json(this._b._thread, cstr(txJson)));
  }

  deserialize(txCborHex) {
    return JSON.parse(this._b._check(this._b._lib.ccl_tx_deserialize(this._b._thread, cstr(txCborHex))));
  }
}

class PlutusApi {
  constructor(bridge) { this._b = bridge; }

  dataHash(datumCborHex) {
    return this._b._check(this._b._lib.ccl_plutus_data_hash(this._b._thread, cstr(datumCborHex)));
  }

  dataToJson(cborHex) {
    return this._b._check(this._b._lib.ccl_plutus_data_to_json(this._b._thread, cstr(cborHex)));
  }

  dataFromJson(json) {
    return this._b._check(this._b._lib.ccl_plutus_data_from_json(this._b._thread, cstr(json)));
  }
}

class ScriptApi {
  constructor(bridge) { this._b = bridge; }

  nativeFromJson(json) {
    return this._b._check(this._b._lib.ccl_script_native_from_json(this._b._thread, cstr(json)));
  }

  hash(scriptCborHex, scriptType = 0) {
    return this._b._check(this._b._lib.ccl_script_hash(this._b._thread, cstr(scriptCborHex), scriptType));
  }
}

export class QuickTxApi {
  constructor(bridge) {
    this._b = bridge;
  }

  /**
   * Build an unsigned transaction from a CCL TxPlan (YAML), fully offline.
   *
   * @param {string} txplanYaml - the TxPlan YAML document defining the transaction(s).
   * @param {Array<object>} utxos - UTXOs (CCL Utxo model) available to the sender.
   * @param {object} protocolParams - protocol parameters (CCL ProtocolParams model).
   * @param {Array<{mem: (number|string), steps: (number|string)}>} [execUnits] - optional redeemer
   *   execution units (one per redeemer, in transaction order) for Plutus script transactions.
   *   Compute these with any evaluator (Ogmios, Blockfrost, Aiken, Scalus); the bridge does not run
   *   the script.
   * @param {number} [additionalSigners=0] - vkey witnesses the fee must budget beyond those implied
   *   by the input UTXOs (one per sender). You know how many keys will sign: 0 for a plain payment,
   *   1 for a stake or DRep certificate (["payment", "stake"] signing), 2 for both in one tx, the
   *   number of sig keys for a native-script spend, plus one per plan-level required signer.
   *   Undercounting yields a fee the node rejects with FeeTooSmallUTxO; overcounting only overpays
   *   (~4,400 lovelace per extra witness).
   * @returns {{tx_cbor: string, tx_hash: string, fee: string}}
   */
  build(txplanYaml, utxos, protocolParams, execUnits = null, additionalSigners = 0) {
    // losslessStringify, not JSON.stringify: a UTxO's lovelace amount or native-token quantity can
    // exceed 2^53, and providers parse those with lossless-json (see providers.js) so they arrive as
    // string-backed LosslessNumber. JSON.stringify would coerce them back through a float64 and
    // round — corrupting the amount fed into UTxO selection and change calculation. losslessStringify
    // emits them as exact bare integers (which the native side's Jackson parses as BigInteger);
    // regular numbers and strings pass through unchanged.
    const rc = this._b._lib.ccl_quicktx_build(
      this._b._thread,
      cstr(txplanYaml),
      cstr(losslessStringify(utxos)),
      cstr(losslessStringify(normalizeCostModels(protocolParams))),
      execUnits != null ? cstr(losslessStringify(execUnits)) : null,
      additionalSigners,
    );
    // The build result is a YAML document.
    return parseYaml(this._b._check(rc));
  }

  /**
   * Convenience: fetch chain data from a provider and build, in one call.
   *
   * Composes `provider.utxos(sender)` + `provider.protocolParams()` with {@link QuickTxApi#build}.
   * The bridge stays offline — this only moves the optional HTTP fetch into wrapper code. See
   * `src/providers.js` for available providers (Yaci DevKit, Blockfrost) or supply your own object
   * with `utxos(address)` and `protocolParams()`.
   *
   * @param {string} txplanYaml - the TxPlan YAML document defining the transaction(s).
   * @param {{utxos: (a: string) => Promise<object[]>, protocolParams: () => Promise<object>}} provider
   * @param {string} sender - the address whose UTXOs fund the transaction.
   * @param {Array<{mem: (number|string), steps: (number|string)}>} [execUnits]
   * @returns {Promise<{tx_cbor: string, tx_hash: string, fee: string}>}
   */
  async buildWith(txplanYaml, provider, senders, evaluator = null, additionalSigners = 0) {
    // UTXOs are fetched per sender and de-duplicated by (tx_hash, output_index), so overlapping
    // senders can't double-fund the build. For multi-sender transactions, TxPlan's
    // context.fee_payer decides who pays the fee.
    const utxos = [];
    const seen = new Set();
    for (const sender of senders) {
      for (const u of await provider.utxos(sender)) {
        const key = `${u.tx_hash}#${u.output_index}`;
        if (!seen.has(key)) {
          seen.add(key);
          utxos.push(u);
        }
      }
    }
    const protocolParams = await provider.protocolParams();
    let execUnits = null;
    if (evaluator != null) {
      // Two-pass: draft (units computed offline by Scalus) -> remote evaluate -> rebuild.
      const draft = this.build(txplanYaml, utxos, protocolParams, null, additionalSigners);
      execUnits = await evaluator.evaluate(draft.tx_cbor, utxos);
    }
    return this.build(txplanYaml, utxos, protocolParams, execUnits, additionalSigners);
  }
}

/**
 * A managed account (ADR-0016) bound to one CIP-1852 payment leaf
 * (`m/1852'/1815'/account'/0/addressIndex`).
 *
 * One handle is one payment address; open further Accounts for further address indices. The
 * stake/DRep/committee keys sit at their standard role indices independent of `addressIndex`, so
 * Accounts at different address indices of one account index share a single stake/DRep identity.
 *
 * Lifecycle: call {@link Account#close} (idempotent) or use `using` / `Symbol.dispose`; any use
 * after close throws a {@link CclError} with code `CCL_ERROR_INVALID_HANDLE` (-11). String
 * representations never contain secret material.
 */
// Best-effort GC fallback (ADR-0016 "wrapper finalizers are fallback protection"): a dropped
// Account's native registry entry pins key material until process exit. Deterministic close()
// or `using` remains the contract — this only narrows the leak. The callback must not touch
// the read-once result slot (it ignores the return code) and must skip closed bridges: the raw
// _threadPtr guard is deliberate, the throwing _thread getter would be wrong in a finalizer.
const accountFinalizer = new FinalizationRegistry(({ bridge, handle }) => {
  if (bridge._threadPtr !== null && handle) {
    try {
      bridge._lib.ccl_account_close(bridge._threadPtr, handle);
    } catch {
      // best-effort only
    }
  }
});

export class Account {
  constructor(bridge, handle) {
    this._b = bridge;
    this._handle = handle;
    this._info = null;
    accountFinalizer.register(this, { bridge, handle }, this);
  }

  /**
   * Public account data: `{ base_address, enterprise_address, stake_address, change_address, network,
   * account_index, address_index, drep_id, committee_cold_id, committee_cold_credential,
   * committee_hot_id, committee_hot_credential }`. Never contains secrets.
   */
  get info() {
    if (this._info === null) {
      const rc = this._b._lib.ccl_account_get_info(this._b._thread, this._handle);
      // Immutable for the handle's lifetime: fetch once, memoize frozen.
      this._info = Object.freeze(JSON.parse(this._b._check(rc)));
    }
    return this._info;
  }

  /**
   * Sign a transaction with the selected roles; returns the signed CBOR hex.
   *
   * `roles` is a {@link SigningRole} combination (bit mask), e.g.
   * `SigningRole.PAYMENT | SigningRole.STAKE` for a stake-certificate transaction. An empty mask
   * is rejected — signing never silently uses every key.
   */
  signTx(txCborHex, roles = SigningRole.PAYMENT) {
    const rc = this._b._lib.ccl_account_sign_tx_handle(
      this._b._thread, this._handle, cstr(txCborHex), roles);
    return this._b._check(rc);
  }

  /**
   * One-shot export of a freshly created account's recovery phrase.
   *
   * Only available on accounts from {@link AccountsApi#create}, and only once — the phrase is
   * removed on retrieval. Accounts opened from a mnemonic throw (the caller already holds the
   * phrase). Persist the returned value securely; nothing else ever returns it.
   */
  exportRecoveryPhrase() {
    // Delivered via out-param in the SAME call — never through the read-once result slot.
    // The native side destroys its pending copy only after the string is materialized, so a
    // failed delivery is retryable instead of orphaning the only copy of the phrase.
    const out = new BigUint64Array(1);
    const rc = this._b._lib.ccl_account_export_recovery_phrase(this._b._thread, this._handle, ptr(out));
    this._b._checkRc(rc);
    const phrasePtr = Number(out[0]);
    const phrase = new CString(phrasePtr).toString();
    this._b._lib.ccl_free_string(this._b._thread, phrasePtr);
    return phrase;
  }

  /** Release the native account state. Idempotent; further use throws with code -11. */
  close() {
    accountFinalizer.unregister(this); // closed deterministically; nothing left to finalize
    const handle = this._handle;
    this._handle = 0n; // 0 is never a valid handle
    this._info = null;
    if (handle && this._b._threadPtr !== null) {
      const rc = this._b._lib.ccl_account_close(this._b._thread, handle);
      this._b._check(rc);
    }
  }

  [Symbol.dispose]() {
    this.close();
  }

  toString() {
    return this._handle ? `<ccl.Account handle=${this._handle}>` : '<ccl.Account closed>';
  }
}

/** Managed-accounts namespace (`bridge.accounts`, ADR-0016). */
export class AccountsApi {
  constructor(bridge) {
    this._b = bridge;
  }

  /**
   * Open an account from a mnemonic at fixed derivation indices; returns an {@link Account}.
   * The mnemonic crosses the FFI boundary once, here; no later operation needs it.
   */
  fromMnemonic(mnemonic, network, accountIndex = 0, addressIndex = 0) {
    checkNetwork(network);
    const out = new BigInt64Array(1);
    const rc = this._b._lib.ccl_account_open_mnemonic(
      this._b._thread, network, cstr(mnemonic), accountIndex, addressIndex, ptr(out));
    this._b._check(rc);
    return new Account(this._b, out[0]);
  }

  /**
   * Create a brand-new account (fresh 24-word mnemonic); returns an {@link Account}.
   * No secret is returned here — retrieve the recovery phrase once, deliberately, with
   * {@link Account#exportRecoveryPhrase}.
   */
  create(network) {
    checkNetwork(network);
    const out = new BigInt64Array(1);
    const rc = this._b._lib.ccl_account_create_handle(this._b._thread, network, ptr(out));
    this._b._check(rc);
    return new Account(this._b, out[0]);
  }
}
