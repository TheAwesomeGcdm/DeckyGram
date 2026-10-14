import zipfile
import ssl
import socket
import asyncio
import json
import signal
import urllib.error
from unittest.mock import AsyncMock, MagicMock

import pytest

import telegram_web_bridge
from telegram_web_bridge import (
    TelegramWebBridge,
    discover_wayland_environment,
    parse_sha256_manifest,
    prepare_electron_environment,
    read_startup_log,
    safe_extract_zip,
)


def test_parse_sha256_manifest_matches_exact_archive_name():
    digest = "a" * 64
    manifest = f"{digest}  another.zip\n{digest} *electron.zip\n"

    assert parse_sha256_manifest(manifest, "electron.zip") == digest


def test_parse_sha256_manifest_rejects_missing_or_invalid_digest():
    with pytest.raises(RuntimeError, match="missing or invalid"):
        parse_sha256_manifest("not-a-digest  electron.zip\n", "electron.zip")


def test_safe_extract_zip_extracts_expected_files(tmp_path):
    archive_path = tmp_path / "electron.zip"
    destination = tmp_path / "extracted"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("electron", "binary")

    safe_extract_zip(str(archive_path), str(destination))

    assert (destination / "electron").read_text() == "binary"


def test_safe_extract_zip_rejects_path_traversal(tmp_path):
    archive_path = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("../outside", "unsafe")

    with pytest.raises(RuntimeError, match="unsafe path"):
        safe_extract_zip(str(archive_path), str(tmp_path / "extracted"))


def test_safe_extract_zip_rejects_symbolic_links(tmp_path):
    archive_path = tmp_path / "symlink.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        info = zipfile.ZipInfo("link")
        info.external_attr = (0o120777 << 16)
        archive.writestr(info, "../outside")

    with pytest.raises(RuntimeError, match="symbolic link"):
        safe_extract_zip(str(archive_path), str(tmp_path / "extracted"))


def test_download_retries_with_fallback_ca_context(tmp_path, monkeypatch):
    contexts = [ssl.create_default_context(), ssl.create_default_context()]
    monkeypatch.setattr(telegram_web_bridge, "_ssl_contexts", lambda: contexts)
    response = MagicMock()
    response.__enter__.return_value.read.side_effect = [b"verified payload", b""]
    calls = 0

    def fake_urlopen(_request, timeout, context):
        nonlocal calls
        calls += 1
        assert timeout == 60
        if calls == 1:
            raise urllib.error.URLError(ssl.SSLCertVerificationError("missing local issuer"))
        assert context is contexts[1]
        return response

    monkeypatch.setattr(telegram_web_bridge.urllib.request, "urlopen", fake_urlopen)
    target = tmp_path / "electron.zip"

    telegram_web_bridge._download("https://example.test/electron.zip", str(target), 1024)

    assert calls == 2
    assert target.read_bytes() == b"verified payload"


def test_download_surfaces_tls_failure_after_all_trust_stores_fail(tmp_path, monkeypatch):
    monkeypatch.setattr(
        telegram_web_bridge,
        "_ssl_contexts",
        lambda: [ssl.create_default_context(), ssl.create_default_context()],
    )
    monkeypatch.setattr(
        telegram_web_bridge.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            urllib.error.URLError(ssl.SSLCertVerificationError("missing local issuer"))
        ),
    )

    with pytest.raises(RuntimeError, match="Update SteamOS's CA certificates"):
        telegram_web_bridge._download("https://example.test/electron.zip", str(tmp_path / "file"), 1024)


def test_read_startup_log_returns_only_the_tail(tmp_path):
    log_path = tmp_path / "electron.log"
    log_path.write_text("first line\nlast line\n", encoding="utf-8")

    assert read_startup_log(str(log_path), max_bytes=10) == "last line"


def test_read_startup_log_reports_missing_file(tmp_path):
    assert read_startup_log(str(tmp_path / "missing.log")) == "Electron did not create a startup log."


