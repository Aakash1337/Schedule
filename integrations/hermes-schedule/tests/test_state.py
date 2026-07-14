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


if __name__ == "__main__":
    unittest.main()
