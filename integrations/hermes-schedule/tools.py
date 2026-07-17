"""Hermes tool handlers with sender-bound, next-turn Schedule confirmation."""

from __future__ import annotations

from contextvars import ContextVar
import hashlib
import json
import threading
from typing import Any, Mapping

from .client import ScheduleAdapterError, ScheduleClient
from .state import ConfirmationState, TurnContext


_runtime_lock = threading.RLock()
_client: ScheduleClient | None = None
_state: ConfirmationState | None = None
_active_turn: ContextVar[TurnContext | None] = ContextVar(
    "schedule_hermes_active_turn", default=None
)


def configure_for_testing(client: ScheduleClient | None, state: ConfirmationState | None) -> None:
    """Replace lazy runtime dependencies in isolated tests; never called by Hermes."""

    global _client, _state
    with _runtime_lock:
        _client = client
        _state = state
        _active_turn.set(None)


def capture_turn(**kwargs: Any) -> None:
    """Observer-only pre_llm_call hook; raw sender/message data remains in memory."""

    _active_turn.set(None)
    try:
        state = _get_state()
        context = state.capture_turn(
            session_id=_context_value(kwargs, "session_id"),
            turn_id=_context_value(kwargs, "turn_id"),
            user_message=_context_value(kwargs, "user_message", allow_empty=True),
            platform=_context_value(kwargs, "platform"),
            sender_id=_context_value(kwargs, "sender_id"),
        )
        _active_turn.set(context)
    except Exception:
        # A missing/invalid adapter configuration must not break an unrelated Hermes turn.
        return None
    return None


def handle_schedule_today(args: dict[str, Any], **kwargs: Any) -> str:
    return _handled(lambda: _today(args, kwargs))


def handle_schedule_list_work_items(args: dict[str, Any], **kwargs: Any) -> str:
    return _handled(lambda: _list_work_items(args, kwargs))


def handle_schedule_list_one_off_reminders(args: dict[str, Any], **kwargs: Any) -> str:
    return _handled(lambda: _list_one_off_reminders(args, kwargs))


def handle_schedule_prepare_change(args: dict[str, Any], **kwargs: Any) -> str:
    return _handled(lambda: _prepare_change(args, kwargs))


def handle_schedule_confirm_change(args: dict[str, Any], **kwargs: Any) -> str:
    return _handled(lambda: _confirm_change(args, kwargs))


def handle_schedule_cancel_change(args: dict[str, Any], **kwargs: Any) -> str:
    return _handled(lambda: _cancel_change(args, kwargs))


def _today(args: Mapping[str, Any], kwargs: Mapping[str, Any]) -> dict[str, Any]:
    _require_exact_args(args, {"date"})
    _session_id(kwargs)
    return {"ok": True, "data": _get_client().get_today(args["date"])}


def _list_work_items(args: Mapping[str, Any], kwargs: Mapping[str, Any]) -> dict[str, Any]:
    _require_allowed_args(args, {"status", "priority", "limit", "offset"})
    _session_id(kwargs)
    return {
        "ok": True,
        "data": _get_client().list_work_items(
            status=args.get("status"),
            priority=args.get("priority"),
            limit=args.get("limit", 100),
            offset=args.get("offset", 0),
        ),
    }


def _list_one_off_reminders(
    args: Mapping[str, Any], kwargs: Mapping[str, Any]
) -> dict[str, Any]:
    _require_exact_args(args, {"from", "to"})
    _session_id(kwargs)
    return {
        "ok": True,
        "data": _get_client().list_one_off_reminders(args["from"], args["to"]),
    }


