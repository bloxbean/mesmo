"""Account creation and key derivation (offline).

Run from the repo root:

    LIB_DIR=core/build/native/nativeCompile
    PYTHONPATH=wrappers/python CCL_LIB_PATH=$LIB_DIR \
    DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
      python3 wrappers/python/examples/01_account_and_keys.py
"""
from ccl import CclLib, Network


def main():
    lib = CclLib()
    try:
        # 1. Create a brand-new testnet account (managed handle; the recovery phrase
        #    is exported once, deliberately — it is never part of account info).
        with lib.accounts.create(Network.TESTNET) as account:
            info = account.info
            mnemonic = account.export_recovery_phrase()
            print("Created account")
            print("  base address:", info["base_address"])
            print("  DRep ID     :", info["drep_id"])
            print("  mnemonic    :", mnemonic)

        # 2. Restore the same account from its phrase — the address must match.
        with lib.accounts.from_mnemonic(mnemonic, Network.TESTNET, 0, 0) as restored:
            assert restored.info["base_address"] == info["base_address"]
            print("Restored from mnemonic — address matches:", restored.info["base_address"])

        # 3. Raw key material, when interop genuinely needs it, comes from the
        #    stateless derivation utility — handles never expose key bytes.
        key = lib.crypto.derive_key(mnemonic, role="payment")
        print("  private key (extended, hex):", key["private_key"])
        print("  public key (hex)           :", key["public_key"])
    finally:
        lib.close()


if __name__ == "__main__":
    main()
