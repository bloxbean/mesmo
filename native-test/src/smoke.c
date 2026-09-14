/*
 * Minimal functional smoke for the static-linking spike.
 *
 * Proves libccl.so doesn't just *load* on an old-glibc distro but actually *runs*: it creates a
 * GraalVM isolate (the runtime initialises), reads the version, and derives a testnet account
 * (exercises the real crypto path). Compiled in the manylinux_2_28 builder against the headers,
 * then executed inside an old container (centos:7, glibc 2.17). Returns non-zero on any failure.
 */
#include <stdio.h>
#include <string.h>
#include "libccl.h"

int main(void) {
    graal_isolatethread_t *thread = NULL;
    graal_isolate_t *isolate = NULL;

    if (graal_create_isolate(NULL, &isolate, &thread) != 0) {
        fprintf(stderr, "FAIL: graal_create_isolate\n");
        return 1;
    }

    if (ccl_version(thread) != 0) {
        fprintf(stderr, "FAIL: ccl_version rc\n");
        return 1;
    }
    char *version = ccl_get_result(thread);
    if (version == NULL || strlen(version) == 0) {
        fprintf(stderr, "FAIL: empty version\n");
        return 1;
    }
    printf("libccl version: %s\n", version);
    ccl_free_string(thread, version);

    /* A real operation (key derivation), not just a load check. */
    long long handle = 0;
    if (ccl_account_create_handle(thread, 1, &handle) != 0) {
        fprintf(stderr, "FAIL: ccl_account_create_handle rc\n");
        return 1;
    }
    if (ccl_account_get_info(thread, handle) != 0) {
        fprintf(stderr, "FAIL: ccl_account_get_info rc\n");
        return 1;
    }
    char *account = ccl_get_result(thread);
    if (account == NULL || strstr(account, "addr_test1") == NULL) {
        fprintf(stderr, "FAIL: testnet account missing addr_test1\n");
        return 1;
    }
    printf("account ok (testnet address derived)\n");
    ccl_free_string(thread, account);
    ccl_account_close(thread, handle);

    printf("SMOKE OK\n");
    return 0;
}
