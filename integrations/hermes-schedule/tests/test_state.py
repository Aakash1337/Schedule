"""Confirmation-state security, persistence, and privacy tests."""

from __future__ import annotations

from pathlib import Path
import sqlite3
import tempfile
import unittest
from uuid import uuid4

from support import PACKAGE_NAME, plugin  # noqa: F401

from importlib import import_module


client_module = import_module(f"{PACKAGE_NAME}.client")
state_module = import_module(f"{PACKAGE_NAME}.state")
ConfirmationState = state_module.ConfirmationState
ScheduleAdapterError = client_module.ScheduleAdapterError

_CURRENT_OPERATION_CHECK = "CHECK(length(operation) BETWEEN 1 AND 64)"
_LEGACY_OPERATION_CHECK = """CHECK(operation IN (
                    'work_item.create', 'work_item.update', 'schedule_block.create',
                    'schedule_block.update', 'plan_item.activity'
                  ))"""


def _replace_schema_text(path: Path, original: str, replacement: str) -> None:
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        schema = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' "
            "AND name = 'schedule_pending_confirmations'"
        ).fetchone()[0]
        if original not in schema:
            raise AssertionError("The expected schema fragment was not found.")
        replacement_schema = schema.replace(
            "schedule_pending_confirmations",
            "schedule_pending_confirmations_fixture",
            1,
        ).replace(original, replacement, 1)
        columns = ", ".join(
            row[1]
            for row in connection.execute(
                "PRAGMA table_info(schedule_pending_confirmations)"
            )
        )
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(replacement_schema)
        connection.execute(
            f"INSERT INTO schedule_pending_confirmations_fixture ({columns}) "
            f"SELECT {columns} FROM schedule_pending_confirmations"
        )
        connection.execute("DROP TABLE schedule_pending_confirmations")
        connection.execute(
            "ALTER TABLE schedule_pending_confirmations_fixture "
            "RENAME TO schedule_pending_confirmations"
        )
        connection.commit()
    finally:
        connection.close()


def _pending_row(path: Path) -> tuple | None:
    connection = sqlite3.connect(path)
    try:
        return connection.execute(
            "SELECT * FROM schedule_pending_confirmations"
        ).fetchone()
    finally:
        connection.close()


