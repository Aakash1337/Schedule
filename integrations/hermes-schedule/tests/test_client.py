"""Deterministic stdlib-only tests for the Schedule gateway client."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest
from uuid import uuid4


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from client import (  # noqa: E402
    INTEGRATION_VERSION,
    ScheduleAdapterError,
    ScheduleClient,
    ScheduleClientConfig,
)


class _Fixture:
    def __init__(self) -> None:
        self.responses: list[tuple[int, dict[str, str], bytes]] = []
        self.requests: list[dict[str, object]] = []


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    fixture: _Fixture

    def do_GET(self) -> None:  # noqa: N802
        self._respond()

    def do_POST(self) -> None:  # noqa: N802
        self._respond()

    def _respond(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        self.fixture.requests.append(
            {
                "method": self.command,
                "target": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "body": raw,
            }
        )
        status, headers, body = self.fixture.responses.pop(0)
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def _json_response(status: int, value: object) -> tuple[int, dict[str, str], bytes]:
    return (
        status,
        {"Content-Type": "application/json; charset=utf-8"},
        json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8"),
    )


def _envelope(data: object) -> dict[str, object]:
    return {
        "version": INTEGRATION_VERSION,
        "requestId": str(uuid4()),
        "data": data,
    }


@contextmanager
def _server(*responses: tuple[int, dict[str, str], bytes]):
    fixture = _Fixture()
    fixture.responses.extend(responses)
    handler = type("FixtureHandler", (_Handler,), {"fixture": fixture})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, fixture
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class ScheduleClientTests(unittest.TestCase):
    token = "opaque-verifier-token-123456789"

    def test_environment_accepts_only_an_exact_loopback_origin(self) -> None:
        client = ScheduleClient.from_environment(
            {
                "SCHEDULE_INTEGRATION_URL": "http://127.0.0.1:4000",
                "SCHEDULE_INTEGRATION_TOKEN": self.token,
            }
        )
        self.assertIsInstance(client, ScheduleClient)

        for value in (
            "",
            "http://localhost:4000",
            "http://127.0.0.1:4000/",
            "http://127.0.0.1:4000@attacker.example",
            "https://127.0.0.1:4000",
            "http://127.0.0.2:4000",
            "http://127.0.0.1:04000",
        ):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ScheduleAdapterError, "^schedule_url_invalid$"):
                    ScheduleClient.from_environment(
                        {
                            "SCHEDULE_INTEGRATION_URL": value,
                            "SCHEDULE_INTEGRATION_TOKEN": self.token,
                        }
                    )

    def test_reads_today_and_work_items_with_exact_bearer_requests(self) -> None:
        workspace_id = str(uuid4())
        item_id = str(uuid4())
        today = {
            "workspaceId": workspace_id,
            "date": "2026-07-15",
            "headVersion": 0,
            "plan": None,
        }
        page = {
            "items": [
                {
                    "id": item_id,
                    "workspaceId": workspace_id,
                    "title": "Bounded work",
                    "description": None,
                    "status": "planned",
                    "priority": "medium",
                    "planningDurationMinutes": 30,
                    "dueOn": "2026-07-16",
                    "version": 1,
                    "createdAt": "2026-07-15T07:00:00.000Z",
                    "updatedAt": "2026-07-15T07:00:00.000Z",
                }
            ],
            "page": {"limit": 10, "offset": 0},
        }
        with _server(_json_response(200, _envelope(today)), _json_response(200, _envelope(page))) as (
            port,
            fixture,
        ):
            client = ScheduleClient(ScheduleClientConfig(port=port, token=self.token))
            self.assertEqual(client.get_today("2026-07-15"), today)
            self.assertEqual(
                client.list_work_items(status="planned", priority="medium", limit=10), page
            )

        self.assertEqual(len(fixture.requests), 2)
        first, second = fixture.requests
        self.assertEqual(first["method"], "GET")
        self.assertEqual(first["target"], "/v1/integrations/today?date=2026-07-15")
        self.assertEqual(second["method"], "GET")
        self.assertEqual(
            second["target"],
            "/v1/integrations/work-items?limit=10&offset=0&status=planned&priority=medium",
        )
        for request in fixture.requests:
            headers = request["headers"]
            self.assertIsInstance(headers, dict)
            self.assertEqual(headers["authorization"], f"Bearer {self.token}")
            self.assertEqual(headers["accept"], "application/json")
            self.assertEqual(headers["connection"], "close")

    def test_prepares_then_confirms_with_distinct_request_and_replay_keys(self) -> None:
        request_id = str(uuid4())
        confirmation_id = str(uuid4())
        idempotency_key = str(uuid4())
        work_item_id = str(uuid4())
        workspace_id = str(uuid4())
        command = {
            "type": "work_item.create",
            "title": "Prepare only",
            "status": "planned",
        }
        prepared = {
            "confirmationId": confirmation_id,
            "requestId": request_id,
            "commandHash": hashlib.sha256(
                json.dumps(command, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode(
                    "utf-8"
                )
            ).hexdigest(),
            "command": command,
            "commandDisplay": json.dumps(command, separators=(",", ":"), sort_keys=True),
            "summary": "Create a planned work item.",
            "expiresAt": "2026-07-15T07:01:00.000Z",
        }
        confirmed = {
            "receiptVersion": 1,
            "confirmationId": confirmation_id,
            "operation": "work_item.create",
            "commandHash": hashlib.sha256(
                json.dumps(command, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode(
                    "utf-8"
                )
            ).hexdigest(),
            "outcome": {
                "type": "work_item.created",
                "workItem": {
                    "id": work_item_id,
                    "workspaceId": workspace_id,
                    "title": "Prepare only",
                    "description": "RECEIPT_DESCRIPTION_MUST_NOT_ESCAPE",
                    "status": "planned",
                    "priority": "none",
                    "planningDurationMinutes": None,
                    "dueOn": None,
                    "version": 1,
                    "createdAt": "2026-07-15T07:00:00.000Z",
                    "updatedAt": "2026-07-15T07:00:00.000Z",
                },
            },
        }
        with _server(
            _json_response(201, _envelope(prepared)),
            _json_response(200, _envelope(confirmed)),
        ) as (port, fixture):
            client = ScheduleClient(ScheduleClientConfig(port=port, token=self.token))
            self.assertEqual(client.prepare_change(request_id, command), prepared)
            safe_receipt = client.confirm_change(
                confirmation_id,
                idempotency_key,
                "work_item.create",
                prepared["commandHash"],
            )

        self.assertEqual(
            safe_receipt["outcome"],
            {
                "type": "work_item.created",
                "workItem": {
                    "id": work_item_id,
                    "status": "planned",
                    "priority": "none",
                    "planningDurationMinutes": None,
                    "dueOn": None,
                    "version": 1,
                },
            },
        )
        self.assertNotIn("RECEIPT_DESCRIPTION_MUST_NOT_ESCAPE", json.dumps(safe_receipt))

        prepare_request, confirm_request = fixture.requests
        self.assertEqual(prepare_request["target"], "/v1/integrations/commands/prepare")
        self.assertEqual(
            json.loads(prepare_request["body"]),
            {"version": INTEGRATION_VERSION, "requestId": request_id, "command": command},
        )
        self.assertNotIn("idempotency-key", prepare_request["headers"])
        self.assertEqual(confirm_request["target"], "/v1/integrations/commands/confirm")
        self.assertEqual(confirm_request["headers"]["idempotency-key"], idempotency_key)
        self.assertEqual(
            json.loads(confirm_request["body"]),
            {"version": INTEGRATION_VERSION, "confirmationId": confirmation_id},
        )

    def test_rejects_prepare_integrity_drift_before_exposing_a_confirmation(self) -> None:
        request_id = str(uuid4())
        confirmation_id = str(uuid4())
        intended = {
            "type": "work_item.create",
            "title": "Intended title",
            "status": "planned",
        }
        canonical = json.dumps(intended, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        expected_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        changed = {**intended, "title": "Different material title"}
        changed_display = json.dumps(
            changed, ensure_ascii=True, separators=(",", ":"), sort_keys=True
        )
        invalid_prepared = (
            {
                "confirmationId": confirmation_id,
                "requestId": request_id,
                "commandHash": hashlib.sha256(changed_display.encode("utf-8")).hexdigest(),
                "command": changed,
                "commandDisplay": changed_display,
                "summary": "Hostile command substitution",
                "expiresAt": "2026-07-15T07:01:00.000Z",
            },
            {
                "confirmationId": confirmation_id,
                "requestId": request_id,
                "commandHash": hashlib.sha256(changed_display.encode("utf-8")).hexdigest(),
                "command": intended,
                "commandDisplay": changed_display,
                "summary": "Hostile display substitution",
                "expiresAt": "2026-07-15T07:01:00.000Z",
            },
            {
                "confirmationId": confirmation_id,
                "requestId": request_id,
                "commandHash": "f" * 64,
                "command": intended,
                "commandDisplay": canonical,
                "summary": "Hostile hash substitution",
                "expiresAt": "2026-07-15T07:01:00.000Z",
            },
            {
                "confirmationId": confirmation_id,
                "requestId": request_id,
                "commandHash": expected_hash,
                "command": intended,
                "commandDisplay": "not-json",
                "summary": "Malformed display",
                "expiresAt": "2026-07-15T07:01:00.000Z",
            },
        )
        for prepared in invalid_prepared:
            with self.subTest(prepared=prepared["summary"]):
                with _server(_json_response(201, _envelope(prepared))) as (port, _fixture):
                    client = ScheduleClient(ScheduleClientConfig(port=port, token=self.token))
                    with self.assertRaisesRegex(
                        ScheduleAdapterError, "^schedule_prepared_change_invalid$"
                    ):
                        client.prepare_change(request_id, intended)

    def test_rejects_mismatched_or_overbroad_confirmation_receipts(self) -> None:
        confirmation_id = str(uuid4())
        idempotency_key = str(uuid4())
        command_hash = "a" * 64
        work_item = {
            "id": str(uuid4()),
            "workspaceId": str(uuid4()),
            "title": "Bounded title",
            "description": None,
            "status": "planned",
            "priority": "medium",
            "planningDurationMinutes": 30,
            "dueOn": None,
            "version": 1,
            "createdAt": "2026-07-15T07:00:00.000Z",
            "updatedAt": "2026-07-15T07:00:00.000Z",
        }
        valid = {
            "receiptVersion": 1,
            "confirmationId": confirmation_id,
            "operation": "work_item.create",
            "commandHash": command_hash,
            "outcome": {"type": "work_item.created", "workItem": work_item},
        }
        invalid_receipts = (
            {**valid, "receiptVersion": True},
            {**valid, "confirmationId": str(uuid4())},
            {**valid, "operation": "work_item.update"},
            {**valid, "commandHash": "b" * 64},
            {**valid, "rawResponseSecret": "MUST_NOT_ESCAPE"},
            {
                **valid,
                "outcome": {
                    "type": "work_item.created",
                    "workItem": {**work_item, "providerSecret": "MUST_NOT_ESCAPE"},
                },
            },
        )
        for receipt in invalid_receipts:
            with self.subTest(receipt=receipt):
                with _server(_json_response(200, _envelope(receipt))) as (port, _fixture):
                    client = ScheduleClient(ScheduleClientConfig(port=port, token=self.token))
                    with self.assertRaisesRegex(
                        ScheduleAdapterError, "^schedule_confirmed_change_invalid$"
                    ) as caught:
                        client.confirm_change(
                            confirmation_id,
                            idempotency_key,
                            "work_item.create",
                            command_hash,
                        )
                self.assertNotIn("MUST_NOT_ESCAPE", str(caught.exception))

    def test_bounds_and_redacts_rejected_or_malformed_responses(self) -> None:
        secret = "lowercase-token-sentinel-123456789"
        provider_detail = "RAW_RESPONSE_SENTINEL_MUST_NOT_ESCAPE"
        error_response = {
            "error": {"code": secret, "message": provider_detail},
            "requestId": str(uuid4()),
        }
        with _server(_json_response(429, error_response)) as (port, _fixture):
            client = ScheduleClient(ScheduleClientConfig(port=port, token=secret))
            with self.assertRaises(ScheduleAdapterError) as caught:
                client.get_today("2026-07-15")
        self.assertEqual(caught.exception.code, "schedule_rate_limited")
        self.assertTrue(caught.exception.retryable)
        self.assertNotIn(secret, str(caught.exception))
        self.assertNotIn(provider_detail, str(caught.exception))

        with _server((200, {"Content-Type": "text/plain"}, b"untrusted body")) as (
            port,
            _fixture,
        ):
            client = ScheduleClient(ScheduleClientConfig(port=port, token=self.token))
            with self.assertRaisesRegex(ScheduleAdapterError, "^schedule_response_not_json$"):
                client.get_today("2026-07-15")

    def test_rejects_filters_and_identifiers_before_opening_http(self) -> None:
        client = ScheduleClient(ScheduleClientConfig(port=65534, token=self.token))
        invalid_calls = (
            lambda: client.get_today("2026-7-15"),
            lambda: client.list_work_items(status="PLANNED"),
            lambda: client.list_work_items(limit=True),
            lambda: client.prepare_change("not-a-uuid", {"type": "work_item.create"}),
            lambda: client.confirm_change(
                str(uuid4()), "not-a-uuid", "work_item.create", "a" * 64
            ),
        )
        for call in invalid_calls:
            with self.subTest(call=call):
                with self.assertRaises(ScheduleAdapterError):
                    call()


if __name__ == "__main__":
    unittest.main()
