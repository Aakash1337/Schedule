"""State and tool tests for sender-bound, next-turn confirmation."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4


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
from hermes_schedule.state import ConfirmationState  # noqa: E402
from hermes_schedule.tools import (  # noqa: E402
    capture_turn,
    configure_for_testing,
    handle_schedule_cancel_change,
    handle_schedule_confirm_change,
    handle_schedule_daily_plan_fit,
    handle_schedule_list_one_off_reminders,
    handle_schedule_list_work_items,
    handle_schedule_prepare_change,
    handle_schedule_today,
)


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


class _FakeClient:
    def __init__(self, *, fail_first_confirmation: bool = False) -> None:
        self.prepare_calls: list[tuple[str, dict[str, object]]] = []
        self.confirm_calls: list[tuple[str, str]] = []
        self.fail_first_confirmation = fail_first_confirmation
        self.confirmation_id = str(uuid4())
        self.work_item_id = str(uuid4())
        self.reminder_ranges: list[tuple[str, str]] = []
        self.plan_fit_dates: list[str] = []

    def get_today(self, local_date: str) -> dict[str, object]:
        return {
            "workspaceId": str(uuid4()),
            "date": local_date,
            "headVersion": 0,
            "plan": None,
        }

    def get_daily_plan_fit(self, for_date: str) -> dict[str, object]:
        self.plan_fit_dates.append(for_date)
        return {
            "forDate": for_date,
            "status": "suggested",
            "disposition": "available",
            "sampleCount": 4,
            "minimumSamples": 3,
            "suggestedTargetMinutes": 90,
            "suggestedTargetTaskCount": 3,
        }

    def list_work_items(self, **filters: object) -> dict[str, object]:
        return {
            "items": [],
            "page": {
                "limit": filters.get("limit", 100),
                "offset": filters.get("offset", 0),
            },
        }

    def list_one_off_reminders(self, start: str, end: str) -> dict[str, object]:
        self.reminder_ranges.append((start, end))
        return {"items": []}

    def prepare_change(self, request_id: str, command: dict[str, object]) -> dict[str, object]:
        self.prepare_calls.append((request_id, dict(command)))
        display = _canonical(command)
        return {
            "confirmationId": self.confirmation_id,
            "requestId": request_id,
            "commandHash": hashlib.sha256(display.encode("utf-8")).hexdigest(),
            "command": dict(command),
            "commandDisplay": display,
            "summary": "Create one exact work item.",
            "expiresAt": "2099-07-15T07:01:00.000Z",
        }

    def confirm_change(
        self,
        confirmation_id: str,
        idempotency_key: str,
        expected_operation: str,
        expected_command_hash: str,
    ) -> dict[str, object]:
        self.confirm_calls.append((confirmation_id, idempotency_key))
        if self.fail_first_confirmation and len(self.confirm_calls) == 1:
            raise ScheduleAdapterError("schedule_unavailable", retryable=True)
        return {
            "receiptVersion": 2,
            "confirmationId": confirmation_id,
            "operation": expected_operation,
            "commandHash": expected_command_hash,
            "outcome": {
                "type": "work_item.created",
                "workItem": {
                    "id": self.work_item_id,
                    "parentWorkItemId": None,
                    "status": "planned",
                    "priority": "none",
                    "planningDurationMinutes": None,
                    "dueOn": None,
                    "version": 1,
                },
            },
        }


class ScheduleToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.state = ConfirmationState(
            self.home / "state" / "schedule-adapter.sqlite3",
            b"test-only-binding-key-that-is-long-enough",
        )
        self.client = _FakeClient()
        configure_for_testing(self.client, self.state)

    def tearDown(self) -> None:
        configure_for_testing(None, None)
        self.temporary.cleanup()

    def _turn(self, turn_id: str, message: str, *, sender: str = "sender-private") -> None:
        capture_turn(
            session_id="session-private",
            turn_id=turn_id,
            user_message=message,
            platform="whatsapp",
            sender_id=sender,
        )

    def _prepare(self) -> dict[str, object]:
        command = {
            "type": "work_item.create",
            "title": "Confirmed only",
            "status": "planned",
        }
        result = json.loads(
            handle_schedule_prepare_change(
                {"command": command}, session_id="session-private"
            )
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "confirmation_required")
        self.assertEqual(result["confirmation"]["command"], command)
        self.assertEqual(self.client.confirm_calls, [])
        return result

    def test_prepare_does_not_confirm_and_requires_the_exact_phrase_in_a_later_turn(self) -> None:
        self._turn("turn-one", "please create it")
        prepared = self._prepare()
        challenge = prepared["confirmation"]["challenge"]

        same_turn = json.loads(
            handle_schedule_confirm_change(
                {"challenge": challenge}, session_id="session-private"
            )
        )
        self.assertEqual(same_turn["error"]["code"], "schedule_confirmation_requires_later_turn")
        self.assertEqual(self.client.confirm_calls, [])

        self._turn("turn-two", f"confirm schedule {challenge}")
        wrong_case = json.loads(
            handle_schedule_confirm_change(
                {"challenge": challenge}, session_id="session-private"
            )
        )
        self.assertEqual(wrong_case["error"]["code"], "schedule_confirmation_phrase_invalid")
        self.assertEqual(self.client.confirm_calls, [])

        self._turn("turn-three", f"CONFIRM SCHEDULE {challenge}")
        confirmed = json.loads(
            handle_schedule_confirm_change(
                {"challenge": challenge}, session_id="session-private"
            )
        )
        self.assertTrue(confirmed["ok"])
        self.assertEqual(confirmed["status"], "confirmed")
        self.assertEqual(len(self.client.confirm_calls), 1)

    def test_hook_context_drives_writes_while_read_tools_remain_bounded(self) -> None:
        today = json.loads(
            handle_schedule_today({"date": "2026-07-15"}, session_id="session-private")
        )
        work_items = json.loads(
            handle_schedule_list_work_items(
                {"status": "planned", "limit": 12}, session_id="session-private"
            )
        )
        plan_fit = json.loads(
            handle_schedule_daily_plan_fit(
                {"forDate": "2026-07-15"}, session_id="session-private"
            )
        )
        reminders = json.loads(
            handle_schedule_list_one_off_reminders(
                {
                    "from": "2026-07-15T00:00:00-04:00",
                    "to": "2026-07-16T00:00:00-04:00",
                },
                session_id="session-private",
            )
        )
        self.assertEqual(today["data"]["date"], "2026-07-15")
        self.assertEqual(plan_fit["data"]["suggestedTargetMinutes"], 90)
        self.assertEqual(self.client.plan_fit_dates, ["2026-07-15"])
        self.assertEqual(work_items["data"]["page"], {"limit": 12, "offset": 0})
        self.assertEqual(reminders["data"], {"items": []})
        self.assertEqual(
            self.client.reminder_ranges,
            [("2026-07-15T00:00:00-04:00", "2026-07-16T00:00:00-04:00")],
        )

        capture_turn(
            session_id="session-private",
            turn_id="turn-from-hook",
            user_message="prepare",
            platform="whatsapp",
            sender_id="sender-private",
        )
        self.assertTrue(self._prepare()["ok"])

    def test_plan_fit_rejects_argument_drift_without_calling_schedule(self) -> None:
        for arguments in ({}, {"forDate": "2026-07-15", "workspaceId": "private"}):
            with self.subTest(arguments=arguments):
                result = json.loads(
                    handle_schedule_daily_plan_fit(
                        arguments, session_id="session-private"
                    )
                )
                self.assertEqual(
                    result["error"]["code"], "schedule_tool_arguments_invalid"
                )
        self.assertEqual(self.client.plan_fit_dates, [])

    def test_missing_sender_context_fails_closed_without_breaking_the_hook(self) -> None:
        self.assertIsNone(
            capture_turn(
                session_id="session-private",
                turn_id="turn-from-hook",
                user_message="prepare",
                platform="whatsapp",
            )
        )
        result = json.loads(
            handle_schedule_prepare_change(
                {
                    "command": {
                        "type": "work_item.create",
                        "title": "Must remain unprepared",
                    }
                },
                session_id="session-private",
            )
        )
        self.assertEqual(result["error"]["code"], "schedule_turn_context_missing")
        self.assertEqual(self.client.prepare_calls, [])

    def test_a_newer_turn_invalidates_a_stale_async_tool_context(self) -> None:
        from contextvars import copy_context

        self._turn("turn-one", "prepare")
        stale_context = copy_context()
        self._turn("turn-two", "a newer request")
        result = json.loads(
            stale_context.run(
                handle_schedule_prepare_change,
                {
                    "command": {
                        "type": "work_item.create",
                        "title": "Stale attempt",
                    }
                },
                session_id="session-private",
            )
        )
        self.assertEqual(result["error"]["code"], "schedule_turn_context_stale")
        self.assertEqual(self.client.prepare_calls, [])

    def test_sender_binding_blocks_a_confirmation_from_another_sender(self) -> None:
        self._turn("turn-one", "prepare")
        prepared = self._prepare()
        challenge = prepared["confirmation"]["challenge"]
        self._turn("turn-two", f"CONFIRM SCHEDULE {challenge}", sender="different-sender")

        result = json.loads(
            handle_schedule_confirm_change(
                {"challenge": challenge}, session_id="session-private"
            )
        )
        self.assertEqual(result["error"]["code"], "schedule_confirmation_binding_mismatch")
        self.assertEqual(self.client.confirm_calls, [])

    def test_retry_reuses_the_same_idempotency_key_then_consumes_the_pending_change(self) -> None:
        self.client = _FakeClient(fail_first_confirmation=True)
        configure_for_testing(self.client, self.state)
        self._turn("turn-one", "prepare")
        prepared = self._prepare()
        challenge = prepared["confirmation"]["challenge"]
        self._turn("turn-two", f"CONFIRM SCHEDULE {challenge}")

        first = json.loads(
            handle_schedule_confirm_change(
                {"challenge": challenge}, session_id="session-private"
            )
        )
        second = json.loads(
            handle_schedule_confirm_change(
                {"challenge": challenge}, session_id="session-private"
            )
        )
        third = json.loads(
            handle_schedule_confirm_change(
                {"challenge": challenge}, session_id="session-private"
            )
        )
        self.assertEqual(first["error"], {"code": "schedule_unavailable", "retryable": True})
        self.assertEqual(second["status"], "confirmed")
        self.assertEqual(third["error"]["code"], "schedule_confirmation_missing")
        self.assertEqual(len(self.client.confirm_calls), 2)
        self.assertEqual(self.client.confirm_calls[0], self.client.confirm_calls[1])

    def test_persisted_state_contains_no_raw_session_sender_or_message(self) -> None:
        message = "RAW_USER_MESSAGE_SENTINEL"
        self._turn("turn-private", message)
        self._prepare()
        persisted = self.state.database_path.read_bytes()
        for private_value in (
            b"session-private",
            b"sender-private",
            b"turn-private",
            message.encode("utf-8"),
        ):
            self.assertNotIn(private_value, persisted)

    def test_cancel_removes_pending_state_without_calling_confirm(self) -> None:
        self._turn("turn-one", "prepare")
        self._prepare()
        canceled = json.loads(handle_schedule_cancel_change({}, session_id="session-private"))
        repeated = json.loads(handle_schedule_cancel_change({}, session_id="session-private"))
        self.assertEqual(canceled["status"], "canceled")
        self.assertEqual(repeated["status"], "nothing_pending")
        self.assertEqual(self.client.confirm_calls, [])


if __name__ == "__main__":
    unittest.main()
