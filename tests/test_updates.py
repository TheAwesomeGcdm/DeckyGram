import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import updates  # noqa: E402
from updates import check_for_update, is_newer, parse_version, read_release  # noqa: E402


def release(tag="v0.25.0", assets=None):
    return {
        "tag_name": tag,
        "html_url": "https://github.com/TheAwesomeGcdm/DeckyGram/releases/tag/" + tag,
        "assets": assets if assets is not None else [
            {"name": "notes.txt", "browser_download_url": "https://example.invalid/notes.txt"},
            {"name": "Deckygram.zip", "browser_download_url": "https://example.invalid/Deckygram.zip", "digest": "sha256:abc123"},
        ],
    }


@pytest.mark.parametrize("text, expected", [("v0.24.2", (0, 24, 2)), ("1.0", (1, 0)), (" 2.3.4 ", (2, 3, 4)), ("v1.0-beta", None), ("", None)])
def test_parse_version(text, expected):
    assert parse_version(text) == expected


@pytest.mark.parametrize("latest, current, newer", [
    ("0.25.0", "0.24.2", True),
    ("0.24.10", "0.24.9", True),
    ("0.24.2", "0.24.2", False),
    ("0.24", "0.24.0", False),
    ("0.24.1", "0.24.2", False),
    ("v1.0.0", "0.24.2", True),
    ("garbage", "0.24.2", False),
])
def test_is_newer_compares_numbers_not_text(latest, current, newer):
    assert is_newer(latest, current) is newer


def test_read_release_picks_the_plugin_zip_and_its_hash():
    assert read_release(release()) == {
        "version": "0.25.0",
        "download_url": "https://example.invalid/Deckygram.zip",
        "sha256": "abc123",
        "release_url": "https://github.com/TheAwesomeGcdm/DeckyGram/releases/tag/v0.25.0",
    }


def test_read_release_without_the_zip_is_an_error():
    with pytest.raises(ValueError, match="Deckygram.zip"):
        read_release(release(assets=[]))


def test_read_release_without_a_version_tag_is_an_error():
    with pytest.raises(ValueError, match="not a version"):
        read_release(release(tag="first-release"))


def test_check_for_update_reports_a_newer_release(monkeypatch):
    monkeypatch.setattr(updates, "fetch_latest_release", lambda contexts: read_release(release("v0.25.0")))

    status = check_for_update("0.24.2", [])

    assert status["update_available"] is True
    assert status["latest"] == "0.25.0"
    assert status["download_url"].endswith("Deckygram.zip")
    assert status["error"] == ""


def test_check_for_update_when_current_is_latest(monkeypatch):
    monkeypatch.setattr(updates, "fetch_latest_release", lambda contexts: read_release(release("v0.24.2")))

    status = check_for_update("0.24.2", [])

    assert status["update_available"] is False
    assert status["latest"] == "0.24.2"


def test_check_for_update_reports_errors_instead_of_raising(monkeypatch):
    def offline(contexts):
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(updates, "fetch_latest_release", offline)

    status = check_for_update("0.24.2", [])

    assert status["update_available"] is False
    assert "network unreachable" in status["error"]


def package(files, version="0.26.0", folder="Deckygram/"):
    import io
    import json
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(folder + "package.json", json.dumps({"version": version}))
        for name, content in files.items():
            archive.writestr(folder + name, content)
    return buffer.getvalue()


def installed_plugin(tmp_path):
    plugin = tmp_path / "plugin"
    (plugin / "dist").mkdir(parents=True)
    (plugin / "package.json").write_text('{"version": "0.25.0"}')
    (plugin / "main.py").write_text("old main")
    (plugin / "plugin.json").write_text("same")
    (plugin / "dist" / "index.js").write_text("old panel")
    return plugin


def test_read_package_returns_files_inside_the_plugin_folder():
    files = updates.read_package(package({"main.py": "new", "dist/index.js": "js"}), "0.26.0")

    assert files["main.py"] == b"new"
    assert files["dist/index.js"] == b"js"


