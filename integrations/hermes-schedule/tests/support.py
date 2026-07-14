"""Load the hyphenated Hermes plugin directory as an isolated Python package."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "schedule_hermes_test_plugin"


def load_plugin():
    existing = sys.modules.get(PACKAGE_NAME)
    if existing is not None:
        return existing
    specification = importlib.util.spec_from_file_location(
        PACKAGE_NAME,
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Could not load the Hermes Schedule plugin for tests")
    module = importlib.util.module_from_spec(specification)
    sys.modules[PACKAGE_NAME] = module
    specification.loader.exec_module(module)
    return module


plugin = load_plugin()
