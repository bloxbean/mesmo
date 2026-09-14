#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libccl.h"

#define ASSERT(cond, msg) do { \
    if (!(cond)) { \
        fprintf(stderr, "FAIL: %s\n", msg); \
        failures++; \
    } else { \
        printf("PASS: %s\n", msg); \
    } \
} while(0)

int main(int argc, char **argv) {
    int failures = 0;
    int rc;

    graal_isolatethread_t *thread = NULL;
    graal_isolate_t *isolate = NULL;

    rc = graal_create_isolate(NULL, &isolate, &thread);
    ASSERT(rc == 0, "Create isolate");

    /* Test: version */
    rc = ccl_version(thread);
    ASSERT(rc == 0, "ccl_version returns 0");
    char *version = ccl_get_result(thread);
    ASSERT(version != NULL, "version result not null");
    ASSERT(strlen(version) > 0, "version is non-empty");
    printf("  Version: %s\n", version);
    ccl_free_string(thread, version);

    /* Test: managed account create (mainnet) — ADR-0016 handle API */
    long long handle = 0;
    rc = ccl_account_create_handle(thread, 0, &handle);
    ASSERT(rc == 0, "ccl_account_create_handle mainnet");
    ASSERT(handle != 0, "handle is non-zero");
    rc = ccl_account_get_info(thread, handle);
    ASSERT(rc == 0, "ccl_account_get_info");
    char *account_json = ccl_get_result(thread);
    ASSERT(account_json != NULL, "account info not null");
    ASSERT(strstr(account_json, "base_address") != NULL, "account info has base_address");
    ASSERT(strstr(account_json, "mnemonic") == NULL, "account info never contains the mnemonic");
    printf("  Account info (first 100 chars): %.100s...\n", account_json);
    ccl_free_string(thread, account_json);

    /* Test: one-shot recovery-phrase export — delivered via out-param in the same call */
    char *phrase = NULL;
    rc = ccl_account_export_recovery_phrase(thread, handle, &phrase);
    ASSERT(rc == 0, "ccl_account_export_recovery_phrase");
    ASSERT(phrase != NULL && strlen(phrase) > 0, "recovery phrase delivered in-call");
    ccl_free_string(thread, phrase);
    char *again = NULL;
    rc = ccl_account_export_recovery_phrase(thread, handle, &again);
    ASSERT(rc != 0, "second export fails (one-shot)");
    ASSERT(again == NULL, "failed export writes nothing");

    /* Test: close is effective — the handle is dead afterwards */
    rc = ccl_account_close(thread, handle);
    ASSERT(rc == 0, "ccl_account_close");
    rc = ccl_account_get_info(thread, handle);
    ASSERT(rc == -11, "closed handle returns CCL_ERROR_INVALID_HANDLE");

    /* Test: managed account create (testnet) */
    long long testnet_handle = 0;
    rc = ccl_account_create_handle(thread, 1, &testnet_handle);
    ASSERT(rc == 0, "ccl_account_create_handle testnet");
    rc = ccl_account_get_info(thread, testnet_handle);
    ASSERT(rc == 0, "ccl_account_get_info testnet");
    char *testnet_json = ccl_get_result(thread);
    ASSERT(strstr(testnet_json, "addr_test1") != NULL, "testnet address has addr_test1 prefix");
    ccl_free_string(thread, testnet_json);
    ccl_account_close(thread, testnet_handle);

    /* Test: invalid network */
    long long bogus_handle = 0;
    rc = ccl_account_create_handle(thread, 99, &bogus_handle);
    ASSERT(rc == -5, "invalid network returns CCL_ERROR_INVALID_NETWORK");

    /* Test: crypto blake2b_256 */
    rc = ccl_crypto_blake2b_256(thread, "48656c6c6f");  /* "Hello" in hex */
    ASSERT(rc == 0, "ccl_crypto_blake2b_256");
    char *hash = ccl_get_result(thread);
    ASSERT(hash != NULL, "blake2b hash not null");
    ASSERT(strlen(hash) == 64, "blake2b-256 hash is 64 hex chars");
    printf("  Blake2b-256 of 'Hello': %s\n", hash);
    ccl_free_string(thread, hash);

    /* Test: crypto generate mnemonic */
    rc = ccl_crypto_generate_mnemonic(thread, 24);
    ASSERT(rc == 0, "ccl_crypto_generate_mnemonic 24 words");
    char *mnemonic = ccl_get_result(thread);
    ASSERT(mnemonic != NULL, "mnemonic not null");
    printf("  Generated mnemonic (first 50): %.50s...\n", mnemonic);

    /* Test: validate the generated mnemonic */
    rc = ccl_crypto_validate_mnemonic(thread, mnemonic);
    ASSERT(rc == 0, "ccl_crypto_validate_mnemonic valid");
    ccl_free_string(thread, mnemonic);

    /* Test: validate invalid mnemonic */
    rc = ccl_crypto_validate_mnemonic(thread, "invalid mnemonic phrase");
    ASSERT(rc != 0, "invalid mnemonic returns error");

    /* Summary */
    printf("\n=== Results: %d failures ===\n", failures);

    graal_tear_down_isolate(thread);
    return failures > 0 ? 1 : 0;
}
