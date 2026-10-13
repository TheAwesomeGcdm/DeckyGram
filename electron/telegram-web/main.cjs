const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");

const port = Number(process.env.DECKYGRAM_BRIDGE_PORT);
const token = process.env.DECKYGRAM_BRIDGE_TOKEN;
const profileDir = process.env.DECKYGRAM_TELEGRAM_PROFILE;
const logPath = process.env.DECKYGRAM_LOG_PATH;
const appUrl = "https://web.telegram.org/a/";
const maxBodyBytes = 16 * 1024;
// Pictures travel base64-encoded, so a 20 MB screenshot needs room for the encoding overhead.
const maxImageBodyBytes = 30 * 1024 * 1024;
const pageInitializationTimeoutMs = 60000;

let window;
let server;
let ready = false;
let pageLoadStartedAt = 0;
let pageLoadedAt = 0;
let initializationFailureLogged = false;
let currentChatId = null;
let loadError = null;
let cachedState = null;
let cachedStateAt = 0;
let statePromise = null;
let stateRevision = 0;

function log(message) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
}

function describeResourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const filename = url.pathname.split("/").filter(Boolean).pop() || "/";
    return `host=${url.host} file=${filename}`;
  } catch {
    return "host=<invalid> extension=<unknown>";
  }
}

