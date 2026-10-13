import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from screenshots import list_screenshots, read_screenshot  # noqa: E402


def make_screenshot(home, app_id, name, data=b"jpeg", mtime=0, thumbnail=b"thumb"):
    directory = home / ".local" / "share" / "Steam" / "userdata" / "123" / "760" / "remote" / app_id / "screenshots"
    (directory / "thumbnails").mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(data)
    os.utime(path, (mtime, mtime))
    if thumbnail is not None:
        (directory / "thumbnails" / name).write_bytes(thumbnail)
    return path


def test_lists_newest_screenshots_across_games_with_thumbnails(tmp_path):
    make_screenshot(tmp_path, "10", "old.jpg", mtime=100)
    make_screenshot(tmp_path, "20", "new.png", mtime=300)
    make_screenshot(tmp_path, "10", "middle.jpg", mtime=200, thumbnail=None)
    make_screenshot(tmp_path, "10", "notes.txt", mtime=400)

    shots = list_screenshots(str(tmp_path))

    assert [shot["name"] for shot in shots] == ["new.png", "middle.jpg", "old.jpg"]
    assert shots[0]["app_id"] == "20"
    assert shots[0]["thumbnail"] == "data:image/png;base64,dGh1bWI="
    # Without Steam's thumbnail a small screenshot stands in for itself.
    assert shots[1]["thumbnail"] == "data:image/jpeg;base64,anBlZw=="


def test_list_respects_limit(tmp_path):
    for index in range(5):
        make_screenshot(tmp_path, "10", f"{index}.jpg", mtime=index)

    assert [shot["name"] for shot in list_screenshots(str(tmp_path), limit=2)] == ["4.jpg", "3.jpg"]


def test_reads_a_steam_screenshot(tmp_path):
    path = make_screenshot(tmp_path, "10", "shot.jpg", data=b"picture")

    assert read_screenshot(str(tmp_path), str(path)) == (b"picture", "image/jpeg", "shot.jpg")


@pytest.mark.parametrize("make_path", [
    lambda home, shot: str(home / "secret.jpg"),
    lambda home, shot: str(shot.parent / "thumbnails" / shot.name),
    lambda home, shot: str(shot.parent / ".." / ".." / "secret.jpg"),
    lambda home, shot: "",
])
def test_refuses_files_outside_steam_screenshot_folders(tmp_path, make_path):
    shot = make_screenshot(tmp_path, "10", "shot.jpg")
    (tmp_path / "secret.jpg").write_bytes(b"secret")

    with pytest.raises(ValueError):
        read_screenshot(str(tmp_path), make_path(tmp_path, shot))


def test_refuses_symlink_out_of_screenshot_folder(tmp_path):
    shot = make_screenshot(tmp_path, "10", "shot.jpg")
    (tmp_path / "secret.jpg").write_bytes(b"secret")
    link = shot.parent / "link.jpg"
    link.symlink_to(tmp_path / "secret.jpg")

    with pytest.raises(ValueError, match="Only Steam screenshots"):
        read_screenshot(str(tmp_path), str(link))
