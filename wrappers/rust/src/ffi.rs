// Auto-generated bindings will be included here by build.rs
// For development without a built native library, we define the FFI manually.

#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(dead_code)]

use std::os::raw::{c_char, c_int, c_void};

// GraalVM isolate types
pub type graal_isolate_t = c_void;
pub type graal_isolatethread_t = c_void;

extern "C" {
    // GraalVM isolate lifecycle
    pub fn graal_create_isolate(
        params: *mut c_void,
        isolate: *mut *mut graal_isolate_t,
        thread: *mut *mut graal_isolatethread_t,
    ) -> c_int;

    pub fn graal_tear_down_isolate(thread: *mut graal_isolatethread_t) -> c_int;

    // Cardano Client Bindings lifecycle
    pub fn ccl_version(thread: *mut graal_isolatethread_t) -> c_int;
    pub fn ccl_get_result(thread: *mut graal_isolatethread_t) -> *mut c_char;
    pub fn ccl_get_last_error(thread: *mut graal_isolatethread_t) -> *mut c_char;
    pub fn ccl_free_string(thread: *mut graal_isolatethread_t, ptr: *mut c_char);


    // Address API
    pub fn ccl_address_info(thread: *mut graal_isolatethread_t, bech32: *const c_char) -> c_int;
    pub fn ccl_address_to_bytes(thread: *mut graal_isolatethread_t, bech32: *const c_char) -> c_int;
    pub fn ccl_address_from_bytes(
        thread: *mut graal_isolatethread_t,
        hex_bytes: *const c_char,
    ) -> c_int;
    pub fn ccl_address_validate(
        thread: *mut graal_isolatethread_t,
        bech32: *const c_char,
    ) -> c_int;

    // Crypto API
    pub fn ccl_crypto_blake2b_256(
        thread: *mut graal_isolatethread_t,
        data_hex: *const c_char,
    ) -> c_int;
    pub fn ccl_crypto_blake2b_224(
        thread: *mut graal_isolatethread_t,
        data_hex: *const c_char,
    ) -> c_int;
    pub fn ccl_crypto_generate_mnemonic(
        thread: *mut graal_isolatethread_t,
        word_count: c_int,
    ) -> c_int;
    pub fn ccl_crypto_validate_mnemonic(
        thread: *mut graal_isolatethread_t,
        mnemonic: *const c_char,
    ) -> c_int;
    pub fn ccl_crypto_sign(
        thread: *mut graal_isolatethread_t,
        message_hex: *const c_char,
        sk_hex: *const c_char,
    ) -> c_int;
    pub fn ccl_crypto_verify(
        thread: *mut graal_isolatethread_t,
        signature_hex: *const c_char,
        message_hex: *const c_char,
        pk_hex: *const c_char,
    ) -> c_int;
    pub fn ccl_crypto_derive_key(
        thread: *mut graal_isolatethread_t,
        mnemonic: *const c_char,
        account_index: c_int,
        address_index: c_int,
        role: *const c_char,
    ) -> c_int;

    // Transaction API
    pub fn ccl_tx_sign_with_secret_key(
        thread: *mut graal_isolatethread_t,
        tx_cbor_hex: *const c_char,
        sk_cbor_hex: *const c_char,
    ) -> c_int;
    pub fn ccl_tx_hash(thread: *mut graal_isolatethread_t, tx_cbor_hex: *const c_char) -> c_int;
    pub fn ccl_tx_to_json(thread: *mut graal_isolatethread_t, tx_cbor_hex: *const c_char)
        -> c_int;
    pub fn ccl_tx_from_json(thread: *mut graal_isolatethread_t, tx_json: *const c_char) -> c_int;
    pub fn ccl_tx_deserialize(
        thread: *mut graal_isolatethread_t,
        tx_cbor_hex: *const c_char,
    ) -> c_int;

    // Plutus API
    pub fn ccl_plutus_data_hash(
        thread: *mut graal_isolatethread_t,
        datum_cbor_hex: *const c_char,
    ) -> c_int;
    pub fn ccl_plutus_data_to_json(
        thread: *mut graal_isolatethread_t,
        cbor_hex: *const c_char,
    ) -> c_int;
    pub fn ccl_plutus_data_from_json(
        thread: *mut graal_isolatethread_t,
        json: *const c_char,
    ) -> c_int;



    // Script API
    pub fn ccl_script_native_from_json(
        thread: *mut graal_isolatethread_t,
        json: *const c_char,
    ) -> c_int;
    pub fn ccl_script_hash(
        thread: *mut graal_isolatethread_t,
        script_cbor_hex: *const c_char,
        script_type: c_int,
    ) -> c_int;

    // QuickTx API
    pub fn ccl_quicktx_build(
        thread: *mut graal_isolatethread_t,
        yaml: *const c_char,
        utxos_json: *const c_char,
        protocol_params_json: *const c_char,
        exec_units_json: *const c_char,
        additional_signers: c_int,
    ) -> c_int;

    // Managed account handles (ADR-0016)
    pub fn ccl_account_open_mnemonic(
        thread: *mut graal_isolatethread_t,
        network: c_int,
        mnemonic: *const c_char,
        account_index: c_int,
        address_index: c_int,
        out_handle: *mut i64,
    ) -> c_int;
    pub fn ccl_account_get_info(thread: *mut graal_isolatethread_t, handle: i64) -> c_int;
    pub fn ccl_account_sign_tx_handle(
        thread: *mut graal_isolatethread_t,
        handle: i64,
        tx_cbor: *const c_char,
        role_mask: c_int,
    ) -> c_int;
    pub fn ccl_account_close(thread: *mut graal_isolatethread_t, handle: i64) -> c_int;
    pub fn ccl_account_create_handle(
        thread: *mut graal_isolatethread_t,
        network: c_int,
        out_handle: *mut i64,
    ) -> c_int;
    pub fn ccl_account_export_recovery_phrase(
        thread: *mut graal_isolatethread_t,
        handle: i64,
        out_phrase: *mut *mut c_char,
    ) -> c_int;
}