function sanitizeConsoleMessage(message) {
  return String(message)
    .replace(/https?:\/\/[^\s"'`]+/gi, "<url>")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "<value>")
    .replace(/\b\d{5,}\b/g, "<number>")
    .slice(0, 300);
}

function logTelegramNetworkFailures(session) {
  const telegramUrlFilter = {
    urls: ["*://telegram.org/*", "*://*.telegram.org/*"],
  };
  session.webRequest.onErrorOccurred(telegramUrlFilter, (details) => {
    log(
      `Telegram resource request failed: type=${details.resourceType} `
      + `${describeResourceUrl(details.url)} error=${details.error}`,
    );
  });
  session.webRequest.onCompleted(telegramUrlFilter, (details) => {
    if (details.statusCode >= 400) {
      log(
        `Telegram resource returned HTTP ${details.statusCode}: type=${details.resourceType} `
        + describeResourceUrl(details.url),
      );
    }
  });
}

function jsonResponse(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function readBody(request, limit = maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > limit) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

const MAX_IMAGE_FILE_BYTES = 48 * 1024 * 1024;

// Shared by state collection and /message-image: finds the picture Telegram rendered for a message,
// skipping avatars, emoji, reply quotes and blurred placeholder thumbnails.
// Page helpers for acting on one message through Telegram's own context menu. Telegram's classes are mostly
// hashed, but menu items carry stable icon names (icon-reply, icon-edit, icon-delete).
const messageMenuSource = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const waitFor = async (find, timeoutMs) => {
    for (let waited = 0; waited <= timeoutMs; waited += 100) {
      const found = find();
      if (found) return found;
      await sleep(100);
    }
    return null;
  };
  // Telegram buttons act on mousedown or on click depending on the button; a full press reaches either once.
  const press = (element) => {
    const pointer = { bubbles: true, cancelable: true, button: 0, view: window };
    element.dispatchEvent(new MouseEvent("mousedown", pointer));
    element.dispatchEvent(new MouseEvent("mouseup", pointer));
    element.click();
  };
  const findMessage = (messageId) => {
    const list = Array.from(document.querySelectorAll("#MiddleColumn .MessageList"))
      .find((candidate) => !candidate.hasAttribute("data-deckygram-stale"));
    return list?.querySelector('[data-message-id="' + messageId + '"]') || null;
  };
  const openMenu = () => {
    const bubble = document.querySelector(".MessageContextMenu .bubble");
    return bubble && bubble.classList.contains("open") && bubble.querySelector(".MenuItem") ? bubble : null;
  };
  const openMessageMenu = async (messageId) => {
    const message = findMessage(messageId);
    if (!message) return null;
    message.scrollIntoView({ block: "center" });
    await sleep(150);
    // The event goes to the bubble itself, so a link under the pointer cannot swallow it.
    const target = message.querySelector(".message-content, .text-content") || message;
    const rect = target.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: rect.left + 8, clientY: rect.top + 8, view: window };
    target.dispatchEvent(new MouseEvent("mousedown", options));
    target.dispatchEvent(new MouseEvent("contextmenu", options));
    return waitFor(openMenu, 3000);
  };
  const closeMenus = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  const menuItem = (menu, icon) => Array.from(menu.querySelectorAll(".MenuItem"))
    .find((item) => item.querySelector("i.icon-" + icon) && !item.classList.contains("disabled"));
  const quickReactions = (menu) => Array.from(menu.querySelectorAll(".ReactionSelector__reactions > *"))
    .filter((item) => !item.matches(".ReactionSelector__show-more"));
  const composerEditor = () => Array.from(document.querySelectorAll("#editable-message-text")).find(visible) || null;
  const replaceText = (element, text) => {
    element.focus();
    document.execCommand("selectAll", false);
    if (text) document.execCommand("insertText", false, text);
    else document.execCommand("delete", false);
  };
  // With "Animated emoji" on, quick reactions are unlabelled animations; with it off they are images whose alt
  // text is the emoji. This turns it off once in Deckygram's own Telegram (Settings > Animations and
  // Performance), which only changes how this browser draws emoji, then returns to the chat list.
  const disableAnimatedEmoji = async () => {
    const backToChats = async () => {
      for (let step = 0; step < 4; step += 1) {
        const back = Array.from(document.querySelectorAll("#LeftColumn .left-header button"))
          .find((button) => visible(button) && button.querySelector("i.icon-arrow-left"));
        if (!back) return;
        press(back);
        await sleep(500);
      }
    };
    const menuButton = Array.from(document.querySelectorAll(".LeftMainHeader button.Button.round")).find(visible);
    if (!menuButton) return false;
    press(menuButton);
    const settings = await waitFor(() => Array.from(document.querySelectorAll(".MenuItem"))
      .find((item) => item.querySelector("i.icon-settings") && visible(item)), 2000);
    if (!settings) {
      closeMenus();
      return false;
    }
    press(settings);
    const performance = await waitFor(() => Array.from(document.querySelectorAll("#LeftColumn .ListItem"))
      .find((item) => item.querySelector("i.icon-animations-filled") && visible(item)), 3000);
    if (!performance) {
      await backToChats();
      return false;
    }
    press(performance.querySelector(".ListItem-button") || performance);
    const section = await waitFor(() => document.querySelector("input[name=SettingsPerformanceStickers]"), 3000);
    // The section's arrow expands it; its checkbox would switch the whole group.
    const arrow = section?.closest("label")?.querySelector(".right-icon");
    if (arrow && !document.querySelector("input[name=animatedEmoji]")) press(arrow);
    const animatedEmoji = await waitFor(() => document.querySelector("input[name=animatedEmoji]"), 2000);
    if (animatedEmoji?.checked) animatedEmoji.click();
    await sleep(300);
    const done = Boolean(animatedEmoji && !animatedEmoji.checked);
    await backToChats();
    return done;
  };
`;

// Page helpers for Telegram's sticker picker (the composer's symbol menu). Stickers carry a stable
// data-sticker-id and their emoji as the title; clicking one sends it.
const stickerPickerSource = `
  // Only stickers inside real sets count: the strip of set covers at the top and the trending Premium set
  // (no id) also carry sticker ids, and the emoji tab has symbol sets of its own. Set 0 is Recently Used.
  const stickerButtons = () => Array.from(document.querySelectorAll(".symbol-set[id*='sticker-set'] .StickerButton[data-sticker-id]"))
    .filter(visible);
  const symbolButton = () => Array.from(document.querySelectorAll(".Composer .symbol-menu-button")).find(visible) || null;
  const scrollerOf = (element) => {
    let node = element?.parentElement;
    while (node && node !== document.body) {
      const overflow = getComputedStyle(node).overflowY;
      if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return null;
  };
  const openStickerPicker = async () => {
    if (!stickerButtons().length) {
      const tab = () => Array.from(document.querySelectorAll(".SymbolMenu-footer .symbol-tab-button"))
        .find((button) => button.querySelector(".icon-stickers") && visible(button)) || null;
      if (!tab()) {
        const opener = symbolButton();
        if (!opener) return null;
        press(opener);
        if (!await waitFor(tab, 3000)) return null;
      }
      press(tab());
    }
    const first = await waitFor(() => stickerButtons()[0], 5000);
    return first ? scrollerOf(first) || first.parentElement : null;
  };
  // Telegram only closes the picker for a trusted Escape, which the main process sends afterwards if needed.
  const closeStickerPicker = async () => {
    closeMenus();
    await sleep(300);
  };
  // A small picture of what the sticker looks like right now: its full image, a video frame, an animation
  // frame or the thumbnail, whichever has loaded.
  const stickerImage = (button) => {
    const toUrl = (source, width, height) => {
      if (!width || !height) return "";
      const scale = Math.min(1, 96 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", 0.85);
    };
    try {
      const image = Array.from(button.querySelectorAll("img")).find((candidate) => candidate.complete && candidate.naturalWidth);
      if (image) return toUrl(image, image.naturalWidth, image.naturalHeight);
      const video = button.querySelector("video");
      if (video && video.readyState >= 2) return toUrl(video, video.videoWidth, video.videoHeight);
      const canvas = button.querySelector("canvas");
      if (canvas && canvas.width) return toUrl(canvas, canvas.width, canvas.height);
    } catch {
      // Cross-origin or worker-drawn; the panel falls back to the emoji.
    }
    return "";
  };
`;

const pickMessageImageSource = `(element) => {
  const images = Array.from(element.querySelectorAll(
    ".media-inner img, .Photo img, .Album img, .sticker-media img, img.full-media, .Video img, .RoundVideo img",
  )).filter((image) => !image.closest(".Avatar, .MessageMeta, .Reactions, .message-title, .EmbeddedMessage")
    && !image.classList.contains("thumbnail")
    && !image.classList.contains("emoji"));
  return images.find((image) => image.complete && image.naturalWidth > 0) || images[0] || null;
}`;

// A sticker message's best picture source: the full sticker image, a video frame or the animation canvas.
// Telegram's blurred placeholder thumbnail is only the last resort. Quoted stickers in replies do not count.
const pickStickerSource = `(element) => {
  const own = (node) => !node.closest(".EmbeddedMessage");
  const sticker = Array.from(element.querySelectorAll(".Sticker")).find(own);
  if (!sticker) return null;
  const images = Array.from(sticker.querySelectorAll("img")).filter((image) => image.complete && image.naturalWidth);
  const full = images.find((image) => image.classList.contains("sticker-media"));
  if (full) return { source: full, width: full.naturalWidth, height: full.naturalHeight };
  const video = Array.from(sticker.querySelectorAll("video")).find((candidate) => candidate.readyState >= 2 && candidate.videoWidth);
  if (video) return { source: video, width: video.videoWidth, height: video.videoHeight };
  const canvas = Array.from(sticker.querySelectorAll("canvas")).find((candidate) => candidate.width && candidate.height);
  if (canvas) return { source: canvas, width: canvas.width, height: canvas.height };
  const fallback = images[0];
  return fallback ? { source: fallback, width: fallback.naturalWidth, height: fallback.naturalHeight } : { source: null, width: 0, height: 0 };
}`;

// A GIF or video message's poster: the playing video's current frame, else Telegram's sharp thumbnail.
// The blurred background canvas never counts.
const pickVideoPosterSource = `(element) => {
  const own = (node) => !node.closest(".EmbeddedMessage");
  const media = Array.from(element.querySelectorAll(".media-inner")).find((node) => own(node)
    && (node.querySelector("video") || node.querySelector(".message-media-duration")));
  if (!media || media.closest(".RoundVideo")) return null;
  const video = media.querySelector("video");
  if (video && video.readyState >= 2 && video.videoWidth) return { source: video, width: video.videoWidth, height: video.videoHeight };
  const image = Array.from(media.querySelectorAll("img")).find((candidate) => candidate.complete && candidate.naturalWidth);
  if (image) return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  const canvas = Array.from(media.querySelectorAll("canvas")).find((candidate) => !candidate.classList.contains("blurred-bg") && candidate.width > 64);
  if (canvas) return { source: canvas, width: canvas.width, height: canvas.height };
  return { source: null, width: 0, height: 0 };
}`;

async function evaluate(expression) {
  if (!window || window.isDestroyed() || !ready) {
    throw new Error("Telegram Web is still loading");
  }
  return window.webContents.executeJavaScript(expression, true);
}

async function collectTelegramState() {
  if (loadError) {
    return { status: "error", error: `Unable to load Telegram Web: ${loadError}`, qr_image: null, chats: [] };
  }
  if (!ready) {
    if (pageLoadStartedAt && Date.now() - pageLoadStartedAt > pageInitializationTimeoutMs) {
      return {
        status: "error",
        error: "Electron opened, but Telegram Web did not finish loading within 60 seconds. Check your Deck's network connection and the Telegram Web startup log, then retry.",
        qr_image: null,
        chats: [],
      };
    }
    return { status: "connecting", error: null, qr_image: null, chats: [] };
  }
  const page = await evaluate(`(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    // Telegram's avatars are blob: URLs that only resolve inside this window, so hand the
    // plugin a small inline copy instead, cached per source to avoid re-encoding every poll.
    const avatarCache = window.__deckygramAvatarCache || (window.__deckygramAvatarCache = new Map());
    const avatarDataUrl = (image) => {
      const source = image?.currentSrc || image?.src || "";
      if (!source) return "";
      if (avatarCache.has(source)) return avatarCache.get(source);
      if (!image.complete || !image.naturalWidth) return "";
      let result = "";
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        canvas.getContext("2d").drawImage(image, 0, 0, 64, 64);
        result = canvas.toDataURL("image/webp", 0.8);
      } catch {
        result = "";
      }
      if (avatarCache.size > 300) avatarCache.clear();
      avatarCache.set(source, result);
      return result;
    };
    const parseCompactCount = (value) => {
      const match = (value || "").trim().match(/^(\\d+(?:[.,]\\d+)?)\\s*([KkMm])?/);
      if (!match) return 0;
      const multiplier = { k: 1e3, m: 1e6 }[(match[2] || "").toLowerCase()] || 1;
      return Math.round(Number(match[1].replace(",", ".")) * multiplier);
    };
    // While a count changes, each changed digit holds the new, old and new character again; the first is current.
    const counterText = (counter) => Array.from(counter.childNodes)
      .map((node) => (node.firstElementChild || node).textContent)
      .join("");
    const unreadBadgeCounts = (row) => {
      // Telegram Web A now styles badges with hashed CSS module classes; only the transition wrapper keeps
      // a stable name. The unread count is the badge holding a counter; mention, reaction and pin badges hold icons.
      const current = Array.from(row.querySelectorAll(".chat-badge-transition.open div"))
        .filter((badge) => badge.querySelector(":scope > span") && !badge.querySelector("i, svg, .icon"))
        .map((badge) => parseCompactCount(counterText(badge.querySelector(":scope > span"))));
      const legacy = Array.from(row.querySelectorAll(".ChatBadge, .badge"))
        .filter((badge) => !badge.matches(".mention, .reaction, .pinned, [class*=mention], [class*=reaction]"))
        .map((badge) => parseCompactCount(badge.textContent));
      return [...current, ...legacy];
    };
    // Telegram's sent icon is not named icon-message-succeeded in current builds, so any status icon
    // that is not read, pending or failed is treated as sent.
    const outgoingStatus = (scope) => {
      const container = scope?.querySelector(".MessageOutgoingStatus");
      if (!container) return "";
      const names = Array.from(container.querySelectorAll("[class]"))
        .map((node) => node.getAttribute("class") || "")
        .concat(container.getAttribute("class") || "")
        .join(" ");
      if (/read/i.test(names)) return "read";
      if (/pending|clock|sending/i.test(names)) return "pending";
      if (/fail|error/i.test(names)) return "failed";
      return container.querySelector("i, svg, [class*=icon]") ? "sent" : "";
    };
    const outgoingStatusClassCounts = {};
    document.querySelectorAll(".MessageOutgoingStatus, .MessageOutgoingStatus [class]").forEach((node) => {
      for (const name of node.classList) outgoingStatusClassCounts[name] = (outgoingStatusClassCounts[name] || 0) + 1;
    });
    const typingText = (scope) => {
      const element = scope?.querySelector(".typing-status");
      return element ? (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim() : "";
    };
    const conversationClassCounts = {};
    document.querySelectorAll("#MiddleColumn [class]").forEach((node) => {
      for (const name of node.classList) {
        if (/typing|OutgoingStatus|icon-message-/i.test(name)) {
          conversationClassCounts[name] = (conversationClassCounts[name] || 0) + 1;
        }
      }
    });
    const chatRowClassCounts = {};
    document.querySelectorAll(".chat-list .ListItem [class]").forEach((node) => {
      for (const name of node.classList) {
        if (/badge|muted|unread|mention|typing|OutgoingStatus|icon-message-/i.test(name)) chatRowClassCounts[name] = (chatRowClassCounts[name] || 0) + 1;
      }
    });
    const qrContainer = document.querySelector("#auth-qr-form .qr-container");
    const passwordInput = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
    const loginForm = document.querySelector("#auth-qr-form, #auth-password-form, #auth-code-form, #auth-phone-number-form");
    const login = Boolean(loginForm || passwordInput);
    const loginError = loginForm?.querySelector(".error, .error-message, [class*=error]")?.textContent?.trim() || "";
    const chatList = document.querySelector(".chat-list, .chatlist, ul.chatlist, [class~='ChatList']");
    const allRows = Array.from(document.querySelectorAll(".chat-list .ListItem"));
    const rows = allRows.filter(visible)
      .map((element) => {
        const index = allRows.indexOf(element);
        const lines = (element.innerText || "").split("\\n").map((line) => line.trim()).filter(Boolean);
        const title = element.querySelector(".fullName, .peer-title, .chat-title")?.textContent?.trim() || lines[0] || "Telegram chat";
        // The time now shares the title's line, so the first other line is the date, not the message.
        // Telegram spaces the sender's colon with CSS, so the prefix and the summary are joined by hand.
        const lastMessage = element.querySelector(".subtitle .last-message");
        const squash = (value) => (value || "").replace(/\\s+/g, " ").trim();
        const summary = lastMessage?.querySelector(".last-message-summary");
        const prefix = squash(lastMessage?.querySelector(".sender-name, .draft")?.innerText).replace(/:$/, "");
        const preview = (summary ? (prefix ? prefix + ": " : "") + squash(summary.innerText) : squash(lastMessage?.innerText))
          || lines.find((line) => line !== title) || "";
        const unread = Math.max(0, ...unreadBadgeCounts(element));
        const avatarImage = avatarDataUrl(element.querySelector(
          "img.Avatar__media, .Avatar img.avatar-media, .Avatar img, img.avatar-media",
        ));
        // Telegram Web links each chat as #<peer id>: users are positive, groups and channels negative.
        const peerHref = (element.matches("a[href]") ? element : element.querySelector("a[href]"))?.getAttribute("href") || "";
        const peerMatch = peerHref.match(/^#(-?\\d+)/);
        const peerId = peerMatch ? Number(peerMatch[1]) : null;
        const rowDescription = (element.getAttribute("aria-label") || "") + " " + (element.className || "");
        const isGroup = peerId !== null
          ? peerId < 0
          : Boolean(element.querySelector(
            '[data-peer-type="group"], [class*="group-avatar"], [class*="GroupAvatar"], [aria-label*="group" i]',
          )) || /group|supergroup|channel/i.test(rowDescription);
        const isMuted = Boolean(element.querySelector(".ChatBadge.muted, .icon-muted"));
        const isArchiveFolder = /^archived chats?(?:\\s+(?:\\(\\d+\\)|\\d+))?$/i.test(title);
        return {
          id: index,
          title,
          last_message: preview,
          last_message_date: 0,
          unread_count: unread,
          avatar_url: avatarImage,
          is_group: isGroup,
          is_direct: peerId !== null ? peerId > 0 : (!isGroup && !isArchiveFolder),
          is_muted: isMuted,
          typing_text: typingText(element),
          last_message_status: outgoingStatus(element.querySelector(".LastMessageMeta") || element),
          is_archive_folder: isArchiveFolder,
          has_pin_icon: Boolean(element.querySelector(".chat-badge-transition .icon-pin-filled")),
        };
      });
    // Pinned chats sit together at the top of Telegram's list, but their pin icon gives way to the unread
    // count, so every chat down to the last one still showing a pin counts as pinned.
    const lastPinned = rows.reduce((last, row, position) => (row.has_pin_icon ? position : last), -1);
    rows.forEach((row, position) => {
      row.is_pinned = position <= lastPinned && !row.is_archive_folder;
      delete row.has_pin_icon;
    });
    const activeRow = document.querySelector(".chat-list .ListItem.active, .chat-list .ListItem.selected");
    const preferredChatId = ${JSON.stringify(currentChatId)};
    const selectedChatId = preferredChatId !== null ? preferredChatId : (activeRow ? allRows.indexOf(activeRow) : null);
    const titleElement = document.querySelector(".MiddleHeader .peer-title, .MiddleHeader .title, [class*=MiddleHeader] [dir=auto]");
    // While Telegram slides between chats, the previous chat's list can still be in the DOM.
    const messageList = Array.from(document.querySelectorAll("#MiddleColumn .MessageList"))
      .find((list) => !list.hasAttribute("data-deckygram-stale") && visible(list))
      || document.querySelector(
        "#MiddleColumn .MessageList, .MessageList[data-list-key], .MessageList, .messages-container, .chat-container",
      );
    const messageScope = messageList || document;
    const diagnosticElements = Array.from(document.querySelectorAll("main, [role=main], [class], [id]"))
      .filter((element) => {
        if (!visible(element)) return false;
        if (element.closest(".chat-list")) return false;
        const signature = (element.id || "") + " "
          + (typeof element.className === "string" ? element.className : "");
        return /message|bubble|history|middle|conversation|scroll|chat|column|transition/i.test(signature);
      });
    const domRegionDiagnostics = diagnosticElements
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const identity = tag + (element.id ? "#" + element.id : "")
          + Array.from(element.classList).slice(0, 3).map((name) => "." + name).join("");
        const rect = element.getBoundingClientRect();
        const scrollable = element.scrollHeight > element.clientHeight + 80;
        const textLength = (element.innerText || "").length;
        return {
          identity,
          children: element.children.length,
          scrollable,
          textLength,
          area: Math.round(rect.width * rect.height),
        };
      })
      .sort((left, right) => Number(right.scrollable) - Number(left.scrollable) || right.area - left.area)
      .slice(0, 8)
      .map((region) => region.identity + "[children=" + region.children
        + ",scroll=" + region.scrollable + ",textLength=" + region.textLength + "]");
    const identifiedMessages = Array.from(messageScope.querySelectorAll(
      ".Message.message-list-item[data-message-id], .Message[data-message-id], [data-message-id], [data-mid]",
    ));
    const messageCandidates = identifiedMessages.length
      ? identifiedMessages
      : Array.from(messageScope.querySelectorAll(
        ".Message.message-list-item, .Message, .message-list-item, .message",
      )).filter((element) => element.children.length === 0 || /message|bubble/i.test(element.className || ""));
    const pickMessageImage = ${pickMessageImageSource};
    const pickSticker = ${pickStickerSource};
    const pickVideoPoster = ${pickVideoPosterSource};
    const describeMedia = (element) => {
      if (element.querySelector(".sticker-media, .Sticker, [class*=sticker]")) return "Sticker";
      if (element.querySelector(".RoundVideo")) return "Video message";
      // Telegram labels GIFs (silent looping MP4s) with "GIF" where videos show their length.
      if (/^gif$/i.test(element.querySelector(".message-media-duration")?.textContent?.trim() || "")) return "GIF";
      if (element.querySelector(".Audio.voice, .Audio [class*=voice], .voice")) return "Voice message";
      if (element.querySelector(".Audio")) return "Audio";
      if (element.querySelector(".Video, video")) return "Video";
      if (element.querySelector(".Photo, .media-inner img, .Album")) return "Photo";
      if (element.querySelector(".Document, .File")) return "File";
      if (element.querySelector(".Poll")) return "Poll";
      if (element.querySelector(".Location, .Venue")) return "Location";
      if (element.querySelector(".Contact")) return "Contact";
      return "";
    };
    const readText = (element) => {
      if (!element) return "";
      const copy = element.cloneNode(true);
      copy.querySelectorAll(".MessageMeta, .Reactions, .message-time, .message-signature").forEach((node) => node.remove());
      return (copy.innerText || copy.textContent || "").trim();
    };
    const messages = messageCandidates
      .filter(visible)
      .slice(-50)
      .map((element, index) => {
        const isService = element.matches(".ActionMessage, [class*=ActionMessage]");
        // A reply shows the quoted message in an EmbeddedMessage box ahead of its own text, using the same
        // text and title classes, so everything about the message itself is looked up outside that box.
        const embedded = isService ? null : element.querySelector(".EmbeddedMessage");
        const outsideQuote = (selector) => Array.from(element.querySelectorAll(selector))
          .find((node) => !node.closest(".EmbeddedMessage")) || null;
        const body = outsideQuote(
          ".message-content-wrapper > .text-content, .message-content-wrapper .text-content, .text-content, .message-text, .translatable-message",
        );
        const withoutQuote = embedded ? element.cloneNode(true) : element;
        if (embedded) withoutQuote.querySelectorAll(".EmbeddedMessage").forEach((node) => node.remove());
        const timeElement = element.querySelector(".MessageMeta .message-time, span.message-time, time, [data-timestamp]");
        const rawTime = timeElement?.getAttribute("datetime") || timeElement?.getAttribute("data-timestamp");
        const numericTime = Number(rawTime);
        const parsedTime = rawTime
          ? (Number.isFinite(numericTime) ? (numericTime > 1e12 ? numericTime / 1000 : numericTime) : Date.parse(rawTime) / 1000)
          : 0;
        const id = Number(element.getAttribute("data-message-id") || element.getAttribute("data-mid")) || index;
        const outgoing = element.classList.contains("own");
        const dayGroup = element.closest(".message-date-group");
        const text = isService ? readText(element) : readText(body);
        return {
          id,
          date: Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : 0,
          time_label: timeElement?.textContent?.trim() || "",
          day_label: dayGroup?.querySelector(".sticky-date")?.textContent?.trim() || "",
          text,
          media: isService ? "" : (describeMedia(withoutQuote) || (text ? "" : "Unsupported message")),
          sender: outgoing
            ? "You"
            : (outsideQuote(".message-title-name, .sender-title, .message-title .title")?.textContent?.trim() || ""),
          media_duration: isService ? "" : (withoutQuote.querySelector(".message-media-duration")?.textContent?.trim() || ""),
          reply: embedded ? {
            sender: embedded.querySelector(".embedded-sender")?.textContent?.trim() || "",
            text: (embedded.querySelector(".embedded-text-wrapper")?.innerText || "").replace(/\\s+/g, " ").trim(),
          } : null,
          is_outgoing: outgoing,
          is_service: isService,
          status: outgoing ? outgoingStatus(element.querySelector(".MessageMeta") || element) : "",
          image: (() => {
            const sticker = isService ? null : pickSticker(element);
            if (sticker) return { width: sticker.width, height: sticker.height, ready: Boolean(sticker.source) };
            const poster = isService ? null : pickVideoPoster(element);
            if (poster) return { width: poster.width, height: poster.height, ready: Boolean(poster.source) };
            const image = isService ? null : pickMessageImage(element);
            if (!image) return null;
            return {
              width: image.naturalWidth || image.width || 0,
              height: image.naturalHeight || image.height || 0,
              ready: Boolean(image.complete && image.naturalWidth),
            };
          })(),
        };
      })
      .filter((message) => message.text || message.media);
    const visibleMessageCandidateCount = messageCandidates.filter(visible).length;
    return {
      status: passwordInput ? "password" : (login ? "login" : (chatList || document.querySelector(".MessageList") ? "ready" : "connecting")),
      page_title: document.title,
      page_ready_state: document.readyState,
      login_form_found: Boolean(loginForm),
      chat_list_found: Boolean(chatList),
      script_count: document.scripts.length,
      module_script_count: document.querySelectorAll('script[type="module"]').length,
      service_worker_supported: "serviceWorker" in navigator,
      service_worker_controlled: Boolean(navigator.serviceWorker?.controller),
      performance_resource_count: performance.getEntriesByType("resource").length,
      message_count: messages.length,
      message_root_found: Boolean(messageList),
      message_root: messageList
        ? messageList.tagName.toLowerCase()
          + (messageList.id ? "#" + messageList.id : "")
          + Array.from(messageList.classList).map((name) => "." + name).join("")
        : null,
      identified_message_count: identifiedMessages.length,
      message_candidate_count: messageCandidates.length,
      visible_message_candidate_count: visibleMessageCandidateCount,
      message_class_count: messageScope.querySelectorAll(".Message").length,
      message_id_attribute_count: messageScope.querySelectorAll("[data-message-id], [data-mid]").length,
      chat_row_class_counts: chatRowClassCounts,
      conversation_class_counts: conversationClassCounts,
      outgoing_status_class_counts: outgoingStatusClassCounts,
      typing_text: typingText(document.querySelector("#MiddleColumn .MiddleHeader")),
      dom_region_diagnostics: [
        "page[visibility=" + document.visibilityState + ",viewport=" + window.innerWidth + "x" + window.innerHeight + "]",
        (() => {
          const middle = document.getElementById("MiddleColumn");
          if (!middle) return "MiddleColumn[missing]";
          const rect = middle.getBoundingClientRect();
          return "MiddleColumn[" + Math.round(rect.width) + "x" + Math.round(rect.height)
            + ",layout=" + Boolean(middle.querySelector(".messages-layout")) + "]";
        })(),
        ...domRegionDiagnostics,
      ],
      login_error: loginError,
      qr_svg: (() => {
        const svg = qrContainer?.querySelector("svg");
        return svg ? new XMLSerializer().serializeToString(svg) : null;
      })(),
      chats: rows,
      selected_chat_id: selectedChatId,
      selected_chat_title: titleElement?.textContent?.trim() || "",
      messages,
    };
  })()`);

  if (
    page.status === "connecting"
    && pageLoadedAt
    && Date.now() - pageLoadedAt > pageInitializationTimeoutMs
  ) {
    if (!initializationFailureLogged) {
      initializationFailureLogged = true;
      log(
        `Telegram Web app UI did not initialize: title=${JSON.stringify(page.page_title)}, `
        + `readyState=${page.page_ready_state}, loginForm=${page.login_form_found}, chatList=${page.chat_list_found}, `
        + `scripts=${page.script_count}, moduleScripts=${page.module_script_count}, `
        + `serviceWorkerSupported=${page.service_worker_supported}, `
        + `serviceWorkerControlled=${page.service_worker_controlled}, `
        + `performanceResources=${page.performance_resource_count}, `
        + `documentUrl=${describeResourceUrl(window.webContents.getURL())}`,
      );
    }
    return {
      status: "error",
      error: "Telegram Web loaded, but its login or chat interface did not initialize. Check the Deckygram Electron log for renderer and network errors, then retry.",
      qr_image: null,
      chats: [],
    };
  }

  return {
    status: page.status,
    login_error: page.login_error,
    qr_image: page.qr_svg ? Buffer.from(page.qr_svg, "utf8").toString("base64") : null,
    chats: page.chats,
    selected_chat_id: page.selected_chat_id,
    selected_chat_title: page.selected_chat_title,
    messages: page.messages,
    message_count: page.message_count,
    message_root_found: page.message_root_found,
    message_root: page.message_root,
    identified_message_count: page.identified_message_count,
    message_candidate_count: page.message_candidate_count,
    visible_message_candidate_count: page.visible_message_candidate_count,
    message_class_count: page.message_class_count,
    message_id_attribute_count: page.message_id_attribute_count,
    dom_region_diagnostics: page.dom_region_diagnostics,
    chat_row_class_counts: page.chat_row_class_counts,
    conversation_class_counts: page.conversation_class_counts,
    outgoing_status_class_counts: page.outgoing_status_class_counts,
    typing_text: page.typing_text,
    selected_chat_title: page.selected_chat_title,
    error: null,
  };
}

async function readTelegramState() {
  if (statePromise) return statePromise;
  if (cachedState && Date.now() - cachedStateAt < 1000) return cachedState;

  const revision = stateRevision;
  const pending = collectTelegramState();
  statePromise = pending;
  try {
    const state = await pending;
    if (revision === stateRevision) {
      cachedState = state;
      cachedStateAt = Date.now();
    }
    return state;
  } finally {
    if (statePromise === pending) statePromise = null;
  }
}

async function handleRequest(request, response) {
  if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
    return jsonResponse(response, 403, { error: "Loopback requests only" });
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    return jsonResponse(response, 401, { error: "Unauthorized" });
  }

  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (request.method === "GET" && url.pathname === "/state") {
      return jsonResponse(response, 200, await readTelegramState());
    }
    if (request.method === "GET" && url.pathname === "/chats") {
      const state = await readTelegramState();
      return jsonResponse(response, 200, { chats: state.chats });
    }
    if (request.method === "GET" && url.pathname === "/messages") {
      const state = await readTelegramState();
      return jsonResponse(response, 200, { messages: state.messages });
    }
    if (request.method === "POST" && url.pathname === "/submit-password") {
      const body = await readBody(request);
      if (typeof body.password !== "string" || !body.password.trim()) {
        return jsonResponse(response, 400, { error: "Cloud password cannot be empty" });
      }
      const result = await evaluate(`(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const input = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
        if (!input) return "missing-password-field";
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(body.password)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const form = input.closest("form");
        if (form?.requestSubmit) {
          form.requestSubmit();
        } else {
          const button = Array.from((form || document).querySelectorAll("button"))
            .find((element) => visible(element) && !element.disabled);
          if (!button) return "missing-submit-button";
          button.click();
        }
        return "submitted";
      })()`, true);
      if (result !== "submitted") {
        return jsonResponse(response, 409, {
          error: result === "missing-password-field"
            ? "Telegram's cloud-password field is no longer available. Refresh the login screen and try again."
            : "Telegram's password submit button was not found.",
        });
      }
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/open-chat") {
      const body = await readBody(request);
      const chatId = Number(body.chat_id);
      if (!Number.isInteger(chatId) || chatId < 0) {
        return jsonResponse(response, 400, { error: "Invalid chat index" });
      }
      currentChatId = null;
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      const target = await evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll(".chat-list .ListItem"));
        const row = rows[${chatId}];
        if (!row) return null;
        const clickable = row.querySelector(".ListItem-button, a[href]") || row;
        const alreadyOpen = row.matches(".active, .selected")
          && Boolean(document.querySelector("#MiddleColumn .messages-layout .MessageList"));
        if (!alreadyOpen) {
          document.querySelectorAll("#MiddleColumn .MessageList").forEach((list) => {
            list.setAttribute("data-deckygram-stale", "");
          });
        }
        clickable.scrollIntoView({ block: "center" });
        const rect = clickable.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          alreadyOpen,
        };
      })()`);
      if (target === null) {
        return jsonResponse(response, 404, { error: "Chat is no longer in the visible chat list" });
      }

      // The previous chat's list stays in the DOM during Telegram's slide transition, so only a
      // list that was not marked stale before the click counts as the newly opened conversation.
      const hasConversationLayout = async () => evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll(".chat-list .ListItem"));
        const row = rows[${chatId}];
        const freshList = Array.from(document.querySelectorAll("#MiddleColumn .messages-layout .MessageList"))
          .some((list) => !list.hasAttribute("data-deckygram-stale"));
        const rowTitle = row?.querySelector(".fullName, .peer-title, .chat-title")?.textContent?.trim();
        const headerTitle = document.querySelector("#MiddleColumn .MiddleHeader .fullName")?.textContent?.trim();
        return freshList || Boolean(rowTitle && headerTitle && rowTitle === headerTitle
          && document.querySelector("#MiddleColumn .messages-layout"));
      })()`);
      const waitForMessages = async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const loaded = await evaluate(`Boolean(Array.from(document.querySelectorAll("#MiddleColumn .MessageList"))
            .find((list) => !list.hasAttribute("data-deckygram-stale"))?.querySelector("[data-message-id]"))`);
          if (loaded) return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };
      const waitForConversationLayout = async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (await hasConversationLayout()) return true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return false;
      };

      let conversationReady = target.alreadyOpen;
      let openMethod = "existing conversation";
      if (!conversationReady) {
        // Telegram Web opens chats on mousedown for desktop pointers, so element.click() alone does nothing.
        window.webContents.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
        window.webContents.sendInputEvent({ type: "mouseDown", x: target.x, y: target.y, button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount: 1 });
        conversationReady = await waitForConversationLayout();
        openMethod = "trusted mouse input";
      }

      if (!conversationReady) {
        openMethod = "synthetic pointer events";
        await evaluate(`(() => {
          const rows = Array.from(document.querySelectorAll(".chat-list .ListItem"));
          const row = rows[${chatId}];
          if (!row) return false;
          const clickable = row.querySelector(".ListItem-button, a[href]") || row;
          const rect = clickable.getBoundingClientRect();
          const init = {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 0,
            buttons: 1,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          };
          clickable.dispatchEvent(new PointerEvent("pointerdown", init));
          clickable.dispatchEvent(new MouseEvent("mousedown", init));
          clickable.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
          clickable.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
          clickable.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
          return true;
        })()`);
        conversationReady = await waitForConversationLayout();
      }

      if (conversationReady) await waitForMessages();
      log(conversationReady
        ? `Opened Telegram chat via ${openMethod}`
        : "Telegram chat did not open after trusted mouse input or synthetic pointer events");

      if (!conversationReady) {
        return jsonResponse(response, 409, {
          error: "Telegram did not open this chat. Its conversation view did not appear; try selecting the chat again.",
        });
      }

      currentChatId = chatId;
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      return jsonResponse(response, 200, await readTelegramState());
    }
    if (request.method === "POST" && url.pathname === "/message-image") {
      const body = await readBody(request);
      const messageId = Number(body.message_id);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return jsonResponse(response, 400, { error: "Invalid message id" });
      }
      const result = await evaluate(`(() => {
        const pick = ${pickMessageImageSource};
        const pickSticker = ${pickStickerSource};
        const pickVideoPoster = ${pickVideoPosterSource};
        const list = Array.from(document.querySelectorAll("#MiddleColumn .MessageList"))
          .find((candidate) => !candidate.hasAttribute("data-deckygram-stale"));
        const message = list?.querySelector('[data-message-id="${messageId}"]');
        const poster = message && !pickSticker(message) ? pickVideoPoster(message) : null;
        if (poster) {
          if (!poster.source) return { found: true, data_url: null };
          const scale = Math.min(1, 360 / Math.max(poster.width, poster.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(poster.width * scale));
          canvas.height = Math.max(1, Math.round(poster.height * scale));
          try {
            canvas.getContext("2d").drawImage(poster.source, 0, 0, canvas.width, canvas.height);
            return { found: true, data_url: canvas.toDataURL("image/webp", 0.8), width: canvas.width, height: canvas.height };
          } catch {
            return { found: true, data_url: null };
          }
        }
        const sticker = message ? pickSticker(message) : null;
        if (sticker) {
          if (!sticker.source) return { found: true, data_url: null };
          // PNG keeps the sticker's transparency; 256px stays sharp at the size the panel shows it.
          const scale = Math.min(1, 256 / Math.max(sticker.width, sticker.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(sticker.width * scale));
          canvas.height = Math.max(1, Math.round(sticker.height * scale));
          try {
            canvas.getContext("2d").drawImage(sticker.source, 0, 0, canvas.width, canvas.height);
            return { found: true, data_url: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
          } catch {
            return { found: true, data_url: null };
          }
        }
        const image = message ? pick(message) : null;
        if (!image) return { found: false, data_url: null };
        if (!image.complete || !image.naturalWidth) return { found: true, data_url: null };
        const scale = Math.min(1, 360 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        try {
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          return { found: true, data_url: canvas.toDataURL("image/webp", 0.8), width: canvas.width, height: canvas.height };
        } catch {
          return { found: true, data_url: null };
        }
      })()`);
      return jsonResponse(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/message-image-file") {
      // The original image file Telegram loaded for a message, for the viewer and for saving.
      const body = await readBody(request);
      const messageId = Number(body.message_id);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return jsonResponse(response, 400, { error: "Invalid message id" });
      }
      const result = await evaluate(`(async () => {
        const pick = ${pickMessageImageSource};
        const list = Array.from(document.querySelectorAll("#MiddleColumn .MessageList"))
          .find((candidate) => !candidate.hasAttribute("data-deckygram-stale"));
        const message = list?.querySelector('[data-message-id="${messageId}"]');
        const image = message ? pick(message) : null;
        if (!image) return { found: false, data_url: null };
        if (!image.complete || !image.naturalWidth) return { found: true, data_url: null };
        const size = { width: image.naturalWidth, height: image.naturalHeight };
        try {
          const blob = await (await fetch(image.currentSrc || image.src)).blob();
          if (blob.size > ${MAX_IMAGE_FILE_BYTES}) return { found: true, data_url: null, error: "Image is too large" };
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          return { found: true, data_url: dataUrl, mime: blob.type, ...size };
        } catch {
          // Fall back to re-drawing the rendered image at full size.
          try {
            const canvas = document.createElement("canvas");
            canvas.width = size.width;
            canvas.height = size.height;
            canvas.getContext("2d").drawImage(image, 0, 0);
            return { found: true, data_url: canvas.toDataURL("image/png"), mime: "image/png", ...size };
          } catch {
            return { found: true, data_url: null };
          }
        }
      })()`);
      return jsonResponse(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/close-chat") {
      // Telegram marks messages in an open chat as read immediately, so leaving it open would
      // suppress unread counts and notifications for the last chat viewed in Deckygram.
      currentChatId = null;
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/send-message") {
      const body = await readBody(request);
      if (typeof body.text !== "string" || !body.text.trim()) {
        return jsonResponse(response, 400, { error: "Message cannot be empty" });
      }
      const replyTo = Number.isInteger(body.reply_to) ? body.reply_to : null;
      const result = await window.webContents.executeJavaScript(`(async () => {
        const text = ${JSON.stringify(body.text)};
        ${messageMenuSource}
        const replyTo = ${JSON.stringify(replyTo)};
        if (replyTo !== null) {
          // Choosing Reply in Telegram's menu attaches the reply to whatever is sent next from the composer.
          const menu = await openMessageMenu(replyTo);
          if (!menu) return "missing-reply-message";
          const reply = menuItem(menu, "reply");
          if (!reply) {
            closeMenus();
            return "cannot-reply";
          }
          press(reply);
          await sleep(300);
        }
        // Selectors are tried in order, so the composer wins over other editable fields on the page.
        const editor = [
          '.input-message-input[contenteditable="true"]:not(.input-field-input-fake)',
          '#message-input-text [contenteditable="true"]',
          '.message-input-wrapper [contenteditable="true"]',
          '[contenteditable="true"], textarea, [role="textbox"]',
        ].map((selector) => Array.from(document.querySelectorAll(selector)).find((element) => visible(element) && !element.disabled))
          .find(Boolean);
        if (!editor) return "missing-editor";
        const editorText = () => (editor.isContentEditable ? editor.textContent : editor.value).trim();
        editor.focus();
        if (editor.isContentEditable) {
          // Replacing the whole content keeps text from an attempt Telegram did not send out of this message.
          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, text);
        } else {
          const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(editor, text);
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        }
        // The send button sits outside the input's own wrapper, so look from the whole composer.
        const composer = editor.closest(".Composer") || document;
        // The main button stays a voice-record button until Telegram renders the new text, and it only
        // gets the "send" class then; a "send" aria-label would also match the "Send message as" button.
        let sendButton = null;
        for (let attempt = 0; attempt < 30 && !sendButton; attempt += 1) {
          sendButton = Array.from(composer.querySelectorAll(".main-button.send"))
            .find((button) => visible(button) && !button.disabled) || null;
          if (!sendButton) await sleep(100);
        }
        if (!sendButton) return "missing-send-button";
        sendButton.click();
        // Telegram empties the composer once the message is on its way.
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (!editorText()) return "sent";
          await sleep(100);
        }
        return "not-sent";
      })()`, true);
      if (result !== "sent") {
        const errors = {
          "missing-editor": "Telegram's message editor was not found",
          "missing-reply-message": "The message you are replying to is no longer loaded; reopen the chat",
          "cannot-reply": "Telegram does not allow replying to that message",
          "missing-send-button": "Telegram's send button did not appear; try again",
          "not-sent": "Telegram did not send the message; check the chat and try again",
        };
        log(`Telegram message send failed: ${result}`);
        return jsonResponse(response, 409, { error: errors[result] || "Telegram did not send the message" });
      }
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/message-action") {
      const body = await readBody(request);
      const messageId = Number(body.message_id);
      const actions = new Set(["edit", "delete", "reaction-options", "react"]);
      if (!Number.isInteger(messageId) || !actions.has(body.action)) {
        return jsonResponse(response, 400, { error: "Unsupported message action" });
      }
      const input = {
        action: body.action,
        messageId,
        text: typeof body.text === "string" ? body.text : "",
        forEveryone: body.for_everyone !== false,
        index: Number.isInteger(body.index) ? body.index : -1,
      };
      const result = await window.webContents.executeJavaScript(`(async () => {
        ${messageMenuSource}
        const input = ${JSON.stringify(input)};
        const menu = await openMessageMenu(input.messageId);
        if (!menu) return { error: "missing-message" };

        if (input.action === "reaction-options") {
          // Quick reactions are animated stickers without any emoji text, so what each one looks like is sent
          // to the panel and the choice comes back as a position in the same list.
          const snapshot = (item) => {
            const canvas = item.querySelector("canvas");
            const image = item.querySelector("img");
            try {
              if (canvas && canvas.width) return canvas.toDataURL("image/png");
              if (image && image.complete && image.naturalWidth) {
                const copy = document.createElement("canvas");
                copy.width = image.naturalWidth;
                copy.height = image.naturalHeight;
                copy.getContext("2d").drawImage(image, 0, 0);
                return copy.toDataURL("image/png");
              }
            } catch {
              // Drawn by a worker or cross-origin; the panel shows a numbered button instead.
            }
            return "";
          };
          const collect = async (currentMenu) => {
            // Stickers draw their first frame shortly after the menu opens; a blank frame is a very short URL.
            let options = [];
            for (let attempt = 0; attempt < 15; attempt += 1) {
              options = quickReactions(currentMenu).map((item, index) => {
                const emoji = item.querySelector("img")?.alt || "";
                return { index, emoji, image: emoji ? "" : snapshot(item), chosen: item.classList.length > 1 };
              });
              if (options.length && options.every((option) => option.emoji || option.image.length > 400)) break;
              await sleep(150);
            }
            return options;
          };
          let options = await collect(menu);
          closeMenus();
          if (options.length && !options.some((option) => option.emoji) && !window.__deckygramStaticEmojiTried) {
            window.__deckygramStaticEmojiTried = true;
            await sleep(300);
            if (await disableAnimatedEmoji()) {
              await sleep(500);
              const reopened = await openMessageMenu(input.messageId);
              if (reopened) {
                options = await collect(reopened);
                closeMenus();
              }
            }
          }
          return { options };
        }

        if (input.action === "react") {
          const reaction = quickReactions(menu)[input.index];
          if (!reaction) {
            closeMenus();
            return { error: "missing-reaction" };
          }
          press(reaction);
          await waitFor(() => !openMenu(), 2000);
          return { ok: true };
        }

        if (input.action === "edit") {
          const edit = menuItem(menu, "edit");
          if (!edit) {
            closeMenus();
            return { error: "cannot-edit" };
          }
          press(edit);
          // Telegram loads the message into the composer and turns the main button into its edit state.
          const saveButton = () => Array.from(document.querySelectorAll(".Composer .main-button.edit"))
            .find((button) => visible(button) && !button.disabled) || null;
          if (!await waitFor(saveButton, 3000)) return { error: "missing-edit", cancel: true };
          const editor = composerEditor();
          if (!editor) return { error: "missing-editor", cancel: true };
          replaceText(editor, input.text);
          await sleep(200);
          const save = await waitFor(saveButton, 2000);
          if (!save) return { error: "missing-save-button", cancel: true };
          press(save);
          // The composer leaves edit mode once Telegram has taken the change.
          const saved = await waitFor(() => !document.querySelector(".Composer .main-button.edit"), 5000);
          return saved ? { ok: true } : { error: "not-saved", cancel: true };
        }

        // delete
        const remove = menuItem(menu, "delete");
        if (!remove) {
          closeMenus();
          return { error: "cannot-delete" };
        }
        press(remove);
        const confirm = await waitFor(() => Array.from(document.querySelectorAll(".confirm-dialog-button.danger"))
          .find((button) => visible(button) && !button.disabled), 3000);
        if (!confirm) return { error: "missing-confirm", cancel: true };
        // "Also delete for ..." only exists where Telegram allows deleting for everyone; it starts checked.
        const checkbox = confirm.closest(".Modal")?.querySelector(".dialog-checkbox input[type=checkbox]");
        if (checkbox && checkbox.checked !== input.forEveryone) {
          checkbox.click();
          await sleep(150);
        }
        const scope = checkbox?.checked ? "everyone" : "self";
        press(confirm);
        const gone = await waitFor(() => !findMessage(input.messageId), 6000);
        return gone ? { ok: true, scope } : { error: "not-deleted" };
      })()`, true);
      if (!result || result.error) {
        const errors = {
          "missing-message": "That message is no longer loaded in Telegram; refresh the chat and try again",
          "missing-reaction": "Telegram's reactions changed; open the reactions again",
          "cannot-edit": "Telegram does not allow editing that message",
          "cannot-delete": "Telegram does not allow deleting that message",
          "missing-edit": "Telegram did not open the message for editing",
          "missing-editor": "Telegram's message editor was not found",
          "missing-save-button": "Telegram's save button did not appear; try again",
          "not-saved": "Telegram did not save the change; check the chat and try again",
          "missing-confirm": "Telegram's delete confirmation did not appear",
          "not-deleted": "Telegram did not delete the message; check the chat and try again",
        };
        log(`Telegram message action ${body.action} failed: ${result?.error}`);
        if (result?.cancel) {
          // Leaves Telegram's edit mode or delete dialog, so the next action starts clean.
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        }
        return jsonResponse(response, 409, { error: errors[result?.error] || "Telegram did not complete that action" });
      }
      if (body.action !== "reaction-options") {
        stateRevision += 1;
        cachedState = null;
        cachedStateAt = 0;
        statePromise = null;
      }
      return jsonResponse(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/chat-action") {
      const body = await readBody(request);
      const chatIndex = Number(body.chat_id);
      if (!Number.isInteger(chatIndex) || !["pin", "unpin"].includes(body.action) || typeof body.title !== "string") {
        return jsonResponse(response, 400, { error: "Unsupported chat action" });
      }
      const result = await window.webContents.executeJavaScript(`(async () => {
        ${messageMenuSource}
        const row = Array.from(document.querySelectorAll(".chat-list .ListItem"))[${chatIndex}];
        const title = row?.querySelector(".fullName, .peer-title, .chat-title")?.textContent?.trim() || "";
        // Rows are positions in a list that keeps moving, so the title confirms it is still the same chat.
        if (!row || title !== ${JSON.stringify(body.title)}) return "missing-chat";
        const target = row.querySelector(".ListItem-button") || row;
        const rect = target.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: rect.left + 30, clientY: rect.top + 20, view: window };
        target.dispatchEvent(new MouseEvent("mousedown", options));
        target.dispatchEvent(new MouseEvent("contextmenu", options));
        const menu = await waitFor(() => Array.from(document.querySelectorAll(".ListItem-context-menu .bubble.open"))
          .find((bubble) => bubble.querySelector(".MenuItem")), 3000);
        if (!menu) return "missing-menu";
        const item = menuItem(menu, ${JSON.stringify(body.action)});
        if (!item) {
          closeMenus();
          return "already";
        }
        press(item);
        // Pinning past Telegram's limit opens a dialog instead of pinning.
        const limit = await waitFor(() => Array.from(document.querySelectorAll(".Modal .modal-dialog")).find(visible), 800);
        return limit ? "limit" : "done";
      })()`, true);
      if (result !== "done") {
        const errors = {
          "missing-chat": "That chat moved in Telegram's list; try again",
          "missing-menu": "Telegram's chat menu did not open; try again",
          already: body.action === "pin" ? "That chat is already pinned" : "That chat is not pinned",
          limit: "Telegram's pinned chat limit is reached; unpin another chat first",
        };
        if (result === "limit") {
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        }
        log(`Telegram chat ${body.action} failed: ${result}`);
        return jsonResponse(response, 409, { error: errors[result] || "Telegram did not change the pinned chats" });
      }
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/message-video") {
      const body = await readBody(request);
      const messageId = Number(body.message_id);
      if (!Number.isInteger(messageId) || messageId <= 0) return jsonResponse(response, 400, { error: "Invalid message id" });
      // GIFs play in the chat, so their file address is on the bubble's <video>. A video that is not loaded
      // only gets one once Telegram's media viewer opens it.
      const located = await window.webContents.executeJavaScript(`(async () => {
        ${messageMenuSource}
        const message = findMessage(${messageId});
        if (!message) return { error: "missing-message" };
        const media = Array.from(message.querySelectorAll(".media-inner")).find((node) => !node.closest(".EmbeddedMessage"));
        if (!media) return { error: "missing-media" };
        const inline = media.querySelector("video[src*='progressive']");
        if (inline) return { src: inline.currentSrc || inline.src, viewer: false };
        press(media);
        const viewerVideo = await waitFor(() => Array.from(document.querySelectorAll(".MediaViewer video, #MediaViewer video"))
          .find((video) => (video.currentSrc || video.src || "").includes("progressive")), 8000);
        if (!viewerVideo) return { error: "missing-video", viewer: true };
        return { src: viewerVideo.currentSrc || viewerVideo.src, viewer: true };
      })()`, true);
      if (located.viewer) {
        // Telegram's media viewer only closes on a trusted Escape.
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      }
      if (located.error) {
        const errors = {
          "missing-message": "That message is no longer loaded in Telegram; refresh the chat and try again",
          "missing-media": "Telegram has not loaded this video yet; try again in a moment",
          "missing-video": "Telegram did not open the video; try again",
        };
        log(`Telegram video lookup failed: ${located.error}`);
        return jsonResponse(response, 409, { error: errors[located.error] });
      }
      // The file stays in Telegram's page and is handed to the panel in pieces; Decky's messages are too
      // small for a whole video. Only the last few are kept.
      const loaded = await window.webContents.executeJavaScript(`(async () => {
        const MAX_BYTES = 50 * 1024 * 1024;
        const src = ${JSON.stringify(located.src)};
        const parts = [];
        let start = 0;
        let total = Infinity;
        let mime = "video/mp4";
        // Telegram's service worker only serves byte ranges, possibly in pieces of a large file.
        while (start < total) {
          const response = await fetch(src, { headers: { Range: "bytes=" + start + "-" } });
          if (!response.ok) return { error: "download-failed" };
          mime = (response.headers.get("content-type") || mime).split(";")[0];
          const range = /bytes (\\d+)-(\\d+)\\/(\\d+)/.exec(response.headers.get("content-range") || "");
          const chunk = new Uint8Array(await response.arrayBuffer());
          if (!chunk.length) break;
          parts.push(chunk);
          if (range) {
            total = Number(range[3]);
            start = Number(range[2]) + 1;
          } else {
            total = start + chunk.length;
            start = total;
          }
          if (total > MAX_BYTES) return { error: "too-large", size: total };
        }
        const size = parts.reduce((sum, part) => sum + part.length, 0);
        const data = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          data.set(part, offset);
          offset += part.length;
        }
        const store = window.__deckygramVideos || (window.__deckygramVideos = new Map());
        while (store.size >= 3) store.delete(store.keys().next().value);
        const id = Math.random().toString(36).slice(2);
        store.set(id, { data, mime });
        return { id, size, mime };
      })()`, true);
      if (loaded.error) {
        const errors = {
          "download-failed": "Telegram did not hand over the video; try again",
          "too-large": "This video is too large to play here (over 50 MB)",
        };
        log(`Telegram video download failed: ${loaded.error}`);
        return jsonResponse(response, 409, { error: errors[loaded.error] });
      }
      return jsonResponse(response, 200, loaded);
    }
    if (request.method === "POST" && url.pathname === "/message-video-chunk") {
      const body = await readBody(request);
      if (typeof body.id !== "string" || !/^[a-z0-9]{1,20}$/.test(body.id) || !Number.isInteger(body.index) || body.index < 0) {
        return jsonResponse(response, 400, { error: "Invalid video chunk" });
      }
      const chunk = await window.webContents.executeJavaScript(`(async () => {
        const CHUNK_BYTES = 1536 * 1024;
        const entry = window.__deckygramVideos?.get(${JSON.stringify(body.id)});
        if (!entry) return { error: "missing" };
        const start = ${body.index} * CHUNK_BYTES;
        const piece = entry.data.subarray(start, start + CHUNK_BYTES);
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.readAsDataURL(new Blob([piece]));
        });
        return { data: base64, done: start + CHUNK_BYTES >= entry.data.length };
      })()`, true);
      if (chunk.error) return jsonResponse(response, 409, { error: "The video was released; play it again" });
      return jsonResponse(response, 200, chunk);
    }
    if (request.method === "POST" && url.pathname === "/message-video-release") {
      const body = await readBody(request);
      if (typeof body.id === "string" && /^[a-z0-9]{1,20}$/.test(body.id)) {
        await window.webContents.executeJavaScript(`void window.__deckygramVideos?.delete(${JSON.stringify(body.id)})`);
      }
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/stickers") {
      const result = await window.webContents.executeJavaScript(`(async () => {
        ${messageMenuSource}
        ${stickerPickerSource}
        const scroller = await openStickerPicker();
        if (!scroller) return { error: "missing-picker" };
        // Sets load their stickers as they scroll into view, so the picker is walked down a screen at a time.
        const found = new Map();
        const collect = () => {
          for (const button of stickerButtons()) {
            const id = button.getAttribute("data-sticker-id");
            const known = found.get(id);
            if (known && known.image) continue;
            const set = button.closest(".symbol-set")?.querySelector(".symbol-set-name")?.textContent?.trim() || "";
            found.set(id, { id, emoji: button.getAttribute("title") || "", set, image: stickerImage(button) });
          }
        };
        scroller.scrollTop = 0;
        await sleep(600);
        for (let step = 0; step < 14 && found.size < 120; step += 1) {
          collect();
          if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
          scroller.scrollTop += Math.max(120, scroller.clientHeight * 0.8);
          await sleep(450);
        }
        collect();
        scroller.scrollTop = 0;
        await closeStickerPicker();
        return { stickers: Array.from(found.values()).slice(0, 120) };
      })()`, true);
      await closeStickerPickerIfOpen();
      if (result.error) return jsonResponse(response, 409, { error: "Telegram's sticker picker did not open; open the chat and try again" });
      return jsonResponse(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/send-sticker") {
      const body = await readBody(request);
      if (typeof body.sticker_id !== "string" || !/^[0-9A-Za-z_-]{1,64}$/.test(body.sticker_id)) {
        return jsonResponse(response, 400, { error: "Unknown sticker" });
      }
      const result = await window.webContents.executeJavaScript(`(async () => {
        ${messageMenuSource}
        ${stickerPickerSource}
        const stickerId = ${JSON.stringify(body.sticker_id)};
        const scroller = await openStickerPicker();
        if (!scroller) return "missing-picker";
        const find = () => stickerButtons().find((button) => button.getAttribute("data-sticker-id") === stickerId) || null;
        scroller.scrollTop = 0;
        await sleep(300);
        let sticker = find();
        for (let step = 0; !sticker && step < 20; step += 1) {
          if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
          scroller.scrollTop += Math.max(120, scroller.clientHeight * 0.8);
          await sleep(350);
          sticker = find();
        }
        if (!sticker) {
          await closeStickerPicker();
          return "missing-sticker";
        }
        const list = Array.from(document.querySelectorAll("#MiddleColumn .MessageList"))
          .find((candidate) => !candidate.hasAttribute("data-deckygram-stale"));
        const before = list ? list.querySelectorAll("[data-message-id]").length : 0;
        press(sticker);
        // The sticker shows up as a new message once Telegram has taken it.
        const sent = await waitFor(() => (list ? list.querySelectorAll("[data-message-id]").length > before : false), 6000);
        await closeStickerPicker();
        return sent ? "sent" : "not-sent";
      })()`, true);
      await closeStickerPickerIfOpen();
      if (result !== "sent") {
        const errors = {
          "missing-picker": "Telegram's sticker picker did not open; open the chat and try again",
          "missing-sticker": "That sticker is no longer in Telegram's picker; refresh the stickers",
          "not-sent": "Telegram did not send the sticker; check the chat and try again",
        };
        log(`Telegram sticker send failed: ${result}`);
        return jsonResponse(response, 409, { error: errors[result] || "Telegram did not send the sticker" });
      }
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/send-image") {
      const body = await readBody(request, maxImageBodyBytes);
      if (typeof body.data !== "string" || !body.data || !/^image\/(jpeg|png)$/.test(body.mime || "")) {
        return jsonResponse(response, 400, { error: "Only JPEG and PNG pictures can be sent" });
      }
      const result = await window.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const waitFor = async (find, timeoutMs) => {
          for (let waited = 0; waited <= timeoutMs; waited += 100) {
            const found = find();
            if (found) return found;
            await sleep(100);
          }
          return null;
        };
        // Telegram opens its attachment dialog for files pasted into the focused message box, which must be
        // the element with this id.
        const editor = Array.from(document.querySelectorAll("#editable-message-text")).find(visible);
        if (!editor) return "missing-editor";
        const captionText = ${JSON.stringify(body.caption || "")};
        const replaceText = (element, text) => {
          element.focus();
          document.execCommand("selectAll", false);
          if (text) document.execCommand("insertText", false, text);
          else document.execCommand("delete", false);
        };
        // The attachment dialog shares the message box's editor, so its caption is whatever the message box
        // holds. Setting it there first also keeps leftover text from becoming an unintended caption.
        replaceText(editor, captionText);
        await sleep(150);
        editor.focus();
        const binary = atob(${JSON.stringify(body.data)});
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const file = new File([bytes], ${JSON.stringify(body.name || "screenshot.jpg")}, { type: ${JSON.stringify(body.mime)} });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
        const caption = await waitFor(() => Array.from(document.querySelectorAll("#editable-message-text-modal")).find(visible), 8000);
        if (!caption) return "missing-dialog";
        if (captionText) {
          const hasCaption = () => caption.isConnected && caption.textContent.trim() === captionText.trim();
          if (!await waitFor(hasCaption, 2000)) {
            replaceText(caption, captionText);
            if (!await waitFor(hasCaption, 2000)) return "missing-caption";
          }
        }
        // The dialog's classes are hashed; its send button is the one carrying Telegram's send icon, and it
        // stays disabled while the picture is prepared.
        const dialog = caption.closest(".Modal") || document;
        const sendButton = await waitFor(() => Array.from(dialog.querySelectorAll("button"))
          .find((button) => button.querySelector(".icon-new-send") && visible(button) && !button.disabled), 30000);
        if (!sendButton) return "missing-send-button";
        // Telegram buttons without noFastClick act on mousedown and ignore click; the others act on click.
        // A full press reaches either kind exactly once.
        const pointer = { bubbles: true, cancelable: true, button: 0, view: window };
        sendButton.dispatchEvent(new MouseEvent("mousedown", pointer));
        sendButton.dispatchEvent(new MouseEvent("mouseup", pointer));
        sendButton.click();
        // The dialog closes once Telegram has taken the picture.
        const closed = await waitFor(() => !Array.from(document.querySelectorAll("#editable-message-text-modal")).some(visible), 15000);
        return closed ? "sent" : "not-sent";
      })()`, true);
      if (result !== "sent") {
        const errors = {
          "missing-editor": "Telegram's message editor was not found",
          "missing-dialog": "Telegram did not accept the picture",
          "missing-caption": "Telegram did not take the caption, so the picture was not sent; try again",
          "missing-send-button": "Telegram's send button did not appear; try again",
          "not-sent": "Telegram did not send the picture; check the chat and try again",
        };
        log(`Telegram picture send failed: ${result}`);
        if (result === "missing-caption" || result === "missing-send-button" || result === "not-sent") {
          // A dialog left open would swallow the next text message.
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        }
        return jsonResponse(response, 409, { error: errors[result] || "Telegram did not send the picture" });
      }
      stateRevision += 1;
      cachedState = null;
      cachedStateAt = 0;
      statePromise = null;
      return jsonResponse(response, 200, { ok: true });
    }
    return jsonResponse(response, 404, { error: "Unknown bridge endpoint" });
  } catch (error) {
    if (url.pathname === "/submit-password") {
      log("Telegram cloud-password submission failed");
      return jsonResponse(response, 500, { error: "Telegram could not submit the cloud password. Check the login screen and try again." });
    }
    log(`bridge request failed: ${error.stack || error.message}`);
    return jsonResponse(response, 500, { error: error.message || "Telegram Web request failed" });
  }
}

