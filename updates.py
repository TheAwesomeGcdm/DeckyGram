import json
import re
import ssl
import time
import urllib.error
import urllib.request
from typing import Any

# Updates come from the latest published GitHub release (drafts and pre-releases are skipped by GitHub).
RELEASE_REPO = "TheAwesomeGcdm/DeckyGram"
RELEASE_ASSET = "Deckygram.zip"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{RELEASE_REPO}/releases/latest"


def parse_version(text: str) -> tuple[int, ...] | None:
    """'v0.24.2' or '0.24.2' -> (0, 24, 2); None when it is not a plain dotted version."""
    match = re.fullmatch(r"v?(\d+(?:\.\d+)*)", (text or "").strip())
    return tuple(int(part) for part in match.group(1).split(".")) if match else None


def is_newer(latest: str, current: str) -> bool:
    latest_version, current_version = parse_version(latest), parse_version(current)
    if latest_version is None or current_version is None:
        return False
    width = max(len(latest_version), len(current_version))
    return latest_version + (0,) * (width - len(latest_version)) > current_version + (0,) * (width - len(current_version))


def read_release(release: dict[str, Any]) -> dict[str, Any]:
    """The parts of a GitHub release Deckygram needs: its version, the plugin ZIP and that file's SHA-256."""
    tag = str(release.get("tag_name") or "")
    if parse_version(tag) is None:
        raise ValueError(f"The latest release tag {tag!r} is not a version number")
    asset = next((item for item in release.get("assets") or [] if item.get("name") == RELEASE_ASSET), None)
    if not asset or not asset.get("browser_download_url"):
        raise ValueError(f"The latest release has no {RELEASE_ASSET} attached")
    digest = str(asset.get("digest") or "")
    return {
        "version": tag.lstrip("v"),
        "download_url": asset["browser_download_url"],
        # GitHub reports "sha256:<hex>"; Decky checks the download against it before installing.
        "sha256": digest.split(":", 1)[1] if digest.startswith("sha256:") else "",
        "release_url": str(release.get("html_url") or ""),
    }


def fetch_latest_release(contexts: list[ssl.SSLContext]) -> dict[str, Any]:
    request = urllib.request.Request(
        LATEST_RELEASE_URL,
        headers={"User-Agent": "Deckygram", "Accept": "application/vnd.github+json"},
    )
    last_certificate_error: urllib.error.URLError | None = None
    for context in contexts:
        try:
            with urllib.request.urlopen(request, timeout=20, context=context) as response:
                return read_release(json.loads(response.read(1024 * 1024).decode("utf-8")))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise ValueError("No release has been published yet") from error
            raise
        except urllib.error.URLError as error:
            if not isinstance(error.reason, ssl.SSLCertVerificationError):
                raise
            last_certificate_error = error
    raise RuntimeError("Unable to verify GitHub's certificate") from last_certificate_error


def check_for_update(current_version: str, contexts: list[ssl.SSLContext]) -> dict[str, Any]:
    status: dict[str, Any] = {
        "current": current_version,
        "latest": "",
        "update_available": False,
        "download_url": "",
        "sha256": "",
        "release_url": "",
        "checked_at": int(time.time()),
        "error": "",
    }
    try:
        release = fetch_latest_release(contexts)
    except (OSError, ValueError, RuntimeError) as error:
        status["error"] = str(error)
        return status
    status.update(
        latest=release["version"],
        update_available=is_newer(release["version"], current_version),
        download_url=release["download_url"],
        sha256=release["sha256"],
        release_url=release["release_url"],
    )
    return status
