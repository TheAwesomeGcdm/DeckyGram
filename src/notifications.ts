import { findModuleExport, Navigation } from "@decky/ui";

// Decky's own toasts crash Steam's notification panel on current SteamOS builds, and other plugins may reroute
// them for that reason, which drops their avatar and click action. Deckygram instead sends Steam friend-message
// notifications from made-up senders that carry the Telegram chat's name and avatar.
// Another plugin already uses accounts 0xde000000-0xde0fffff for its made-up senders; Deckygram keeps clear of that range.
const STEAMID_BASE = BigInt("76561197960265728");
const SENDER_ACCOUNT_BASE = 0xdd000000;
const SENDER_ACCOUNT_MASK = 0xfffff;
// Friend-message notifications are type 2; only that type hands the sender back to Steam when it is selected.
const FRIEND_MESSAGE_NOTIFICATION = 2;

type Sender = { sid64: string; accountid: number; name: string };

export type TelegramNotification = {
  // Identifies the chat, so each chat keeps its own sender and its own click action.
  key: string;
  name: string;
  body: string;
  avatarUrl: string;
  playSound: boolean;
  onSelect: () => void;
};

const isDeckygramSender = (accountid: number) =>
  accountid >= SENDER_ACCOUNT_BASE && accountid <= SENDER_ACCOUNT_BASE + SENDER_ACCOUNT_MASK;

function senderFor(key: string, name: string): Sender {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) hash = (Math.imul(hash, 33) ^ key.charCodeAt(index)) >>> 0;
  const accountid = SENDER_ACCOUNT_BASE + (hash & SENDER_ACCOUNT_MASK);
  return { sid64: (STEAMID_BASE + BigInt(accountid)).toString(), accountid, name };
}

function personaOf(sender: Sender) {
  const friendStore = (window as any).friendStore;
  return friendStore?.GetFriendState?.({
    GetAccountID: () => sender.accountid,
    ConvertTo64BitString: () => sender.sid64,
    BIsValid: () => true,
  })?.m_persona ?? null;
}

// Steam refreshes an unknown sender's persona shortly after it appears and clears its name. The name is a
// non-configurable MobX field, so it is written again until Steam stops, and periodically for the tray.
const senders = new Map<number, Sender>();
let nameGuard: number | undefined;

function restoreName(sender: Sender) {
  try {
    const persona = personaOf(sender);
    if (persona && persona.m_strPlayerName !== sender.name) persona.m_strPlayerName = sender.name;
  } catch {
    // The toast still shows, just without the name.
  }
}

function prepareSender(sender: Sender, avatarUrl: string) {
  const persona = personaOf(sender);
  if (!persona) return;
  restoreName(sender);
  for (const key of ["avatar_url_small", "avatar_url_medium", "avatar_url_full"]) {
    try {
      Object.defineProperty(persona, key, { get: () => avatarUrl, configurable: true });
    } catch {
      // Steam's default avatar is shown instead.
    }
  }
  senders.set(sender.accountid, sender);
  nameGuard ??= window.setInterval(() => senders.forEach(restoreName), 2000);
  for (const delay of [300, 800, 1500]) window.setTimeout(() => restoreName(sender), delay);
}

// Selecting a friend-message notification calls ShowFriendChatDialog with the sender; Deckygram's senders open
// their Telegram chat instead, and every other sender goes on to Steam (or another plugin's hook).
const selectActions = new Map<number, () => void>();
let chatDialogs: any = null;
let installedHook: ((...args: any[]) => unknown) | null = null;
let hookedPrevious: ((...args: any[]) => unknown) | null = null;

function ensureSelectHook() {
  chatDialogs ??= findModuleExport((exported: any) => exported
    && typeof exported.ShowFriendChatDialog === "function"
    && typeof exported.ShowChatRoomGroupDialog === "function");
  if (!chatDialogs || chatDialogs.ShowFriendChatDialog === installedHook) return;
  const previous = chatDialogs.ShowFriendChatDialog;
  const hook = function (this: unknown, context: unknown, steamID: any, ...rest: unknown[]) {
    let accountid = NaN;
    try {
      accountid = Number(steamID?.GetAccountID?.());
    } catch {
      // Not a sender Deckygram can recognise.
    }
    if (!isDeckygramSender(accountid)) return previous.call(this, context, steamID, ...rest);
    const action = selectActions.get(accountid);
    if (action) {
      Navigation.CloseSideMenus();
      action();
    }
    return undefined;
  };
  chatDialogs.ShowFriendChatDialog = hook;
  installedHook = hook;
  hookedPrevious = previous;
}

