"""Hermes Schedule local installation tests."""

from __future__ import annotations

import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from support import PACKAGE_NAME, PLUGIN_ROOT


installer = importlib.import_module(f"{PACKAGE_NAME}.install")


class HermesInstallTests(unittest.TestCase):
    def test_uses_the_native_windows_home_when_no_override_is_set(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch.dict(os.environ, {"LOCALAPPDATA": temporary}, clear=True),
                patch.object(sys, "platform", "win32"),
            ):
                self.assertEqual(installer.default_hermes_home(), Path(temporary) / "hermes")

    def test_explicit_home_still_wins_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            configured = Path(temporary) / "configured"
            with (
                patch.dict(
                    os.environ,
                    {"HERMES_HOME": str(configured), "LOCALAPPDATA": temporary},
                    clear=True,
                ),
                patch.object(sys, "platform", "win32"),
            ):
                self.assertEqual(installer.default_hermes_home(), configured)

    def test_windows_home_has_a_stable_fallback_without_local_app_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            user_home = Path(temporary)
            with (
                patch.dict(os.environ, {}, clear=True),
                patch.object(sys, "platform", "win32"),
                patch.object(installer.Path, "home", return_value=user_home),
            ):
                self.assertEqual(
                    installer.default_hermes_home(),
                    user_home / "AppData" / "Local" / "hermes",
                )

    def test_non_windows_home_keeps_the_posix_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            user_home = Path(temporary)
            with (
                patch.dict(os.environ, {}, clear=True),
                patch.object(sys, "platform", "linux"),
                patch.object(installer.Path, "home", return_value=user_home),
            ):
                self.assertEqual(installer.default_hermes_home(), user_home / ".hermes")

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