def _prepare_change(args: Mapping[str, Any], kwargs: Mapping[str, Any]) -> dict[str, Any]:
    _require_exact_args(args, {"command"})
    command = args["command"]
    if not isinstance(command, dict):
        raise ScheduleAdapterError("schedule_command_invalid")
    operation = command.get("type")
    if not isinstance(operation, str):
        raise ScheduleAdapterError("schedule_command_invalid")
    session_id = _session_id(kwargs)
    turn_context = _turn_context()
    canonical = _canonical_json(command)
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    state = _get_state()
    attempt = state.begin_prepare(session_id, fingerprint, turn_context)
    try:
        prepared = _get_client().prepare_change(attempt.request_id, command)
    except ScheduleAdapterError as error:
        if not error.retryable:
            state.clear_prepare_attempt(attempt)
        raise
    pending = state.create_pending(
        session_id,
        turn_context=turn_context,
        confirmation_id=prepared["confirmationId"],
        command_hash=prepared["commandHash"],
        operation=operation,
        request_id=prepared["requestId"],
        expires_at=prepared["expiresAt"],
    )
    return {
        "ok": True,
        "status": "confirmation_required",
        "confirmation": {
            "challenge": pending.challenge,
            "phrase": f"CONFIRM SCHEDULE {pending.challenge}",
            "expiresAt": pending.expires_at,
            "commandHash": pending.command_hash,
            "command": prepared["command"],
            "commandDisplay": prepared["commandDisplay"],
            "summary": prepared["summary"],
        },
    }


def _confirm_change(args: Mapping[str, Any], kwargs: Mapping[str, Any]) -> dict[str, Any]:
    _require_exact_args(args, {"challenge"})
    challenge = args["challenge"]
    if not isinstance(challenge, str):
        raise ScheduleAdapterError("schedule_confirmation_phrase_invalid")
    session_id = _session_id(kwargs)
    turn_context = _turn_context()
    state = _get_state()
    claimed = state.claim_pending(session_id, challenge, turn_context)
    pending = claimed.pending
    try:
        confirmed = _get_client().confirm_change(
            pending.confirmation_id,
            pending.idempotency_key,
            pending.operation,
            pending.command_hash,
        )
    except Exception:
        state.release_claim(claimed)
        raise
    state.consume_claim(claimed)
    return {"ok": True, "status": "confirmed", "data": confirmed}


def _cancel_change(args: Mapping[str, Any], kwargs: Mapping[str, Any]) -> dict[str, Any]:
    _require_exact_args(args, set())
    canceled = _get_state().cancel(_session_id(kwargs), _turn_context())
    return {"ok": True, "status": "canceled" if canceled else "nothing_pending"}


def _get_client() -> ScheduleClient:
    global _client
    with _runtime_lock:
        if _client is None:
            _client = ScheduleClient.from_environment()
        return _client


def _get_state() -> ConfirmationState:
    global _state
    with _runtime_lock:
        if _state is None:
            _state = ConfirmationState.from_environment()
        return _state


def _handled(operation: Any) -> str:
    try:
        result = operation()
    except ScheduleAdapterError as error:
        result = {"ok": False, "error": {"code": error.code, "retryable": error.retryable}}
    except Exception:
        result = {
            "ok": False,
            "error": {"code": "schedule_adapter_internal", "retryable": False},
        }
    return json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _canonical_json(value: Any) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError) as error:
        raise ScheduleAdapterError("schedule_command_invalid") from error
    if len(encoded.encode("utf-8")) > 131_072:
        raise ScheduleAdapterError("schedule_command_invalid")
    return encoded


def _context_value(context: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = context.get(key)
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ScheduleAdapterError("schedule_context_missing")
    return value


def _session_id(context: Mapping[str, Any]) -> str:
    return _context_value(context, "session_id")


def _turn_context() -> TurnContext:
    context = _active_turn.get()
    if context is None:
        raise ScheduleAdapterError("schedule_turn_context_missing")
    return context


def _require_exact_args(args: Mapping[str, Any], expected: set[str]) -> None:
    if not isinstance(args, Mapping) or set(args) != expected:
        raise ScheduleAdapterError("schedule_tool_arguments_invalid")


def _require_allowed_args(args: Mapping[str, Any], allowed: set[str]) -> None:
    if not isinstance(args, Mapping) or set(args) - allowed:
        raise ScheduleAdapterError("schedule_tool_arguments_invalid")
