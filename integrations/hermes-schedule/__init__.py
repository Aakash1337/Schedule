"""Hermes plugin registration for the Schedule integration gateway."""

from __future__ import annotations

from copy import deepcopy

from . import schemas
from .tools import (
    capture_turn,
    handle_schedule_cancel_change,
    handle_schedule_confirm_change,
    handle_schedule_daily_plan_fit,
    handle_schedule_list_one_off_reminders,
    handle_schedule_list_schedule_blocks,
    handle_schedule_list_work_items,
    handle_schedule_prepare_change,
    handle_schedule_today,
)


_TOOLS = (
    ("schedule_today", schemas.SCHEDULE_TODAY, handle_schedule_today, "📅"),
    (
        "schedule_daily_plan_fit",
        schemas.SCHEDULE_DAILY_PLAN_FIT,
        handle_schedule_daily_plan_fit,
        "🎯",
    ),
    (
        "schedule_list_work_items",
        schemas.SCHEDULE_LIST_WORK_ITEMS,
        handle_schedule_list_work_items,
        "📋",
    ),
    (
        "schedule_list_one_off_reminders",
        schemas.SCHEDULE_LIST_ONE_OFF_REMINDERS,
        handle_schedule_list_one_off_reminders,
        "⏰",
    ),
    (
        "schedule_list_schedule_blocks",
        schemas.SCHEDULE_LIST_SCHEDULE_BLOCKS,
        handle_schedule_list_schedule_blocks,
        "🗓️",
    ),
    (
        "schedule_prepare_change",
        schemas.SCHEDULE_PREPARE_CHANGE,
        handle_schedule_prepare_change,
        "📝",
    ),
    (
        "schedule_confirm_change",
        schemas.SCHEDULE_CONFIRM_CHANGE,
        handle_schedule_confirm_change,
        "✅",
    ),
    (
        "schedule_cancel_change",
        schemas.SCHEDULE_CANCEL_CHANGE,
        handle_schedule_cancel_change,
        "🚫",
    ),
)


def register(ctx: object) -> None:
    """Register the bounded tool surface and observer-only turn hook."""

    for name, schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=name,
            toolset="schedule",
            schema=deepcopy(schema),
            handler=handler,
            emoji=emoji,
        )
    ctx.register_hook("pre_llm_call", capture_turn)
