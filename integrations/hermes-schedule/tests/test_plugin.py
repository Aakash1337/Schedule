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
                "schedule_daily_plan_fit",
                "schedule_list_work_items",
                "schedule_list_one_off_reminders",
                "schedule_prepare_change",
                "schedule_confirm_change",
                "schedule_cancel_change",
            ],
        )
        self.assertTrue(all(entry["toolset"] == "schedule" for entry in context.tools))
        self.assertEqual([name for name, _callback in context.hooks], ["pre_llm_call"])

    def test_command_schemas_match_the_current_gateway_bounds_and_hierarchy_fields(self) -> None:
        create = plugin.schemas.WORK_ITEM_CREATE["properties"]
        update = plugin.schemas.WORK_ITEM_UPDATE["properties"]
        activity = plugin.schemas.PLAN_ITEM_ACTIVITY["properties"]
        reminder = plugin.schemas.ONE_OFF_REMINDER_CREATE
        reminder_update = plugin.schemas.ONE_OFF_REMINDER_UPDATE
        reminder_cancel = plugin.schemas.ONE_OFF_REMINDER_CANCEL

        self.assertEqual(create["parentWorkItemId"]["oneOf"][1], {"type": "null"})
        self.assertEqual(update["parentWorkItemId"]["oneOf"][1], {"type": "null"})
        self.assertEqual(create["description"]["maxLength"], 4_000)
        self.assertEqual(
            create["planningDurationMinutes"]["oneOf"][0]["maximum"], 43_200
        )
        self.assertEqual(plugin.schemas.TIME_ZONE["maxLength"], 80)
        self.assertEqual(activity["metadata"]["maxProperties"], 8)
        self.assertEqual(activity["metadata"]["propertyNames"]["maxLength"], 64)
        self.assertEqual(activity["metadata"]["propertyNames"]["pattern"], r".*\S.*")
        self.assertIn("[1-8]", plugin.schemas.UUID["pattern"])
        self.assertIn(reminder, plugin.schemas.INTEGRATION_COMMAND["oneOf"])
        self.assertIn(reminder_update, plugin.schemas.INTEGRATION_COMMAND["oneOf"])
        self.assertIn(reminder_cancel, plugin.schemas.INTEGRATION_COMMAND["oneOf"])
        self.assertEqual(reminder["required"], ["type", "title", "scheduledFor"])
        self.assertFalse(reminder["additionalProperties"])
        self.assertEqual(reminder["properties"]["title"]["maxLength"], 240)
        self.assertEqual(reminder["properties"]["title"]["pattern"], r"^(?:\S|\S.*\S)$")
        self.assertEqual(reminder["properties"]["scheduledFor"], plugin.schemas.INSTANT)
        self.assertEqual(
            reminder_update["required"],
            ["type", "oneOffReminderId", "expectedVersion"],
        )
        self.assertEqual(
            reminder_update["anyOf"],
            [{"required": ["title"]}, {"required": ["scheduledFor"]}],
        )
        self.assertFalse(reminder_cancel["additionalProperties"])
        self.assertEqual(
            plugin.schemas.SCHEDULE_LIST_ONE_OFF_REMINDERS["parameters"]["required"],
            ["from", "to"],
        )
        self.assertEqual(
            plugin.schemas.SCHEDULE_DAILY_PLAN_FIT["parameters"],
            {
                "type": "object",
                "properties": {"forDate": plugin.schemas.LOCAL_DATE},
                "required": ["forDate"],
                "additionalProperties": False,
            },
        )

    def test_registration_isolates_schema_instances_from_consumer_mutation(self) -> None:
        first = FakePluginContext()
        plugin.register(first)
        first_prepare = next(entry for entry in first.tools if entry["name"] == "schedule_prepare_change")
        first_create = first_prepare["schema"]["parameters"]["properties"]["command"]["oneOf"][0]
        first_create["properties"]["title"]["maxLength"] = 1

        second = FakePluginContext()
        plugin.register(second)
        second_prepare = next(
            entry for entry in second.tools if entry["name"] == "schedule_prepare_change"
        )
        second_create = second_prepare["schema"]["parameters"]["properties"]["command"][
            "oneOf"
        ][0]
        self.assertEqual(second_create["properties"]["title"]["maxLength"], 240)
        self.assertEqual(plugin.schemas.WORK_ITEM_CREATE["properties"]["title"]["maxLength"], 240)


if __name__ == "__main__":
    unittest.main()
