#!/usr/bin/env python3
"""Print a deterministic, bounded Today digest for Hermes cron delivery."""

from __future__ import annotations

import argparse
from datetime import datetime
import os
import sys
from typing import Any
import unicodedata

try:
    from .client import ScheduleAdapterError, ScheduleClient
except ImportError:  # Direct script execution from the installed plugin directory.
    from client import ScheduleAdapterError, ScheduleClient


MAXIMUM_ITEMS = 20
MAXIMUM_OUTPUT_CHARACTERS = 3_500


def _safe_title(value: Any) -> str:
    """Render an untrusted title without terminal/chat line or bidi spoofing."""

    if not isinstance(value, str) or not value or len(value) > 240:
        raise ScheduleAdapterError("schedule_today_invalid")
    characters = []
    for character in value:
        category = unicodedata.category(character)
        characters.append(
            " "
            if character.isspace() or category in {"Cc", "Cf", "Cs", "Zl", "Zp"}
            else character
        )
    return " ".join("".join(characters).split()) or "[title omitted]"


def format_today_digest(data: dict[str, Any]) -> str:
    local_date = data.get("date")
    plan = data.get("plan")
    if not isinstance(local_date, str):
        raise ScheduleAdapterError("schedule_today_invalid")
    if plan is None:
        return f"Schedule for {local_date}: no Today plan has been generated."
    if not isinstance(plan, dict) or not isinstance(plan.get("items"), list):
        raise ScheduleAdapterError("schedule_today_invalid")

    actionable: list[dict[str, Any]] = []
    for item in plan["items"]:
        if not isinstance(item, dict):
            raise ScheduleAdapterError("schedule_today_invalid")
        state = item.get("activityState")
        if state in {"pending", "started"}:
            actionable.append(item)

    if not actionable:
        return f"Schedule for {local_date}: no unfinished Today items."

    lines = [f"Schedule for {local_date}: {len(actionable)} unfinished item(s)."]
    for index, item in enumerate(actionable[:MAXIMUM_ITEMS], start=1):
        title = _safe_title(item.get("title"))
        state = item.get("activityState")
        minutes = item.get("scheduledMinutes")
        suffix = []
        if state == "started":
            suffix.append("started")
        if isinstance(minutes, int) and not isinstance(minutes, bool) and minutes > 0:
            suffix.append(f"{minutes} min")
        label = f" ({', '.join(suffix)})" if suffix else ""
        lines.append(f"{index}. {title}{label}")
    if len(actionable) > MAXIMUM_ITEMS:
        lines.append(f"…and {len(actionable) - MAXIMUM_ITEMS} more. Open Schedule for the full plan.")
    output = "\n".join(lines)
    if len(output) > MAXIMUM_OUTPUT_CHARACTERS:
        output = output[: MAXIMUM_OUTPUT_CHARACTERS - 1].rstrip() + "…"
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print a deterministic Schedule Today digest")
    parser.add_argument("--date", help="Local date in YYYY-MM-DD form")
    arguments = parser.parse_args(argv)
    requested_date = arguments.date or os.environ.get("SCHEDULE_REMINDER_DATE")
    if requested_date is None:
        requested_date = datetime.now().astimezone().date().isoformat()
    try:
        digest = format_today_digest(ScheduleClient.from_environment().get_today(requested_date))
    except ScheduleAdapterError as error:
        if error.code == "schedule_resource_not_found":
            digest = format_today_digest({"date": requested_date, "plan": None})
        else:
            print(f"Schedule reminder unavailable ({error.code}).", file=sys.stderr)
            return 1
    print(digest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
