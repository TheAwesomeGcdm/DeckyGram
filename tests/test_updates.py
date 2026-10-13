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
