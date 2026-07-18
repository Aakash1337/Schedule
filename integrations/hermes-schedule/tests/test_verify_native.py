"""Native Hermes registration-verifier tests."""

from __future__ import annotations

import importlib
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from support import PACKAGE_NAME, PLUGIN_ROOT


verifier = importlib.import_module(f"{PACKAGE_NAME}.verify_native")


class FakeRegistry:
    def __init__(self, handlers: dict[str, object], toolset: str = "schedule") -> None:
        self.handlers = handlers
        self.toolset = toolset

    def get_entry(self, name: str):
        handler = self.handlers.get(name)
        return None if handler is None else SimpleNamespace(toolset=self.toolset, handler=handler)


def native_state(*, enabled: bool = True, tools=None, hooks=None, error=None):
    handlers = {name: (lambda: None) for name in verifier.EXPECTED_TOOLS}
    capture_turn = lambda: None
    module = SimpleNamespace(
        __file__=str(PLUGIN_ROOT / "__init__.py"),
        capture_turn=capture_turn,
    )
    for name, handler_name in verifier.EXPECTED_HANDLERS.items():
        setattr(module, handler_name, handlers[name])
    plugin = SimpleNamespace(
        enabled=enabled,
        error=error,
        manifest=SimpleNamespace(path=str(PLUGIN_ROOT)),
        module=module,
        tools_registered=list(verifier.EXPECTED_TOOLS if tools is None else tools),
        hooks_registered=list(verifier.EXPECTED_HOOKS if hooks is None else hooks),
    )
    manager = SimpleNamespace(
        _plugins={verifier.PLUGIN_KEY: plugin},
        _hooks={"pre_llm_call": [capture_turn]},
    )
    return manager, FakeRegistry(handlers)


class NativeVerificationTests(unittest.TestCase):
    def test_import_root_must_belong_to_a_hermes_virtual_environment(self) -> None:
        with patch.object(sys, "prefix", sys.base_prefix):
            with self.assertRaisesRegex(verifier.NativeVerificationError, "Hermes's Python"):
                verifier._prepare_hermes_import_root()

        with tempfile.TemporaryDirectory() as temporary:
            agent = Path(temporary) / "hermes-agent"
            prefix = agent / "venv"
            (agent / "hermes_cli").mkdir(parents=True)
            (agent / "tools").mkdir()
            (agent / "hermes_cli" / "plugins.py").touch()
            (agent / "tools" / "registry.py").touch()
            previous_path = list(sys.path)
            try:
                with (
                    patch.object(sys, "prefix", str(prefix)),
                    patch.object(sys, "base_prefix", str(Path(temporary) / "base")),
                ):
                    self.assertEqual(verifier._prepare_hermes_import_root(), agent.resolve())
            finally:
                sys.path[:] = previous_path

    def test_accepts_the_exact_native_registration(self) -> None:
        self.assertEqual(len(verifier.EXPECTED_TOOLS), 8)
        manager, registry = native_state()
        verifier.verify_registration(manager, registry)

    def test_main_reports_the_eight_tool_native_surface(self) -> None:
        manager, registry = native_state()
        hermes_cli = ModuleType("hermes_cli")
        hermes_plugins = ModuleType("hermes_cli.plugins")
        hermes_plugins.discover_plugins = lambda *, force: None
        hermes_plugins.get_plugin_manager = lambda: manager
        hermes_cli.plugins = hermes_plugins
        tools = ModuleType("tools")
        tool_registry = ModuleType("tools.registry")
        tool_registry.registry = registry
        tools.registry = tool_registry
        output = StringIO()
        with (
            patch.dict(
                sys.modules,
                {
                    "hermes_cli": hermes_cli,
                    "hermes_cli.plugins": hermes_plugins,
                    "tools": tools,
                    "tools.registry": tool_registry,
                },
            ),
            patch.object(verifier, "_prepare_hermes_import_root", return_value=PLUGIN_ROOT),
            patch.object(verifier, "_require_module_origin"),
            redirect_stdout(output),
        ):
            self.assertEqual(verifier.main(), 0)
        self.assertEqual(
            output.getvalue().strip(),
            "plugin=enabled tools=8 toolset=schedule hook=pre_llm_call",
        )

    def test_rejects_a_disabled_plugin(self) -> None:
        manager, registry = native_state(enabled=False)
        with self.assertRaisesRegex(verifier.NativeVerificationError, "plugins enable"):
            verifier.verify_registration(manager, registry)

    def test_rejects_registration_drift_and_duplicates(self) -> None:
        manager, registry = native_state(tools={"schedule_today"})
        with self.assertRaisesRegex(verifier.NativeVerificationError, "tool set"):
            verifier.verify_registration(manager, registry)

        duplicate_tools = [*verifier.EXPECTED_TOOLS, "schedule_today"]
        manager, registry = native_state(tools=duplicate_tools)
        with self.assertRaisesRegex(verifier.NativeVerificationError, "tool set"):
            verifier.verify_registration(manager, registry)

        manager, registry = native_state(hooks=[])
        with self.assertRaisesRegex(verifier.NativeVerificationError, "hook set"):
            verifier.verify_registration(manager, registry)

    def test_rejects_a_tool_outside_the_schedule_toolset(self) -> None:
        manager, registry = native_state()
        registry.toolset = "other"
        with self.assertRaisesRegex(verifier.NativeVerificationError, "native toolset"):
            verifier.verify_registration(manager, registry)

    def test_rejects_handler_hook_and_origin_drift(self) -> None:
        manager, registry = native_state()
        registry.handlers["schedule_today"] = lambda: None
        with self.assertRaisesRegex(verifier.NativeVerificationError, "native handler"):
            verifier.verify_registration(manager, registry)

        manager, registry = native_state()
        manager._hooks["pre_llm_call"] = []
        with self.assertRaisesRegex(verifier.NativeVerificationError, "active exactly once"):
            verifier.verify_registration(manager, registry)

        manager, registry = native_state()
        manager._plugins[verifier.PLUGIN_KEY].module.__file__ = str(PLUGIN_ROOT.parent / "other.py")
        with self.assertRaisesRegex(verifier.NativeVerificationError, "unexpected origin"):
            verifier.verify_registration(manager, registry)


if __name__ == "__main__":
    unittest.main()
