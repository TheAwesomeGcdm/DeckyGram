import asyncio
import os
import importlib.util
import logging
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock

import pytest


def load_plugin_class(monkeypatch):
    decky_stub = types.ModuleType("decky")
    decky_stub.DECKY_PLUGIN_DIR = "/plugin"
    decky_stub.DECKY_PLUGIN_RUNTIME_DIR = "/runtime"
    decky_stub.DECKY_PLUGIN_SETTINGS_DIR = "/settings"
    decky_stub.logger = logging.getLogger("deckygram-test")
    monkeypatch.setitem(sys.modules, "decky", decky_stub)

    spec = importlib.util.spec_from_file_location(
        "deckygram_main_for_settings_test",
        Path(__file__).resolve().parents[1] / "main.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Plugin


DEFAULTS = {
    "chat_filter": "all",
    "hide_archived": False,
    "notifications": "steam",
    "notification_sound": True,
    "unread_badges": "all",
    "notification_cooldown": False,
    "cooldown_minutes": 5,
}


def test_plugin_settings_default_then_persist(tmp_path, monkeypatch):
    plugin_class = load_plugin_class(monkeypatch)
    plugin = object.__new__(plugin_class)
    plugin.settings_path = str(tmp_path / "settings" / "settings.json")
    plugin.settings = plugin._load_settings()

    assert plugin.settings == DEFAULTS

    result = asyncio.run(plugin.update_settings({"chat_filter": "dms", "notification_sound": False}))

    assert result == {**DEFAULTS, "chat_filter": "dms", "notification_sound": False}
    assert plugin._load_settings() == result


def test_plugin_settings_keep_valid_legacy_values_and_drop_unknown_ones(tmp_path, monkeypatch):
    plugin_class = load_plugin_class(monkeypatch)
    plugin = object.__new__(plugin_class)
    plugin.settings_path = str(tmp_path / "settings.json")
    (tmp_path / "settings.json").write_text(
        '{"hide_archived": true, "notify_groups": true, "unread_badges": "everything"}',
        encoding="utf-8",
    )

    assert plugin._load_settings() == {**DEFAULTS, "hide_archived": True}


def test_plugin_settings_reject_invalid_keys_and_values(tmp_path, monkeypatch):
    plugin_class = load_plugin_class(monkeypatch)
    plugin = object.__new__(plugin_class)
    plugin.settings_path = str(tmp_path / "settings.json")
    plugin.settings = dict(DEFAULTS)

    for change in (
        {"hide_archived": "yes"},
        {"notifications": "email"},
        {"unread_badges": True},
        {"cooldown_minutes": 4},
        {"cooldown_minutes": "5"},
        {"cooldown_minutes": True},
        {"notification_cooldown": "on"},
        {"notify_groups": True},
    ):
        with pytest.raises(ValueError, match="Unsupported"):
            asyncio.run(plugin.update_settings(change))
    assert plugin.settings == DEFAULTS


def run_notification_watcher(monkeypatch, settings, first_chats, second_chats):
    plugin_class = load_plugin_class(monkeypatch)
    module_globals = plugin_class._watch_notifications.__globals__
    plugin = object.__new__(plugin_class)
    plugin.settings = {**DEFAULTS, **settings}
    plugin.telegram = types.SimpleNamespace(get_state=AsyncMock(side_effect=[
        {"status": "ready", "chats": first_chats},
        {"status": "ready", "chats": second_chats},
    ]))
    emitted = []

    async def emit(*args):
        emitted.append(args)

    sleeps = iter([None])

    async def sleep(_seconds):
        if next(sleeps, "stop") == "stop":
            raise asyncio.CancelledError

    monkeypatch.setattr(module_globals["decky"], "emit", emit, raising=False)
    monkeypatch.setattr(module_globals["asyncio"], "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(plugin._watch_notifications())
    return emitted


def chat(title, unread, **flags):
    return {"title": title, "unread_count": unread, "last_message": "hi", "is_group": False, **flags}


def test_notifications_follow_unread_increases_and_skip_muted_chats(monkeypatch):
    emitted = run_notification_watcher(
        monkeypatch,
        {"notification_sound": False},
        [chat("Alex", 0), chat("Muted group", 2, is_muted=True)],
        # Alex moves to a different row position; tracking must follow the chat, not the index.
        [chat("Muted group", 5, is_muted=True), chat("Alex", 1)],
    )

    assert emitted == [("deckygram_message", "Alex", "hi", False, "", False)]


def test_notifications_carry_avatar_and_chat_kind(monkeypatch):
    emitted = run_notification_watcher(
        monkeypatch,
        {},
        [chat("Team", 0, is_group=True, avatar_url="data:image/webp;base64,AAAA")],
        [chat("Team", 2, is_group=True, avatar_url="data:image/webp;base64,AAAA")],
    )

    assert emitted == [("deckygram_message", "Team", "hi", True, "data:image/webp;base64,AAAA", True)]


def test_notifications_off_emits_nothing(monkeypatch):
    emitted = run_notification_watcher(monkeypatch, {"notifications": "off"}, [chat("Alex", 0)], [chat("Alex", 3)])

    assert emitted == []


def test_panel_version_matches_package_versions():
    import json
    import re

    root = Path(__file__).resolve().parents[1]
    package_version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    bridge_version = json.loads((root / "electron" / "telegram-web" / "package.json").read_text(encoding="utf-8"))["version"]
    panel_version = re.search(r'const PANEL_VERSION = "([^"]+)";', (root / "src" / "index.tsx").read_text(encoding="utf-8"))

    assert panel_version is not None
    assert panel_version.group(1) == package_version == bridge_version


def test_get_version_reports_decky_plugin_version(monkeypatch):
    plugin_class = load_plugin_class(monkeypatch)
    module_globals = plugin_class.get_version.__globals__
    monkeypatch.setattr(module_globals["decky"], "DECKY_PLUGIN_VERSION", "1.2.3", raising=False)

    assert asyncio.run(object.__new__(plugin_class).get_version()) == "1.2.3"


def test_migration_moves_legacy_steamgram_data_and_settings(tmp_path, monkeypatch):
    plugin_class = load_plugin_class(monkeypatch)
    module_globals = plugin_class._migrate_from_legacy_name.__globals__
    data_root, settings_root = tmp_path / "data", tmp_path / "settings"
    (data_root / "SteamGram" / "telegram-web" / "profile-v3").mkdir(parents=True)
    (settings_root / "SteamGram").mkdir(parents=True)
    (settings_root / "SteamGram" / "settings.json").write_text('{"chat_filter": "dms"}', encoding="utf-8")
    runtime_dir, settings_dir = data_root / "Deckygram", settings_root / "Deckygram"
    moved = []

    def migrate(target):
        def move(*sources):
            import shutil
            target.mkdir(parents=True, exist_ok=True)
            for source in sources:
                for entry in os.listdir(source):
                    shutil.move(os.path.join(source, entry), target / entry)
                os.rmdir(source)
                moved.append(source)
        return move

    monkeypatch.setattr(module_globals["decky"], "migrate_runtime", migrate(runtime_dir), raising=False)
    monkeypatch.setattr(module_globals["decky"], "migrate_settings", migrate(settings_dir), raising=False)
    stopped = []
    monkeypatch.setitem(module_globals, "stop_stale_electron_processes", lambda path: stopped.append(path) or 0)
    plugin = object.__new__(plugin_class)
    plugin.telegram = types.SimpleNamespace(runtime_dir=str(runtime_dir))
    plugin.settings_path = str(settings_dir / "settings.json")
    plugin.settings = dict(DEFAULTS)

    plugin._migrate_from_legacy_name()

    assert (runtime_dir / "telegram-web" / "profile-v3").is_dir()
    assert not (data_root / "SteamGram").exists()
    assert stopped == [str(data_root / "SteamGram" / "telegram-web")]
    assert plugin.settings["chat_filter"] == "dms"

    # A second start finds nothing left to move and leaves Deckygram's own data alone.
    moved.clear()
    plugin._migrate_from_legacy_name()
    assert moved == []


def run_watcher_over_states(monkeypatch, settings, states):
    plugin_class = load_plugin_class(monkeypatch)
    module_globals = plugin_class._watch_notifications.__globals__
    plugin = object.__new__(plugin_class)
    plugin.settings = {**DEFAULTS, **settings}
    plugin.telegram = types.SimpleNamespace(get_state=AsyncMock(side_effect=[
        {"status": "ready", "chats": chats} for chats in states
    ]))
    emitted = []

    async def emit(*args):
        emitted.append(args)

    remaining = iter(range(len(states) - 1))

    async def sleep(_seconds):
        if next(remaining, None) is None:
            raise asyncio.CancelledError

    monkeypatch.setattr(module_globals["decky"], "emit", emit, raising=False)
    monkeypatch.setattr(module_globals["asyncio"], "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(plugin._watch_notifications())
    return emitted


def burst(count):
    return [[chat("Alex", unread)] for unread in range(count + 1)]


def test_cooldown_is_off_by_default(monkeypatch):
    emitted = run_watcher_over_states(monkeypatch, {}, burst(5))

    assert len(emitted) == 5


def test_cooldown_stops_popups_after_three_from_one_chat(monkeypatch):
    emitted = run_watcher_over_states(monkeypatch, {"notification_cooldown": True}, burst(5))

    assert len(emitted) == 3


def test_cooldown_counts_each_chat_separately(monkeypatch):
    states = [[chat("Alex", n), chat("Bo", n)] for n in range(5)]

    emitted = run_watcher_over_states(monkeypatch, {"notification_cooldown": True}, states)

    assert [event[1] for event in emitted].count("Alex") == 3
    assert [event[1] for event in emitted].count("Bo") == 3


def test_cooldown_off_notifies_every_message(monkeypatch):
    emitted = run_watcher_over_states(monkeypatch, {"notification_cooldown": False}, burst(5))

    assert len(emitted) == 5


def test_allow_notification_starts_over_once_the_window_passes_since_the_first_popup(monkeypatch):
    plugin_class = load_plugin_class(monkeypatch)
    allow = plugin_class._watch_notifications.__globals__["allow_notification"]
    sent_at = []

    assert [allow(sent_at, moment, 300, 3) for moment in (0, 10, 20, 30)] == [True, True, True, False]
    # Silenced messages do not push the end of the burst back.
    assert allow(sent_at, 299, 300, 3) is False
    # 5 minutes after the first popup, a whole new burst of three is allowed.
    assert [allow(sent_at, moment, 300, 3) for moment in (300, 301, 302, 303)] == [True, True, True, False]


def test_allow_notification_keeps_a_quiet_chat_unlimited(monkeypatch):
    plugin_class = load_plugin_class(monkeypatch)
    allow = plugin_class._watch_notifications.__globals__["allow_notification"]
    sent_at = []

    # Messages far enough apart each start a fresh burst.
    assert [allow(sent_at, moment, 300, 3) for moment in (0, 400, 800, 1200, 1600)] == [True] * 5


def test_unload_stops_telegram_first_and_never_waits_on_its_tasks(monkeypatch):
    plugin = object.__new__(load_plugin_class(monkeypatch))
    order = []
    plugin.telegram = types.SimpleNamespace(shut_down=AsyncMock(side_effect=lambda: order.append("telegram")))
    plugin.update_task = None

    async def unload_with_stuck_task():
        # A task that ignores cancellation, like one whose loop Decky's _unload cannot reach.
        never = asyncio.get_running_loop().create_future()
        stuck = asyncio.ensure_future(asyncio.shield(never))
        plugin.notification_task = stuck
        await asyncio.wait_for(plugin._unload(), timeout=1)
        order.append("cancelled" if stuck.cancelled() or stuck.cancelling() else "running")

    asyncio.run(unload_with_stuck_task())

    assert order == ["telegram", "cancelled"]
