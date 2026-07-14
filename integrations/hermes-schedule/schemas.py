"""Hermes tool schemas for Schedule's bounded integration surface."""

from __future__ import annotations


LOCAL_DATE = {"type": "string", "pattern": r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}
UUID = {
    "type": "string",
    "pattern": r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
}
PRIORITY = {"type": "string", "enum": ["none", "low", "medium", "high", "urgent"]}
STATUS = {
    "type": "string",
    "enum": ["backlog", "planned", "in_progress", "blocked", "done", "cancelled"],
}


def _strict(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


WORK_ITEM_CREATE = _strict(
    {
        "type": {"const": "work_item.create"},
        "title": {"type": "string", "minLength": 1, "maxLength": 240},
        "description": {"type": ["string", "null"], "maxLength": 10_000},
        "status": STATUS,
        "priority": PRIORITY,
        "planningDurationMinutes": {"type": ["integer", "null"], "minimum": 1},
        "dueOn": {"oneOf": [LOCAL_DATE, {"type": "null"}]},
    },
    ["type", "title"],
)
WORK_ITEM_UPDATE = _strict(
    {
        "type": {"const": "work_item.update"},
        "workItemId": UUID,
        "expectedVersion": {"type": "integer", "minimum": 1},
        "title": {"type": "string", "minLength": 1, "maxLength": 240},
        "description": {"type": ["string", "null"], "maxLength": 10_000},
        "status": STATUS,
        "priority": PRIORITY,
        "planningDurationMinutes": {"type": ["integer", "null"], "minimum": 1},
        "dueOn": {"oneOf": [LOCAL_DATE, {"type": "null"}]},
    },
    ["type", "workItemId", "expectedVersion"],
)
SCHEDULE_BLOCK_CREATE = _strict(
    {
        "type": {"const": "schedule_block.create"},
        "workItemId": {"oneOf": [UUID, {"type": "null"}]},
        "title": {"type": ["string", "null"], "maxLength": 240},
        "startsAt": {"type": "string", "maxLength": 64},
        "endsAt": {"type": "string", "maxLength": 64},
        "timeZone": {"type": "string", "minLength": 1, "maxLength": 128},
    },
    ["type", "startsAt", "endsAt", "timeZone"],
)
SCHEDULE_BLOCK_UPDATE = _strict(
    {
        "type": {"const": "schedule_block.update"},
        "scheduleBlockId": UUID,
        "expectedVersion": {"type": "integer", "minimum": 1},
        "workItemId": {"oneOf": [UUID, {"type": "null"}]},
        "title": {"type": ["string", "null"], "maxLength": 240},
        "startsAt": {"type": "string", "maxLength": 64},
        "endsAt": {"type": "string", "maxLength": 64},
        "timeZone": {"type": "string", "minLength": 1, "maxLength": 128},
    },
    ["type", "scheduleBlockId", "expectedVersion"],
)
PLAN_ITEM_ACTIVITY = _strict(
    {
        "type": {"const": "plan_item.activity"},
        "date": LOCAL_DATE,
        "expectedPlanId": UUID,
        "itemId": UUID,
        "expectedHeadVersion": {"type": "integer", "minimum": 0},
        "activityType": {
            "type": "string",
            "enum": [
                "started",
                "completed",
                "skipped",
                "deferred",
                "dismissed",
                "completion_reversed",
            ],
        },
        "occurredAt": {"type": "string", "maxLength": 64},
        "timeZone": {"type": "string", "minLength": 1, "maxLength": 128},
        "durationMinutes": {"type": ["integer", "null"], "minimum": 1},
        "reason": {"type": ["string", "null"], "maxLength": 500},
        "metadata": {"type": "object", "maxProperties": 20},
    },
    [
        "type",
        "date",
        "expectedPlanId",
        "itemId",
        "expectedHeadVersion",
        "activityType",
        "occurredAt",
        "timeZone",
    ],
)

INTEGRATION_COMMAND = {
    "oneOf": [
        WORK_ITEM_CREATE,
        WORK_ITEM_UPDATE,
        SCHEDULE_BLOCK_CREATE,
        SCHEDULE_BLOCK_UPDATE,
        PLAN_ITEM_ACTIVITY,
    ]
}

SCHEDULE_TODAY = {
    "name": "schedule_today",
    "description": "Read the authoritative current Schedule Today plan for one exact local date. This tool never changes Schedule.",
    "parameters": _strict({"date": LOCAL_DATE}, ["date"]),
}

SCHEDULE_LIST_WORK_ITEMS = {
    "name": "schedule_list_work_items",
    "description": "List a bounded page of work items in the credential's Schedule workspace. Use returned IDs and versions before preparing an update.",
    "parameters": _strict(
        {
            "status": STATUS,
            "priority": PRIORITY,
            "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            "offset": {"type": "integer", "minimum": 0, "maximum": 1_000_000},
        },
        [],
    ),
}

SCHEDULE_PREPARE_CHANGE = {
    "name": "schedule_prepare_change",
    "description": (
        "Validate and preview one exact Schedule change. This performs no mutation. "
        "Present the complete returned command and confirmation phrase to the user."
    ),
    "parameters": _strict({"command": INTEGRATION_COMMAND}, ["command"]),
}

SCHEDULE_CONFIRM_CHANGE = {
    "name": "schedule_confirm_change",
    "description": (
        "Confirm the pending Schedule change. Call this only when the current external user message "
        "is exactly CONFIRM SCHEDULE followed by the returned challenge, in a later turn."
    ),
    "parameters": _strict(
        {
            "challenge": {
                "type": "string",
                "pattern": r"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$",
            }
        },
        ["challenge"],
    ),
}

SCHEDULE_CANCEL_CHANGE = {
    "name": "schedule_cancel_change",
    "description": "Cancel this sender/session's pending Schedule preview without changing Schedule.",
    "parameters": _strict({}, []),
}
