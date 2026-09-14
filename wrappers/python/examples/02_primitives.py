"""Crypto and address primitives (offline).

Run from the repo root:

    LIB_DIR=core/build/native/nativeCompile
    PYTHONPATH=wrappers/python CCL_LIB_PATH=$LIB_DIR \
    DYLD_LIBRARY_PATH=$LIB_DIR LD_LIBRARY_PATH=$LIB_DIR \
      python3 wrappers/python/examples/02_primitives.py
"""
from ccl import CclLib, Network


def main():
    lib = CclLib()
    try:
        # --- Mnemonics ---
        mnemonic = lib.crypto.generate_mnemonic(24)
        print("Generated 24-word mnemonic:", mnemonic)
        print("  valid? ", lib.crypto.validate_mnemonic(mnemonic))
        print("  'not a real mnemonic' valid?", lib.crypto.validate_mnemonic("not a real mnemonic"))

        # --- Blake2b hashing (hex in -> hex out). "Hello" == 48656c6c6f ---
        print("Blake2b-256('Hello'):", lib.crypto.blake2b_256("48656c6c6f"))
        print("Blake2b-224('Hello'):", lib.crypto.blake2b_224("48656c6c6f"))

        # --- Ed25519 signing ---
        # crypto.derive_key returns the 64-byte extended BIP32-Ed25519 key; pass it
        # whole to sign — the extended form is detected by length. (Never slice it:
        # its first half is a clamped scalar, not a seed.)
        mnemonic = lib.crypto.generate_mnemonic(24)
        key = lib.crypto.derive_key(mnemonic, role="payment")
        sk = key["private_key"]
        pk = key["public_key"]
        message_hex = "68656c6c6f"  # "hello"
        signature = lib.crypto.sign(message_hex, sk)
        print("Ed25519 signature:", signature)
        # A tampered signature is correctly rejected.
        print("  verify(fake signature) ->", lib.crypto.verify("00" * 64, message_hex, pk))

        # --- Address parsing & validation ---
        with lib.accounts.from_mnemonic(mnemonic, Network.TESTNET) as acct:
            addr = acct.info["base_address"]
        print("Address valid?", lib.address.validate(addr))
        print("Address info  :", lib.address.info(addr))
        raw = lib.address.to_bytes(addr)
        print("Address -> bytes -> address round-trips:",
              lib.address.from_bytes(raw) == addr)
    finally:
        lib.close()


if __name__ == "__main__":
    main()
