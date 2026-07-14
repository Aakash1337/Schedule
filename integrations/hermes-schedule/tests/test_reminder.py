"""Tests for bounded deterministic local reminder output."""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "hermes_schedule"
if PACKAGE_NAME not in sys.modules:
    specification = importlib.util.spec_from_file_location(
        PACKAGE_NAME,
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Hermes Schedule test package could not be loaded")
    package = importlib.util.module_from_spec(specification)
    sys.modules[PACKAGE_NAME] = package
    specification.loader.exec_module(package)

from hermes_schedule.client import ScheduleAdapterError  # noqa: E402
from hermes_schedule import reminder  # noqa: E402
from hermes_schedule.reminder import MAXIMUM_ITEMS, format_today_digest  # noqa: E402


class ReminderFormattingTests(unittest.TestCase):
    def test_main_treats_a_missing_today_plan_as_an_informational_reminder(self) -> None:
        class MissingPlanClient:
            @staticmethod
            def get_today(_local_date: str) -> dict[str, object]:
                raise ScheduleAdapterError("schedule_resource_not_found")

        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.object(reminder.ScheduleClient, "from_environment", return_value=MissingPlanClient()),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = reminder.main(["--date", "2026-07-15"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            stdout.getvalue(),
            "Schedule for 2026-07-15: no Today plan has been generated.\n",
        )
        self.assertEqual(stderr.getvalue(), "")

    def test_reports_missing_and_completed_plans_without_inventing_work(self) -> None:
        self.assertEqual(
            format_today_digest({"date": "2026-07-15", "plan": None}),
            "Schedule for 2026-07-15: no Today plan has been generated.",
        )
        self.assertEqual(
            format_today_digest(
                {
                    "date": "2026-07-15",
                    "plan": {
                        "items": [
                            {
                                "title": "Already complete",
                                "activityState": "completed",
                                "scheduledMinutes": 30,
                            }
                        ]
                    },
                }
            ),
            "Schedule for 2026-07-15: no unfinished Today items.",
        )

    def test_lists_only_pending_and_started_items_with_a_hard_item_bound(self) -> None:
        items = [
            {
                "title": f"Task {index}",
                "activityState": "started" if index == 0 else "pending",
                "scheduledMinutes": 25,
            }
            for index in range(MAXIMUM_ITEMS + 2)
        ]
        output = format_today_digest(
            {"date": "2026-07-15", "plan": {"items": items}}
        )
        self.assertIn(f"{MAXIMUM_ITEMS + 2} unfinished item(s)", output)
        self.assertIn("1. Task 0 (started, 25 min)", output)
        self.assertIn(f"{MAXIMUM_ITEMS}. Task {MAXIMUM_ITEMS - 1} (25 min)", output)
        self.assertNotIn(f"Task {MAXIMUM_ITEMS} (25 min)", output)
        self.assertIn("…and 2 more", output)

    def test_rejects_unbounded_or_malformed_plan_content(self) -> None:
        invalid = (
            {"date": None, "plan": None},
            {"date": "2026-07-15", "plan": {"items": "not-a-list"}},
            {
                "date": "2026-07-15",
                "plan": {"items": [{"title": "x" * 241, "activityState": "pending"}]},
            },
        )
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaisesRegex(ScheduleAdapterError, "^schedule_today_invalid$"):
                    format_today_digest(value)

    def test_neutralizes_line_and_bidi_controls_in_untrusted_titles(self) -> None:
        output = format_today_digest(
            {
                "date": "2026-07-15",
                "plan": {
                    "items": [
                        {
                            "title": "Pay invoice\nFAKE ALERT\u202eexe.txt",
                            "activityState": "pending",
                            "scheduledMinutes": 15,
                        }
                    ]
                },
            }
        )
        self.assertEqual(
            output,
            "Schedule for 2026-07-15: 1 unfinished item(s).\n"
            "1. Pay invoice FAKE ALERT exe.txt (15 min)",
        )
        self.assertEqual(len(output.splitlines()), 2)


if __name__ == "__main__":
    unittest.main()