@pytest.mark.parametrize("name", ["../escape.py", "dist/../../escape.py", "dist//x.js"])
def test_read_package_refuses_paths_outside_the_plugin(name):
    with pytest.raises(ValueError):
        updates.read_package(package({name: "x"}), "0.26.0")


def test_read_package_refuses_another_top_folder_or_version():
    with pytest.raises(ValueError):
        updates.read_package(package({"main.py": "x"}, folder="Other/"), "0.26.0")
    with pytest.raises(ValueError, match="0.25.9"):
        updates.read_package(package({"main.py": "x"}, version="0.25.9"), "0.26.0")


def test_plan_install_skips_unchanged_files_and_allows_new_ones_in_writable_folders(tmp_path):
    plugin = installed_plugin(tmp_path)
    (plugin / "plugin.json").chmod(0o444)
    files = {"main.py": b"new main", "plugin.json": b"same", "dist/extra.js": b"extra"}

    changes, reason = updates.plan_install(str(plugin), files)

    assert reason == ""
    assert changes == {"main.py": b"new main", "dist/extra.js": b"extra"}


def test_plan_install_leaves_unwritable_changes_to_deckys_installer(tmp_path):
    plugin = installed_plugin(tmp_path)
    (plugin / "plugin.json").chmod(0o444)
    plugin.chmod(0o555)
    try:
        changes, reason = updates.plan_install(str(plugin), {"plugin.json": b"changed"})
        assert changes == {} and "plugin.json" in reason
        changes, reason = updates.plan_install(str(plugin), {"new_module.py": b"x"})
        assert changes == {} and "new_module.py" in reason
    finally:
        plugin.chmod(0o755)


def test_write_files_puts_everything_back_when_a_write_fails(tmp_path, monkeypatch):
    plugin = installed_plugin(tmp_path)
    real_open = open

    def failing_open(path, mode="r", *args, **kwargs):
        if str(path).endswith("index.js") and "w" in mode and failing_open.armed:
            failing_open.armed = False
            raise OSError("disk full")
        return real_open(path, mode, *args, **kwargs)

    failing_open.armed = True
    monkeypatch.setattr("builtins.open", failing_open)
    with pytest.raises(OSError):
        updates.write_files(str(plugin), {"main.py": b"new main", "dist/new.js": b"n", "dist/index.js": b"new panel"})

    assert (plugin / "main.py").read_text() == "old main"
    assert (plugin / "dist" / "index.js").read_text() == "old panel"
    assert not (plugin / "dist" / "new.js").exists()


def test_install_release_checks_the_download_and_rewrites_changed_files(tmp_path, monkeypatch):
    import hashlib

    plugin = installed_plugin(tmp_path)
    data = package({"main.py": "new main", "plugin.json": "same", "dist/index.js": "new panel"})
    monkeypatch.setattr(updates, "download_release", lambda url, sha256, contexts: data if sha256 == hashlib.sha256(data).hexdigest() else None)
    status = {"update_available": True, "latest": "0.26.0", "download_url": "https://example.invalid/Deckygram.zip", "sha256": hashlib.sha256(data).hexdigest()}

    result = updates.install_release(str(plugin), status, [])

    assert result == {"installed": True, "version": "0.26.0", "changed": ["dist/index.js", "main.py", "package.json"]}
    assert (plugin / "main.py").read_text() == "new main"


def test_install_release_without_a_checksum_is_left_to_deckys_installer(tmp_path):
    status = {"update_available": True, "latest": "0.26.0", "download_url": "https://example.invalid/Deckygram.zip", "sha256": ""}

    assert updates.install_release(str(tmp_path), status, [])["installed"] is False


def test_download_release_rejects_a_checksum_mismatch(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, size):
            return b"zip bytes"

    monkeypatch.setattr(updates.urllib.request, "urlopen", lambda request, timeout, context: Response())

    with pytest.raises(ValueError, match="checksum"):
        updates.download_release("https://example.invalid/Deckygram.zip", "00" * 32, [None])