class ConfirmationStateTests(unittest.TestCase):
    key = b"state-test-binding-key-that-is-long-enough"

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "state.sqlite3"
        self.state = ConfirmationState(self.path, self.key)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _capture(
        self,
        *,
        turn: str = "turn-1",
        message: str = "please create the item",
        sender: str = "15551234567@s.whatsapp.net",
        session: str = "raw-session-identifier",
    ):
        return self.state.capture_turn(
            session_id=session,
            turn_id=turn,
            user_message=message,
            platform="whatsapp",
            sender_id=sender,
        )

    def test_persists_only_keyed_binding_and_opaque_confirmation_metadata(self) -> None:
        context = self._capture()
        attempt = self.state.begin_prepare("raw-session-identifier", "a" * 64, context)
        pending = self.state.create_pending(
            "raw-session-identifier",
            turn_context=context,
            confirmation_id=str(uuid4()),
            command_hash="b" * 64,
            operation="work_item.create",
            request_id=attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        self.assertEqual(pending.binding_hash, context.binding_hash)

        restarted = ConfirmationState(self.path, self.key)
        restarted.capture_turn(
            session_id="raw-session-identifier",
            turn_id="turn-2",
            user_message=f"CONFIRM SCHEDULE {pending.challenge}",
            platform="whatsapp",
            sender_id="15551234567@s.whatsapp.net",
        )
        self.assertEqual(restarted.load_pending("raw-session-identifier"), pending)

        persisted = b"".join(
            candidate.read_bytes()
            for candidate in self.path.parent.glob(f"{self.path.name}*")
            if candidate.is_file()
        )
        for forbidden in (
            b"raw-session-identifier",
            b"15551234567",
            b"please create the item",
            self.key,
        ):
            self.assertNotIn(forbidden, persisted)

    def test_reuses_one_prepare_request_only_for_the_same_turn_and_command(self) -> None:
        context = self._capture()
        first = self.state.begin_prepare("raw-session-identifier", "c" * 64, context)
        replay = self.state.begin_prepare("raw-session-identifier", "c" * 64, context)
        self.assertEqual(replay.request_id, first.request_id)
        with self.assertRaisesRegex(ScheduleAdapterError, "^schedule_prepare_attempt_conflict$"):
            self.state.begin_prepare("raw-session-identifier", "d" * 64, context)

    def test_rejects_a_different_sender_even_inside_the_same_session(self) -> None:
        context = self._capture()
        attempt = self.state.begin_prepare("raw-session-identifier", "e" * 64, context)
        pending = self.state.create_pending(
            "raw-session-identifier",
            turn_context=context,
            confirmation_id=str(uuid4()),
            command_hash="f" * 64,
            operation="work_item.create",
            request_id=attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        self._capture(
            turn="turn-2",
            message=f"CONFIRM SCHEDULE {pending.challenge}",
            sender="attacker@s.whatsapp.net",
        )
        with self.assertRaisesRegex(
            ScheduleAdapterError, "^schedule_confirmation_binding_mismatch$"
        ):
            self.state.load_pending("raw-session-identifier")

    def test_claim_blocks_cancel_until_the_remote_attempt_finishes(self) -> None:
        first_context = self._capture()
        attempt = self.state.begin_prepare("raw-session-identifier", "1" * 64, first_context)
        pending = self.state.create_pending(
            "raw-session-identifier",
            turn_context=first_context,
            confirmation_id=str(uuid4()),
            command_hash="2" * 64,
            operation="work_item.create",
            request_id=attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        confirmation_context = self._capture(
            turn="turn-2", message=f"CONFIRM SCHEDULE {pending.challenge}"
        )
        claimed = self.state.claim_pending(
            "raw-session-identifier", pending.challenge, confirmation_context
        )
        with self.assertRaisesRegex(
            ScheduleAdapterError, "^schedule_confirmation_in_progress$"
        ):
            self.state.cancel("raw-session-identifier", confirmation_context)
        self.state.release_claim(claimed)
        self.assertTrue(self.state.cancel("raw-session-identifier", confirmation_context))

    def test_rejects_a_stale_async_turn_context_after_a_newer_turn_arrives(self) -> None:
        stale = self._capture(turn="turn-1")
        self._capture(turn="turn-2")
        with self.assertRaisesRegex(ScheduleAdapterError, "^schedule_turn_context_stale$"):
            self.state.begin_prepare("raw-session-identifier", "3" * 64, stale)

    def test_stale_claim_can_only_retry_the_same_idempotent_confirmation(self) -> None:
        first_context = self._capture()
        attempt = self.state.begin_prepare("raw-session-identifier", "4" * 64, first_context)
        pending = self.state.create_pending(
            "raw-session-identifier",
            turn_context=first_context,
            confirmation_id=str(uuid4()),
            command_hash="5" * 64,
            operation="work_item.create",
            request_id=attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        confirmation_context = self._capture(
            turn="turn-2", message=f"CONFIRM SCHEDULE {pending.challenge}"
        )
        first_claim = self.state.claim_pending(
            "raw-session-identifier", pending.challenge, confirmation_context
        )
        connection = sqlite3.connect(self.path)
        try:
            connection.execute(
                "UPDATE schedule_pending_confirmations SET claimed_at = ?",
                ("2000-01-01T00:00:00+00:00",),
            )
            connection.commit()
        finally:
            connection.close()
        retry_context = self._capture(
            turn="turn-3", message=f"CONFIRM SCHEDULE {pending.challenge}"
        )
        retry_claim = self.state.claim_pending(
            "raw-session-identifier", pending.challenge, retry_context
        )
        self.assertEqual(retry_claim.pending.idempotency_key, first_claim.pending.idempotency_key)
        self.assertNotEqual(retry_claim.claim_token, first_claim.claim_token)
        with self.assertRaisesRegex(ScheduleAdapterError, "^schedule_confirmation_claim_lost$"):
            self.state.release_claim(first_claim)
        self.state.release_claim(retry_claim)

    def test_late_failure_cleanup_cannot_delete_a_newer_prepare_attempt(self) -> None:
        first_context = self._capture(turn="turn-1")
        old_attempt = self.state.begin_prepare(
            "raw-session-identifier", "6" * 64, first_context
        )
        newer_context = self._capture(turn="turn-2")
        newer_attempt = self.state.begin_prepare(
            "raw-session-identifier", "7" * 64, newer_context
        )
        self.state.clear_prepare_attempt(old_attempt)
        replay = self.state.begin_prepare(
            "raw-session-identifier", "7" * 64, newer_context
        )
        self.assertEqual(replay.request_id, newer_attempt.request_id)

    def test_requires_nonempty_platform_and_sender_for_confirmation_state(self) -> None:
        for platform, sender in (("", "sender"), ("whatsapp", "")):
            with self.subTest(platform=platform, sender=sender):
                with self.assertRaises(ScheduleAdapterError):
                    self.state.capture_turn(
                        session_id="session",
                        turn_id="turn",
                        user_message="message",
                        platform=platform,
                        sender_id=sender,
                    )

    def test_accepts_fresh_management_operations_and_rejects_unknown_operations(self) -> None:
        for index, operation in enumerate(
            (
                "one_off_reminder.create",
                "one_off_reminder.update",
                "one_off_reminder.cancel",
                "schedule_block.cancel",
            )
        ):
            session = f"reminder-session-{index}"
            reminder_context = self.state.capture_turn(
                session_id=session,
                turn_id="turn-1",
                user_message="manage a reminder",
                platform="whatsapp",
                sender_id="reminder-sender",
            )
            reminder_attempt = self.state.begin_prepare(
                session, str(index) * 64, reminder_context
            )
            pending = self.state.create_pending(
                session,
                turn_context=reminder_context,
                confirmation_id=str(uuid4()),
                command_hash=str(index + 3) * 64,
                operation=operation,
                request_id=reminder_attempt.request_id,
                expires_at="2099-07-15T07:01:00.000Z",
            )
            self.assertEqual(pending.operation, operation)

        unknown_context = self.state.capture_turn(
            session_id="unknown-session",
            turn_id="turn-1",
            user_message="unknown operation",
            platform="whatsapp",
            sender_id="unknown-sender",
        )
        unknown_attempt = self.state.begin_prepare(
            "unknown-session", "a" * 64, unknown_context
        )
        with self.assertRaisesRegex(
            ScheduleAdapterError, "^schedule_prepared_change_invalid$"
        ):
            self.state.create_pending(
                "unknown-session",
                turn_context=unknown_context,
                confirmation_id=str(uuid4()),
                command_hash="b" * 64,
                operation="unrecognized.create",
                request_id=unknown_attempt.request_id,
                expires_at="2099-07-15T07:01:00.000Z",
            )

    def test_upgrades_populated_legacy_state_without_losing_a_claim(self) -> None:
        context = self._capture()
        attempt = self.state.begin_prepare("raw-session-identifier", "c" * 64, context)
        pending = self.state.create_pending(
            "raw-session-identifier",
            turn_context=context,
            confirmation_id=str(uuid4()),
            command_hash="d" * 64,
            operation="work_item.create",
            request_id=attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        confirmation_context = self._capture(
            turn="turn-2", message=f"CONFIRM SCHEDULE {pending.challenge}"
        )
        self.state.claim_pending(
            "raw-session-identifier", pending.challenge, confirmation_context
        )
        before = _pending_row(self.path)
        self.assertIsNotNone(before)
        self.assertIsNotNone(before[-3])
        self.assertIsNotNone(before[-2])

        _replace_schema_text(
            self.path, _CURRENT_OPERATION_CHECK, _LEGACY_OPERATION_CHECK
        )
        restarted = ConfirmationState(self.path, self.key)
        restarted_again = ConfirmationState(self.path, self.key)

        self.assertEqual(_pending_row(self.path), before)
        restarted_again.capture_turn(
            session_id="raw-session-identifier",
            turn_id="turn-3",
            user_message="inspect pending",
            platform="whatsapp",
            sender_id="15551234567@s.whatsapp.net",
        )
        self.assertEqual(
            restarted_again.load_pending("raw-session-identifier"), pending
        )
        connection = sqlite3.connect(self.path)
        try:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            schema = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' "
                "AND name = 'schedule_pending_confirmations'"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertIn(_CURRENT_OPERATION_CHECK, schema)

        reminder_context = restarted.capture_turn(
            session_id="post-upgrade-reminder",
            turn_id="turn-1",
            user_message="create reminder",
            platform="whatsapp",
            sender_id="reminder-sender",
        )
        reminder_attempt = restarted.begin_prepare(
            "post-upgrade-reminder", "e" * 64, reminder_context
        )
        created = restarted.create_pending(
            "post-upgrade-reminder",
            turn_context=reminder_context,
            confirmation_id=str(uuid4()),
            command_hash="f" * 64,
            operation="one_off_reminder.create",
            request_id=reminder_attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        self.assertEqual(created.operation, "one_off_reminder.create")

        block_context = restarted.capture_turn(
            session_id="post-upgrade-block",
            turn_id="turn-1",
            user_message="cancel calendar block",
            platform="whatsapp",
            sender_id="block-sender",
        )
        block_attempt = restarted.begin_prepare(
            "post-upgrade-block", "1" * 64, block_context
        )
        cancelled = restarted.create_pending(
            "post-upgrade-block",
            turn_context=block_context,
            confirmation_id=str(uuid4()),
            command_hash="2" * 64,
            operation="schedule_block.cancel",
            request_id=block_attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        self.assertEqual(cancelled.operation, "schedule_block.cancel")

    def test_fails_closed_on_current_schema_constraint_drift(self) -> None:
        context = self._capture()
        attempt = self.state.begin_prepare("raw-session-identifier", "1" * 64, context)
        self.state.create_pending(
            "raw-session-identifier",
            turn_context=context,
            confirmation_id=str(uuid4()),
            command_hash="2" * 64,
            operation="work_item.create",
            request_id=attempt.request_id,
            expires_at="2099-07-15T07:01:00.000Z",
        )
        _replace_schema_text(
            self.path,
            "CHECK(length(binding_hash) = 64)",
            "CHECK(length(binding_hash) >= 63)",
        )
        before = _pending_row(self.path)

        with self.assertRaisesRegex(
            ScheduleAdapterError, "^schedule_state_schema_invalid$"
        ):
            ConfirmationState(self.path, self.key)
        self.assertEqual(_pending_row(self.path), before)


if __name__ == "__main__":
    unittest.main()
