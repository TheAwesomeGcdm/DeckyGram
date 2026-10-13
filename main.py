import asyncio
import json
import os
import sys
import time

import decky

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from screenshots import list_screenshots, read_screenshot
from telegram_web_bridge import TelegramWebBridge, _ssl_contexts, stop_stale_electron_processes
from updates import check_for_update as check_latest_release

# Deckygram was called SteamGram; its Telegram login, Electron runtime and settings live under that name.
LEGACY_PLUGIN_NAME = "SteamGram"

DEFAULT_SETTINGS = {
    "chat_filter": "all",
    "hide_archived": False,
    "notifications": "steam",
    "notification_sound": True,
    "unread_badges": "all",
    "notification_cooldown": False,
    "cooldown_minutes": 5,
}
SETTING_CHOICES = {
    "chat_filter": {"all", "dms"},
    "notifications": {"steam", "off"},
    "unread_badges": {"all", "dms", "off"},
    "cooldown_minutes": {3, 5, 10, 15},
}
# A chat that raised this many popups stays quiet until the cooldown window has passed since the first
# of them, then starts over; its unread badge keeps counting either way.
COOLDOWN_NOTIFICATION_LIMIT = 3
# The first update check waits for Deckygram to settle after Steam starts, then repeats a few times a day.
UPDATE_FIRST_CHECK_SECONDS = 60
UPDATE_CHECK_INTERVAL_SECONDS = 6 * 60 * 60


def valid_setting(key, value):
    if key not in DEFAULT_SETTINGS:
        return False
    if key in SETTING_CHOICES:
        # bool is an int in Python; True must not pass as a minute count.
        return type(value) is type(DEFAULT_SETTINGS[key]) and value in SETTING_CHOICES[key]
    return type(value) is bool


def allow_notification(sent_at: list[float], now: float, window_seconds: float, limit: int) -> bool:
    """Records this popup in sent_at if the chat's current burst is under the limit.

    A burst starts with a chat's first popup. Once the window has passed since then, the burst is over
    and the count starts again from zero, so the next `limit` popups all show.
    """
    if sent_at and now - sent_at[0] >= window_seconds:
        sent_at.clear()
    if len(sent_at) >= limit:
        return False
    sent_at.append(now)
    return True