def test_bridge_uses_separate_profile_without_replacing_existing_profile(tmp_path):
    existing_profile = tmp_path / "telegram-web" / "profile-v2"
    existing_profile.mkdir(parents=True)
    (existing_profile / "session-marker").write_text("preserve", encoding="utf-8")

    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())

    assert bridge.profile_dir == str(tmp_path / "telegram-web" / "profile-v3")
    assert (existing_profile / "session-marker").read_text(encoding="utf-8") == "preserve"


def test_profile_lock_prevents_two_bridge_instances_sharing_profile(tmp_path):
    first = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    second = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())

    first._acquire_profile_lock()
    try:
        with pytest.raises(RuntimeError, match="Another Deckygram Telegram Web process"):
            second._acquire_profile_lock()
    finally:
        first._release_profile_lock()

    second._acquire_profile_lock()
    second._release_profile_lock()


def test_find_stale_electron_process_groups_matches_only_deckygram_electron(tmp_path, monkeypatch):
    browser_dir = tmp_path / "telegram-web"
    electron = browser_dir / "electron-v44.7.0-linux-x64" / "electron"
    proc_dir = tmp_path / "proc"
    processes = {
        "101": (f"{electron}\0--ozone-platform=wayland\0/plugin/bin\0", 101),
        "102": (f"{electron}\0--type=renderer\0", 101),
        "201": ("/usr/bin/electron\0/some/other/app\0", 201),
        "301": (f"{electron}\0--type=zygote\0", 300),
    }
    for pid, (cmdline, _) in processes.items():
        (proc_dir / pid).mkdir(parents=True)
        (proc_dir / pid / "cmdline").write_bytes(cmdline.encode())
    (proc_dir / "self").mkdir()
    groups = {int(pid): group for pid, (_, group) in processes.items()}
    monkeypatch.setattr(telegram_web_bridge.os, "getpgid", lambda pid: 300 if pid == 0 else groups[pid])

    assert telegram_web_bridge.find_stale_electron_process_groups(str(browser_dir), str(proc_dir)) == {101}


def test_start_stops_stale_electron_and_passes_profile_lock_to_child(tmp_path, monkeypatch):
    plugin_dir = tmp_path / "plugin"
    app_dir = plugin_dir / "bin" / "deckygram-telegram-web"
    app_dir.mkdir(parents=True)
    (app_dir / "main.cjs").write_text("", encoding="utf-8")
    bridge = TelegramWebBridge(str(plugin_dir), str(tmp_path / "runtime"), MagicMock())
    stale_cleanups = []
    monkeypatch.setattr(
        telegram_web_bridge,
        "stop_stale_electron_processes",
        lambda browser_dir: stale_cleanups.append(browser_dir) or 1,
    )
    monkeypatch.setattr(telegram_web_bridge, "discover_wayland_environment", lambda env: dict(env, WAYLAND_DISPLAY="wayland-0"))
    monkeypatch.setattr(telegram_web_bridge, "install_electron", lambda browser_dir: "/electron")
    launch = AsyncMock(return_value=MagicMock(returncode=None))
    monkeypatch.setattr(telegram_web_bridge.asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(bridge, "_wait_for_bridge", AsyncMock())

    asyncio.run(bridge.start())
    try:
        assert stale_cleanups == [bridge.browser_dir]
        assert launch.await_args.kwargs["pass_fds"] == (bridge.profile_lock_file.fileno(),)
    finally:
        bridge._release_profile_lock()


def record_signals(monkeypatch, running_groups=()):
    """Records kill/killpg calls; signal 0 reports a group as gone unless it is listed as still running."""
    signals = []

    def kill(pid, received_signal):
        signals.append(("kill", pid, received_signal))

    def killpg(group, received_signal):
        if received_signal == 0:
            if group not in running_groups:
                raise ProcessLookupError
            return
        signals.append(("killpg", group, received_signal))

    monkeypatch.setattr(telegram_web_bridge.os, "kill", kill)
    monkeypatch.setattr(telegram_web_bridge.os, "killpg", killpg)
    return signals


def test_terminate_process_group_asks_electron_to_quit_before_killing_leftovers(monkeypatch):
    process = MagicMock()
    process.pid = 1234
    process.wait = AsyncMock(return_value=0)
    signals = record_signals(monkeypatch)

    asyncio.run(telegram_web_bridge.terminate_process_group(process))

    # SIGTERM goes to the main process only, so Chromium can stop its storage process itself.
    assert signals == [("kill", 1234, signal.SIGTERM), ("killpg", 1234, signal.SIGKILL)]


def test_stop_stale_electron_processes_signals_main_process_then_kills_stuck_groups(monkeypatch):
    monkeypatch.setattr(telegram_web_bridge, "find_stale_electron_process_groups", lambda browser_dir: {101, 202})
    monkeypatch.setattr(telegram_web_bridge, "ELECTRON_STOP_TIMEOUT_SECONDS", 0.2)
    signals = record_signals(monkeypatch, running_groups={202})

    assert telegram_web_bridge.stop_stale_electron_processes("/runtime") == 2

    assert sorted(signals) == [
        ("kill", 101, signal.SIGTERM),
        ("kill", 202, signal.SIGTERM),
        ("killpg", 202, signal.SIGKILL),
    ]


def test_discover_wayland_environment_from_user_runtime_socket(tmp_path):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    display_socket = runtime_dir / "wayland-0"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(display_socket))
    try:
        resolved = discover_wayland_environment({"XDG_RUNTIME_DIR": str(runtime_dir)}, uid=1234)
    finally:
        listener.close()

    assert resolved is not None
    assert resolved["XDG_RUNTIME_DIR"] == str(runtime_dir)
    assert resolved["WAYLAND_DISPLAY"] == "wayland-0"
    assert resolved["XDG_SESSION_TYPE"] == "wayland"


