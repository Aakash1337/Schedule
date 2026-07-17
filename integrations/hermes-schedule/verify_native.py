#!/usr/bin/env python3
"""Verify that Hermes loaded the Schedule plugin without invoking its tools."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


PLUGIN_KEY = "hermes-schedule"
EXPECTED_HANDLERS = {
    "schedule_today": "handle_schedule_today",
    "schedule_daily_plan_fit": "handle_schedule_daily_plan_fit",
    "schedule_list_work_items": "handle_schedule_list_work_items",
    "schedule_list_one_off_reminders": "handle_schedule_list_one_off_reminders",
    "schedule_prepare_change": "handle_schedule_prepare_change",
    "schedule_confirm_change": "handle_schedule_confirm_change",
    "schedule_cancel_change": "handle_schedule_cancel_change",
}
EXPECTED_TOOLS = frozenset(EXPECTED_HANDLERS)
EXPECTED_HOOKS = frozenset({"pre_llm_call"})


class NativeVerificationError(Exception):
    """A fixed, operator-actionable native verification failure."""


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _prepare_hermes_import_root() -> Path:
    """Return the trusted install root and expose its adjacent source checkout."""

    prefix = Path(sys.prefix).resolve()
    if prefix == Path(sys.base_prefix).resolve():
        raise NativeVerificationError("run this script with Hermes's Python")
    candidate = prefix.parent.resolve()
    if (candidate / "hermes_cli" / "plugins.py").is_file() and (
        candidate / "tools" / "registry.py"
    ).is_file():
        sys.path.insert(0, str(candidate))
        return candidate
    return prefix


def _require_module_origin(module: Any, trusted_root: Path) -> None:
    location = getattr(module, "__file__", None)
    if not isinstance(location, str) or not _is_within(Path(location).resolve(), trusted_root):
        raise NativeVerificationError("Hermes modules loaded from outside the active installation")


def verify_registration(manager: Any, registry: Any) -> None:
    """Assert the plugin-specific registration state after native discovery."""

    plugin = getattr(manager, "_plugins", {}).get(PLUGIN_KEY)
    if plugin is None:
        raise NativeVerificationError("the plugin is not installed in the active Hermes home")
    if not getattr(plugin, "enabled", False):
        raise NativeVerificationError(
            "the plugin is disabled; run `hermes plugins enable hermes-schedule`"
        )
    if getattr(plugin, "error", None):
        raise NativeVerificationError("Hermes reported a plugin load error")

    module = getattr(plugin, "module", None)
    manifest = getattr(plugin, "manifest", None)
    module_file = getattr(module, "__file__", None)
    manifest_path = getattr(manifest, "path", None)
    if not isinstance(module_file, str) or not isinstance(manifest_path, str):
        raise NativeVerificationError("Hermes omitted the loaded plugin origin")
    if not _is_within(Path(module_file).resolve(), Path(manifest_path).resolve()):
        raise NativeVerificationError("Hermes loaded the plugin from an unexpected origin")

    tools = tuple(getattr(plugin, "tools_registered", ()))
    hooks = tuple(getattr(plugin, "hooks_registered", ()))
    if len(tools) != len(EXPECTED_TOOLS) or frozenset(tools) != EXPECTED_TOOLS:
        raise NativeVerificationError("the registered Schedule tool set is incomplete or unexpected")
    if len(hooks) != len(EXPECTED_HOOKS) or frozenset(hooks) != EXPECTED_HOOKS:
        raise NativeVerificationError("the registered Schedule hook set is incomplete or unexpected")

    for name, handler_name in EXPECTED_HANDLERS.items():
        entry = registry.get_entry(name)
        if entry is None or getattr(entry, "toolset", None) != "schedule":
            raise NativeVerificationError("a Schedule tool is absent from its native toolset")
        expected_handler = getattr(module, handler_name, None)
        if not callable(expected_handler) or getattr(entry, "handler", None) is not expected_handler:
            raise NativeVerificationError("a Schedule tool has an unexpected native handler")

    expected_hook = getattr(module, "capture_turn", None)
    active_hooks = getattr(manager, "_hooks", {}).get("pre_llm_call", ())
    if not callable(expected_hook) or sum(callback is expected_hook for callback in active_hooks) != 1:
        raise NativeVerificationError("the Schedule turn hook is not active exactly once")


def main() -> int:
    try:
        trusted_root = _prepare_hermes_import_root()
        import hermes_cli.plugins as hermes_plugins
        import tools.registry as tool_registry

        _require_module_origin(hermes_plugins, trusted_root)
        _require_module_origin(tool_registry, trusted_root)
    except ImportError:
        print(
            "Hermes Schedule native verification failed: run this script with Hermes's Python.",
            file=sys.stderr,
        )
        return 1
    except NativeVerificationError as error:
        print(f"Hermes Schedule native verification failed: {error}.", file=sys.stderr)
        return 1

    try:
        hermes_plugins.discover_plugins(force=True)
        verify_registration(hermes_plugins.get_plugin_manager(), tool_registry.registry)
    except NativeVerificationError as error:
        print(f"Hermes Schedule native verification failed: {error}.", file=sys.stderr)
        return 1
    except Exception:
        print("Hermes Schedule native verification failed: plugin discovery failed.", file=sys.stderr)
        return 1

    print("plugin=enabled tools=7 toolset=schedule hook=pre_llm_call")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
