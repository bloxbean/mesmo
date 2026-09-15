import pytest
from mesmo._ffi import MesmoLib


@pytest.fixture(scope="session")
def ccl():
    """Create a shared MesmoLib instance for all tests."""
    lib = MesmoLib()
    yield lib
    lib.close()
