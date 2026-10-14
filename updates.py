import hashlib
import io
import json
import os
import re
import ssl
import stat
import time
import zipfile
import urllib.error
import urllib.request
from typing import Any

# Updates come from the latest published GitHub release (drafts and pre-releases are skipped by GitHub).
RELEASE_REPO = "TheAwesomeGcdm/DeckyGram"
RELEASE_ASSET = "Deckygram.zip"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{RELEASE_REPO}/releases/latest"
# Every file in the release ZIP sits under this folder, as Decky's installer expects.
PACKAGE_FOLDER = "Deckygram/"
MAX_PACKAGE_BYTES = 50 * 1024 * 1024


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


def download_release(url: str, sha256: str, contexts: list[ssl.SSLContext]) -> bytes:
    """The release ZIP, checked against the SHA-256 GitHub reported for it."""
    request = urllib.request.Request(url, headers={"User-Agent": "Deckygram"})
    last_certificate_error: urllib.error.URLError | None = None
    for context in contexts:
        try:
            with urllib.request.urlopen(request, timeout=60, context=context) as response:
                data = response.read(MAX_PACKAGE_BYTES + 1)
            break
        except urllib.error.URLError as error:
            if not isinstance(error.reason, ssl.SSLCertVerificationError):
                raise
            last_certificate_error = error
    else:
        raise RuntimeError("Unable to verify GitHub's certificate") from last_certificate_error
    if len(data) > MAX_PACKAGE_BYTES:
        raise ValueError("The update is larger than expected")
    if hashlib.sha256(data).hexdigest() != sha256.lower():
        raise ValueError("The downloaded update does not match its published checksum")
    return data


def read_package(data: bytes, version: str) -> dict[str, bytes]:
    """The ZIP's files by path inside the plugin folder; refuses anything that could land outside it."""
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            if not entry.filename.startswith(PACKAGE_FOLDER):
                raise ValueError(f"Unexpected file in the update: {entry.filename}")
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError(f"The update contains a link: {entry.filename}")
            relative = entry.filename[len(PACKAGE_FOLDER):]
            if entry.is_dir() or not relative:
                continue
            parts = relative.split("/")
            if relative.startswith("/") or "\\" in relative or any(part in ("", ".", "..") for part in parts):
                raise ValueError(f"Unsafe path in the update: {entry.filename}")
            files[relative] = archive.read(entry)
    try:
        package_version = json.loads(files["package.json"].decode("utf-8")).get("version")
    except (KeyError, ValueError) as error:
        raise ValueError("The update has no readable package.json") from error
    if package_version != version:
        raise ValueError(f"The update's package.json says {package_version}, not {version}")
    return files


def _read_existing(path: str) -> bytes | None:
    try:
        with open(path, "rb") as existing:
            return existing.read()
    except FileNotFoundError:
        return None


def _can_create(path: str, plugin_dir: str) -> bool:
    """A missing file can be created when its nearest existing folder inside the plugin is writable."""
    folder = os.path.dirname(path)
    while not os.path.isdir(folder):
        if folder == plugin_dir or not folder.startswith(plugin_dir + os.sep):
            return False
        folder = os.path.dirname(folder)
    return os.access(folder, os.W_OK | os.X_OK)


def plan_install(plugin_dir: str, files: dict[str, bytes]) -> tuple[dict[str, bytes], str]:
    """The files that differ from what is installed, or why they cannot be written in place.

    Decky owns the plugin folder and a few files in it, so Deckygram can rewrite its other files but not
    replace or add top-level entries; anything it cannot write goes back to Decky's installer.
    """
    plugin_dir = os.path.realpath(plugin_dir)
    changes: dict[str, bytes] = {}
    for relative, content in files.items():
        target = os.path.join(plugin_dir, *relative.split("/"))
        if os.path.islink(target) or not os.path.realpath(target).startswith(plugin_dir + os.sep):
            return {}, f"{relative} is not a plain file in the plugin folder"
        existing = _read_existing(target)
        if existing == content:
            continue
        writable = os.access(target, os.W_OK) if existing is not None else _can_create(target, plugin_dir)
        if not writable:
            return {}, f"{relative} cannot be written by Deckygram"
        changes[relative] = content
    return changes, ""


def write_files(plugin_dir: str, changes: dict[str, bytes]) -> None:
    """Rewrites each file in place, keeping its owner; on any failure every file is put back as it was."""
    plugin_dir = os.path.realpath(plugin_dir)
    previous: dict[str, bytes | None] = {}
    created_folders: list[str] = []
    try:
        for relative, content in changes.items():
            target = os.path.join(plugin_dir, *relative.split("/"))
            previous[target] = _read_existing(target)
            folder = os.path.dirname(target)
            missing = []
            while not os.path.isdir(folder):
                missing.append(folder)
                folder = os.path.dirname(folder)
            for folder in reversed(missing):
                os.mkdir(folder, 0o755)
                created_folders.append(folder)
            with open(target, "wb") as output:
                output.write(content)
    except OSError:
        for target, content in previous.items():
            try:
                if content is None:
                    os.remove(target)
                else:
                    with open(target, "wb") as output:
                        output.write(content)
            except OSError:
                pass
        for folder in reversed(created_folders):
            try:
                os.rmdir(folder)
            except OSError:
                pass
        raise


def install_release(plugin_dir: str, status: dict[str, Any], contexts: list[ssl.SSLContext]) -> dict[str, Any]:
    """Installs the release Deckygram found by rewriting its own files, without Decky's installer.

    Returns installed=False with a reason when it has to be left to Decky's installer instead.
    """
    if not status.get("update_available") or not status.get("download_url"):
        raise ValueError("No update is available")
    if not status.get("sha256"):
        return {"installed": False, "reason": "The release has no published checksum"}
    data = download_release(status["download_url"], status["sha256"], contexts)
    files = read_package(data, status["latest"])
    changes, reason = plan_install(plugin_dir, files)
    if reason:
        return {"installed": False, "reason": reason}
    write_files(plugin_dir, changes)
    return {"installed": True, "version": status["latest"], "changed": sorted(changes)}