// Steam plays the friend-message sound for each notification. Deckygram's own are counted here when the sound
// setting is off; the count covers several messages from one chat arriving together.
const SILENT_WINDOW_MS = 8000;
const silentSenders = new Map<string, { remaining: number; expires: number }>();
let installedSoundPatch: ((notification: any) => unknown) | null = null;
let soundPrevious: ((notification: any) => unknown) | null = null;

function ensureSoundPatch() {
  const store = (window as any).NotificationStore;
  if (!store || typeof store.PlayNotificationSound !== "function" || store.PlayNotificationSound === installedSoundPatch) return;
  const previous = store.PlayNotificationSound;
  const patch = function (this: unknown, notification: any) {
    try {
      const data = notification?.data;
      const raw = typeof data?.steamid_sender === "function" ? data.steamid_sender() : data?.steamid_sender;
      const entry = raw == null ? undefined : silentSenders.get(String(raw));
      if (entry && entry.expires > Date.now()) {
        entry.remaining -= 1;
        if (entry.remaining <= 0) silentSenders.delete(String(raw));
        return undefined;
      }
    } catch {
      // Fall through to Steam's sound.
    }
    return previous.call(this, notification);
  };
  store.PlayNotificationSound = patch;
  installedSoundPatch = patch;
  soundPrevious = previous;
}

function silence(sender: Sender) {
  ensureSoundPatch();
  const entry = silentSenders.get(sender.sid64);
  const expires = Date.now() + SILENT_WINDOW_MS;
  if (entry && entry.expires > Date.now()) {
    entry.remaining += 1;
    entry.expires = expires;
  } else {
    silentSenders.set(sender.sid64, { remaining: 1, expires });
  }
}

// The first notification of a Steam session can arrive before the toast window subscribes, and is then never
// shown. If nothing is rendering shortly after the first one, it is sent once more.
let firstNotificationChecked = false;

function resendIfFirstWasDropped(send: () => void) {
  if (firstNotificationChecked) return;
  firstNotificationChecked = true;
  const store = (window as any).NotificationStore;
  if (typeof store?.BAnyContextRenderingToasts !== "function") return;
  window.setTimeout(() => {
    try {
      if (!store.BAnyContextRenderingToasts()) send();
    } catch {
      // Losing the first toast is the worst case either way.
    }
  }, 900);
}

export function showTelegramNotification(notification: TelegramNotification) {
  const client = (window as any).SteamClient?.ClientNotifications;
  if (typeof client?.DisplayClientNotification !== "function") return;
  const sender = senderFor(notification.key, notification.name);
  prepareSender(sender, notification.avatarUrl);
  selectActions.set(sender.accountid, notification.onSelect);
  ensureSelectHook();
  if (!notification.playSound) silence(sender);
  // Steam shows the proto title only outside Gaming Mode, as a group name; the sender's name already covers it.
  const send = () => client.DisplayClientNotification(
    FRIEND_MESSAGE_NOTIFICATION,
    JSON.stringify({ title: "", body: notification.body, steamid: sender.sid64 }),
    () => {},
  );
  send();
  resendIfFirstWasDropped(send);
}

export function stopTelegramNotifications() {
  if (nameGuard !== undefined) window.clearInterval(nameGuard);
  nameGuard = undefined;
  senders.clear();
  selectActions.clear();
  silentSenders.clear();
  // Only undo hooks that are still Deckygram's; another plugin may have wrapped them since.
  if (chatDialogs && chatDialogs.ShowFriendChatDialog === installedHook && hookedPrevious) {
    chatDialogs.ShowFriendChatDialog = hookedPrevious;
  }
  installedHook = null;
  hookedPrevious = null;
  const store = (window as any).NotificationStore;
  if (store && store.PlayNotificationSound === installedSoundPatch && soundPrevious) store.PlayNotificationSound = soundPrevious;
  installedSoundPatch = null;
  soundPrevious = null;
}
