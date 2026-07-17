"""Strict loopback client for Schedule's authenticated integration gateway."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type, datetime
import hashlib
import hmac
import http.client
import json
import os
import re
from typing import Any, Mapping
from urllib.parse import urlencode


INTEGRATION_VERSION = "schedule.integration/v1"
MAXIMUM_RESPONSE_BYTES = 1_048_576
DEFAULT_TIMEOUT_SECONDS = 8.0
_BASE_URL = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{3,4})\Z")
_TOKEN = re.compile(r"[^\s\x00-\x1f\x7f]{16,4096}\Z")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
_INSTANT = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z"
)
_MAXIMUM_INTEGER = 2_147_483_647
_PRIORITIES = frozenset({"none", "low", "medium", "high", "urgent"})
_STATUSES = frozenset({"backlog", "planned", "in_progress", "blocked", "done", "cancelled"})
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
_ACTIVITY_STATES = frozenset({"pending", "started", "completed", "skipped", "deferred", "dismissed"})
_ACTIVITY_TYPES = frozenset(
    {"started", "completed", "skipped", "deferred", "dismissed", "completion_reversed"}
)


class ScheduleAdapterError(Exception):
    """A bounded adapter error that never includes a token or response body."""

    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def _exact_object(value: Any, keys: set[str], code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ScheduleAdapterError(code)
    return value


def _uuid(value: Any, code: str) -> str:
    if not isinstance(value, str) or _UUID.fullmatch(value) is None:
        raise ScheduleAdapterError(code)
    return value


def _positive_integer(value: Any, code: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not (1 <= value <= _MAXIMUM_INTEGER)
    ):
        raise ScheduleAdapterError(code)
    return value


def _bounded_text(value: Any, maximum: int, code: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ScheduleAdapterError(code)
    length = len(value)
    if length > maximum or (length == 0 and not allow_empty):
        raise ScheduleAdapterError(code)
    return value


def _local_date(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 10:
        raise ScheduleAdapterError("schedule_date_invalid")
    try:
        parsed = date_type.fromisoformat(value)
    except ValueError as error:
        raise ScheduleAdapterError("schedule_date_invalid") from error
    if parsed.isoformat() != value:
        raise ScheduleAdapterError("schedule_date_invalid")
    return value


def _instant(value: Any, code: str) -> str:
    instant = _bounded_text(value, 64, code)
    if _INSTANT.fullmatch(instant) is None:
        raise ScheduleAdapterError(code)
    normalized = instant[:-1] + "+00:00" if instant.endswith("Z") else instant
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ScheduleAdapterError(code) from error
    if parsed.tzinfo is None:
        raise ScheduleAdapterError(code)
    return instant


def _same_json(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            _same_json(left[key], right[key]) for key in left
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _same_json(left_item, right_item)
            for left_item, right_item in zip(left, right, strict=True)
        )
    return left == right


@dataclass(frozen=True)
class ScheduleClientConfig:
    port: int
    token: str
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    maximum_response_bytes: int = MAXIMUM_RESPONSE_BYTES


class ScheduleClient:
    """Calls only an exact IPv4 loopback origin and never follows redirects."""

    def __init__(self, config: ScheduleClientConfig) -> None:
        if not (1024 <= config.port <= 65535):
            raise ScheduleAdapterError("schedule_url_invalid")
        if _TOKEN.fullmatch(config.token) is None:
            raise ScheduleAdapterError("schedule_token_invalid")
        if not (0.1 <= config.timeout_seconds <= 30.0):
            raise ScheduleAdapterError("schedule_timeout_invalid")
        if not (1_024 <= config.maximum_response_bytes <= MAXIMUM_RESPONSE_BYTES):
            raise ScheduleAdapterError("schedule_response_limit_invalid")
        self._config = config

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> "ScheduleClient":
        source = os.environ if environment is None else environment
        raw_url = source.get("SCHEDULE_INTEGRATION_URL", "")
        match = _BASE_URL.fullmatch(raw_url)
        if match is None:
            raise ScheduleAdapterError("schedule_url_invalid")
        port = int(match.group(1), 10)
        if str(port) != match.group(1) or not (1024 <= port <= 65535):
            raise ScheduleAdapterError("schedule_url_invalid")
        return cls(ScheduleClientConfig(port=port, token=source.get("SCHEDULE_INTEGRATION_TOKEN", "")))

    def get_today(self, local_date: str) -> dict[str, Any]:
        requested_date = _local_date(local_date)
        data = self._request("GET", f"/v1/integrations/today?{urlencode({'date': requested_date})}")
        today = _exact_object(data, {"workspaceId", "date", "headVersion", "plan"}, "schedule_today_invalid")
        _uuid(today["workspaceId"], "schedule_today_invalid")
        if today["date"] != requested_date:
            raise ScheduleAdapterError("schedule_today_invalid")
        if not isinstance(today["headVersion"], int) or isinstance(today["headVersion"], bool) or today["headVersion"] < 0:
            raise ScheduleAdapterError("schedule_today_invalid")
        if today["plan"] is not None and not isinstance(today["plan"], dict):
            raise ScheduleAdapterError("schedule_today_invalid")
        return today

    def list_work_items(
        self,
        *,
        status: str | None = None,
        priority: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        if status is not None and status not in _STATUSES:
            raise ScheduleAdapterError("schedule_work_filter_invalid")
        if priority is not None and priority not in _PRIORITIES:
            raise ScheduleAdapterError("schedule_work_filter_invalid")
        if isinstance(limit, bool) or not isinstance(limit, int) or not (1 <= limit <= 200):
            raise ScheduleAdapterError("schedule_work_filter_invalid")
        if isinstance(offset, bool) or not isinstance(offset, int) or not (0 <= offset <= 1_000_000):
            raise ScheduleAdapterError("schedule_work_filter_invalid")
        query: dict[str, str] = {"limit": str(limit), "offset": str(offset)}
        if status is not None:
            query["status"] = status
        if priority is not None:
            query["priority"] = priority
        data = self._request("GET", f"/v1/integrations/work-items?{urlencode(query)}")
        page = _exact_object(data, {"items", "page"}, "schedule_work_items_invalid")
        if not isinstance(page["items"], list) or len(page["items"]) > limit:
            raise ScheduleAdapterError("schedule_work_items_invalid")
        paging = _exact_object(page["page"], {"limit", "offset"}, "schedule_work_items_invalid")
        if paging != {"limit": limit, "offset": offset}:
            raise ScheduleAdapterError("schedule_work_items_invalid")
        for item in page["items"]:
            self._validate_work_item(item)
        return page

    def list_one_off_reminders(
        self, from_inclusive: str, through_exclusive: str
    ) -> dict[str, Any]:
        start = _instant(from_inclusive, "schedule_reminder_range_invalid")
        end = _instant(through_exclusive, "schedule_reminder_range_invalid")
        start_at = datetime.fromisoformat(start.replace("Z", "+00:00"))
        end_at = datetime.fromisoformat(end.replace("Z", "+00:00"))
        duration = end_at - start_at
        if not (0 < duration.total_seconds() <= 31 * 86_400):
            raise ScheduleAdapterError("schedule_reminder_range_invalid")
        data = self._request(
            "GET",
            f"/v1/integrations/one-off-reminders?{urlencode({'from': start, 'to': end})}",
        )
        page = _exact_object(data, {"items"}, "schedule_one_off_reminders_invalid")
        if not isinstance(page["items"], list) or len(page["items"]) > 100:
            raise ScheduleAdapterError("schedule_one_off_reminders_invalid")
        previous: tuple[datetime, str] | None = None
        workspace_id: str | None = None
        for reminder in page["items"]:
            item = self._validate_one_off_reminder(
                reminder, "schedule_one_off_reminders_invalid"
            )
            if workspace_id is None:
                workspace_id = item["workspaceId"]
            elif item["workspaceId"] != workspace_id:
                raise ScheduleAdapterError("schedule_one_off_reminders_invalid")
            key = (
                datetime.fromisoformat(item["scheduledFor"].replace("Z", "+00:00")),
                item["id"],
            )
            if not start_at <= key[0] < end_at or (previous is not None and key <= previous):
                raise ScheduleAdapterError("schedule_one_off_reminders_invalid")
            previous = key
        return page

    def prepare_change(self, request_id: str, command: Mapping[str, Any]) -> dict[str, Any]:
        _uuid(request_id, "schedule_request_id_invalid")
        if not isinstance(command, Mapping):
            raise ScheduleAdapterError("schedule_command_invalid")
        if command.get("type") in {
            "one_off_reminder.create",
            "one_off_reminder.update",
            "one_off_reminder.cancel",
        }:
            self._validate_one_off_command(command)
        data = self._request(
            "POST",
            "/v1/integrations/commands/prepare",
            {"version": INTEGRATION_VERSION, "requestId": request_id, "command": dict(command)},
        )
        prepared = _exact_object(
            data,
            {
                "confirmationId",
                "requestId",
                "commandHash",
                "command",
                "commandDisplay",
                "summary",
                "expiresAt",
            },
            "schedule_prepared_change_invalid",
        )
        _uuid(prepared["confirmationId"], "schedule_prepared_change_invalid")
        if prepared["requestId"] != request_id:
            raise ScheduleAdapterError("schedule_prepared_change_invalid")
        if not isinstance(prepared["commandHash"], str) or re.fullmatch(r"[a-f0-9]{64}", prepared["commandHash"]) is None:
            raise ScheduleAdapterError("schedule_prepared_change_invalid")
        if not isinstance(prepared["command"], dict):
            raise ScheduleAdapterError("schedule_prepared_change_invalid")
        command_display = _bounded_text(
            prepared["commandDisplay"], 32_768, "schedule_prepared_change_invalid"
        )
        try:
            displayed_command = json.loads(command_display)
        except json.JSONDecodeError as error:
            raise ScheduleAdapterError("schedule_prepared_change_invalid") from error
        if not _same_json(displayed_command, prepared["command"]) or not _same_json(
            prepared["command"], dict(command)
        ):
            raise ScheduleAdapterError("schedule_prepared_change_invalid")
        display_hash = hashlib.sha256(command_display.encode("utf-8")).hexdigest()
        if not hmac.compare_digest(display_hash, prepared["commandHash"]):
            raise ScheduleAdapterError("schedule_prepared_change_invalid")
        _bounded_text(prepared["summary"], 500, "schedule_prepared_change_invalid")
        _bounded_text(prepared["expiresAt"], 64, "schedule_prepared_change_invalid")
        return prepared

    def confirm_change(
        self,
        confirmation_id: str,
        idempotency_key: str,
        expected_operation: str,
        expected_command_hash: str,
    ) -> dict[str, Any]:
        _uuid(confirmation_id, "schedule_confirmation_id_invalid")
        _uuid(idempotency_key, "schedule_idempotency_key_invalid")
        if expected_operation not in _OPERATIONS or not isinstance(expected_command_hash, str):
            raise ScheduleAdapterError("schedule_confirmation_expectation_invalid")
        if re.fullmatch(r"[a-f0-9]{64}", expected_command_hash) is None:
            raise ScheduleAdapterError("schedule_confirmation_expectation_invalid")
        data = self._request(
            "POST",
            "/v1/integrations/commands/confirm",
            {"version": INTEGRATION_VERSION, "confirmationId": confirmation_id},
            extra_headers={"Idempotency-Key": idempotency_key},
        )
        if not isinstance(data, dict):
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        common_keys = {
            "confirmationId",
            "operation",
            "commandHash",
            "outcome",
        }
        receipt_version = data.get("receiptVersion") if "receiptVersion" in data else None
        expected_keys = common_keys if receipt_version is None else common_keys | {"receiptVersion"}
        if set(data) != expected_keys:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        if receipt_version is not None and (
            isinstance(receipt_version, bool)
            or not isinstance(receipt_version, int)
            or receipt_version not in {1, 2}
        ):
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        if data["confirmationId"] != confirmation_id:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        returned_hash = data.get("commandHash")
        if not isinstance(returned_hash, str) or not hmac.compare_digest(
            returned_hash, expected_command_hash
        ):
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        if data["operation"] != expected_operation:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        safe_receipt = {
            "confirmationId": confirmation_id,
            "operation": expected_operation,
            "commandHash": expected_command_hash,
            "outcome": self._safe_confirmation_outcome(
                data["outcome"], expected_operation, receipt_version
            ),
        }
        if receipt_version is not None:
            safe_receipt["receiptVersion"] = receipt_version
        return safe_receipt

    def _request(
        self,
        method: str,
        target: str,
        body: Mapping[str, Any] | None = None,
        *,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Any:
        if not target.startswith("/v1/integrations/") or "#" in target:
            raise ScheduleAdapterError("schedule_target_invalid")
        encoded = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._config.token}",
            "Connection": "close",
            "Host": f"127.0.0.1:{self._config.port}",
            "User-Agent": "schedule-hermes-adapter/0.1",
        }
        if body is not None:
            try:
                encoded = json.dumps(
                    body,
                    ensure_ascii=True,
                    separators=(",", ":"),
                    sort_keys=True,
                    allow_nan=False,
                ).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise ScheduleAdapterError("schedule_request_invalid") from error
            if len(encoded) > 131_072:
                raise ScheduleAdapterError("schedule_request_too_large")
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)

        connection = http.client.HTTPConnection(
            "127.0.0.1", self._config.port, timeout=self._config.timeout_seconds
        )
        try:
            connection.request(method, target, body=encoded, headers=headers)
            response = connection.getresponse()
            raw_length = response.getheader("Content-Length")
            if raw_length is not None:
                if re.fullmatch(r"0|[1-9][0-9]*", raw_length) is None:
                    raise ScheduleAdapterError("schedule_response_invalid")
                if int(raw_length, 10) > self._config.maximum_response_bytes:
                    raise ScheduleAdapterError("schedule_response_too_large")
            raw = response.read(self._config.maximum_response_bytes + 1)
            if len(raw) > self._config.maximum_response_bytes:
                raise ScheduleAdapterError("schedule_response_too_large")
            content_type = (response.getheader("Content-Type") or "").lower().split(";", 1)[0].strip()
            if content_type != "application/json":
                raise ScheduleAdapterError("schedule_response_not_json")
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ScheduleAdapterError("schedule_response_not_json") from error
            if not (200 <= response.status <= 299):
                error_code = {
                    401: "schedule_authentication_rejected",
                    403: "schedule_authorization_rejected",
                    404: "schedule_resource_not_found",
                    409: "schedule_conflict",
                    429: "schedule_rate_limited",
                }.get(
                    response.status,
                    "schedule_upstream_failure"
                    if response.status >= 500
                    else "schedule_request_rejected",
                )
                raise ScheduleAdapterError(
                    error_code,
                    retryable=response.status == 429 or response.status >= 500,
                )
            envelope = _exact_object(
                payload, {"version", "requestId", "data"}, "schedule_envelope_invalid"
            )
            if envelope["version"] != INTEGRATION_VERSION:
                raise ScheduleAdapterError("schedule_envelope_invalid")
            _uuid(envelope["requestId"], "schedule_envelope_invalid")
            return envelope["data"]
        except ScheduleAdapterError:
            raise
        except (OSError, http.client.HTTPException, TimeoutError) as error:
            raise ScheduleAdapterError("schedule_unavailable", retryable=True) from error
        finally:
            connection.close()

    @staticmethod
    def _validate_work_item(
        value: Any,
        receipt_version: int | None = 2,
        code: str = "schedule_work_items_invalid",
    ) -> dict[str, Any]:
        base_keys = {
            "id",
            "workspaceId",
            "title",
            "description",
            "status",
            "priority",
            "planningDurationMinutes",
            "version",
            "createdAt",
            "updatedAt",
        }
        versioned_keys = base_keys | ({"dueOn"} if receipt_version in {1, 2} else set())
        expected_keys = versioned_keys | ({"parentWorkItemId"} if receipt_version == 2 else set())
        item = _exact_object(
            value,
            expected_keys,
            code,
        )
        _uuid(item["id"], code)
        _uuid(item["workspaceId"], code)
        if receipt_version == 2 and item["parentWorkItemId"] is not None:
            _uuid(item["parentWorkItemId"], code)
        _bounded_text(item["title"], 240, code)
        if item["description"] is not None:
            _bounded_text(item["description"], 4_000, code, allow_empty=True)
        if item["status"] not in _STATUSES or item["priority"] not in _PRIORITIES:
            raise ScheduleAdapterError(code)
        duration = item["planningDurationMinutes"]
        if duration is not None and (
            isinstance(duration, bool)
            or not isinstance(duration, int)
            or not (1 <= duration <= 43_200)
        ):
            raise ScheduleAdapterError(code)
        if receipt_version in {1, 2} and item["dueOn"] is not None:
            try:
                _local_date(item["dueOn"])
            except ScheduleAdapterError as error:
                raise ScheduleAdapterError(code) from error
        _positive_integer(item["version"], code)
        _bounded_text(item["createdAt"], 64, code)
        _bounded_text(item["updatedAt"], 64, code)
        return item

    @staticmethod
    def _validate_one_off_command(command: Mapping[str, Any]) -> None:
        code = "schedule_command_invalid"
        operation = command.get("type")
        if operation == "one_off_reminder.create":
            _exact_object(command, {"type", "title", "scheduledFor"}, code)
        elif operation == "one_off_reminder.update":
            base = {"type", "oneOffReminderId", "expectedVersion"}
            changes = set(command) - base
            if set(command) - changes != base or not changes or changes - {
                "title",
                "scheduledFor",
            }:
                raise ScheduleAdapterError(code)
        else:
            _exact_object(command, {"type", "oneOffReminderId", "expectedVersion"}, code)
        if operation != "one_off_reminder.create":
            _uuid(command["oneOffReminderId"], code)
            _positive_integer(command["expectedVersion"], code)
        if "title" in command:
            title = command["title"]
            if (
                not isinstance(title, str)
                or title != title.strip()
                or not (1 <= len(title) <= 240)
            ):
                raise ScheduleAdapterError(code)
        if "scheduledFor" in command:
            _instant(command["scheduledFor"], code)

    @staticmethod
    def _validate_one_off_reminder(value: Any, code: str) -> dict[str, Any]:
        reminder = _exact_object(
            value,
            {
                "id",
                "workspaceId",
                "title",
                "scheduledFor",
                "cancelledAt",
                "version",
                "createdAt",
                "updatedAt",
            },
            code,
        )
        _uuid(reminder["id"], code)
        _uuid(reminder["workspaceId"], code)
        title = _bounded_text(reminder["title"], 240, code)
        if title != title.strip():
            raise ScheduleAdapterError(code)
        _instant(reminder["scheduledFor"], code)
        cancelled_at = (
            None
            if reminder["cancelledAt"] is None
            else datetime.fromisoformat(
                _instant(reminder["cancelledAt"], code).replace("Z", "+00:00")
            )
        )
        _positive_integer(reminder["version"], code)
        created_at = datetime.fromisoformat(
            _instant(reminder["createdAt"], code).replace("Z", "+00:00")
        )
        updated_at = datetime.fromisoformat(
            _instant(reminder["updatedAt"], code).replace("Z", "+00:00")
        )
        if updated_at < created_at or (
            cancelled_at is not None
            and (cancelled_at < created_at or cancelled_at != updated_at)
        ):
            raise ScheduleAdapterError(code)
        return reminder

    @staticmethod
    def _safe_confirmation_outcome(
        value: Any, operation: str, receipt_version: int | None
    ) -> dict[str, Any]:
        if operation in {"work_item.create", "work_item.update"}:
            outcome = _exact_object(
                value, {"type", "workItem"}, "schedule_confirmed_change_invalid"
            )
            expected_type = (
                "work_item.created" if operation == "work_item.create" else "work_item.updated"
            )
            if outcome["type"] != expected_type:
                raise ScheduleAdapterError("schedule_confirmed_change_invalid")
            item = ScheduleClient._validate_work_item(
                outcome["workItem"], receipt_version, "schedule_confirmed_change_invalid"
            )
            return {
                "type": expected_type,
                "workItem": {
                    "id": item["id"],
                    "parentWorkItemId": item.get("parentWorkItemId"),
                    "status": item["status"],
                    "priority": item["priority"],
                    "planningDurationMinutes": item["planningDurationMinutes"],
                    "dueOn": item.get("dueOn"),
                    "version": item["version"],
                },
            }
        if operation in {"schedule_block.create", "schedule_block.update"}:
            outcome = _exact_object(
                value, {"type", "scheduleBlock"}, "schedule_confirmed_change_invalid"
            )
            expected_type = (
                "schedule_block.created"
                if operation == "schedule_block.create"
                else "schedule_block.updated"
            )
            if outcome["type"] != expected_type:
                raise ScheduleAdapterError("schedule_confirmed_change_invalid")
            block = _exact_object(
                outcome["scheduleBlock"],
                {
                    "id",
                    "workspaceId",
                    "workItemId",
                    "title",
                    "startsAt",
                    "endsAt",
                    "timeZone",
                    "version",
                    "createdAt",
                    "updatedAt",
                },
                "schedule_confirmed_change_invalid",
            )
            _uuid(block["id"], "schedule_confirmed_change_invalid")
            _uuid(block["workspaceId"], "schedule_confirmed_change_invalid")
            if block["workItemId"] is not None:
                _uuid(block["workItemId"], "schedule_confirmed_change_invalid")
            if block["title"] is not None:
                _bounded_text(
                    block["title"], 240, "schedule_confirmed_change_invalid", allow_empty=True
                )
            for field in ("startsAt", "endsAt", "createdAt", "updatedAt"):
                _bounded_text(block[field], 64, "schedule_confirmed_change_invalid")
            _bounded_text(block["timeZone"], 80, "schedule_confirmed_change_invalid")
            version = _positive_integer(block["version"], "schedule_confirmed_change_invalid")
            return {
                "type": expected_type,
                "scheduleBlock": {"id": block["id"], "version": version},
            }

        if operation in {
            "one_off_reminder.create",
            "one_off_reminder.update",
            "one_off_reminder.cancel",
        }:
            if receipt_version != 2:
                raise ScheduleAdapterError("schedule_confirmed_change_invalid")
            outcome = _exact_object(
                value, {"type", "oneOffReminder"}, "schedule_confirmed_change_invalid"
            )
            expected_type = {
                "one_off_reminder.create": "one_off_reminder.created",
                "one_off_reminder.update": "one_off_reminder.updated",
                "one_off_reminder.cancel": "one_off_reminder.cancelled",
            }[operation]
            if outcome["type"] != expected_type:
                raise ScheduleAdapterError("schedule_confirmed_change_invalid")
            reminder = ScheduleClient._validate_one_off_reminder(
                outcome["oneOffReminder"],
                "schedule_confirmed_change_invalid",
            )
            cancelled = operation == "one_off_reminder.cancel"
            if (reminder["cancelledAt"] is not None) != cancelled:
                raise ScheduleAdapterError("schedule_confirmed_change_invalid")
            if operation == "one_off_reminder.create" and reminder["version"] != 1:
                raise ScheduleAdapterError("schedule_confirmed_change_invalid")
            projected = {"id": reminder["id"], "version": reminder["version"]}
            field = "cancelledAt" if cancelled else "scheduledFor"
            projected[field] = reminder[field]
            return {
                "type": expected_type,
                "oneOffReminder": projected,
            }

        outcome = _exact_object(
            value, {"type", "planItemActivity"}, "schedule_confirmed_change_invalid"
        )
        if outcome["type"] != "plan_item.activity_recorded":
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        activity = _exact_object(
            outcome["planItemActivity"],
            {"planId", "itemId", "activityState", "activityEvent", "headVersion"},
            "schedule_confirmed_change_invalid",
        )
        plan_id = _uuid(activity["planId"], "schedule_confirmed_change_invalid")
        item_id = _uuid(activity["itemId"], "schedule_confirmed_change_invalid")
        if activity["activityState"] not in _ACTIVITY_STATES:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        head_version = _positive_integer(
            activity["headVersion"], "schedule_confirmed_change_invalid"
        )
        event = _exact_object(
            activity["activityEvent"],
            {
                "id",
                "workspaceId",
                "sourceType",
                "routineId",
                "workItemId",
                "planId",
                "planItemId",
                "type",
                "occurredAt",
                "localDate",
                "timeZone",
                "durationMinutes",
                "reason",
                "referenceEventId",
                "metadata",
                "recordedAt",
            },
            "schedule_confirmed_change_invalid",
        )
        event_id = _uuid(event["id"], "schedule_confirmed_change_invalid")
        _uuid(event["workspaceId"], "schedule_confirmed_change_invalid")
        if event["sourceType"] not in {"routine", "work_item"}:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        for field in ("routineId", "workItemId", "referenceEventId"):
            if event[field] is not None:
                _uuid(event[field], "schedule_confirmed_change_invalid")
        if event["planId"] != plan_id or event["planItemId"] != item_id:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        if event["type"] not in _ACTIVITY_TYPES:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        _bounded_text(event["occurredAt"], 64, "schedule_confirmed_change_invalid")
        _local_date(event["localDate"])
        _bounded_text(event["timeZone"], 80, "schedule_confirmed_change_invalid")
        duration = event["durationMinutes"]
        if duration is not None and (
            isinstance(duration, bool)
            or not isinstance(duration, int)
            or not (1 <= duration <= 43_200)
        ):
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        if event["reason"] is not None:
            _bounded_text(
                event["reason"], 500, "schedule_confirmed_change_invalid", allow_empty=True
            )
        if not isinstance(event["metadata"], dict) or len(event["metadata"]) > 8:
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        for key, child in event["metadata"].items():
            if (
                not isinstance(key, str)
                or not (1 <= len(key) <= 64)
                or not key.strip()
            ):
                raise ScheduleAdapterError("schedule_confirmed_change_invalid")
            if child is None or isinstance(child, bool):
                continue
            if isinstance(child, str) and len(child) <= 256:
                continue
            if isinstance(child, (int, float)) and not isinstance(child, bool):
                if child == child and child not in {float("inf"), float("-inf")}:
                    continue
            raise ScheduleAdapterError("schedule_confirmed_change_invalid")
        _bounded_text(event["recordedAt"], 64, "schedule_confirmed_change_invalid")
        return {
            "type": "plan_item.activity_recorded",
            "planItemActivity": {
                "planId": plan_id,
                "itemId": item_id,
                "activityState": activity["activityState"],
                "headVersion": head_version,
                "activityEventId": event_id,
            },
        }
