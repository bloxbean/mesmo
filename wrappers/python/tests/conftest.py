import pytest
from mesmo._ffi import Mesmo


@pytest.fixture(scope="session")
def mesmo():
    """Create a shared Mesmo instance for all tests."""
    lib = Mesmo()
    yield lib
    lib.close()
