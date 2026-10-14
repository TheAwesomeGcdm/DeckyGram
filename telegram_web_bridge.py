import asyncio
import base64
import binascii
import fcntl
import hashlib
import json
import os
import secrets
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


ELECTRON_VERSION = "44.7.0"
ELECTRON_ARCHIVE = f"electron-v{ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_RELEASE = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}"
MAX_ELECTRON_ARCHIVE_BYTES = 300 * 1024 * 1024
MAX_STARTUP_LOG_BYTES = 8 * 1024
ELECTRON_STOP_TIMEOUT_SECONDS = 10
# Decky kills a plugin's backend five seconds after asking it to stop.
UNLOAD_STOP_SECONDS = 3
# At boot Decky starts plugins before Steam's compositor has opened its Wayland socket.
DISPLAY_WAIT_SECONDS = 90
DISPLAY_POLL_SECONDS = 2
STEAMOS_CA_BUNDLE_PATHS = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
)


def parse_sha256_manifest(manifest: str, filename: str) -> str:
    for line in manifest.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == filename:
            digest = parts[0].lower()
            if len(digest) == 64 and all(char in "0123456789abcdef" for char in digest):
                return digest
            break
    raise RuntimeError(f"Electron release checksum is missing or invalid for {filename}")


def safe_extract_zip(archive_path: str, destination: str) -> None:
    destination_path = Path(destination).resolve()
    with zipfile.ZipFile(archive_path) as archive:
        total_uncompressed_bytes = 0
        for member in archive.infolist():
            total_uncompressed_bytes += member.file_size
            if total_uncompressed_bytes > 1024 * 1024 * 1024:
                raise RuntimeError("Electron archive expands beyond the allowed size")
            member_path = PurePosixPath(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise RuntimeError("Electron archive contains an unsafe path")
            target = (destination_path / Path(*member_path.parts)).resolve()
            if not target.is_relative_to(destination_path):
                raise RuntimeError("Electron archive contains an unsafe path")
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise RuntimeError("Electron archive contains an unsupported symbolic link")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            if mode:
                target.chmod(mode & 0o777)


def _ssl_contexts() -> list[ssl.SSLContext]:
    default_context = ssl.create_default_context()
    contexts = [default_context]
    loaded_paths: set[str] = set()
    verify_paths = ssl.get_default_verify_paths()
    candidates = (
        os.environ.get("SSL_CERT_FILE"),
        verify_paths.cafile,
        *STEAMOS_CA_BUNDLE_PATHS,
    )

    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        normalized_path = os.path.realpath(path)
        if normalized_path in loaded_paths:
            continue
        loaded_paths.add(normalized_path)
        context = ssl.create_default_context(cafile=path)
        contexts.append(context)
    return contexts


def _download(url: str, target: str, max_bytes: int) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Deckygram"})
    last_certificate_error: urllib.error.URLError | None = None
    for context in _ssl_contexts():
        try:
            with urllib.request.urlopen(request, timeout=60, context=context) as response, open(target, "wb") as output:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > max_bytes:
                        raise RuntimeError("Electron download exceeded the allowed size")
                    output.write(chunk)
            return
        except urllib.error.URLError as error:
            if not isinstance(error.reason, ssl.SSLCertVerificationError):
                raise
            last_certificate_error = error

    if last_certificate_error:
        raise RuntimeError(
            "Unable to verify the Electron download certificate. Update SteamOS's CA certificates and retry."
        ) from last_certificate_error
    raise RuntimeError("No trusted TLS certificate bundle is available to download Electron")


def read_startup_log(path: str, max_bytes: int = MAX_STARTUP_LOG_BYTES) -> str:
    try:
        with open(path, "rb") as log_file:
            log_file.seek(0, os.SEEK_END)
            size = log_file.tell()
            log_file.seek(max(0, size - max_bytes))
            content = log_file.read().decode("utf-8", errors="replace").strip()
    except FileNotFoundError:
        return "Electron did not create a startup log."
    except OSError as error:
        return f"Unable to read Electron startup log: {error}"

    if not content:
        return "Electron exited without writing a startup log."
    return content


def discover_wayland_environment(environment: dict[str, str], uid: int | None = None) -> dict[str, str] | None:
    resolved = dict(environment)
    runtime_dir = resolved.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid() if uid is None else uid}"
    configured_display = resolved.get("WAYLAND_DISPLAY")
    candidates: list[Path] = []
    if configured_display:
        display_path = Path(configured_display)
        candidates.append(display_path if display_path.is_absolute() else Path(runtime_dir) / display_path)

    runtime_path = Path(runtime_dir)
    candidates.extend(sorted(runtime_path.glob("wayland-*")))
    candidates.extend(sorted(runtime_path.glob("gamescope-*")))
    seen: set[str] = set()
    for candidate in candidates:
        try:
            socket_path = str(candidate.resolve(strict=True))
            if socket_path in seen or not stat.S_ISSOCK(os.stat(socket_path).st_mode):
                continue
        except OSError:
            continue
        seen.add(socket_path)
        resolved["XDG_RUNTIME_DIR"] = runtime_dir
        resolved["WAYLAND_DISPLAY"] = (
            socket_path if candidate.is_absolute() and str(candidate) == configured_display else candidate.name
        )
        resolved["XDG_SESSION_TYPE"] = "wayland"
        return resolved
    return None


