"""Hermes Schedule local installation tests."""

from __future__ import annotations

import importlib
from pathlib import Path
import tempfile
import unittest

from support import PACKAGE_NAME, PLUGIN_ROOT


installer = importlib.import_module(f"{PACKAGE_NAME}.install")


class HermesInstallTests(unittest.TestCase):
    def test_installs_only_runtime_and_reminder_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            installer.install(home, PLUGIN_ROOT)
            plugin, reminder = installer.paths(home)

            self.assertEqual(
                set(installer.PLUGIN_FILES), {path.name for path in plugin.iterdir()}
            )
            self.assertEqual(set(installer.REMINDER_FILES), {path.name for path in reminder.iterdir()})
            self.assertEqual(installer.check(home, PLUGIN_ROOT), ("current", "current"))

    def test_requires_explicit_replace_for_changed_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            installer.install(home, PLUGIN_ROOT)
            plugin, _reminder = installer.paths(home)
            (plugin / "client.py").write_text("changed", encoding="utf-8")

            with self.assertRaisesRegex(installer.HermesInstallError, "--replace"):
                installer.install(home, PLUGIN_ROOT)
            installer.install(home, PLUGIN_ROOT, replace=True)
            self.assertEqual(installer.check(home, PLUGIN_ROOT), ("current", "current"))

    def test_check_does_not_create_the_hermes_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "absent"
            self.assertEqual(installer.check(home, PLUGIN_ROOT), ("missing", "missing"))
            self.assertFalse(home.exists())

    def test_rejects_an_incomplete_source_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(installer.HermesInstallError, "source is incomplete"):
                installer.check(root / "home", root / "incomplete-source")


if __name__ == "__main__":
    unittest.main()