class Plugin:
    def __init__(self):
        plugin_dir = os.environ.get("DECKY_PLUGIN_DIR", decky.DECKY_PLUGIN_DIR)
        runtime_dir = os.environ.get("DECKY_PLUGIN_RUNTIME_DIR", decky.DECKY_PLUGIN_RUNTIME_DIR)
        self.telegram = TelegramWebBridge(plugin_dir, runtime_dir, decky.logger)
        settings_dir = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", decky.DECKY_PLUGIN_SETTINGS_DIR)
        self.settings_path = os.path.join(settings_dir, "settings.json")
        self.settings = self._load_settings()
        self.notification_task = None
        self.update_task = None
        self.update_status = None
        self.user_home = os.environ.get("DECKY_USER_HOME", decky.DECKY_USER_HOME)

    async def get_state(self):
        return await self.telegram.get_state()

    async def get_chats(self):
        return await self.telegram.get_chats()

    async def get_version(self):
        return getattr(decky, "DECKY_PLUGIN_VERSION", "")

    async def get_settings(self):
        return dict(self.settings)

    async def update_settings(self, changes: dict):
        if not isinstance(changes, dict) or any(not valid_setting(key, value) for key, value in changes.items()):
            raise ValueError(f"Unsupported Deckygram setting change: {changes!r}")
        self.settings.update(changes)
        os.makedirs(os.path.dirname(self.settings_path), mode=0o700, exist_ok=True)
        temporary_path = f"{self.settings_path}.tmp"
        with open(temporary_path, "w", encoding="utf-8") as settings_file:
            json.dump(self.settings, settings_file)
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, self.settings_path)
        return dict(self.settings)

    def _load_settings(self):
        defaults = dict(DEFAULT_SETTINGS)
        try:
            with open(self.settings_path, encoding="utf-8") as settings_file:
                saved = json.load(settings_file)
        except FileNotFoundError:
            return defaults
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.error("Unable to load Deckygram settings: %s", error)
            return defaults
        if not isinstance(saved, dict):
            decky.logger.error("Deckygram settings file must contain a JSON object")
            return defaults
        for key in defaults:
            if key in saved and valid_setting(key, saved[key]):
                defaults[key] = saved[key]
        return defaults

    async def _watch_notifications(self):
        unread_by_chat = {}
        popups_by_chat = {}
        while True:
            try:
                state = await self.telegram.get_state()
                if state.get("status") == "ready":
                    for chat in state.get("chats", []):
                        chat_key = chat.get("title"), chat.get("is_group")
                        unread = chat.get("unread_count", 0)
                        previous = unread_by_chat.get(chat_key)
                        unread_by_chat[chat_key] = unread
                        if (
                            previous is not None
                            and unread > previous
                            and not chat.get("is_muted")
                            and not chat.get("is_archive_folder")
                            and self.settings["notifications"] == "steam"
                            and (
                                not self.settings["notification_cooldown"]
                                or allow_notification(
                                    popups_by_chat.setdefault(chat_key, []),
                                    time.monotonic(),
                                    self.settings["cooldown_minutes"] * 60,
                                    COOLDOWN_NOTIFICATION_LIMIT,
                                )
                            )
                        ):
                            await decky.emit(
                                "deckygram_message",
                                chat.get("title", "Telegram"),
                                chat.get("last_message", ""),
                                self.settings["notification_sound"],
                                # The panel shows the avatar and reopens this chat when the toast is selected.
                                chat.get("avatar_url", ""),
                                bool(chat.get("is_group")),
                            )
            except Exception as error:
                decky.logger.error("Unable to check Telegram notifications: %s", error)
            await asyncio.sleep(10)

    async def get_update_status(self):
        return self.update_status

    async def check_for_update(self):
        version = getattr(decky, "DECKY_PLUGIN_VERSION", "")
        self.update_status = await asyncio.to_thread(check_latest_release, version, _ssl_contexts())
        return self.update_status

    async def _watch_updates(self):
        await asyncio.sleep(UPDATE_FIRST_CHECK_SECONDS)
        while True:
            status = await self.check_for_update()
            if status["error"]:
                decky.logger.info("Deckygram update check failed: %s", status["error"])
            await asyncio.sleep(UPDATE_CHECK_INTERVAL_SECONDS)

    async def get_messages(self, chat_id: int):
        return await self.telegram.get_messages(chat_id)

    async def open_chat(self, chat_id: int):
        return await self.telegram.open_chat(chat_id)

    async def get_message_image(self, chat_id: int, message_id: int):
        return await self.telegram.get_message_image(chat_id, message_id)

    async def get_message_image_file(self, chat_id: int, message_id: int):
        return await self.telegram.get_message_image_file(chat_id, message_id)

    async def save_message_image(self, chat_id: int, message_id: int):
        return await self.telegram.save_message_image(chat_id, message_id)

    async def close_chat(self):
        return await self.telegram.close_chat()

    async def send_message(self, chat_id: int, text: str, reply_to: int | None = None):
        return await self.telegram.send_message(chat_id, text, reply_to)

    async def edit_message(self, chat_id: int, message_id: int, text: str):
        return await self.telegram.edit_message(chat_id, message_id, text)

    async def delete_message(self, chat_id: int, message_id: int, for_everyone: bool):
        return await self.telegram.delete_message(chat_id, message_id, for_everyone)

    async def reaction_options(self, chat_id: int, message_id: int):
        return await self.telegram.reaction_options(chat_id, message_id)

    async def react(self, chat_id: int, message_id: int, index: int):
        return await self.telegram.react(chat_id, message_id, index)

    async def load_message_video(self, chat_id: int, message_id: int):
        return await self.telegram.load_message_video(chat_id, message_id)

    async def message_video_chunk(self, video_id: str, index: int):
        return await self.telegram.message_video_chunk(video_id, index)

    async def release_message_video(self, video_id: str):
        return await self.telegram.release_message_video(video_id)

    async def set_chat_pinned(self, chat_id: int, title: str, pinned: bool):
        return await self.telegram.set_chat_pinned(chat_id, title, pinned)

    async def list_stickers(self, chat_id: int):
        return await self.telegram.list_stickers(chat_id)

    async def send_sticker(self, chat_id: int, sticker_id: str):
        return await self.telegram.send_sticker(chat_id, sticker_id)

    async def list_screenshots(self):
        return await asyncio.to_thread(list_screenshots, self.user_home)

    async def send_screenshot(self, chat_id: int, path: str, caption: str = ""):
        data, mime, name = await asyncio.to_thread(read_screenshot, self.user_home, path)
        return await self.telegram.send_image(chat_id, data, mime, name, caption)

    async def submit_cloud_password(self, password: str):
        return await self.telegram.submit_cloud_password(password)

    async def restart_telegram(self):
        await self.telegram.restart()

    async def logout(self):
        await self.telegram.logout()

    async def _main(self):
        await self.telegram.start()
        self.notification_task = asyncio.create_task(self._watch_notifications())
        self.update_task = asyncio.create_task(self._watch_updates())

    async def _unload(self):
        for task in (self.notification_task, self.update_task):
            if not task:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await self.telegram.stop()

    async def _uninstall(self):
        await self._unload()

    async def _migration(self):
        await asyncio.to_thread(self._migrate_from_legacy_name)
        os.makedirs(self.telegram.runtime_dir, mode=0o700, exist_ok=True)

    def _migrate_from_legacy_name(self):
        runtime_dir = self.telegram.runtime_dir
        settings_dir = os.path.dirname(self.settings_path)
        legacy_runtime = os.path.join(os.path.dirname(runtime_dir), LEGACY_PLUGIN_NAME)
        legacy_settings = os.path.join(os.path.dirname(settings_dir), LEGACY_PLUGIN_NAME)
        if os.path.isdir(legacy_runtime) and not os.path.exists(os.path.join(runtime_dir, "telegram-web")):
            # An Electron still running from the old folder would hold the profile while it moves.
            stop_stale_electron_processes(os.path.join(legacy_runtime, "telegram-web"))
            decky.migrate_runtime(legacy_runtime)
            decky.logger.info("Moved SteamGram's Telegram data to Deckygram")
        if os.path.isdir(legacy_settings) and not os.path.exists(self.settings_path):
            decky.migrate_settings(legacy_settings)
            self.settings = self._load_settings()
            decky.logger.info("Moved SteamGram's settings to Deckygram")