def test_discover_wayland_environment_uses_configured_runtime_directory(tmp_path):
    display_socket = tmp_path / "steam-wayland"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(display_socket))
    try:
        resolved = discover_wayland_environment(
            {
                "XDG_RUNTIME_DIR": str(tmp_path),
                "WAYLAND_DISPLAY": "steam-wayland",
            }
        )
    finally:
        listener.close()

    assert resolved is not None
    assert resolved["WAYLAND_DISPLAY"] == "steam-wayland"
    assert resolved["XDG_RUNTIME_DIR"] == str(tmp_path)


def test_discover_wayland_environment_returns_none_without_socket(tmp_path):
    assert discover_wayland_environment({"XDG_RUNTIME_DIR": str(tmp_path)}) is None


def test_prepare_electron_environment_removes_temporary_python_library_path():
    environment = {
        "LD_LIBRARY_PATH": "/tmp/_MEI12345:/usr/lib:/opt/runtime/lib",
        "PATH": "/usr/bin",
    }

    resolved, changed = prepare_electron_environment(environment)

    assert changed
    assert resolved["LD_LIBRARY_PATH"] == "/usr/lib:/opt/runtime/lib"
    assert environment["LD_LIBRARY_PATH"] == "/tmp/_MEI12345:/usr/lib:/opt/runtime/lib"
    assert resolved["PATH"] == "/usr/bin"


def test_prepare_electron_environment_removes_empty_bundle_only_library_path():
    resolved, changed = prepare_electron_environment({"LD_LIBRARY_PATH": "/tmp/_MEI12345"})

    assert changed
    assert "LD_LIBRARY_PATH" not in resolved


def test_prepare_electron_environment_preserves_normal_library_path():
    environment = {"LD_LIBRARY_PATH": "/usr/lib:/opt/runtime/lib"}

    resolved, changed = prepare_electron_environment(environment)

    assert not changed
    assert resolved == environment