// Telegram's sticker picker ignores synthetic Escape. A trusted one is sent only while the picker is open,
// since Escape with nothing open would close the chat.
async function closeStickerPickerIfOpen() {
  const open = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll(".symbol-set[id*='sticker-set'] .StickerButton[data-sticker-id]"))
    .some((button) => { const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })`);
  if (!open) return;
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function startBridge() {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || !profileDir) {
    throw new Error("Deckygram bridge configuration is invalid");
  }
  server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(port, "127.0.0.1");
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-features", "MediaRouter");
app.setPath("userData", profileDir);

app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 960,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Telegram Web applies every DOM update in requestAnimationFrame. A never-shown window gets
      // no animation frames on SteamOS, so new messages never render; offscreen rendering keeps them running.
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  window.webContents.setFrameRate(10);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  logTelegramNetworkFailures(window.webContents.session);
  window.webContents.on("console-message", (details) => {
    if (details.level < 2) return;
    log(
      `Telegram renderer console: level=${details.level} line=${details.lineNumber} `
      + `${describeResourceUrl(details.sourceId)} message=${sanitizeConsoleMessage(details.message)}`,
    );
  });
  window.webContents.on("dom-ready", () => {
    log("Telegram document DOM ready");
  });
  window.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    if (isInPlace) {
      log("Telegram Web in-page navigation started; keeping the current document ready");
      return;
    }
    ready = false;
    pageLoadStartedAt = Date.now();
    pageLoadedAt = 0;
    initializationFailureLogged = false;
    loadError = null;
    log(`Telegram Web navigation started: ${url}`);
  });
  window.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !(parsed.hostname === "telegram.org" || parsed.hostname.endsWith(".telegram.org"))) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
    if (code !== -3) {
      loadError = `${description} (${code})`;
      log(
        `Telegram Web load failed (${code}): ${description} mainFrame=${isMainFrame} `
        + describeResourceUrl(validatedUrl),
      );
    }
  });
  window.webContents.on("did-finish-load", () => {
    ready = true;
    pageLoadedAt = Date.now();
    loadError = null;
    log("Telegram Web loaded");
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    ready = false;
    loadError = `Telegram Web renderer exited (${details.reason}${details.exitCode !== undefined ? `, code ${details.exitCode}` : ""})`;
    log(`${loadError}; details=${JSON.stringify(details)}`);
  });
  startBridge();
  pageLoadStartedAt = Date.now();
  window.loadURL(appUrl).catch((error) => {
    loadError = error.message;
    log(`Telegram Web navigation failed: ${error.message}`);
  });
});

app.on("before-quit", () => {
  if (server) server.close();
});

app.on("window-all-closed", () => app.quit());
