import os
import shutil
import tempfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_TMP = tempfile.mkdtemp(prefix="flpc-test-")

# Configure before any flpc import: isolated DB, auth on, reload on every call.
os.environ["FLPC_DB"] = os.path.join(_TMP, "florida_pc.sqlite")
os.environ["FLPC_INPUT_DIRS"] = REPO
os.environ["FLPC_API_KEY"] = "test-key"
os.environ["FLPC_RELOAD_INTERVAL"] = "0"


@pytest.fixture(scope="session")
def store():
    from flpc.store import Store
    return Store()


@pytest.fixture()
def tmp_inputs(tmp_path):
    """A private input folder seeded with the 2026Q1 workbooks."""
    for name in os.listdir(REPO):
        if name.endswith(".xlsx") and "2026q1" in name:
            shutil.copy(os.path.join(REPO, name), tmp_path / name)
    return tmp_path


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP, ignore_errors=True)
