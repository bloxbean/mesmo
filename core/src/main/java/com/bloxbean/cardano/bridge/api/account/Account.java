package com.bloxbean.cardano.bridge.api.account;

/**
 * A managed account (ADR-0016): a CCL account opened once from a mnemonic, held behind an opaque
 * handle in the {@link AccountService} registry. The network and derivation indices are fixed at
 * open and immutable for the account's lifetime.
 *
 * <p>A handle binds <b>one payment leaf</b> of the CIP-1852 tree
 * ({@code m/1852'/1815'/accountIndex'/0/addressIndex}) plus the account's role keys. This does not
 * limit a user to one Cardano address: further addresses of the same account are further leaves —
 * open one handle per leaf (a future wallet handle will derive leaves on demand). Note that the
 * stake, DRep, and committee keys sit at their standard role indices independent of
 * {@code addressIndex}, so handles at different address indices of one account share a single
 * stake/DRep identity.
 *
 * <p>This record carries key material (via the wrapped CCL account) and therefore never leaves the
 * registry — callers hold only the handle. Public data is served through
 * {@link AccountService#info(long)}.
 *
 * @param cclAccount   the wrapped CCL account, positioned at this handle's leaf; owns the key
 *                     derivation and signing (never exposed across the ABI)
 * @param networkId    the bridge network enum ordinal (0=mainnet, 1=testnet) — note this is <em>not</em> the on-chain network id, which is
 *                     inverted for mainnet/testnet
 * @param accountIndex the hardened CIP-1852 account index ({@code accountIndex'}); one handle can
 *                     never derive a sibling account, by design
 * @param addressIndex the payment-leaf index within the account (role {@code 0}); selects which
 *                     base/enterprise address this handle represents
 */
record Account(com.bloxbean.cardano.client.account.Account cclAccount,
               int networkId, int accountIndex, int addressIndex) {
}