def prepare_electron_environment(environment: dict[str, str]) -> tuple[dict[str, str], bool]:
    resolved = dict(environment)
    library_path = resolved.get("LD_LIBRARY_PATH")
    if not library_path:
        return resolved, False

    entries = library_path.split(os.pathsep)
    filtered_entries = [
        entry for entry in entries
        if not any(part.startswith("_MEI") for part in Path(entry).parts)
    ]
    if len(filtered_entries) == len(entries):
        return resolved, False

    if filtered_entries:
        resolved["LD_LIBRARY_PATH"] = os.pathsep.join(filtered_entries)
    else:
        resolved.pop("LD_LIBRARY_PATH", None)
    return resolved, True


IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MAX_SAVED_IMAGE_BYTES = 48 * 1024 * 1024


def downloads_dir() -> str:
    """The user's Downloads folder: xdg-user-dirs first, then ~/Downloads."""
    home = os.path.expanduser("~")
    try:
        result = subprocess.run(["xdg-user-dir", "DOWNLOAD"], capture_output=True, text=True, timeout=5)
        path = result.stdout.strip()
        if result.returncode == 0 and path and path != home:
            return path
    except (OSError, subprocess.SubprocessError):
        pass
    return os.path.join(home, "Downloads")


def decode_image_data_url(data_url: str) -> tuple[bytes, str]:
    header, separator, payload = data_url.partition(",")
    if not separator or not header.startswith("data:image/") or not header.endswith(";base64"):
        raise RuntimeError("Telegram Web returned an unsupported image format")
    mime = header[len("data:"):-len(";base64")]
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RuntimeError("Telegram Web returned a damaged image") from error
    if len(data) > MAX_SAVED_IMAGE_BYTES:
        raise RuntimeError("Image is too large to save")
    return data, mime


def write_new_file(directory: str, filename: str, data: bytes) -> str:
    """Write data under directory without overwriting: name.ext, then name (2).ext, name (3).ext, ..."""
    os.makedirs(directory, exist_ok=True)
    stem, extension = os.path.splitext(filename)
    path = os.path.join(directory, filename)
    counter = 2
    while os.path.exists(path):
        path = os.path.join(directory, f"{stem} ({counter}){extension}")
        counter += 1
    temporary = f"{path}.part"
    try:
        with open(temporary, "wb") as file:
            file.write(data)
        os.replace(temporary, path)
    except OSError:
        try:
            os.remove(temporary)
        except OSError:
            pass
        raise
    return path


def find_stale_electron_process_groups(browser_dir: str, proc_dir: str = "/proc") -> set[int]:
    """Find process groups running an Electron binary from Deckygram's runtime directory."""
    electron_root = os.path.realpath(browser_dir) + os.sep
    own_group = os.getpgid(0)
    groups: set[int] = set()
    for entry in os.listdir(proc_dir):
        if not entry.isdigit():
            continue
        try:
            with open(os.path.join(proc_dir, entry, "cmdline"), "rb") as cmdline_file:
                executable = os.fsdecode(cmdline_file.read().split(b"\0", 1)[0])
            group = os.getpgid(int(entry))
        except (OSError, ProcessLookupError):
            continue
        if executable.startswith(electron_root) and group != own_group:
            groups.add(group)
    return groups


