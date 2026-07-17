"""Durable, privacy-minimal confirmation state for the Hermes adapter."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
from typing import Iterator, Mapping
from uuid import uuid4

from .client import ScheduleAdapterError


_CHALLENGE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_CLAIM_RETRY_AFTER = timedelta(seconds=60)
_OPERATIONS = frozenset(
    {
        "work_item.create",
        "work_item.update",
        "schedule_block.create",
        "schedule_block.update",
        "plan_item.activity",
        "one_off_reminder.create",
        "one_off_reminder.update",
        "one_off_reminder.cancel",
    }
)
_PENDING_COLUMNS = (
    "session_hash",
    "binding_hash",
    "prepare_turn_sequence",
    "confirmation_id",
    "command_hash",
    "operation",
    "request_id",
    "idempotency_key",
    "challenge",
    "expires_at",
    "claim_token",
    "claimed_at",
    "created_at",
)
_PENDING_TABLE_SQL = """
CREATE TABLE {qualifier}{table} (
  session_hash TEXT PRIMARY KEY
    REFERENCES schedule_turns(session_hash) ON DELETE CASCADE,
  binding_hash TEXT NOT NULL CHECK(length(binding_hash) = 64),
  prepare_turn_sequence INTEGER NOT NULL CHECK(prepare_turn_sequence > 0),
  confirmation_id TEXT NOT NULL UNIQUE,
  command_hash TEXT NOT NULL CHECK(length(command_hash) = 64),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
  request_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  challenge TEXT NOT NULL CHECK(length(challenge) = 8),
  expires_at TEXT NOT NULL,
  claim_token TEXT UNIQUE,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (claim_token IS NULL AND claimed_at IS NULL)
    OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
  )
)
"""


def _pending_schema_signature(value: str) -> str:
    normalized = re.sub(r"\s+", " ", value.strip())
    return re.sub(
        r'\ACREATE TABLE(?: IF NOT EXISTS)? (?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)',
        "CREATE TABLE <pending>",
        normalized,
        count=1,
        flags=re.IGNORECASE,
    )


_CURRENT_PENDING_SCHEMA = _pending_schema_signature(
    _PENDING_TABLE_SQL.format(qualifier="", table="schedule_pending_confirmations")
)
_LEGACY_PENDING_SCHEMA = _pending_schema_signature(
    _PENDING_TABLE_SQL.replace(
        "CHECK(length(operation) BETWEEN 1 AND 64)",
        """CHECK(operation IN (
          'work_item.create', 'work_item.update', 'schedule_block.create',
          'schedule_block.update', 'plan_item.activity'
        ))""",
    ).format(qualifier="", table="schedule_pending_confirmations")
)


@dataclass(frozen=True)
class TurnContext:
    session_hash: str
    binding_hash: str
    sequence: int
    user_message: str


@dataclass(frozen=True)
class PrepareAttempt:
    session_hash: str
    binding_hash: str
    turn_sequence: int
    command_fingerprint: str
    request_id: str


@dataclass(frozen=True)
class PendingConfirmation:
    session_hash: str
    binding_hash: str
    prepare_turn_sequence: int
    confirmation_id: str
    command_hash: str
    operation: str
    request_id: str
    idempotency_key: str
    challenge: str
    expires_at: str


@dataclass(frozen=True)
class ClaimedConfirmation:
    pending: PendingConfirmation
    claim_token: str


class ConfirmationState:
    """Stores only keyed identities and opaque Schedule confirmation metadata."""

    def __init__(self, database_path: Path, binding_key: bytes) -> None:
        if len(binding_key) < 32:
            raise ScheduleAdapterError("schedule_binding_key_invalid")
        self._path = database_path.resolve()
        self._key = bytes(binding_key)
        self._lock = threading.RLock()
        self._current: dict[str, TurnContext] = {}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._restrict_permissions(self._path.parent, 0o700)
        self._initialize()

    @classmethod
    def from_environment(
        cls, environment: Mapping[str, str] | None = None
    ) -> "ConfirmationState":
        source = os.environ if environment is None else environment
        raw_key = source.get("SCHEDULE_HERMES_BINDING_KEY", "")
        try:
            key = raw_key.encode("utf-8", "strict")
        except UnicodeEncodeError as error:
            raise ScheduleAdapterError("schedule_binding_key_invalid") from error
        if len(key) < 32 or len(key) > 4096 or any(character.isspace() for character in raw_key):
            raise ScheduleAdapterError("schedule_binding_key_invalid")
        home = Path(source.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
        return cls(home / "state" / "schedule-adapter.sqlite3", key)

    @property
    def database_path(self) -> Path:
        return self._path

    def capture_turn(
        self,
        *,
        session_id: str,
        turn_id: str,
        user_message: str,
        platform: str,
        sender_id: str,
    ) -> TurnContext:
        session = self._validated_context_text(session_id, 1024, "schedule_session_invalid")
        self._validated_context_text(turn_id, 1024, "schedule_turn_invalid")
        message = self._validated_context_text(
            user_message, 16_384, "schedule_user_message_invalid", allow_empty=True
        )
        platform_value = self._validated_context_text(
            platform, 128, "schedule_platform_invalid"
        )
        sender = self._validated_context_text(
            sender_id, 1024, "schedule_sender_invalid"
        )
        session_hash = self._digest("session", session)
        binding_hash = self._digest("binding", session, platform_value, sender)
        turn_hash = self._digest("turn", session, turn_id)
        now = datetime.now(timezone.utc).isoformat()

        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT turn_sequence, turn_hash FROM schedule_turns WHERE session_hash = ?",
                (session_hash,),
            ).fetchone()
            if row is not None and row[1] == turn_hash:
                sequence = int(row[0])
            else:
                sequence = 1 if row is None else int(row[0]) + 1
                connection.execute(
                    """
                    INSERT INTO schedule_turns (
                      session_hash, binding_hash, turn_sequence, turn_hash, updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(session_hash) DO UPDATE SET
                      binding_hash = excluded.binding_hash,
                      turn_sequence = excluded.turn_sequence,
                      turn_hash = excluded.turn_hash,
                      updated_at = excluded.updated_at
                    """,
                    (session_hash, binding_hash, sequence, turn_hash, now),
                )
            connection.commit()
        context = TurnContext(session_hash, binding_hash, sequence, message)
        with self._lock:
            self._current[session_hash] = context
        return context

    def current_turn(self, session_id: str) -> TurnContext:
        session_hash = self._digest(
            "session", self._validated_context_text(session_id, 1024, "schedule_session_invalid")
        )
        with self._lock:
            context = self._current.get(session_hash)
        if context is None:
            raise ScheduleAdapterError("schedule_turn_context_missing")
        return context

    def begin_prepare(
        self,
        session_id: str,
        command_fingerprint: str,
        turn_context: TurnContext,
    ) -> PrepareAttempt:
        if _HASH.fullmatch(command_fingerprint) is None:
            raise ScheduleAdapterError("schedule_command_invalid")
        context = self._context_for_session(session_id, turn_context)
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._assert_latest_context(connection, context)
            pending = connection.execute(
                "SELECT binding_hash FROM schedule_pending_confirmations WHERE session_hash = ?",
                (context.session_hash,),
            ).fetchone()
            if pending is not None:
                if pending[0] != context.binding_hash:
                    raise ScheduleAdapterError("schedule_confirmation_binding_mismatch")
                raise ScheduleAdapterError("schedule_confirmation_already_pending")
            row = connection.execute(
                """
                SELECT binding_hash, turn_sequence, command_fingerprint, request_id
                FROM schedule_prepare_attempts WHERE session_hash = ?
                """,
                (context.session_hash,),
            ).fetchone()
            if row is not None and (
                row[0] != context.binding_hash or int(row[1]) != context.sequence
            ):
                connection.execute(
                    "DELETE FROM schedule_prepare_attempts WHERE session_hash = ?",
                    (context.session_hash,),
                )
                row = None
            if row is not None:
                if row[2] != command_fingerprint:
                    raise ScheduleAdapterError("schedule_prepare_attempt_conflict")
                attempt = PrepareAttempt(
                    context.session_hash,
                    context.binding_hash,
                    context.sequence,
                    command_fingerprint,
                    row[3],
                )
            else:
                attempt = PrepareAttempt(
                    context.session_hash,
                    context.binding_hash,
                    context.sequence,
                    command_fingerprint,
                    str(uuid4()),
                )
                connection.execute(
                    """
                    INSERT INTO schedule_prepare_attempts (
                      session_hash, binding_hash, turn_sequence, command_fingerprint,
                      request_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        attempt.session_hash,
                        attempt.binding_hash,
                        attempt.turn_sequence,
                        attempt.command_fingerprint,
                        attempt.request_id,
                        now,
                    ),
                )
            connection.commit()
        return attempt

    def create_pending(
        self,
        session_id: str,
        *,
        turn_context: TurnContext,
        confirmation_id: str,
        command_hash: str,
        operation: str,
        request_id: str,
        expires_at: str,
    ) -> PendingConfirmation:
        context = self._context_for_session(session_id, turn_context)
        if _HASH.fullmatch(command_hash) is None:
            raise ScheduleAdapterError("schedule_prepared_change_invalid")
        if operation not in _OPERATIONS:
            raise ScheduleAdapterError("schedule_prepared_change_invalid")
        self._parse_instant(expires_at, "schedule_prepared_change_invalid")
        challenge = "".join(secrets.choice(_CHALLENGE_ALPHABET) for _ in range(8))
        idempotency_key = str(uuid4())
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._assert_latest_context(connection, context)
            attempt = connection.execute(
                """
                SELECT binding_hash, turn_sequence, request_id
                FROM schedule_prepare_attempts WHERE session_hash = ?
                """,
                (context.session_hash,),
            ).fetchone()
            if (
                attempt is None
                or attempt[0] != context.binding_hash
                or int(attempt[1]) != context.sequence
                or attempt[2] != request_id
            ):
                raise ScheduleAdapterError("schedule_prepare_attempt_missing")
            existing = connection.execute(
                """
                SELECT binding_hash, prepare_turn_sequence, confirmation_id, command_hash,
                       operation, request_id, idempotency_key, challenge, expires_at
                FROM schedule_pending_confirmations WHERE session_hash = ?
                """,
                (context.session_hash,),
            ).fetchone()
            if existing is not None:
                if (
                    existing[2] != confirmation_id
                    or existing[3] != command_hash
                    or existing[4] != operation
                ):
                    raise ScheduleAdapterError("schedule_confirmation_already_pending")
                pending = self._pending_from_row(context.session_hash, existing)
            else:
                pending = PendingConfirmation(
                    context.session_hash,
                    context.binding_hash,
                    context.sequence,
                    confirmation_id,
                    command_hash,
                    operation,
                    request_id,
                    idempotency_key,
                    challenge,
                    expires_at,
                )
                connection.execute(
                    """
                    INSERT INTO schedule_pending_confirmations (
                      session_hash, binding_hash, prepare_turn_sequence, confirmation_id,
                      command_hash, operation, request_id, idempotency_key, challenge,
                      expires_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        pending.session_hash,
                        pending.binding_hash,
                        pending.prepare_turn_sequence,
                        pending.confirmation_id,
                        pending.command_hash,
                        operation,
                        pending.request_id,
                        pending.idempotency_key,
                        pending.challenge,
                        pending.expires_at,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
            connection.commit()
        return pending

    def load_pending(self, session_id: str) -> PendingConfirmation:
        context = self.current_turn(session_id)
        with self._lock, self._connection() as connection:
            row = connection.execute(
                """
                SELECT binding_hash, prepare_turn_sequence, confirmation_id, command_hash,
                       operation, request_id, idempotency_key, challenge, expires_at
                FROM schedule_pending_confirmations WHERE session_hash = ?
                """,
                (context.session_hash,),
            ).fetchone()
        if row is None:
            raise ScheduleAdapterError("schedule_confirmation_missing")
        pending = self._pending_from_row(context.session_hash, row)
        if not hmac.compare_digest(pending.binding_hash, context.binding_hash):
            raise ScheduleAdapterError("schedule_confirmation_binding_mismatch")
        if self._parse_instant(pending.expires_at, "schedule_confirmation_expired") <= datetime.now(
            timezone.utc
        ):
            raise ScheduleAdapterError("schedule_confirmation_expired")
        return pending

    def claim_pending(
        self,
        session_id: str,
        challenge: str,
        turn_context: TurnContext,
    ) -> ClaimedConfirmation:
        context = self._context_for_session(session_id, turn_context)
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._assert_latest_context(connection, context)
            row = connection.execute(
                """
                SELECT binding_hash, prepare_turn_sequence, confirmation_id, command_hash,
                       operation, request_id, idempotency_key, challenge, expires_at,
                       claim_token, claimed_at
                FROM schedule_pending_confirmations WHERE session_hash = ?
                """,
                (context.session_hash,),
            ).fetchone()
            if row is None:
                raise ScheduleAdapterError("schedule_confirmation_missing")
            pending = self._pending_from_row(context.session_hash, row)
            if not hmac.compare_digest(pending.binding_hash, context.binding_hash):
                raise ScheduleAdapterError("schedule_confirmation_binding_mismatch")
            if self._parse_instant(
                pending.expires_at, "schedule_confirmation_expired"
            ) <= datetime.now(timezone.utc):
                raise ScheduleAdapterError("schedule_confirmation_expired")
            if context.sequence <= pending.prepare_turn_sequence:
                raise ScheduleAdapterError("schedule_confirmation_requires_later_turn")
            if not isinstance(challenge, str) or not hmac.compare_digest(
                challenge, pending.challenge
            ):
                raise ScheduleAdapterError("schedule_confirmation_phrase_invalid")
            if not hmac.compare_digest(
                context.user_message, f"CONFIRM SCHEDULE {pending.challenge}"
            ):
                raise ScheduleAdapterError("schedule_confirmation_phrase_invalid")
            previous_claim = row[9]
            if previous_claim is not None:
                claimed_at = self._parse_instant(
                    row[10], "schedule_confirmation_claim_corrupt"
                )
                if claimed_at + _CLAIM_RETRY_AFTER > datetime.now(timezone.utc):
                    raise ScheduleAdapterError(
                        "schedule_confirmation_in_progress", retryable=True
                    )
            claim_token = str(uuid4())
            updated = connection.execute(
                """
                UPDATE schedule_pending_confirmations
                SET claim_token = ?, claimed_at = ?
                WHERE session_hash = ?
                  AND (
                    (? IS NULL AND claim_token IS NULL)
                    OR claim_token = ?
                  )
                """,
                (
                    claim_token,
                    datetime.now(timezone.utc).isoformat(),
                    context.session_hash,
                    previous_claim,
                    previous_claim,
                ),
            ).rowcount
            if updated != 1:
                raise ScheduleAdapterError("schedule_confirmation_in_progress", retryable=True)
            connection.commit()
        return ClaimedConfirmation(pending, claim_token)

    def release_claim(self, claimed: ClaimedConfirmation) -> None:
        pending = claimed.pending
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            updated = connection.execute(
                """
                UPDATE schedule_pending_confirmations
                SET claim_token = NULL, claimed_at = NULL
                WHERE session_hash = ? AND binding_hash = ? AND confirmation_id = ?
                  AND command_hash = ? AND claim_token = ?
                """,
                (
                    pending.session_hash,
                    pending.binding_hash,
                    pending.confirmation_id,
                    pending.command_hash,
                    claimed.claim_token,
                ),
            ).rowcount
            if updated != 1:
                raise ScheduleAdapterError("schedule_confirmation_claim_lost")
            connection.commit()

    def consume_claim(self, claimed: ClaimedConfirmation) -> None:
        pending = claimed.pending
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT binding_hash, confirmation_id, command_hash, claim_token
                FROM schedule_pending_confirmations WHERE session_hash = ?
                """,
                (pending.session_hash,),
            ).fetchone()
            if row is None:
                raise ScheduleAdapterError("schedule_confirmation_missing")
            if (
                not hmac.compare_digest(row[0], pending.binding_hash)
                or row[1] != pending.confirmation_id
                or row[2] != pending.command_hash
                or row[3] != claimed.claim_token
            ):
                raise ScheduleAdapterError("schedule_confirmation_claim_lost")
            connection.execute(
                "DELETE FROM schedule_pending_confirmations WHERE session_hash = ?",
                (pending.session_hash,),
            )
            connection.execute(
                "DELETE FROM schedule_prepare_attempts WHERE session_hash = ?",
                (pending.session_hash,),
            )
            connection.commit()

    def cancel(self, session_id: str, turn_context: TurnContext) -> bool:
        context = self._context_for_session(session_id, turn_context)
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._assert_latest_context(connection, context)
            row = connection.execute(
                """
                SELECT binding_hash, claim_token
                FROM schedule_pending_confirmations WHERE session_hash = ?
                """,
                (context.session_hash,),
            ).fetchone()
            if row is not None and not hmac.compare_digest(row[0], context.binding_hash):
                raise ScheduleAdapterError("schedule_confirmation_binding_mismatch")
            if row is not None and row[1] is not None:
                raise ScheduleAdapterError("schedule_confirmation_in_progress", retryable=True)
            deleted = connection.execute(
                "DELETE FROM schedule_pending_confirmations WHERE session_hash = ?",
                (context.session_hash,),
            ).rowcount
            connection.execute(
                "DELETE FROM schedule_prepare_attempts WHERE session_hash = ?",
                (context.session_hash,),
            )
            connection.commit()
        return deleted > 0

    def clear_prepare_attempt(self, attempt: PrepareAttempt) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                DELETE FROM schedule_prepare_attempts
                WHERE session_hash = ? AND binding_hash = ? AND turn_sequence = ?
                  AND command_fingerprint = ? AND request_id = ?
                """,
                (
                    attempt.session_hash,
                    attempt.binding_hash,
                    attempt.turn_sequence,
                    attempt.command_fingerprint,
                    attempt.request_id,
                ),
            )

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = FULL;
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS schedule_turns (
                  session_hash TEXT PRIMARY KEY CHECK(length(session_hash) = 64),
                  binding_hash TEXT NOT NULL CHECK(length(binding_hash) = 64),
                  turn_sequence INTEGER NOT NULL CHECK(turn_sequence > 0),
                  turn_hash TEXT NOT NULL CHECK(length(turn_hash) = 64),
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS schedule_prepare_attempts (
                  session_hash TEXT PRIMARY KEY
                    REFERENCES schedule_turns(session_hash) ON DELETE CASCADE,
                  binding_hash TEXT NOT NULL CHECK(length(binding_hash) = 64),
                  turn_sequence INTEGER NOT NULL CHECK(turn_sequence > 0),
                  command_fingerprint TEXT NOT NULL CHECK(length(command_fingerprint) = 64),
                  request_id TEXT NOT NULL UNIQUE,
                  created_at TEXT NOT NULL
                );
                """
            )
            connection.execute(
                _PENDING_TABLE_SQL.format(
                    qualifier="IF NOT EXISTS ", table="schedule_pending_confirmations"
                )
            )
            self._upgrade_pending_table(connection)
        self._restrict_permissions(self._path, 0o600)

    @staticmethod
    def _upgrade_pending_table(connection: sqlite3.Connection) -> None:
        schema = ConfirmationState._pending_schema(connection)
        if _pending_schema_signature(schema) == _CURRENT_PENDING_SCHEMA:
            return

        connection.execute("BEGIN IMMEDIATE")
        try:
            schema = ConfirmationState._pending_schema(connection)
            if _pending_schema_signature(schema) == _CURRENT_PENDING_SCHEMA:
                connection.commit()
                return
            temporary_exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                ("schedule_pending_confirmations_next",),
            ).fetchone()
            if (
                _pending_schema_signature(schema) != _LEGACY_PENDING_SCHEMA
                or temporary_exists is not None
            ):
                raise ScheduleAdapterError("schedule_state_schema_invalid")

            connection.execute(
                _PENDING_TABLE_SQL.format(
                    qualifier="", table="schedule_pending_confirmations_next"
                )
            )
            column_list = ", ".join(_PENDING_COLUMNS)
            connection.execute(
                f"INSERT INTO schedule_pending_confirmations_next ({column_list}) "
                f"SELECT {column_list} FROM schedule_pending_confirmations"
            )
            connection.execute("DROP TABLE schedule_pending_confirmations")
            connection.execute(
                "ALTER TABLE schedule_pending_confirmations_next "
                "RENAME TO schedule_pending_confirmations"
            )
            if (
                _pending_schema_signature(ConfirmationState._pending_schema(connection))
                != _CURRENT_PENDING_SCHEMA
            ):
                raise ScheduleAdapterError("schedule_state_schema_invalid")
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise ScheduleAdapterError("schedule_state_schema_invalid")
            connection.commit()
        except ScheduleAdapterError:
            connection.rollback()
            raise
        except sqlite3.DatabaseError as error:
            connection.rollback()
            raise ScheduleAdapterError("schedule_state_schema_invalid") from error

    @staticmethod
    def _pending_schema(connection: sqlite3.Connection) -> str:
        row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            ("schedule_pending_confirmations",),
        ).fetchone()
        if row is None or not isinstance(row[0], str):
            raise ScheduleAdapterError("schedule_state_schema_invalid")
        return row[0]

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self._path, timeout=5.0, isolation_level=None)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA busy_timeout = 5000")
            yield connection
        finally:
            connection.close()

    def _digest(self, purpose: str, *parts: str) -> str:
        payload = purpose.encode("ascii") + b"\0" + b"\0".join(
            part.encode("utf-8", "strict") for part in parts
        )
        return hmac.new(self._key, payload, hashlib.sha256).hexdigest()

    def _context_for_session(
        self, session_id: str, turn_context: TurnContext
    ) -> TurnContext:
        session_hash = self._digest(
            "session", self._validated_context_text(session_id, 1024, "schedule_session_invalid")
        )
        if not isinstance(turn_context, TurnContext) or not hmac.compare_digest(
            session_hash, turn_context.session_hash
        ):
            raise ScheduleAdapterError("schedule_turn_context_mismatch")
        return turn_context

    @staticmethod
    def _assert_latest_context(
        connection: sqlite3.Connection, context: TurnContext
    ) -> None:
        row = connection.execute(
            """
            SELECT binding_hash, turn_sequence
            FROM schedule_turns WHERE session_hash = ?
            """,
            (context.session_hash,),
        ).fetchone()
        if (
            row is None
            or not hmac.compare_digest(str(row[0]), context.binding_hash)
            or int(row[1]) != context.sequence
        ):
            raise ScheduleAdapterError("schedule_turn_context_stale")

    @staticmethod
    def _validated_context_text(
        value: str, maximum: int, code: str, *, allow_empty: bool = False
    ) -> str:
        if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value):
            raise ScheduleAdapterError(code)
        if "\x00" in value:
            raise ScheduleAdapterError(code)
        return value

    @staticmethod
    def _parse_instant(value: str, code: str) -> datetime:
        if not isinstance(value, str) or len(value) > 64:
            raise ScheduleAdapterError(code)
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError as error:
            raise ScheduleAdapterError(code) from error
        if parsed.tzinfo is None:
            raise ScheduleAdapterError(code)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _pending_from_row(session_hash: str, row: sqlite3.Row | tuple) -> PendingConfirmation:
        return PendingConfirmation(
            session_hash=session_hash,
            binding_hash=str(row[0]),
            prepare_turn_sequence=int(row[1]),
            confirmation_id=str(row[2]),
            command_hash=str(row[3]),
            operation=str(row[4]),
            request_id=str(row[5]),
            idempotency_key=str(row[6]),
            challenge=str(row[7]),
            expires_at=str(row[8]),
        )

    @staticmethod
    def _restrict_permissions(path: Path, mode: int) -> None:
        try:
            path.chmod(mode)
        except OSError:
            # Windows ACLs are inherited from HERMES_HOME; POSIX gets an explicit mode.
            pass