def test_bridge_request_passes_timeout_as_keyword_not_http_body(monkeypatch, tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge.port = 43210
    bridge.token = "test-token"
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = json.dumps({"status": "login"}).encode()
    calls = {}

    def fake_urlopen(request, *args, **kwargs):
        calls["args"] = args
        calls["kwargs"] = kwargs
        calls["data"] = request.data
        return response

    monkeypatch.setattr(telegram_web_bridge.urllib.request, "urlopen", fake_urlopen)

    result = asyncio.run(bridge._request("GET", "/state", timeout=2))

    assert result == {"status": "login"}
    assert calls["args"] == ()
    assert calls["kwargs"] == {"timeout": 2}
    assert calls["data"] is None


def test_submit_cloud_password_forwards_password_to_local_bridge(tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge._request = AsyncMock(return_value={"ok": True})

    result = asyncio.run(bridge.submit_cloud_password("cloud-secret"))

    assert result == {"ok": True}
    bridge._request.assert_awaited_once_with(
        "POST",
        "/submit-password",
        {"password": "cloud-secret"},
    )


def test_get_messages_returns_extraction_diagnostics_for_selected_chat(tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge._request = AsyncMock(return_value={
        "selected_chat_id": 4,
        "messages": [{"id": 1, "text": "Hello"}],
        "message_count": 1,
        "message_root_found": True,
        "message_root": "div.MessageList",
        "identified_message_count": 1,
        "message_candidate_count": 1,
        "visible_message_candidate_count": 1,
        "message_class_count": 1,
        "message_id_attribute_count": 1,
        "dom_region_diagnostics": [],
        "selected_chat_title": "Example chat",
        "typing_text": "typing",
    })

    result = asyncio.run(bridge.get_messages(4))

    assert result == {
        "messages": [{"id": 1, "text": "Hello"}],
        "message_count": 1,
        "message_root_found": True,
        "message_root": "div.MessageList",
        "identified_message_count": 1,
        "message_candidate_count": 1,
        "visible_message_candidate_count": 1,
        "message_class_count": 1,
        "message_id_attribute_count": 1,
        "dom_region_diagnostics": [],
        "selected_chat_title": "Example chat",
        "typing_text": "typing",
    }
    bridge._request.assert_awaited_once_with("GET", "/state")


def test_get_messages_rejects_response_for_a_different_selected_chat(tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge._request = AsyncMock(return_value={"selected_chat_id": 3})

    with pytest.raises(RuntimeError, match="selected Telegram chat changed"):
        asyncio.run(bridge.get_messages(4))


def test_logout_deletes_every_profile_and_restarts(tmp_path, monkeypatch):
    bridge = TelegramWebBridge(str(tmp_path / "plugin"), str(tmp_path / "runtime"), MagicMock())
    browser_dir = tmp_path / "runtime" / "telegram-web"
    for name in ("profile", "profile-v2", "profile-v3", "electron-v44.7.0-linux-x64"):
        (browser_dir / name).mkdir(parents=True)
        (browser_dir / name / "marker").write_text("data", encoding="utf-8")
    monkeypatch.setattr(telegram_web_bridge, "stop_stale_electron_processes", lambda browser_dir: 0)
    bridge.stop = AsyncMock()
    bridge.start = AsyncMock()

    asyncio.run(bridge.logout())

    assert sorted(path.name for path in browser_dir.iterdir()) == ["electron-v44.7.0-linux-x64"]
    bridge.stop.assert_awaited_once()
    bridge.start.assert_awaited_once()
    assert bridge.state["status"] == "starting"


def test_close_chat_clears_selected_chat(tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge.state["selected_chat_id"] = 4
    bridge._request = AsyncMock(return_value={"ok": True})

    assert asyncio.run(bridge.close_chat()) == {"ok": True}

    bridge._request.assert_awaited_once_with("POST", "/close-chat", {})
    assert bridge.state["selected_chat_id"] is None


def test_get_message_image_requests_image_for_selected_chat(tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge.state["selected_chat_id"] = 2
    bridge._request = AsyncMock(return_value={"found": True, "data_url": "data:image/webp;base64,AA"})

    result = asyncio.run(bridge.get_message_image(2, 77))

    assert result["data_url"].startswith("data:image/webp")
    bridge._request.assert_awaited_once_with("POST", "/message-image", {"message_id": 77})


def test_get_message_image_rejects_a_different_chat(tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge.state["selected_chat_id"] = 2
    bridge._request = AsyncMock()

    with pytest.raises(RuntimeError, match="selected Telegram chat changed"):
        asyncio.run(bridge.get_message_image(3, 77))
    bridge._request.assert_not_awaited()


def test_save_message_image_writes_to_downloads_without_overwriting(tmp_path, monkeypatch):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge.state["selected_chat_id"] = 1
    payload = b"\xff\xd8\xff fake jpeg"
    data_url = "data:image/jpeg;base64," + __import__("base64").b64encode(payload).decode()
    bridge._request = AsyncMock(return_value={"found": True, "data_url": data_url, "mime": "image/jpeg"})
    downloads = tmp_path / "Downloads"
    monkeypatch.setattr(telegram_web_bridge, "downloads_dir", lambda: str(downloads))

    first = asyncio.run(bridge.save_message_image(1, 42))
    second = asyncio.run(bridge.save_message_image(1, 42))

    assert first["name"] == "telegram-42.jpg"
    assert first["path"] == str(downloads / "Telegram" / "telegram-42.jpg")
    assert second["name"] == "telegram-42 (2).jpg"
    assert (downloads / "Telegram" / "telegram-42.jpg").read_bytes() == payload
    assert not list((downloads / "Telegram").glob("*.part"))
    bridge._request.assert_awaited_with("POST", "/message-image-file", {"message_id": 42}, timeout=30)


def test_save_message_image_reports_unloaded_or_bad_images(tmp_path, monkeypatch):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge.state["selected_chat_id"] = 1
    monkeypatch.setattr(telegram_web_bridge, "downloads_dir", lambda: str(tmp_path / "Downloads"))

    bridge._request = AsyncMock(return_value={"found": True, "data_url": None})
    with pytest.raises(RuntimeError, match="not loaded"):
        asyncio.run(bridge.save_message_image(1, 7))

    bridge._request = AsyncMock(return_value={"found": True, "data_url": "data:text/html;base64,PGI+"})
    with pytest.raises(RuntimeError, match="unsupported"):
        asyncio.run(bridge.save_message_image(1, 7))
    assert not (tmp_path / "Downloads").exists()


def test_downloads_dir_uses_xdg_and_falls_back_to_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(telegram_web_bridge.subprocess, "run",
                        lambda *args, **kwargs: MagicMock(returncode=0, stdout="/media/Descargas\n"))
    assert telegram_web_bridge.downloads_dir() == "/media/Descargas"

    def missing(*args, **kwargs):
        raise FileNotFoundError("xdg-user-dir")

    monkeypatch.setattr(telegram_web_bridge.subprocess, "run", missing)
    assert telegram_web_bridge.downloads_dir() == str(tmp_path / "Downloads")


def bridge_with_selected_chat(tmp_path, chat_id=4, result=None):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge._request = AsyncMock(side_effect=[{"selected_chat_id": chat_id}, result or {"ok": True}])
    return bridge


def test_send_message_passes_the_reply_target(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path)

    asyncio.run(bridge.send_message(4, " hi ", reply_to=17))

    bridge._request.assert_awaited_with("POST", "/send-message", {"text": "hi", "reply_to": 17}, timeout=20)


def test_send_message_without_reply_sends_text_only(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path)

    asyncio.run(bridge.send_message(4, "hi"))

    bridge._request.assert_awaited_with("POST", "/send-message", {"text": "hi"}, timeout=20)


@pytest.mark.parametrize("call, payload", [
    (lambda bridge: bridge.edit_message(4, 9, " fixed "), {"action": "edit", "message_id": 9, "text": "fixed"}),
    (lambda bridge: bridge.delete_message(4, 9, False), {"action": "delete", "message_id": 9, "for_everyone": False}),
    (lambda bridge: bridge.reaction_options(4, 9), {"action": "reaction-options", "message_id": 9}),
    (lambda bridge: bridge.react(4, 9, 2), {"action": "react", "message_id": 9, "index": 2}),
])
def test_message_actions_go_to_the_bridge(tmp_path, call, payload):
    bridge = bridge_with_selected_chat(tmp_path)

    asyncio.run(call(bridge))

    bridge._request.assert_awaited_with("POST", "/message-action", payload, timeout=30)


def test_message_actions_refuse_a_different_selected_chat(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path, chat_id=3)

    with pytest.raises(RuntimeError, match="selected Telegram chat changed"):
        asyncio.run(bridge.delete_message(4, 9, True))
    assert bridge._request.await_count == 1


def test_edit_refuses_empty_text(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path)

    with pytest.raises(ValueError, match="empty"):
        asyncio.run(bridge.edit_message(4, 9, "  "))


def test_list_stickers_checks_the_chat_first(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path, result={"stickers": []})

    assert asyncio.run(bridge.list_stickers(4)) == {"stickers": []}
    bridge._request.assert_awaited_with("POST", "/stickers", {}, timeout=60)


def test_send_sticker_passes_the_sticker_id(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path)

    asyncio.run(bridge.send_sticker(4, "5170233102089322756"))

    bridge._request.assert_awaited_with("POST", "/send-sticker", {"sticker_id": "5170233102089322756"}, timeout=40)


def test_stickers_refuse_a_different_selected_chat(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path, chat_id=3)

    with pytest.raises(RuntimeError, match="selected Telegram chat changed"):
        asyncio.run(bridge.send_sticker(4, "1"))


@pytest.mark.parametrize("pinned, action", [(True, "pin"), (False, "unpin")])
def test_set_chat_pinned_names_the_chat(tmp_path, pinned, action):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge._request = AsyncMock(return_value={"ok": True})

    asyncio.run(bridge.set_chat_pinned(3, "Alex", pinned))

    bridge._request.assert_awaited_once_with("POST", "/chat-action", {"chat_id": 3, "title": "Alex", "action": action}, timeout=20)


def test_load_message_video_checks_the_chat_and_waits_for_the_download(tmp_path):
    bridge = bridge_with_selected_chat(tmp_path, result={"id": "abc", "size": 10, "mime": "video/mp4"})

    assert asyncio.run(bridge.load_message_video(4, 9))["id"] == "abc"
    bridge._request.assert_awaited_with("POST", "/message-video", {"message_id": 9}, timeout=120)


def test_video_chunks_and_release_name_the_video(tmp_path):
    bridge = TelegramWebBridge(str(tmp_path), str(tmp_path), MagicMock())
    bridge._request = AsyncMock(return_value={"data": "", "done": True})

    asyncio.run(bridge.message_video_chunk("abc", 2))
    bridge._request.assert_awaited_with("POST", "/message-video-chunk", {"id": "abc", "index": 2}, timeout=30)
    asyncio.run(bridge.release_message_video("abc"))
    bridge._request.assert_awaited_with("POST", "/message-video-release", {"id": "abc"})


def test_process_running_treats_exited_children_as_stopped(tmp_path):
    for pid, state in (("10", "S"), ("11", "Z")):
        (tmp_path / pid).mkdir()
        (tmp_path / pid / "stat").write_text(f"{pid} (electron (main)) {state} 1 1 1")

    assert telegram_web_bridge._process_running(10, str(tmp_path)) is True
    assert telegram_web_bridge._process_running(11, str(tmp_path)) is False
    assert telegram_web_bridge._process_running(12, str(tmp_path)) is False


def test_shut_down_asks_electron_to_quit_and_releases_the_profile(tmp_path, monkeypatch):
    bridge = TelegramWebBridge(str(tmp_path / "plugin"), str(tmp_path / "runtime"), MagicMock())
    bridge._acquire_profile_lock()
    process = MagicMock()
    process.pid = 4321
    process.wait = AsyncMock(side_effect=AssertionError("must not await the process"))
    bridge.process = process
    exits = iter([True, True, False])
    monkeypatch.setattr(telegram_web_bridge, "_process_running", lambda pid: next(exits))
    signals = record_signals(monkeypatch)

    asyncio.run(bridge.shut_down())

    assert signals == [("kill", 4321, signal.SIGTERM)]
    assert bridge.process is None and bridge.profile_lock_file is None


def test_shut_down_gives_up_waiting_before_deckys_deadline(tmp_path, monkeypatch):
    bridge = TelegramWebBridge(str(tmp_path / "plugin"), str(tmp_path / "runtime"), MagicMock())
    process = MagicMock()
    process.pid = 4321
    bridge.process = process
    monkeypatch.setattr(telegram_web_bridge, "UNLOAD_STOP_SECONDS", 0.3)
    monkeypatch.setattr(telegram_web_bridge, "_process_running", lambda pid: True)
    signals = record_signals(monkeypatch)

    asyncio.run(asyncio.wait_for(bridge.shut_down(), timeout=2))

    # Still quitting: it is left to finish rather than killed mid-write.
    assert signals == [("kill", 4321, signal.SIGTERM)]


def bridge_ready_to_launch(tmp_path, monkeypatch, displays):
    """A bridge whose display discovery returns each of `displays` in turn and whose launch is recorded."""
    plugin_dir = tmp_path / "plugin"
    app_dir = plugin_dir / "bin" / "deckygram-telegram-web"
    app_dir.mkdir(parents=True)
    (app_dir / "main.cjs").write_text("", encoding="utf-8")
    bridge = TelegramWebBridge(str(plugin_dir), str(tmp_path / "runtime"), MagicMock())
    found = iter(displays)
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(telegram_web_bridge, "discover_wayland_environment", lambda env: next(found, displays[-1]))
    monkeypatch.setattr(telegram_web_bridge, "DISPLAY_POLL_SECONDS", 0)
    monkeypatch.setattr(telegram_web_bridge, "stop_stale_electron_processes", lambda browser_dir: 0)
    monkeypatch.setattr(telegram_web_bridge, "install_electron", lambda browser_dir: "/electron")
    launch = AsyncMock(return_value=MagicMock(returncode=None))
    monkeypatch.setattr(telegram_web_bridge.asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(bridge, "_wait_for_bridge", AsyncMock())
    return bridge, launch


def test_start_waits_for_steams_display_socket_at_boot(tmp_path, monkeypatch):
    wayland = {"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": "/run/user/1000"}
    bridge, launch = bridge_ready_to_launch(tmp_path, monkeypatch, [None, None, None, wayland])

    asyncio.run(bridge.start())
    try:
        assert launch.await_count == 1
        assert bridge.state["status"] != "error"
    finally:
        bridge._release_profile_lock()


def test_start_reports_the_missing_display_after_waiting(tmp_path, monkeypatch):
    bridge, launch = bridge_ready_to_launch(tmp_path, monkeypatch, [None])
    monkeypatch.setattr(telegram_web_bridge, "DISPLAY_WAIT_SECONDS", 0.05)

    asyncio.run(bridge.start())

    assert launch.await_count == 0
    assert bridge.state["status"] == "error"
    assert "Wayland display socket" in bridge.state["error"]


def test_a_retry_during_the_wait_does_not_launch_a_second_electron(tmp_path, monkeypatch):
    wayland = {"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": "/run/user/1000"}
    bridge, launch = bridge_ready_to_launch(tmp_path, monkeypatch, [None, None, None, None, wayland])

    async def boot_and_retry():
        await asyncio.gather(bridge.start(), bridge.start())

    asyncio.run(boot_and_retry())
    try:
        assert launch.await_count == 1
    finally:
        bridge._release_profile_lock()