def _wait_for_groups_to_exit(groups: set[int], timeout: float) -> set[int]:
    """Wait until the process groups are empty; returns the groups still running at the deadline."""
    deadline = time.monotonic() + timeout
    remaining = set(groups)
    while remaining:
        for group in list(remaining):
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                remaining.discard(group)
        if not remaining or time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    return remaining


def _process_running(pid: int, proc_dir: str = "/proc") -> bool:
    """True until the process has exited; an exited child waiting to be reaped counts as stopped."""
    try:
        with open(os.path.join(proc_dir, str(pid), "stat"), encoding="utf-8") as stat_file:
            # The state follows the command name, which is in parentheses and may contain spaces.
            return stat_file.read().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return False


def _request_electron_quit(group: int) -> None:
    """Electron's main process leads its group; signalling it alone lets Chromium stop its helper processes,
    including the one writing Telegram's storage, in order. Without a main process, the helpers are stopped."""
    try:
        os.kill(group, signal.SIGTERM)
    except ProcessLookupError:
        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass


def stop_stale_electron_processes(browser_dir: str) -> int:
    """Stop Electron instances left behind when an earlier Deckygram backend exited uncleanly."""
    groups = find_stale_electron_process_groups(browser_dir)
    for group in groups:
        _request_electron_quit(group)
    for group in _wait_for_groups_to_exit(groups, ELECTRON_STOP_TIMEOUT_SECONDS):
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return len(groups)


