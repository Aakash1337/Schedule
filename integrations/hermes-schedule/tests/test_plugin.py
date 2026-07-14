"""Hermes plugin registration contract tests."""

from __future__ import annotations

import unittest

from support import plugin


class FakePluginContext:
    def __init__(self) -> None:
        self.tools: list[dict] = []
        self.hooks: list[tuple[str, object]] = []

    def register_tool(self, **kwargs) -> None:
        self.tools.append(kwargs)

    def register_hook(self, name: str, callback: object) -> None:
        self.hooks.append((name, callback))


class PluginRegistrationTests(unittest.TestCase):
    def test_registers_only_the_bounded_schedule_tools_and_turn_hook(self) -> None:
        context = FakePluginContext()
        plugin.register(context)
        self.assertEqual(
            [entry["name"] for entry in context.tools],
            [
                "schedule_today",
                "schedule_list_work_items",
                "schedule_prepare_change",
                "schedule_confirm_change",
                "schedule_cancel_change",
            ],
        )
        self.assertTrue(all(entry["toolset"] == "schedule" for entry in context.tools))
        self.assertEqual([name for name, _callback in context.hooks], ["pre_llm_call"])


if __name__ == "__main__":
    unittest.main()
