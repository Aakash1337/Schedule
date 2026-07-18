#!/usr/bin/env python3
"""Locate, install, or check the local Hermes Schedule plugin without touching secrets."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import sys
import uuid


PLUGIN_FILES = (
    "__init__.py",
    "client.py",
    "plugin.yaml",
    "reminder.py",
    "schemas.py",
    "state.py",
    "tools.py",
    "verify_native.py",
)
REMINDER_FILES = ("client.py", "reminder.py")


class HermesInstallError(Exception):
    """A fixed, operator-actionable installation failure."""


def default_hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME", "").strip()
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return base / "hermes"
    return Path.home() / ".hermes"


def _digest(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise HermesInstallError("Hermes Schedule files could not be read.") from error


def _validate_source(source: Path) -> None:
    for name in set(PLUGIN_FILES + REMINDER_FILES):
        candidate = source / name
        if not candidate.is_file() or candidate.is_symlink():
            raise HermesInstallError("Hermes Schedule source is incomplete.")


def _require_inside_home(hermes_home: Path, destination: Path) -> None:
    try:
        destination.parent.resolve().relative_to(hermes_home.resolve())
    except (OSError, ValueError) as error:
        raise HermesInstallError("Hermes destination escapes the configured home.") from error


def bundle_status(source: Path, destination: Path, files: tuple[str, ...]) -> str:
    if not destination.is_dir() or destination.is_symlink():
        return "missing" if not destination.exists() else "outdated"
    return (
        "current"
        if all(
            (destination / name).is_file()
            and not (destination / name).is_symlink()
            and _digest(source / name) == _digest(destination / name)
            for name in files
        )
        else "outdated"
    )


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def _replace_bundle(source: Path, destination: Path, files: tuple[str, ...]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = destination.with_name(f".{destination.name}.stage-{uuid.uuid4().hex}")
    backup = destination.with_name(f".{destination.name}.backup-{uuid.uuid4().hex}")
    stage.mkdir()
    try:
        for name in files:
            candidate = source / name
            if not candidate.is_file() or candidate.is_symlink():
                raise HermesInstallError("Hermes Schedule source is incomplete.")
            shutil.copy2(candidate, stage / name)
        had_destination = destination.exists() or destination.is_symlink()
        if had_destination:
            destination.rename(backup)
        try:
            stage.rename(destination)
        except Exception:
            if had_destination and (backup.exists() or backup.is_symlink()):
                backup.rename(destination)
            raise
        _remove(backup)
    except HermesInstallError:
        raise
    except Exception as error:
        raise HermesInstallError("Hermes Schedule files could not be installed.") from error
    finally:
        _remove(stage)


def paths(hermes_home: Path) -> tuple[Path, Path]:
    return (
        hermes_home / "plugins" / "hermes-schedule",
        hermes_home / "scripts" / "schedule-reminder",
    )


def check(hermes_home: Path, source: Path) -> tuple[str, str]:
    plugin, reminder = paths(hermes_home)
    _validate_source(source)
    return (
        bundle_status(source, plugin, PLUGIN_FILES),
        bundle_status(source, reminder, REMINDER_FILES),
    )


def install(hermes_home: Path, source: Path, replace: bool = False) -> None:
    plugin, reminder = paths(hermes_home)
    _require_inside_home(hermes_home, plugin)
    _require_inside_home(hermes_home, reminder)
    statuses = check(hermes_home, source)
    if not replace and "outdated" in statuses:
        raise HermesInstallError("Existing Hermes Schedule files differ; use --replace to upgrade.")
    if statuses[0] != "current":
        _replace_bundle(source, plugin, PLUGIN_FILES)
    if statuses[1] != "current":
        _replace_bundle(source, reminder, REMINDER_FILES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("home", "check", "install"))
    parser.add_argument("--hermes-home", type=Path, default=default_hermes_home())
    parser.add_argument("--replace", action="store_true", help="Replace an outdated installation")
    arguments = parser.parse_args(argv)
    if arguments.action == "home":
        print(arguments.hermes_home)
        return 0
    source = Path(__file__).resolve().parent
    try:
        if arguments.action == "install":
            install(arguments.hermes_home, source, arguments.replace)
        plugin_status, reminder_status = check(arguments.hermes_home, source)
    except HermesInstallError as error:
        print(f"Hermes Schedule install failed: {error}", file=sys.stderr)
        return 1
    print(f"plugin={plugin_status} reminder={reminder_status}")
    if arguments.action == "install":
        print(
            "Files installed; enablement is unchanged. Configure secrets, explicitly enable if "
            "needed, and restart Hermes."
        )
    return 0 if plugin_status == reminder_status == "current" else 1


if __name__ == "__main__":
    raise SystemExit(main())