async def terminate_process_group(process: asyncio.subprocess.Process) -> None:
    """Ask Electron to quit so Telegram's storage is written out, then clear whatever is left of its group."""
    _request_electron_quit(process.pid)
    try:
        await asyncio.wait_for(process.wait(), timeout=ELECTRON_STOP_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        pass
    else:
        # Chromium's helpers finish shortly after the main process.
        await asyncio.to_thread(_wait_for_groups_to_exit, {process.pid}, 2)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await process.wait()


def install_electron(runtime_dir: str) -> str:
    install_dir = os.path.join(runtime_dir, f"electron-v{ELECTRON_VERSION}-linux-x64")
    electron_binary = os.path.join(install_dir, "electron")
    if os.path.isfile(electron_binary):
        return electron_binary

    os.makedirs(runtime_dir, mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="deckygram-electron-", dir=runtime_dir) as temp_dir:
        manifest_path = os.path.join(temp_dir, "SHASUMS256.txt")
        archive_path = os.path.join(temp_dir, ELECTRON_ARCHIVE)
        manifest_url = f"{ELECTRON_RELEASE}/SHASUMS256.txt"
        archive_url = f"{ELECTRON_RELEASE}/{ELECTRON_ARCHIVE}"
        try:
            _download(manifest_url, manifest_path, 1024 * 1024)
            manifest = Path(manifest_path).read_text(encoding="ascii")
            expected_digest = parse_sha256_manifest(manifest, ELECTRON_ARCHIVE)
            _download(archive_url, archive_path, MAX_ELECTRON_ARCHIVE_BYTES)
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            raise RuntimeError(f"Unable to download the Electron runtime: {error}") from error

        digest = hashlib.sha256()
        with open(archive_path, "rb") as archive_file:
            for chunk in iter(lambda: archive_file.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_digest:
            raise RuntimeError("Electron runtime checksum verification failed")

        staging_dir = os.path.join(temp_dir, "extracted")
        os.makedirs(staging_dir, mode=0o700)
        safe_extract_zip(archive_path, staging_dir)
        extracted_binary = os.path.join(staging_dir, "electron")
        extracted_dir = staging_dir
        if not os.path.isfile(extracted_binary):
            extracted_dir = os.path.join(staging_dir, f"electron-v{ELECTRON_VERSION}-linux-x64")
            extracted_binary = os.path.join(extracted_dir, "electron")
        if not os.path.isfile(extracted_binary):
            raise RuntimeError("Electron archive did not contain its expected executable")
        os.chmod(extracted_binary, 0o755)
        shutil.move(extracted_dir, install_dir)
    return electron_binary


class TelegramWebBridge:
    def __init__(self, plugin_dir: str, runtime_dir: str, logger: Any):
        self.plugin_dir = plugin_dir
        self.runtime_dir = runtime_dir
        self.logger = logger
        self.app_dir = os.path.join(plugin_dir, "bin", "deckygram-telegram-web")
        source_app_dir = os.path.join(plugin_dir, "electron", "telegram-web")
        if not os.path.isfile(os.path.join(self.app_dir, "main.cjs")):
            self.app_dir = source_app_dir
        self.browser_dir = os.path.join(runtime_dir, "telegram-web")
        self.profile_dir = os.path.join(self.browser_dir, "profile-v3")
        self.profile_lock_path = os.path.join(self.browser_dir, "profile-v3.lock")
        self.profile_lock_file = None
        self.log_path = os.path.join(self.browser_dir, "electron.log")
        self.process: asyncio.subprocess.Process | None = None
        self.port: int | None = None
        self.token: str | None = None
        self.state: dict[str, Any] = {
            "status": "starting",
            "chats": [],
            "error": None,
            "qr_image": None,
        }
        self.lock = asyncio.Lock()
        # One start at a time: a retry pressed while the first start waits must not launch a second Electron.
        self.start_lock = asyncio.Lock()

    async def start(self) -> None:
        async with self.start_lock:
            await self._start()

    async def _wait_for_display(self) -> dict[str, str] | None:
        """Steam's Wayland environment once its socket exists, or None if there is none in time and no X display."""
        deadline = asyncio.get_running_loop().time() + DISPLAY_WAIT_SECONDS
        while True:
            environment = discover_wayland_environment(os.environ.copy())
            if environment or os.environ.get("DISPLAY"):
                return environment
            if asyncio.get_running_loop().time() >= deadline:
                return None
            await asyncio.sleep(DISPLAY_POLL_SECONDS)

    async def _start(self) -> None:
        if self.process and self.process.returncode is None:
            return
        os.makedirs(self.profile_dir, mode=0o700, exist_ok=True)
        os.chmod(self.browser_dir, 0o700)
        os.chmod(self.profile_dir, 0o700)
        app_entry = os.path.join(self.app_dir, "main.cjs")
        if not os.path.isfile(app_entry):
            await self._set_state(
                status="error",
                error="The Telegram Web bridge files are missing from the plugin's bin directory.",
            )
            return

        launch_environment = await self._wait_for_display()
        if not launch_environment and not os.environ.get("DISPLAY"):
            await self._set_state(
                status="error",
                error=(
                    "Deckygram cannot find Steam's Wayland display socket. "
                    "Electron needs an active graphical session; open Deckygram from Steam Gaming Mode "
                    "and verify that /run/user/<your-user-id> contains an accessible wayland-* socket."
                ),
            )
            return

        try:
            stale_groups = await asyncio.to_thread(stop_stale_electron_processes, self.browser_dir)
            if stale_groups:
                self.logger.warning("Stopped %d leftover Telegram Web process group(s)", stale_groups)
            self._acquire_profile_lock()
        except (OSError, RuntimeError) as error:
            message = str(error)
            await self._set_state(status="error", error=message)
            self.logger.error("%s", message)
            return

        await self._set_state(status="downloading", error=None)
        try:
            with open(self.log_path, "w", encoding="utf-8") as log_file:
                log_file.write(
                    "Starting Telegram Web bridge\n"
                    f"Bridge app directory: {self.app_dir}\n"
                    f"DISPLAY: {launch_environment.get('DISPLAY', '<unset>') if launch_environment else '<unset>'}\n"
                    f"WAYLAND_DISPLAY: {launch_environment.get('WAYLAND_DISPLAY', '<unset>') if launch_environment else '<unset>'}\n"
                    f"XDG_RUNTIME_DIR: {launch_environment.get('XDG_RUNTIME_DIR', '<unset>') if launch_environment else '<unset>'}\n"
                    f"Telegram profile: {self.profile_dir}\n"
                    f"Previous Telegram profiles preserved: {os.path.join(self.browser_dir, 'profile')}, "
                    f"{os.path.join(self.browser_dir, 'profile-v2')}\n"
                    f"Profile lock acquired: {self.profile_lock_path}\n"
                )
            os.chmod(self.log_path, 0o600)
            electron_binary = await asyncio.to_thread(install_electron, self.browser_dir)
            with open(self.log_path, "a", encoding="utf-8") as log_file:
                log_file.write(
                    f"Electron executable: {electron_binary}\n"
                )
            self.port = self._available_port()
            self.token = secrets.token_urlsafe(32)
            env, filtered_bundle_library_path = prepare_electron_environment(
                launch_environment or os.environ.copy()
            )
            if filtered_bundle_library_path:
                with open(self.log_path, "a", encoding="utf-8") as log_file:
                    log_file.write(
                        "Filtered temporary Python bundle libraries from Electron's LD_LIBRARY_PATH\n"
                    )
            env.update({
                "DECKYGRAM_BRIDGE_PORT": str(self.port),
                "DECKYGRAM_BRIDGE_TOKEN": self.token,
                "DECKYGRAM_TELEGRAM_PROFILE": self.profile_dir,
                "DECKYGRAM_LOG_PATH": self.log_path,
            })
            command = [electron_binary, "--disable-gpu", self.app_dir]
            if env.get("WAYLAND_DISPLAY"):
                command[1:1] = ["--ozone-platform=wayland", "--enable-features=UseOzonePlatform"]
            if os.geteuid() == 0:
                command.insert(1, "--no-sandbox")
            with open(self.log_path, "ab") as log_file:
                self.process = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=self.app_dir,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=log_file,
                    start_new_session=True,
                    # Electron inherits the profile lock so it stays held if this backend exits first.
                    pass_fds=(self.profile_lock_file.fileno(),),
                )
            await self._wait_for_bridge()
        except Exception as error:
            process = self.process
            if process:
                try:
                    await terminate_process_group(process)
                except OSError as cleanup_error:
                    self.logger.error("Unable to fully stop Telegram Web process group: %s", cleanup_error)
                else:
                    self.process = None
                    self._release_profile_lock()
            else:
                self._release_profile_lock()
            log_tail = await asyncio.to_thread(read_startup_log, self.log_path)
            await self._set_state(status="error", error=f"{error}\n\nElectron startup log:\n{log_tail}")
            self.logger.error("Unable to start Telegram Web bridge: %s", error)

    def _acquire_profile_lock(self) -> None:
        if self.profile_lock_file:
            return
        os.makedirs(self.browser_dir, mode=0o700, exist_ok=True)
        lock_file = open(self.profile_lock_path, "a", encoding="utf-8")
        try:
            os.chmod(self.profile_lock_path, 0o600)
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            lock_file.close()
            raise RuntimeError(
                "Another Deckygram Telegram Web process is using this browser profile. "
                "Stop the other Deckygram instance and retry."
            ) from error
        except OSError:
            lock_file.close()
            raise
        self.profile_lock_file = lock_file

    def _release_profile_lock(self) -> None:
        lock_file = self.profile_lock_file
        self.profile_lock_file = None
        if lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            lock_file.close()

    @staticmethod
    def _available_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            return listener.getsockname()[1]

    async def _wait_for_bridge(self) -> None:
        deadline = asyncio.get_running_loop().time() + 45
        while asyncio.get_running_loop().time() < deadline:
            if not self.process or self.process.returncode is not None:
                return_code = self.process.returncode if self.process else "unknown"
                raise RuntimeError(
                    f"The Telegram Web process exited with code {return_code} before its local bridge started."
                )
            try:
                state = await self._request("GET", "/state", timeout=2)
                await self._update_from_bridge(state)
                return
            except (OSError, RuntimeError, urllib.error.URLError, json.JSONDecodeError):
                await asyncio.sleep(0.5)
        raise RuntimeError("Timed out waiting for the Telegram Web bridge to start")

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 10,
    ) -> Any:
        if not self.port or not self.token:
            raise RuntimeError("Telegram Web bridge is not running")
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            response = await asyncio.to_thread(urllib.request.urlopen, request, timeout=timeout)
            with response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Telegram Web bridge request failed ({error.code}): {detail}") from error
        except (OSError, urllib.error.URLError) as error:
            raise RuntimeError(f"Telegram Web bridge is unavailable: {error}") from error

    async def _update_from_bridge(self, state: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            self.state.update({
                "status": state.get("status", "connecting"),
                "chats": state.get("chats", []),
                "error": state.get("error"),
                "login_error": state.get("login_error"),
                "qr_image": state.get("qr_image"),
                "selected_chat_id": state.get("selected_chat_id"),
            })
            return dict(self.state)

    async def _set_state(self, **changes: Any) -> None:
        async with self.lock:
            self.state.update(changes)

    async def get_state(self) -> dict[str, Any]:
        if not self.process:
            return dict(self.state)
        if self.process.returncode is not None:
            await self._set_state(status="error", error="Telegram Web exited unexpectedly.")
            return dict(self.state)
        try:
            return await self._update_from_bridge(await self._request("GET", "/state"))
        except Exception as error:
            await self._set_state(status="error", error=str(error))
            return dict(self.state)

    async def get_chats(self) -> list[dict[str, Any]]:
        state = await self.get_state()
        return state["chats"]

    async def open_chat(self, chat_id: int) -> dict[str, Any]:
        result = await self._request("POST", "/open-chat", {"chat_id": int(chat_id)}, timeout=30)
        await self._update_from_bridge(result)
        return result

    async def get_message_image(self, chat_id: int, message_id: int) -> dict[str, Any]:
        if self.state.get("selected_chat_id") != int(chat_id):
            raise RuntimeError("The selected Telegram chat changed; reopen it before loading images")
        return await self._request("POST", "/message-image", {"message_id": int(message_id)})

    async def get_message_image_file(self, chat_id: int, message_id: int) -> dict[str, Any]:
        if self.state.get("selected_chat_id") != int(chat_id):
            raise RuntimeError("The selected Telegram chat changed; reopen it before loading images")
        return await self._request("POST", "/message-image-file", {"message_id": int(message_id)}, timeout=30)

    async def save_message_image(self, chat_id: int, message_id: int) -> dict[str, Any]:
        result = await self.get_message_image_file(chat_id, message_id)
        if not result.get("data_url"):
            raise RuntimeError(result.get("error") or "Telegram Web has not loaded this image yet; try again in a moment")
        data, mime = decode_image_data_url(result["data_url"])
        filename = f"telegram-{int(message_id)}{IMAGE_EXTENSIONS.get(mime, '.jpg')}"
        directory = os.path.join(downloads_dir(), "Telegram")
        path = await asyncio.to_thread(write_new_file, directory, filename, data)
        return {"ok": True, "path": path, "name": os.path.basename(path)}

    async def close_chat(self) -> dict[str, Any]:
        result = await self._request("POST", "/close-chat", {})
        await self._set_state(selected_chat_id=None)
        return result

    async def get_messages(self, chat_id: int) -> dict[str, Any]:
        state = await self._request("GET", "/state")
        if state.get("selected_chat_id") != int(chat_id):
            raise RuntimeError("The selected Telegram chat changed; reopen it before refreshing messages")
        return {
            "messages": state.get("messages", []),
            "message_count": state.get("message_count", 0),
            "message_root_found": state.get("message_root_found", False),
            "message_root": state.get("message_root"),
            "identified_message_count": state.get("identified_message_count", 0),
            "message_candidate_count": state.get("message_candidate_count", 0),
            "visible_message_candidate_count": state.get("visible_message_candidate_count", 0),
            "message_class_count": state.get("message_class_count", 0),
            "message_id_attribute_count": state.get("message_id_attribute_count", 0),
            "dom_region_diagnostics": state.get("dom_region_diagnostics", []),
            "selected_chat_title": state.get("selected_chat_title", ""),
            "typing_text": state.get("typing_text", ""),
        }

    async def _ensure_selected(self, chat_id: int) -> None:
        state = await self._request("GET", "/state")
        if state.get("selected_chat_id") != int(chat_id):
            raise RuntimeError("The selected Telegram chat changed; reopen it and try again")

    async def send_message(self, chat_id: int, text: str, reply_to: int | None = None) -> dict[str, Any]:
        text = text.strip()
        if not text:
            raise ValueError("Message cannot be empty")
        await self._ensure_selected(chat_id)
        payload: dict[str, Any] = {"text": text}
        if reply_to is not None:
            payload["reply_to"] = int(reply_to)
        return await self._request("POST", "/send-message", payload, timeout=20)

    async def _message_action(self, chat_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        await self._ensure_selected(chat_id)
        return await self._request("POST", "/message-action", payload, timeout=30)

    async def edit_message(self, chat_id: int, message_id: int, text: str) -> dict[str, Any]:
        text = text.strip()
        if not text:
            raise ValueError("Message cannot be empty")
        return await self._message_action(chat_id, {"action": "edit", "message_id": int(message_id), "text": text})

    async def delete_message(self, chat_id: int, message_id: int, for_everyone: bool) -> dict[str, Any]:
        return await self._message_action(
            chat_id, {"action": "delete", "message_id": int(message_id), "for_everyone": bool(for_everyone)},
        )

    async def reaction_options(self, chat_id: int, message_id: int) -> dict[str, Any]:
        return await self._message_action(chat_id, {"action": "reaction-options", "message_id": int(message_id)})

    async def react(self, chat_id: int, message_id: int, index: int) -> dict[str, Any]:
        return await self._message_action(chat_id, {"action": "react", "message_id": int(message_id), "index": int(index)})

    async def load_message_video(self, chat_id: int, message_id: int) -> dict[str, Any]:
        await self._ensure_selected(chat_id)
        # Telegram may have to download the whole file first.
        return await self._request("POST", "/message-video", {"message_id": int(message_id)}, timeout=120)

    async def message_video_chunk(self, video_id: str, index: int) -> dict[str, Any]:
        return await self._request("POST", "/message-video-chunk", {"id": str(video_id), "index": int(index)}, timeout=30)

    async def release_message_video(self, video_id: str) -> dict[str, Any]:
        return await self._request("POST", "/message-video-release", {"id": str(video_id)})

    async def set_chat_pinned(self, chat_id: int, title: str, pinned: bool) -> dict[str, Any]:
        payload = {"chat_id": int(chat_id), "title": str(title), "action": "pin" if pinned else "unpin"}
        return await self._request("POST", "/chat-action", payload, timeout=20)

    async def list_stickers(self, chat_id: int) -> dict[str, Any]:
        await self._ensure_selected(chat_id)
        # Telegram's picker is walked set by set while stickers load.
        return await self._request("POST", "/stickers", {}, timeout=60)

    async def send_sticker(self, chat_id: int, sticker_id: str) -> dict[str, Any]:
        await self._ensure_selected(chat_id)
        return await self._request("POST", "/send-sticker", {"sticker_id": str(sticker_id)}, timeout=40)

    async def send_image(self, chat_id: int, data: bytes, mime: str, name: str, caption: str = "") -> dict[str, Any]:
        await self._ensure_selected(chat_id)
        payload = {
            "data": base64.b64encode(data).decode("ascii"),
            "mime": mime,
            "name": name,
            "caption": caption.strip(),
        }
        # Telegram has to load and prepare the picture before it can be sent.
        return await self._request("POST", "/send-image", payload, timeout=90)

    async def submit_cloud_password(self, password: str) -> dict[str, Any]:
        if not password.strip():
            raise ValueError("Cloud password cannot be empty")
        return await self._request("POST", "/submit-password", {"password": password})

    async def stop(self) -> None:
        process = self.process
        if process:
            await terminate_process_group(process)
            self.process = None
        self._release_profile_lock()
        self.port = None
        self.token = None

    async def shut_down(self) -> None:
        """For plugin unload, which Decky cuts off after five seconds: Telegram Web is asked to quit and given
        a few seconds. Nothing here awaits the process object, whose watcher may belong to another event loop.
        If Electron needs longer it finishes by itself, and the next start waits for it."""
        process = self.process
        self.process = None
        if process:
            _request_electron_quit(process.pid)
            deadline = time.monotonic() + UNLOAD_STOP_SECONDS
            while _process_running(process.pid) and time.monotonic() < deadline:
                await asyncio.sleep(0.1)
        self._release_profile_lock()
        self.port = None
        self.token = None

    async def logout(self) -> None:
        """Sign out locally by deleting every stored Telegram Web profile, then show a fresh login."""
        await self.stop()
        await asyncio.to_thread(stop_stale_electron_processes, self.browser_dir)
        for name in ("profile-v3", "profile-v2", "profile"):
            path = os.path.join(self.browser_dir, name)
            if os.path.isdir(path) and not os.path.islink(path):
                await asyncio.to_thread(shutil.rmtree, path)
        await self._set_state(status="starting", error=None, chats=[], qr_image=None, selected_chat_id=None)
        await self.start()

    async def restart(self) -> None:
        await self.stop()
        await self._set_state(status="starting", error=None)
        await self.start()
