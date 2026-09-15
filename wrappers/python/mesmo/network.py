"""The network selector passed to key-derivation and signing calls.

.. warning::

   ``Network`` values are **CCL's own enum ordinals**, *not* Cardano's on-chain network id.
   The two are different things, and for mainnet/testnet they are **inverted**:

   =============== ============================= ==================================
   Member          CCL ordinal (what you pass)   Cardano on-chain ``network_id``
   =============== ============================= ==================================
   ``MAINNET``     0                             **1**
   ``TESTNET``     1                             **0**
   =============== ============================= ==================================

   So ``Network.MAINNET`` is ``0`` here, but the address it derives carries an on-chain
   network id of ``1``. This is confusing but correct — it is why these calls take a
   parameter named ``network`` and never ``network_id``.

   The *real* on-chain id is the ``network_id`` key returned by ``lib.address.info(addr)``.
   It is a different value from the ``Network`` member you passed in, and must not be fed
   back into these APIs::

       acct = lib.accounts.create(Network.MAINNET)              # Network.MAINNET == 0
       lib.address.info(acct.info["base_address"])["network_id"] # -> 1  (the on-chain id)

``Network`` is an :class:`enum.IntEnum`, so it is wire-compatible with the native call and a
plain ``int`` of 0 or 1 is still accepted anywhere a ``Network`` is.
"""

from enum import IntEnum

__all__ = ["Network"]


class Network(IntEnum):
    """CCL network enum ordinals. See the module docstring — these are NOT on-chain network ids."""

    MAINNET = 0
    TESTNET = 1
