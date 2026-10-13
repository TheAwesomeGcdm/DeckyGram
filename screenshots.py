import base64
import glob
import os
from typing import Any

IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
# Telegram compresses photos itself; this only keeps an oversized file from being pushed through the bridge.
MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024
# Steam writes a small copy of each screenshot here, which keeps the picker light.
THUMBNAIL_DIR = "thumbnails"
MAX_THUMBNAIL_FALLBACK_BYTES = 512 * 1024


def screenshot_dirs(home: str) -> list[str]:
    """Steam keeps each game's screenshots under userdata/<account>/760/remote/<app id>/screenshots."""
    pattern = os.path.join(home, ".local", "share", "Steam", "userdata", "*", "760", "remote", "*", "screenshots")
    return [directory for directory in glob.glob(pattern) if os.path.isdir(directory)]


def image_type(path: str) -> str | None:
    return IMAGE_TYPES.get(os.path.splitext(path)[1].lower())


def data_url(path: str) -> str:
    with open(path, "rb") as image_file:
        encoded = base64.b64encode(image_file.read()).decode("ascii")
    return f"data:{image_type(path)};base64,{encoded}"


def thumbnail_data_url(path: str) -> str:
    thumbnail = os.path.join(os.path.dirname(path), THUMBNAIL_DIR, os.path.basename(path))
    try:
        if os.path.isfile(thumbnail):
            return data_url(thumbnail)
        if os.path.getsize(path) <= MAX_THUMBNAIL_FALLBACK_BYTES:
            return data_url(path)
    except OSError:
        pass
    return ""


def list_screenshots(home: str, limit: int = 48) -> list[dict[str, Any]]:
    """Newest screenshots across every game, each with a thumbnail for the picker."""
    found = []
    for directory in screenshot_dirs(home):
        app_id = os.path.basename(os.path.dirname(directory))
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        for entry in entries:
            if not image_type(entry.name):
                continue
            try:
                if entry.is_file():
                    found.append((entry.stat().st_mtime, entry.path, app_id))
            except OSError:
                continue
    found.sort(reverse=True)
    return [
        {
            "path": path,
            "name": os.path.basename(path),
            "app_id": app_id,
            "taken_at": int(taken_at),
            "thumbnail": thumbnail_data_url(path),
        }
        for taken_at, path, app_id in found[:limit]
    ]


def read_screenshot(home: str, path: str) -> tuple[bytes, str, str]:
    """Reads a screenshot to send; anything outside Steam's screenshot folders is refused."""
    if not isinstance(path, str) or not path:
        raise ValueError("No screenshot was chosen")
    real_path = os.path.realpath(path)
    allowed_dirs = {os.path.realpath(directory) for directory in screenshot_dirs(home)}
    mime = image_type(real_path)
    if os.path.dirname(real_path) not in allowed_dirs or not mime:
        raise ValueError("Only Steam screenshots can be sent")
    if not os.path.isfile(real_path):
        raise ValueError("That screenshot no longer exists")
    if os.path.getsize(real_path) > MAX_SCREENSHOT_BYTES:
        raise ValueError("That screenshot is too large to send")
    with open(real_path, "rb") as image_file:
        return image_file.read(), mime, os.path.basename(real_path)
