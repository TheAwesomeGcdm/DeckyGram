import {
  addEventListener,
  callable,
  definePlugin,
  removeEventListener,
} from "@decky/api"
import {
  ButtonItem,
  DialogButton,
  DropdownItem,
  Focusable,
  GamepadButton,
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  showModal,
  SteamSpinner,
  TextField,
  ToggleField,
} from "@decky/ui";
import { Fragment, KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { mediaLabel, t } from "./i18n";
import { showTelegramNotification, stopTelegramNotifications } from "./notifications";
import {
  FaArrowLeft,
  FaCheck,
  FaCheckDouble,
  FaBell,
  FaBellSlash,
  FaArrowCircleUp,
  FaCog,
  FaExclamationCircle,
  FaExpand,
  FaImage,
  FaPaperPlane,
  FaPen,
  FaPlay,
  FaRegClock,
  FaRegGrinStars,
  FaRegSmile,
  FaRegWindowRestore,
  FaReply,
  FaSyncAlt,
  FaTelegramPlane,
  FaThumbtack,
  FaTimes,
  FaTrashAlt,
  FaUser,
  FaUsers,
} from "react-icons/fa";

const styleText = `
.deckygram {
  --sg-bg: #090d12;
  --sg-surface: #111b22;
  --sg-surface-2: #1a2630;
  --sg-line: rgba(154, 171, 178, 0.18);
  --sg-text: #edf4f3;
  --sg-muted: #9fb2b8;
  --sg-accent: #6fe4ee;
  --sg-accent-2: #8d60ef;
  --sg-warm: #f4b35a;
  min-height: 420px;
  color: var(--sg-text);
  background: linear-gradient(180deg, #060a0f 0%, #0b1016 100%);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}

.deckygram * { box-sizing: border-box; }
.deckygram button,
.deckygram input { font: inherit; }

.deckygram-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 62px;
  padding: 0 16px;
  border-radius: 22px 22px 0 0;
  background: linear-gradient(90deg, rgba(150, 105, 235, 0.96), rgba(101, 142, 197, 0.92));
  border-bottom: 1px solid rgba(255,255,255,0.12);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
}

.brand-mark,
.auth-brand span {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(255,255,255,0.16);
  color: white;
}

.header-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.header-copy strong {
  overflow: hidden;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-copy span,
.auth-detail,
.auth-status {
  color: var(--sg-muted);
  font-size: 12px;
}

.chat-screen {
  display: flex;
  flex-direction: column;
  min-height: 420px;
  background: linear-gradient(180deg, rgba(16, 21, 27, 0.96), rgba(12, 18, 24, 0.98));
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  background: rgba(18, 24, 30, 0.98);
}

.chat-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 56px;
  padding: 8px 14px;
  border: 0;
  border-bottom: 1px solid var(--sg-line);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, transform 120ms ease;
}

.chat-row:hover,
.chat-row:focus-visible {
  background: rgba(108, 166, 242, 0.09);
  outline: none;
}

.chat-row:focus-visible {
  box-shadow: inset 0 0 0 1px rgba(117, 200, 217, 0.35);
}

.chat-avatar {
  display: grid;
  place-items: center;
  flex: 0 0 38px;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: linear-gradient(180deg, rgba(98, 210, 219, 0.9), rgba(82, 151, 183, 0.72));
  color: #16252b;
  font-size: 17px;
  font-weight: 800;
}

.chat-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
}

.chat-copy strong,
.chat-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-copy strong {
  font-size: 15px;
  font-weight: 700;
}

.chat-copy span {
  color: var(--sg-muted);
  font-size: 12px;
}

.unread-count {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: linear-gradient(180deg, #ffbd6b, #e8913c);
  color: #1a1200;
  font-size: 11px;
  font-weight: 800;
}

.conversation {
  display: flex;
  flex-direction: column;
  min-height: 420px;
}

.message-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 220px;
  max-height: min(58vh, 440px);
  overflow-y: auto;
  padding: 10px 12px;
  background: rgba(18, 24, 30, 0.96);
}

.message {
  max-width: 86%;
  padding: 8px 10px 7px;
  border: 1px solid var(--sg-line);
  border-radius: 10px;
  background: rgba(30, 40, 46, 0.9);
  overflow-wrap: anywhere;
}

.message.incoming { align-self: flex-start; }
.message.outgoing {
  align-self: flex-end;
  border-color: rgba(95, 206, 216, 0.42);
  background: rgba(20, 52, 58, 0.95);
}

.message p {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.message-sender {
  display: block;
  margin-bottom: 4px;
  color: var(--sg-accent);
  font-size: 11px;
  font-weight: 700;
}

.message time {
  display: block;
  margin-top: 4px;
  color: var(--sg-muted);
  font-size: 10px;
  text-align: right;
}

.composer {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--sg-line);
  background: rgba(17, 24, 30, 0.96);
}

.composer input,
.auth-form input {
  width: 100%;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 1px solid rgba(145, 165, 171, 0.18);
  border-radius: 8px;
  background: rgba(9, 14, 18, 0.9);
  color: var(--sg-text);
  outline: none;
  font-size: 14px;
}

.composer input:focus,
.auth-form input:focus {
  border-color: var(--sg-accent);
}

.auth-screen {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 420px;
  padding: 22px 18px;
}

.auth-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  font-size: 20px;
}

.auth-brand span {
  width: 42px;
  height: 42px;
  font-size: 21px;
}

.auth-status {
  margin: 16px 0 18px;
  font-size: 13px;
}

.auth-detail {
  line-height: 1.5;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.auth-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #dfeaf0;
  font-size: 12px;
}

.auth-form a {
  width: fit-content;
  color: var(--sg-accent);
  font-size: 12px;
}

.notice {
  margin: 8px 12px 12px;
  color: var(--sg-warm);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.error-notice {
  margin: 16px 0 0;
}

.empty-state {
  display: grid;
  place-items: center;
  min-height: 120px;
  padding: 18px;
  color: var(--sg-muted);
  font-size: 13px;
  text-align: center;
}

.loading-mark {
  width: 22px;
  height: 22px;
  border: 2px solid rgba(164, 180, 184, 0.5);
  border-top-color: var(--sg-accent);
  border-radius: 50%;
  animation: deckygram-spin .8s linear infinite;
}

.telegram-qr {
  display: block;
  width: min(280px, 80vw);
  height: auto;
  margin: 0 auto;
  border: 10px solid white;
  border-radius: 8px;
  background: white;
}

@keyframes deckygram-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 380px) {
  .auth-screen { padding: 18px 12px; }
  .deckygram-header { padding: 0 10px; }
  .chat-row { gap: 8px; padding-left: 10px; padding-right: 10px; }
}

.steam-button {
  appearance: none;
  border: 0;
  border-radius: 8px;
  background: rgba(95, 206, 216, 0.12);
  color: var(--sg-text);
  cursor: pointer;
  font-weight: 600;
}

.steam-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.steam-button-row {
  width: 100%;
  min-height: 36px;
  padding: 9px 14px;
  border-radius: 0;
  border-bottom: 1px solid var(--sg-line);
  background: rgba(16, 22, 28, 0.8);
  text-align: left;
}

.primary-button {
  min-height: 40px;
  border: 0;
  border-radius: 8px;
  color: #132321 !important;
  background: linear-gradient(180deg, #68dfe9, #4ab7bf);
  font-size: 14px;
  font-weight: 700;
}

.send-button {
  min-width: 84px;
  min-height: 40px;
  color: #102225 !important;
  background: linear-gradient(180deg, #68dfe9, #4ab7bf);
}

/* Padding must count inside widths, or full-width rows overflow and Steam scrolls the panel sideways. */
.deckygram-native [class^="sg-"],
.deckygram-native [class*=" sg-"] {
  box-sizing: border-box;
}

.sg-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.sg-toolbar-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 15px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sg-icon-button svg {
  width: 16px;
  height: 16px;
}

.sg-typing {
  display: block;
  overflow: hidden;
  color: #8fd3ff;
  font-size: 11px;
  font-style: italic;
  font-weight: 400;
  text-overflow: ellipsis;
}

.sg-typing.inline {
  display: inline;
  font-size: inherit;
}

.sg-status {
  width: 11px;
  height: 11px;
  margin: 0 4px 0 0;
  vertical-align: -1px;
}

.sg-chat-time .sg-status { margin: 0 0 0 4px; }
.sg-status.read { color: #8fd3ff; }
.sg-status.failed { color: #ff8a8a; }
.sg-chat-message .sg-status.read { color: inherit; }

.sg-chat-row {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
}

.sg-chat-row.sg-focused {
  background: rgba(255, 255, 255, 0.14);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
}

.sg-unread {
  flex: 0 0 auto;
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 10px;
  background: #3390ec;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.sg-unread.muted { background: rgba(255, 255, 255, 0.28); }

.sg-version { text-align: center; }

.sg-version-mismatch {
  display: block;
  margin-top: 4px;
  color: #ffb870;
}

.sg-settings-note {
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.7;
}

.sg-chat-scroll {
  display: flex;
  flex-direction: column-reverse;
  margin: 0 -4px 8px;
  padding: 0 4px;
  overflow-y: auto;
  overflow-anchor: none;
}

.sg-chat-stack {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding-block: 4px;
}

.sg-chat-day {
  align-self: center;
  margin: 10px 0 6px;
  padding: 2px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.28);
  font-size: 11px;
  opacity: 0.85;
}

.sg-chat-message {
  max-width: 86%;
  margin-top: 8px;
  padding: 5px 9px 4px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.sg-chat-message.continued { margin-top: 2px; }

.sg-chat-message.incoming {
  align-self: flex-start;
  border-bottom-left-radius: 4px;
  background: rgba(255, 255, 255, 0.12);
}

.sg-chat-message.outgoing {
  align-self: flex-end;
  border-bottom-right-radius: 4px;
  background: rgba(51, 144, 236, 0.62);
}

.sg-chat-message.service {
  align-self: center;
  max-width: 92%;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.22);
  font-size: 11px;
  text-align: center;
  opacity: 0.85;
}

.sg-chat-message.sg-focused {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
}

.sg-chat-sender {
  display: block;
  margin-bottom: 1px;
  font-size: 12px;
  font-weight: 700;
}

.sg-chat-image {
  display: block;
  width: 240px;
  max-width: 100%;
  max-height: 300px;
  margin: 2px 0 4px;
  overflow: hidden;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.sg-chat-image.viewable { cursor: pointer; }

.sg-chat-image {
  position: relative;
}

.sg-chat-image video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sg-media-badge {
  position: absolute;
  left: 6px;
  bottom: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.55);
  color: white;
  font-size: 11px;
  font-weight: 700;
}

.sg-video-viewer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.sg-video-viewer video,
.sg-video-viewer img {
  max-width: 100%;
  max-height: 72vh;
  border-radius: 6px;
}

.sg-chat-message.sticker.incoming,
.sg-chat-message.sticker.outgoing {
  padding: 0;
  background: transparent;
}

.sg-chat-image.sticker {
  width: 120px;
  max-height: 120px;
  margin: 0;
  border-radius: 0;
  background: transparent;
}

.sg-chat-image.sticker img {
  object-fit: contain;
}

.sg-chat-message.sticker .sg-chat-time {
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
}

.sg-chat-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sg-chat-media {
  display: block;
  font-style: italic;
  opacity: 0.8;
}

.sg-chat-time {
  float: right;
  margin: 4px 0 0 10px;
  font-size: 10px;
  line-height: 1.2;
  opacity: 0.65;
}

.sg-chat-empty {
  padding: 16px 4px;
  font-size: 13px;
  text-align: center;
  opacity: 0.75;
}

.sg-chat-diagnostics {
  display: block;
  margin-top: 6px;
  font-size: 10px;
  opacity: 0.6;
  overflow-wrap: anywhere;
}

.sg-chat-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sg-chat-actions {
  display: flex;
  gap: 6px;
}

.sg-chat-composer .sg-chat-send {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 6px 10px;
  font-size: 14px;
}

.sg-shots {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 4px 8px;
}

.sg-shots-title {
  font-size: 18px;
  font-weight: 700;
}

.sg-shots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 4px;
}

.sg-shots-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
}

.sg-shots-item.sg-focused {
  background: rgba(255, 255, 255, 0.14);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
}

.sg-shots-item img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 4px;
}

.sg-shots-caption {
  overflow: hidden;
  font-size: 12px;
  opacity: 0.75;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sg-shots-confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 640px;
}

.sg-shots-preview {
  width: 100%;
  border-radius: 6px;
}

.sg-shots-error {
  color: #ff8a8a;
}

.sg-chat-message.selected {
  box-shadow: 0 0 0 2px #1a9fff;
}

.sg-chat-message.editing {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 85%;
}

.sg-message-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 4px 0 6px;
}

.sg-message-actions.outgoing {
  justify-content: flex-end;
}

.sg-message-actions.replying {
  flex-direction: column;
  align-items: stretch;
  width: 85%;
}

.sg-message-actions.replying.outgoing {
  align-self: flex-end;
}

.sg-message-icon.destructive {
  color: #ff8a8a;
}

.sg-message-icon.chosen {
  box-shadow: 0 0 0 2px #1a9fff;
}

.sg-reaction-image {
  display: block;
  width: 20px;
  height: 20px;
}

.sg-stickers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
}

.sg-stickers-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sg-stickers-title {
  flex: 1;
  font-weight: 700;
}

.sg-stickers-scroll {
  max-height: 34vh;
  overflow-y: auto;
  padding: 2px;
}

.sg-stickers-set {
  margin: 6px 0 4px;
  font-size: 12px;
  opacity: 0.7;
}

.sg-stickers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 6px;
}

.sg-sticker {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  border-radius: 6px;
  font-size: 28px;
}

.sg-sticker.sg-focused {
  background: rgba(255, 255, 255, 0.14);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
}

.sg-sticker img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.sg-chat-quote {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 0 5px;
  padding: 4px 8px;
  border-left: 3px solid;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.18);
  font-size: 12px;
}

.sg-chat-quote-sender {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 700;
}

.sg-chat-quote-text {
  display: -webkit-box;
  overflow: hidden;
  opacity: 0.85;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.sg-list-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 2px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.6;
}

.sg-pin-mark {
  flex: 0 0 auto;
  font-size: 11px;
  opacity: 0.55;
  transform: rotate(45deg);
}

.sg-icon-button.muted {
  color: #ff5c5c;
}

.sg-update-dot {
  position: absolute;
  top: 5px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff5c5c;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4);
}

.sg-update-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sg-password input {
  -webkit-text-security: disc;
}

.sg-message-hint {
  font-size: 12px;
  opacity: 0.7;
}

.sg-message-error {
  margin-bottom: 6px;
  font-size: 12px;
  color: #ff8a8a;
}

.sg-message-error.outgoing {
  text-align: right;
}

.deckygram-title {
  font-weight: 700;
  letter-spacing: 0.02em;
}
`;

type Chat = {
  id: number;
  title: string;
  last_message: string;
  last_message_date: number;
  unread_count: number;
  avatar_url: string;
  is_group: boolean;
  is_direct: boolean;
  is_muted: boolean;
  is_archive_folder: boolean;
  is_pinned: boolean;
  typing_text: string;
  last_message_status: MessageStatus;
};

type MessageStatus = "" | "pending" | "sent" | "read" | "failed";

type Message = {
  id: number;
  date: number;
  time_label: string;
  day_label: string;
  text: string;
  media: string;
  sender: string;
  is_outgoing: boolean;
  is_service: boolean;
  status: MessageStatus;
  image: { width: number; height: number; ready: boolean } | null;
  reply: { sender: string; text: string } | null;
  media_duration: string;
};

// Steam gives the QAM and modals more CSS pixels at higher resolutions and smaller UI scales, while Deckygram's
// sizes were chosen on a Deck. Every size is multiplied by --dg-scale, measured from the space Steam gives
// (see useUiScale). Media queries cannot use variables, and 1px lines stay crisp.
const scaled = (pixels: number) => `calc(${pixels}px * var(--dg-scale, 1))`;
const scaledStyleText = styleText
  .split("\n")
  .map((line) => (line.trim().startsWith("@media") ? line : line.replace(/(-?\d*\.?\d+)px/g, (match, value) => {
    const pixels = Number(value);
    return Math.abs(pixels) <= 1 || Math.abs(pixels) >= 999 ? match : scaled(pixels);
  })))
  .join("\n");

// Deck baseline: the QAM is about 340 CSS px wide, and the screen 800 tall.
const DECK_PANEL_WIDTH = 340;
const DECK_SCREEN_HEIGHT = 800;

function uiScale(element: HTMLElement, windowed: boolean) {
  const view = element.ownerDocument.defaultView;
  if (!view) return 1;
  let scale = windowed
    ? view.innerHeight / DECK_SCREEN_HEIGHT
    : element.getBoundingClientRect().width / DECK_PANEL_WIDTH;
  // A tall QAM on a big screen can stay narrow, so its height counts as well.
  if (!windowed && view.innerHeight >= 1100) scale = Math.max(scale, view.innerHeight / DECK_SCREEN_HEIGHT);
  return Math.round(Math.min(2.2, Math.max(1, scale)) * 100) / 100;
}

// Decky's DialogButton forces full width internally; inline sizing is the only thing that wins over it.
const iconButtonStyle = {
  flex: "0 0 auto",
  width: scaled(40),
  minWidth: scaled(40),
  height: scaled(36),
  minHeight: 0,
  padding: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

// The picture and window buttons beside Send: a narrow square-ish button that takes Send's height.
const composerIconStyle = {
  flex: "0 0 auto",
  width: scaled(34),
  minWidth: 0,
  height: "auto",
  minHeight: 0,
  padding: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: scaled(14),
};

// Icons under a selected message. DialogButton forces full width, so sizes have to be inline.
const messageIconStyle = {
  flex: "0 0 auto",
  width: "auto",
  minWidth: scaled(30),
  height: scaled(26),
  minHeight: 0,
  padding: `0 ${scaled(8)}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: scaled(4),
  fontSize: scaled(13),
};

const reactionButtonStyle = { ...messageIconStyle, fontSize: scaled(18), padding: `0 ${scaled(6)}` };

function ActionIcon({ label, onClick, disabled, destructive, chosen, style = messageIconStyle, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  chosen?: boolean;
  style?: typeof messageIconStyle;
  children: ReactNode;
}) {
  return (
    <DialogButton
      className={`sg-message-icon${destructive ? " destructive" : ""}${chosen ? " chosen" : ""}`}
      style={style}
      onClick={onClick}
      disabled={disabled}
      onOKActionDescription={label}
    >
      {children}
    </DialogButton>
  );
}

const senderColors = ["#ff8a8a", "#ffb870", "#c9a2ff", "#7fdc94", "#72c8ff", "#5fd6d0", "#ff92c9"];

function senderColor(name: string) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return senderColors[Math.abs(hash) % senderColors.length];
}

function typingLabel(text: string) {
  return /[.\u2026]$/.test(text) ? text : `${text}\u2026`;
}

function StatusIcon({ status }: { status: MessageStatus }) {
  if (status === "read") return <FaCheckDouble className="sg-status read" />;
  if (status === "sent") return <FaCheck className="sg-status" />;
  if (status === "pending") return <FaRegClock className="sg-status" />;
  if (status === "failed") return <FaExclamationCircle className="sg-status failed" />;
  return null;
}

function messageTime(message: Message) {
  if (message.time_label) return message.time_label;
  if (message.date > 0) {
    return new Date(message.date * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return "";
}

type TelegramState = {
  status: string;
  chats: Chat[];
  error: string | null;
  login_error: string | null;
  qr_image: string | null;
};

type Settings = {
  chat_filter: "all" | "dms";
  hide_archived: boolean;
  notifications: "steam" | "off";
  notification_sound: boolean;
  unread_badges: "all" | "dms" | "off";
  notification_cooldown: boolean;
  cooldown_minutes: 3 | 5 | 10 | 15;
};

type MessageResult = {
  messages: Message[];
  message_count: number;
  message_root_found: boolean;
  message_root: string | null;
  identified_message_count: number;
  message_candidate_count: number;
  visible_message_candidate_count: number;
  message_class_count: number;
  message_id_attribute_count: number;
  dom_region_diagnostics: string[];
  selected_chat_title: string;
  typing_text: string;
};

// Kept equal to package.json by tests; comparing it with the backend's version shows when Steam is
// still running an older panel after an update.
const PANEL_VERSION = "0.25.2";

const getState = callable<[], TelegramState>("get_state");
const getVersion = callable<[], string>("get_version");
type UpdateStatus = {
  current: string;
  latest: string;
  update_available: boolean;
  download_url: string;
  sha256: string;
  release_url: string;
  checked_at: number;
  error: string;
};
const getUpdateStatus = callable<[], UpdateStatus | null>("get_update_status");
const checkForUpdate = callable<[], UpdateStatus>("check_for_update");
// Decky's own installer, the one its plugin store uses: it asks the user to confirm, downloads the ZIP,
// checks it against the release's SHA-256 when GitHub provides one, and reloads the plugin.
const DECKY_INSTALL_TYPE_UPDATE = 2;
function installUpdate(status: UpdateStatus) {
  const install = (window as any).DeckyBackend?.callable?.("utilities/install_plugin");
  if (!install) throw new Error("Decky's installer is not available");
  return install(status.download_url, "Deckygram", status.latest, status.sha256 || null, DECKY_INSTALL_TYPE_UPDATE);
}
const getChats = callable<[], Chat[]>("get_chats");
const getMessages = callable<[chatId: number], MessageResult>("get_messages");
const selectChat = callable<[chatId: number], TelegramState>("open_chat");
const leaveChat = callable<[], { ok: boolean }>("close_chat");
const getMessageImage = callable<[chatId: number, messageId: number], { found: boolean; data_url: string | null }>(
  "get_message_image",
);
const getMessageImageFile = callable<
  [chatId: number, messageId: number],
  { found: boolean; data_url: string | null; error?: string }
>("get_message_image_file");
const saveMessageImage = callable<[chatId: number, messageId: number], { ok: boolean; path: string; name: string }>(
  "save_message_image",
);
const MAX_CACHED_IMAGES = 80;
// Labels that the picture itself replaces once it has loaded.
const IMAGE_LABELS = new Set(["Photo", "Sticker"]);
// GIFs play in place; videos open the full-screen player. Both show a poster frame until then.
const PLAYABLE_LABELS = new Set(["GIF", "Video"]);
const sendMessage = callable<[chatId: number, text: string, replyTo: number | null], { ok: boolean }>("send_message");
const editMessage = callable<[chatId: number, messageId: number, text: string], { ok: boolean }>("edit_message");
const deleteMessage = callable<[chatId: number, messageId: number, forEveryone: boolean], { ok: boolean; scope: "everyone" | "self" }>(
  "delete_message",
);
type ReactionOption = { index: number; image: string; emoji: string; chosen: boolean };
type MessageAction = {
  messageId: number;
  mode: "menu" | "reply" | "edit" | "react" | "delete";
  text: string;
  reactions: ReactionOption[] | null;
  error: string;
  busy: boolean;
};
const reactionOptions = callable<[chatId: number, messageId: number], { options: ReactionOption[] }>("reaction_options");
const reactToMessage = callable<[chatId: number, messageId: number, index: number], { ok: boolean }>("react");
type Screenshot = { path: string; name: string; app_id: string; taken_at: number; thumbnail: string };
const listScreenshots = callable<[], Screenshot[]>("list_screenshots");
type Sticker = { id: string; emoji: string; set: string; image: string };
const loadMessageVideo = callable<[chatId: number, messageId: number], { id: string; size: number; mime: string }>("load_message_video");
const messageVideoChunk = callable<[videoId: string, index: number], { data: string; done: boolean }>("message_video_chunk");
const releaseMessageVideo = callable<[videoId: string], { ok: boolean }>("release_message_video");

// Fetches a GIF or video from Telegram in pieces (Decky's messages cannot carry a whole video) and
// returns a playable object URL. The caller revokes it when done.
async function fetchVideoUrl(chatId: number, messageId: number) {
  const video = await loadMessageVideo(chatId, messageId);
  const parts: Uint8Array[] = [];
  try {
    for (let index = 0; ; index += 1) {
      const chunk = await messageVideoChunk(video.id, index);
      const binary = atob(chunk.data);
      const bytes = new Uint8Array(binary.length);
      for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
      parts.push(bytes);
      if (chunk.done) break;
    }
  } finally {
    void releaseMessageVideo(video.id).catch(() => undefined);
  }
  return URL.createObjectURL(new Blob(parts, { type: video.mime || "video/mp4" }));
}

const setChatPinned = callable<[chatId: number, title: string, pinned: boolean], { ok: boolean }>("set_chat_pinned");
const listStickers = callable<[chatId: number], { stickers: Sticker[] }>("list_stickers");
const sendSticker = callable<[chatId: number, stickerId: string], { ok: boolean }>("send_sticker");
// Reading Telegram's sticker picker takes a few seconds, so the list is kept for the session.
let cachedStickers: Sticker[] | null = null;
const sendScreenshot = callable<[chatId: number, path: string, caption: string], { ok: boolean }>("send_screenshot");
const submitCloudPassword = callable<[password: string], { ok: boolean }>("submit_cloud_password");
const restartTelegram = callable<[], void>("restart_telegram");
const logout = callable<[], void>("logout");
const getSettings = callable<[], Settings>("get_settings");
const updateSettings = callable<[changes: Partial<Settings>], Settings>("update_settings");

const initialState: TelegramState = { status: "starting", chats: [], error: null, login_error: null, qr_image: null };
const initialSettings: Settings = {
  chat_filter: "all",
  hide_archived: false,
  notifications: "steam",
  notification_sound: true,
  unread_badges: "all",
  notification_cooldown: false,
  cooldown_minutes: 5,
};

// Full-screen image viewer: preview first, then the original file Telegram
// loaded, with a Save button that writes it to Downloads. It renders in Steam's main window, outside
// the QAM, so Deckygram's stylesheet does not reach it and every style here is inline.
function gameName(appId: string) {
  try {
    return (window as any).appStore?.GetAppOverviewByAppID?.(Number(appId))?.display_name || t("screenshot");
  } catch {
    return t("screenshot");
  }
}

// Steam screenshots, newest first. Choosing one shows it with an optional caption.
function ScreenshotPicker({ closeModal, chatId, chatTitle, onSent }: {
  closeModal?: () => void;
  chatId: number;
  chatTitle: string;
  onSent?: () => void;
}) {
  const [screenshots, setScreenshots] = useState<Screenshot[] | null>(null);
  const [chosen, setChosen] = useState<Screenshot | null>(null);
  const [caption, setCaption] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listScreenshots().then(setScreenshots).catch((loadError: Error) => setError(loadError.message));
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (root) root.style.setProperty("--dg-scale", String(uiScale(root, true)));
  }, []);

  const send = async () => {
    if (!chosen || sending) return;
    setSending(true);
    setError("");
    try {
      await sendScreenshot(chatId, chosen.path, caption);
      onSent?.();
      closeModal?.();
    } catch (sendError) {
      setError((sendError as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal} bAllowFullSize>
      <style>{scaledStyleText}</style>
      <div ref={rootRef} className="deckygram-native sg-shots">
        <div className="sg-shots-title">{chosen ? t("sendTo", { name: chatTitle }) : t("sendAScreenshot")}</div>
        {chosen ? (
          <Focusable className="sg-shots-confirm" flow-children="column">
            {chosen.thumbnail ? <img className="sg-shots-preview" src={chosen.thumbnail} alt="" /> : null}
            <TextField
              {...{ placeholder: t("captionPlaceholder") }}
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              disabled={sending}
            />
            <Focusable className="sg-chat-actions" flow-children="row">
              <DialogButton onClick={() => setChosen(null)} disabled={sending}>{t("back")}</DialogButton>
              <DialogButton onClick={() => void send()} disabled={sending}>{sending ? t("sending") : t("send")}</DialogButton>
            </Focusable>
          </Focusable>
        ) : screenshots === null ? (
          error ? null : <SteamSpinner background="transparent" />
        ) : screenshots.length === 0 ? (
          <div className="sg-chat-empty">{t("noScreenshots")}</div>
        ) : (
          <Focusable className="sg-shots-grid" flow-children="grid">
            {screenshots.map((screenshot) => (
              <Focusable
                key={screenshot.path}
                className="sg-shots-item"
                focusClassName="sg-focused"
                noFocusRing
                onActivate={() => setChosen(screenshot)}
                onClick={() => setChosen(screenshot)}
                onOKActionDescription={t("choose")}
              >
                {screenshot.thumbnail ? <img src={screenshot.thumbnail} alt="" /> : null}
                <span className="sg-shots-caption">
                  {gameName(screenshot.app_id)} · {new Date(screenshot.taken_at * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                </span>
              </Focusable>
            ))}
          </Focusable>
        )}
        {error ? <div className="sg-shots-error">{error}</div> : null}
      </div>
    </ModalRoot>
  );
}

// The chat window's sticker picker: the user's Telegram stickers, grouped by set as Telegram lists them.
function StickerPanel({ chatId, onSent, onClose }: { chatId: number; onSent: () => void; onClose: () => void }) {
  const [stickers, setStickers] = useState<Sticker[] | null>(cachedStickers);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = (refresh: boolean) => {
    if (!refresh && cachedStickers) return;
    setLoading(true);
    setError("");
    listStickers(chatId)
      .then((result) => {
        cachedStickers = result.stickers;
        setStickers(result.stickers);
      })
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(false), []);

  const send = async (sticker: Sticker) => {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      await sendSticker(chatId, sticker.id);
      onSent();
    } catch (sendError) {
      setError((sendError as Error).message);
    } finally {
      setSending(false);
    }
  };

  const groups: [string, Sticker[]][] = [];
  for (const sticker of stickers ?? []) {
    const last = groups[groups.length - 1];
    if (last && last[0] === sticker.set) last[1].push(sticker);
    else groups.push([sticker.set, [sticker]]);
  }

  return (
    <Focusable className="sg-stickers" flow-children="column">
      <Focusable className="sg-stickers-header" flow-children="row">
        <span className="sg-stickers-title">{t("stickers")}</span>
        <ActionIcon label={t("refreshStickers")} onClick={() => load(true)} disabled={loading || sending}><FaSyncAlt /></ActionIcon>
        <ActionIcon label={t("close")} onClick={onClose}><FaTimes /></ActionIcon>
      </Focusable>
      {loading ? <span className="sg-message-hint">{t("loadingStickers")}</span> : null}
      {!loading && stickers?.length === 0 && !error ? <span className="sg-message-hint">{t("noStickers")}</span> : null}
      <div className="sg-stickers-scroll">
        {groups.map(([set, items], index) => (
          <Fragment key={`${index}:${set}`}>
            {set ? <div className="sg-stickers-set">{set}</div> : null}
            <Focusable className="sg-stickers-grid" flow-children="grid">
              {items.map((sticker) => (
                <Focusable
                  key={sticker.id}
                  className="sg-sticker"
                  focusClassName="sg-focused"
                  noFocusRing
                  onActivate={() => void send(sticker)}
                  onClick={() => void send(sticker)}
                  onOKActionDescription={t("sendSticker")}
                >
                  {sticker.image ? <img src={sticker.image} alt={sticker.emoji} /> : <span>{sticker.emoji || "?"}</span>}
                </Focusable>
              ))}
            </Focusable>
          </Fragment>
        ))}
      </div>
      {error ? <div className="sg-shots-error">{error}</div> : null}
    </Focusable>
  );
}

// Full-screen player for a video message, with sound and Steam's own video controls.
function VideoViewer({ closeModal, chatId, messageId, poster }: {
  closeModal?: () => void;
  chatId: number;
  messageId: number;
  poster: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let created = "";
    fetchVideoUrl(chatId, messageId)
      .then((objectUrl) => {
        created = objectUrl;
        if (active) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((loadError: Error) => active && setError(loadError.message));
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, []);

  return (
    <ModalRoot closeModal={closeModal} onCancel={() => closeModal?.()} bAllowFullSize>
      <style>{scaledStyleText}</style>
      <div className="deckygram-native sg-video-viewer">
        {url ? (
          <video src={url} poster={poster || undefined} controls autoPlay playsInline />
        ) : (
          <>
            {poster ? <img src={poster} alt="" /> : null}
            {error ? <div className="sg-shots-error">{error}</div> : <span className="sg-message-hint">{t("loadingVideo")}</span>}
          </>
        )}
        <DialogButton onClick={() => closeModal?.()} style={{ width: "auto", minWidth: 0, padding: "8px 22px" }}>
          {t("close")}
        </DialogButton>
      </div>
    </ModalRoot>
  );
}

function ImageViewer({
  chatId,
  messageId,
  preview,
  closeModal,
}: {
  chatId: number;
  messageId: number;
  preview: string;
  closeModal?: () => void;
}) {
  const [full, setFull] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [saveDetail, setSaveDetail] = useState("");

  useEffect(() => {
    let mounted = true;
    getMessageImageFile(chatId, messageId)
      .then((result) => {
        if (!mounted) return;
        if (result.data_url) setFull(result.data_url);
        else setLoadError(result.error || t("previewOnly"));
      })
      .catch((error: Error) => {
        if (mounted) setLoadError(error.message);
      });
    return () => {
      mounted = false;
    };
  }, [chatId, messageId]);

  const save = async () => {
    if (saveState === "busy" || saveState === "done") return;
    setSaveState("busy");
    try {
      const result = await saveMessageImage(chatId, messageId);
      setSaveDetail(result.path);
      setSaveState("done");
    } catch (error) {
      setSaveDetail((error as Error).message);
      setSaveState("failed");
    }
  };

  const source = full || preview;
  return (
    <ModalRoot closeModal={closeModal} onCancel={() => closeModal?.()} bAllowFullSize>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        {source ? (
          <img
            src={source}
            alt=""
            style={{
              display: "block",
              maxWidth: "100%",
              maxHeight: "72vh",
              objectFit: "contain",
              borderRadius: 6,
              background: "#000",
            }}
          />
        ) : (
          <SteamSpinner background="transparent" />
        )}
        {!full && !loadError && source ? (
          <div style={{ fontSize: 12, opacity: 0.7 }}>{t("loadingFullImage")}</div>
        ) : null}
        {loadError ? <div style={{ fontSize: 12, opacity: 0.7, textAlign: "center" }}>{loadError}</div> : null}
        <Focusable style={{ display: "flex", gap: 8 }} flow-children="row">
          <DialogButton
            onClick={() => void save()}
            disabled={saveState === "busy" || saveState === "done"}
            style={{ width: "auto", minWidth: 0, padding: "8px 22px" }}
          >
            {saveState === "busy" ? t("saving") : saveState === "done" ? t("saved") : saveState === "failed" ? t("retrySave") : t("saveToDownloads")}
          </DialogButton>
          <DialogButton onClick={() => closeModal?.()} style={{ width: "auto", minWidth: 0, padding: "8px 22px" }}>
            {t("close")}
          </DialogButton>
        </Focusable>
        {saveDetail ? (
          <div style={{ fontSize: 12, opacity: 0.75, wordBreak: "break-all", textAlign: "center" }}>
            {saveState === "done" ? t("savedTo", { path: saveDetail }) : saveDetail}
          </div>
        ) : null}
      </div>
    </ModalRoot>
  );
}

// Chat ids are row positions in Telegram's list, so a chat window names its chat and looks the row up itself.
type ChatTarget = { title: string; isGroup: boolean };
// Telegram Web has one open chat at a time. A window opened from the panel shares the panel's chat and leaves
// it open on close; one opened from a notification takes over and leaves it on close.
type WindowTarget = ChatTarget & { sharedWithPanel?: boolean };
const chatWindowListeners = new Set<(target: ChatTarget) => void>();

type ContentProps = {
  windowChat?: WindowTarget;
  closeWindow?: () => void;
  // Lets the window's own close and cancel go through the chat view too.
  closeHandle?: { current: (() => void) | null };
};

function Content({ windowChat, closeWindow, closeHandle }: ContentProps = {}) {
  const [state, setState] = useState(initialState);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageRootFound, setMessageRootFound] = useState(true);
  const [messageDiagnostics, setMessageDiagnostics] = useState<MessageResult | null>(null);
  const [draft, setDraft] = useState("");
  // The selected message and what is being done to it, shown inline under (or in place of) its bubble.
  const [messageAction, setMessageAction] = useState<MessageAction | null>(null);
  const actionRowRef = useRef<HTMLDivElement>(null);
  const draftFieldRef = useRef<HTMLDivElement>(null);
  const [showStickers, setShowStickers] = useState(false);
  // Playing GIFs by message id, as object URLs; "" while a GIF is still loading.
  const gifUrls = useRef(new Map<number, string>());
  const [, setGifVersion] = useState(0);
  const [cloudPassword, setCloudPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settings, setSettings] = useState(initialSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [backendVersion, setBackendVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "installing">("idle");
  const [typingText, setTypingText] = useState("");
  // Images are fetched once per message and kept here, instead of travelling with every 2-second refresh.
  const imageCache = useRef(new Map<string, string>());
  const imageRequests = useRef(new Set<string>());
  const [, setImageVersion] = useState(0);
  // The message list fills whatever height is left above the composer, so the reply box sits at the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [scrollHeight, setScrollHeight] = useState<number | null>(null);
  // The QAM's own scroll container, locked while a chat is open.
  const qamScroller = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const backAction = useRef<(() => void) | null>(null);
  const lastBackAt = useRef(0);
  const [notice, setNotice] = useState("");
  // Results for a chat the user has since left must not overwrite the newly selected conversation.
  const activeChatId = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    const refreshState = async () => {
      try {
        const nextState = await getState();
        if (mounted) setState(nextState);
      } catch (error) {
        if (mounted) setNotice((error as Error).message);
      } finally {
        if (mounted) timer = window.setTimeout(() => void refreshState(), 2000);
      }
    };
    void refreshState();
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    getVersion().then(setBackendVersion).catch(() => setBackendVersion(""));
  }, []);

  useEffect(() => {
    // The backend checks GitHub in the background; this only reads its last result.
    getUpdateStatus().then(setUpdateStatus).catch(() => undefined);
  }, []);

  const pressUpdateButton = async () => {
    if (updateState !== "idle") return;
    if (updateStatus?.update_available) {
      setUpdateState("installing");
      setNotice(t("updateStarted"));
      try {
        await installUpdate(updateStatus);
      } catch (error) {
        setNotice((error as Error).message);
      } finally {
        setUpdateState("idle");
      }
      return;
    }
    setUpdateState("checking");
    try {
      setUpdateStatus(await checkForUpdate());
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setUpdateState("idle");
    }
  };

  useEffect(() => {
    let mounted = true;
    getSettings()
      .then((value) => {
        if (mounted) setSettings(value);
      })
      .catch((error: Error) => {
        if (mounted) setNotice(error.message);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedChat || state.status !== "ready") return undefined;
    let mounted = true;
    let timer: number | undefined;
    const pollMessages = async () => {
      try {
        await refreshMessages(selectedChat);
      } catch (error) {
        if (mounted && activeChatId.current === selectedChat.id) setNotice((error as Error).message);
      } finally {
        if (mounted) timer = window.setTimeout(() => void pollMessages(), 2000);
      }
    };
    timer = window.setTimeout(() => void pollMessages(), 2000);
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selectedChat, state.status]);

  useEffect(() => {
    if (!selectedChat) return;
    const chatId = selectedChat.id;
    const pending = messages.filter((message) => {
      const key = `${chatId}:${message.id}`;
      return message.image?.ready && !imageCache.current.has(key) && !imageRequests.current.has(key);
    });
    if (pending.length === 0) return;
    void (async () => {
      for (const message of pending) {
        const key = `${chatId}:${message.id}`;
        if (activeChatId.current !== chatId) return;
        imageRequests.current.add(key);
        try {
          const result = await getMessageImage(chatId, message.id);
          if (result.data_url) {
            if (imageCache.current.size >= MAX_CACHED_IMAGES) {
              const oldest = imageCache.current.keys().next().value;
              if (oldest !== undefined) imageCache.current.delete(oldest);
            }
            imageCache.current.set(key, result.data_url);
            setImageVersion((version) => version + 1);
          }
        } catch {
          // Not loaded in Telegram yet or the chat changed; the next refresh retries.
        } finally {
          imageRequests.current.delete(key);
        }
      }
    })();
  }, [messages, selectedChat]);

  useEffect(() => {
    // Decky's container is sized to the panel plus its title bar and padding, so it always overhangs the
    // panel by ~58px of empty space. Growing the chat into the free space below the composer makes that
    // overhang overflow and scroll the QAM. While a chat is open the QAM's scroller is therefore locked,
    // the overhang stays below the fold, and only the message list scrolls.
    if (!selectedChat) return undefined;
    const list = scrollRef.current;
    const view = list?.ownerDocument.defaultView;
    let scroller: HTMLElement | null = list?.parentElement ?? null;
    while (scroller && view && !/(auto|scroll)/.test(view.getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    if (!scroller) return undefined;
    const locked = scroller;
    const previousOverflow = locked.style.overflowY;
    locked.scrollTop = 0;
    locked.style.overflowY = "hidden";
    qamScroller.current = locked;
    return () => {
      locked.style.overflowY = previousOverflow;
      qamScroller.current = null;
    };
  }, [selectedChat]);

  useEffect(() => {
    // Plugin code runs in Steam's shared JS context, so the global window is not the one the QAM is
    // drawn in; measure against the window that actually owns the panel's elements.
    const list = scrollRef.current;
    const view = list?.ownerDocument.defaultView;
    const scroller = qamScroller.current;
    // Steam's focus handling can still scroll an overflow:hidden container from code; keep it at the top.
    const pinScroller = () => {
      if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0;
    };
    // Size the list so the composer sits just above the QAM's visible bottom edge, at any UI scale.
    const measure = () => {
      const composer = composerRef.current;
      if (!list || !composer || !view) return;
      pinScroller();
      const visibleBottom = scroller
        ? scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight
        : view.innerHeight;
      const next = list.getBoundingClientRect().height + (visibleBottom - 6 - composer.getBoundingClientRect().bottom);
      const height = Math.max(120, Math.floor(next));
      setScrollHeight((current) => (current === height ? current : height));
    };
    measure();
    scroller?.addEventListener("scroll", pinScroller);
    view?.addEventListener("resize", measure);
    // Catches QAM size changes from UI scaling or resolution that do not fire a window resize.
    const Observer = (view as (Window & { ResizeObserver?: typeof ResizeObserver }) | null | undefined)?.ResizeObserver;
    const observer = Observer && scroller ? new Observer(measure) : null;
    if (observer && scroller) observer.observe(scroller);
    return () => {
      scroller?.removeEventListener("scroll", pinScroller);
      view?.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  });

  const isViewable = (message: Message) => Boolean(message.image) && IMAGE_LABELS.has(message.media);
  const isPlayable = (message: Message) => Boolean(message.image) && PLAYABLE_LABELS.has(message.media);

  const releaseGifs = () => {
    gifUrls.current.forEach((url) => url && URL.revokeObjectURL(url));
    gifUrls.current.clear();
  };

  useEffect(() => releaseGifs, []);

  const playMedia = (message: Message) => {
    const chat = selectedChat;
    if (!chat || !isPlayable(message)) return;
    if (message.media === "Video") {
      showModal(
        <VideoViewer
          chatId={chat.id}
          messageId={message.id}
          poster={imageCache.current.get(`${chat.id}:${message.id}`) ?? ""}
        />,
      );
      return;
    }
    if (gifUrls.current.has(message.id)) return;
    gifUrls.current.set(message.id, "");
    setGifVersion((version) => version + 1);
    fetchVideoUrl(chat.id, message.id)
      .then((url) => {
        if (activeChatId.current === chat.id) gifUrls.current.set(message.id, url);
        else URL.revokeObjectURL(url);
      })
      .catch((error: Error) => {
        gifUrls.current.delete(message.id);
        setNotice(error.message);
      })
      .finally(() => setGifVersion((version) => version + 1));
  };
  const openImage = (message: Message) => {
    if (!selectedChat || !isViewable(message)) return;
    showModal(
      <ImageViewer
        chatId={selectedChat.id}
        messageId={message.id}
        preview={imageCache.current.get(`${selectedChat.id}:${message.id}`) ?? ""}
      />,
    );
  };

  const closeMessageAction = () => setMessageAction(null);
  const updateMessageAction = (changes: Partial<MessageAction>) =>
    setMessageAction((current) => (current ? { ...current, ...changes } : current));

  const selectMessage = (message: Message) => {
    if (message.is_service) {
      if (isViewable(message)) openImage(message);
      return;
    }
    setMessageAction((current) => (current?.messageId === message.id && current.mode === "menu"
      ? null
      : { messageId: message.id, mode: "menu", text: "", reactions: null, error: "", busy: false }));
  };

  const startMessageMode = (mode: MessageAction["mode"], text = "") => updateMessageAction({ mode, text, error: "" });

  const startReact = (chat: Chat, message: Message) => {
    updateMessageAction({ mode: "react", reactions: null, error: "" });
    reactionOptions(chat.id, message.id)
      .then((result) => setMessageAction((current) => (current?.messageId === message.id
        ? { ...current, reactions: result.options }
        : current)))
      .catch((error: Error) => setMessageAction((current) => (current?.messageId === message.id
        ? { ...current, reactions: [], error: error.message }
        : current)));
  };

  // Runs one action on the selected message; the inline row stays open with the error if Telegram refuses.
  const runMessageAction = async (chat: Chat, action: () => Promise<unknown>) => {
    updateMessageAction({ busy: true, error: "" });
    try {
      await action();
      setMessageAction(null);
      await refreshMessages(chat);
    } catch (error) {
      updateMessageAction({ busy: false, error: (error as Error).message });
    }
  };

  const deleteSelectedMessage = (chat: Chat, message: Message, forEveryone: boolean) => runMessageAction(chat, async () => {
    const result = await deleteMessage(chat.id, message.id, forEveryone);
    if (forEveryone && result.scope === "self") {
      setNotice(t("deletedForYouOnly"));
    }
  });

  useEffect(() => {
    // The row's first button takes controller focus as it appears; text boxes focus themselves.
    if (!messageAction || messageAction.mode === "reply" || messageAction.mode === "edit") return;
    actionRowRef.current?.querySelector<HTMLElement>(".DialogButton, button")?.focus();
  }, [messageAction?.messageId, messageAction?.mode, messageAction?.reactions]);

  const refreshMessages = async (chat: Chat) => {
    const result = await getMessages(chat.id);
    if (activeChatId.current !== chat.id) return;
    setMessages(result.messages);
    setMessageRootFound(result.message_root_found);
    setMessageDiagnostics(result);
    setTypingText(result.typing_text || "");
  };

  const refreshSelectedChat = async (chat: Chat) => {
    setBusy(true);
    setNotice("");
    try {
      await refreshMessages(chat);
    } catch (error) {
      if (activeChatId.current === chat.id) setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const togglePinned = (chat: Chat) => {
    if (busy || chat.is_archive_folder) return;
    setBusy(true);
    setNotice("");
    setChatPinned(chat.id, chat.title, !chat.is_pinned)
      .then(async () => setState(await getState()))
      .catch((error: Error) => setNotice(error.message))
      .finally(() => setBusy(false));
  };

  const openChat = async (chat: Chat) => {
    activeChatId.current = chat.id;
    setSelectedChat(chat);
    setMessages([]);
    setMessageDiagnostics(null);
    setTypingText("");
    setMessageRootFound(true);
    setNotice("");
    setBusy(true);
    try {
      await selectChat(chat.id);
      await refreshMessages(chat);
    } catch (error) {
      if (activeChatId.current === chat.id) setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // leave is false when another view still needs Telegram's open chat.
  const closeChat = (leave = true) => {
    const wasOpen = activeChatId.current !== null;
    activeChatId.current = null;
    setSelectedChat(null);
    setMessageAction(null);
    releaseGifs();
    setMessages([]);
    setMessageDiagnostics(null);
    setTypingText("");
    setNotice("");
    if (wasOpen && leave) {
      leaveChat().catch((error: Error) => setNotice(error.message));
    }
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const view = root.ownerDocument.defaultView;
    // Steam changes the space it gives on resolution and UI-scale changes, not always with a resize event.
    const applyScale = () => {
      if (!root.isConnected || (!windowChat && root.getBoundingClientRect().width < 80)) return;
      const next = String(uiScale(root, Boolean(windowChat)));
      if (root.style.getPropertyValue("--dg-scale") !== next) root.style.setProperty("--dg-scale", next);
    };
    applyScale();
    const timer = window.setInterval(applyScale, 2000);
    view?.addEventListener("resize", applyScale);
    return () => {
      window.clearInterval(timer);
      view?.removeEventListener("resize", applyScale);
    };
  }, []);

  const selectedChatRef = useRef(selectedChat);
  selectedChatRef.current = selectedChat;
  useEffect(() => {
    if (windowChat) return undefined;
    // A window that opened a different chat moved Telegram away from the panel's, so the panel goes back to its list.
    const listener = (target: ChatTarget) => {
      const current = selectedChatRef.current;
      if (current && (current.title !== target.title || current.is_group !== target.isGroup)) closeChat(false);
    };
    chatWindowListeners.add(listener);
    return () => {
      chatWindowListeners.delete(listener);
    };
  }, []);

  const windowChatOpened = useRef(false);
  useEffect(() => {
    if (!windowChat || windowChatOpened.current || state.status !== "ready") return;
    windowChatOpened.current = true;
    const chat = state.chats.find((candidate) => candidate.title === windowChat.title && candidate.is_group === windowChat.isGroup);
    if (!chat) {
      setNotice(`${windowChat.title} is no longer in Telegram's chat list.`);
      return;
    }
    if (!windowChat.sharedWithPanel) chatWindowListeners.forEach((listener) => listener(windowChat));
    void openChat(chat);
  }, [state]);

  const closeChatWindow = () => {
    closeChat(!windowChat?.sharedWithPanel);
    closeWindow?.();
  };
  if (closeHandle) closeHandle.current = closeChatWindow;

  const openScreenshotPicker = (chat: Chat) => {
    showModal(<ScreenshotPicker chatId={chat.id} chatTitle={chat.title} onSent={() => void refreshMessages(chat)} />);
  };

  const openChatWindow = (chat: Chat) => {
    showModal(<ChatWindow target={{ title: chat.title, isGroup: chat.is_group, sharedWithPanel: true }} />);
  };

  const sendDraft = async () => {
    if (!selectedChat || !draft.trim() || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await sendMessage(selectedChat.id, draft, null);
      setDraft("");
      // Pressing Send moves focus to the button; return it so the conversation can go on.
      draftFieldRef.current?.querySelector("input")?.focus();
      await refreshMessages(selectedChat);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!cloudPassword.trim() || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await submitCloudPassword(cloudPassword);
      setCloudPassword("");
    } catch (error) {
      setNotice((error as Error).message);
      setCloudPassword("");
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitPassword();
    }
  };

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendDraft();
    }
  };

  const refreshChatList = async () => {
    setBusy(true);
    try {
      const [chats, nextState] = await Promise.all([getChats(), getState()]);
      setState({ ...nextState, chats });
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeSetting = async <K extends keyof Settings>(setting: K, value: Settings[K]) => {
    setSettingsBusy(true);
    setNotice("");
    try {
      setSettings(await updateSettings({ [setting]: value }));
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const retryTelegram = async () => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await restartTelegram();
      setState(await getState());
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const closeSettings = () => {
    setShowSettings(false);
    setConfirmLogout(false);
  };

  // B / Escape go back from a chat or Settings to the chat list. On the chat list it is left alone so
  // B still closes the QAM. One press can arrive through several routes, so repeats are swallowed.
  backAction.current = messageAction && !messageAction.busy ? closeMessageAction
    : windowChat ? closeChatWindow
    : state.status !== "ready" ? null : selectedChat ? closeChat : showSettings ? closeSettings : null;
  const handleBack = (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    const now = Date.now();
    const repeat = now - lastBackAt.current < 300;
    if (!repeat && !backAction.current) return false;
    if (!repeat) {
      lastBackAt.current = now;
      backAction.current?.();
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    return true;
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    // Steam emits vgp_oncancel for B; Focusable's props are not always wired up inside the QAM.
    const onCancel = (event: Event) => {
      handleBack(event);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") handleBack(event);
    };
    root.addEventListener("vgp_oncancel", onCancel, true);
    root.addEventListener("keydown", onKeyDown, true);
    return () => {
      root.removeEventListener("vgp_oncancel", onCancel, true);
      root.removeEventListener("keydown", onKeyDown, true);
    };
  });

  const signOut = async () => {
    setConfirmLogout(false);
    setShowSettings(false);
    closeChat();
    setBusy(true);
    try {
      await logout();
      setState(await getState());
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const visibleChats = state.chats.filter((chat) => {
    if (chat.is_archive_folder) return !settings.hide_archived && settings.chat_filter === "all";
    return settings.chat_filter === "all" || chat.is_direct;
  });
  const showBadge = (chat: Chat) => chat.unread_count > 0 && (
    settings.unread_badges === "all" || (settings.unread_badges === "dms" && chat.is_direct)
  );

  return (
    <>
      <style>{scaledStyleText}</style>
      <Focusable
        ref={rootRef}
        className="deckygram-native"
        flow-children="column"
        noFocusRing
        onCancel={(event) => handleBack(event)}
        onCancelButton={(event) => handleBack(event)}
        onButtonDown={(event) => {
          if (event.detail.button === GamepadButton.CANCEL) handleBack(event);
        }}
        onCancelActionDescription={backAction.current ? t("back") : undefined}
      >
        {state.status === "ready" ? (
          showSettings ? (
            <>
              <PanelSection>
                <Focusable className="sg-toolbar" flow-children="row">
                  <DialogButton className="sg-icon-button" onClick={closeSettings} style={iconButtonStyle}>
                    <FaArrowLeft />
                  </DialogButton>
                  <span className="sg-toolbar-title">{t("settings")}</span>
                </Focusable>
              </PanelSection>
              <PanelSection title={t("chats")}>
                <PanelSectionRow>
                  <DropdownItem
                    label={t("show")}
                    rgOptions={[{ data: "all", label: t("allChats") }, { data: "dms", label: t("directMessagesOnly") }]}
                    selectedOption={settings.chat_filter}
                    disabled={settingsBusy}
                    onChange={(option) => void changeSetting("chat_filter", option.data)}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label={t("hideArchived")}
                    checked={settings.hide_archived}
                    disabled={settingsBusy}
                    onChange={(checked) => void changeSetting("hide_archived", checked)}
                  />
                </PanelSectionRow>
              </PanelSection>
              <PanelSection title={t("notifications")}>
                <PanelSectionRow>
                  <DropdownItem
                    label={t("popups")}
                    rgOptions={[{ data: "steam", label: t("steamNotifications") }, { data: "off", label: t("noPopups") }]}
                    selectedOption={settings.notifications}
                    disabled={settingsBusy}
                    onChange={(option) => void changeSetting("notifications", option.data)}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label={t("notificationSound")}
                    checked={settings.notification_sound}
                    disabled={settingsBusy || settings.notifications === "off"}
                    onChange={(checked) => void changeSetting("notification_sound", checked)}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label={t("cooldown")}
                    description={t("cooldownNote")}
                    checked={settings.notification_cooldown}
                    disabled={settingsBusy || settings.notifications === "off"}
                    onChange={(checked) => void changeSetting("notification_cooldown", checked)}
                  />
                </PanelSectionRow>
                {settings.notification_cooldown && settings.notifications !== "off" ? (
                  <PanelSectionRow>
                    <DropdownItem
                      label={t("cooldownWindow")}
                      rgOptions={([3, 5, 10, 15] as const).map((count) => ({ data: count, label: t("minutes", { count }) }))}
                      selectedOption={settings.cooldown_minutes}
                      disabled={settingsBusy}
                      onChange={(option) => void changeSetting("cooldown_minutes", option.data)}
                    />
                  </PanelSectionRow>
                ) : null}
                <PanelSectionRow>
                  <DropdownItem
                    label={t("unreadCounters")}
                    rgOptions={[
                      { data: "all", label: t("allChats") },
                      { data: "dms", label: t("directMessagesOnly") },
                      { data: "off", label: t("off") },
                    ]}
                    selectedOption={settings.unread_badges}
                    disabled={settingsBusy}
                    onChange={(option) => void changeSetting("unread_badges", option.data)}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <div className="sg-settings-note">
                    {t("mutedNote")}
                  </div>
                </PanelSectionRow>
              </PanelSection>
              <PanelSection title={t("account")}>
                {confirmLogout ? (
                  <>
                    <PanelSectionRow>
                      <div className="sg-settings-note">
                        {t("logOutDetail")} {t("logOutSession")}
                      </div>
                    </PanelSectionRow>
                    <PanelSectionRow>
                      <ButtonItem onClick={() => void signOut()} disabled={busy}>{t("confirmLogOut")}</ButtonItem>
                    </PanelSectionRow>
                    <PanelSectionRow>
                      <ButtonItem onClick={() => setConfirmLogout(false)}>{t("cancel")}</ButtonItem>
                    </PanelSectionRow>
                  </>
                ) : (
                  <PanelSectionRow>
                    <ButtonItem onClick={() => setConfirmLogout(true)} disabled={busy}>{t("logOut")}</ButtonItem>
                  </PanelSectionRow>
                )}
                {notice ? <PanelSectionRow>{notice}</PanelSectionRow> : null}
              </PanelSection>
              <PanelSection title={t("updates")}>
                <PanelSectionRow>
                  <ButtonItem
                    layout="below"
                    onClick={() => void pressUpdateButton()}
                    disabled={updateState !== "idle"}
                    description={updateStatus?.error && !updateStatus.update_available
                      ? t("updateCheckFailed", { error: updateStatus.error })
                      : t("installedVersion", { version: PANEL_VERSION })}
                  >
                    <span className="sg-update-button">
                      {updateState === "checking" ? t("checkingVersion")
                        : updateStatus?.update_available ? <><FaArrowCircleUp /> {t("updateTo", { version: updateStatus.latest })}</>
                          : updateStatus && !updateStatus.error ? <><FaCheck /> {t("upToDate")}</>
                            : t("checkVersion")}
                    </span>
                  </ButtonItem>
                </PanelSectionRow>
              </PanelSection>
              <PanelSection>
                <PanelSectionRow>
                  <div className="sg-settings-note sg-version">
                    Deckygram {PANEL_VERSION}
                    {backendVersion && backendVersion !== PANEL_VERSION ? (
                      <span className="sg-version-mismatch">
                        {t("backendMismatch", { version: backendVersion })}
                      </span>
                    ) : null}
                  </div>
                </PanelSectionRow>
              </PanelSection>
            </>
          ) : selectedChat ? (
            <PanelSection>
              <Focusable className="sg-toolbar" flow-children="row">
                <DialogButton
                  className="sg-icon-button"
                  onClick={() => (windowChat ? closeChatWindow() : closeChat())}
                  style={iconButtonStyle}
                >
                  <FaArrowLeft />
                </DialogButton>
                <span className="sg-toolbar-title">
                  {selectedChat.title}
                  {typingText ? <span className="sg-typing">{typingLabel(typingText)}</span> : null}
                </span>
                <DialogButton
                  className="sg-icon-button"
                  onClick={() => void refreshSelectedChat(selectedChat)}
                  disabled={busy}
                  style={iconButtonStyle}
                >
                  <FaSyncAlt />
                </DialogButton>
              </Focusable>
              <Focusable
                ref={scrollRef}
                className="sg-chat-scroll"
                flow-children="column"
                style={scrollHeight ? { height: scrollHeight } : { maxHeight: "52vh" }}
              >
                <div className="sg-chat-stack">
                  {busy && messages.length === 0 ? <SteamSpinner background="transparent" /> : null}
                  {!busy && messages.length === 0 ? (
                    <div className="sg-chat-empty">
                      {messageRootFound
                        ? t("noMessages")
                        : t("messageListMissing")}
                      {messageDiagnostics ? (
                        <small className="sg-chat-diagnostics">
                          root: {messageDiagnostics.message_root || "not found"}
                          {" · "}message nodes: {messageDiagnostics.identified_message_count}
                          {" · "}visible: {messageDiagnostics.visible_message_candidate_count}
                          {" · "}DOM: {messageDiagnostics.dom_region_diagnostics.slice(0, 5).join(", ") || "none"}
                        </small>
                      ) : null}
                    </div>
                  ) : null}
                  {messages.map((message, index) => {
                    const previous = index > 0 ? messages[index - 1] : null;
                    const newDay = Boolean(message.day_label) && message.day_label !== previous?.day_label;
                    const continued = Boolean(previous) && !newDay && !message.is_service && !previous?.is_service
                      && previous?.is_outgoing === message.is_outgoing && previous?.sender === message.sender;
                    const showSender = selectedChat.is_group && !message.is_outgoing && !message.is_service
                      && !continued && Boolean(message.sender);
                    const kind = message.is_service ? "service" : message.is_outgoing ? "outgoing" : "incoming";
                    // Stickers show on their own, without a bubble, the way Telegram draws them.
                    const isSticker = message.media === "Sticker" && Boolean(message.image) && !message.text;
                    const time = message.is_service ? "" : messageTime(message);
                    const action = messageAction?.messageId === message.id ? messageAction : null;
                    return (
                      <Fragment key={message.id}>
                        {newDay ? <div className="sg-chat-day">{message.day_label}</div> : null}
                        {action?.mode === "edit" ? (
                          <Focusable className={`sg-chat-message ${kind} editing`} flow-children="column">
                            <TextField
                              value={action.text}
                              onChange={(event) => updateMessageAction({ text: event.target.value })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && action.text.trim()) {
                                  event.preventDefault();
                                  void runMessageAction(selectedChat, () => editMessage(selectedChat.id, message.id, action.text));
                                }
                              }}
                              focusOnMount
                              disabled={action.busy}
                            />
                            <Focusable className="sg-message-actions outgoing" flow-children="row">
                              <ActionIcon
                                label={t("save")}
                                onClick={() => void runMessageAction(selectedChat, () => editMessage(selectedChat.id, message.id, action.text))}
                                disabled={action.busy || !action.text.trim()}
                              >
                                <FaCheck />
                              </ActionIcon>
                              <ActionIcon label={t("cancel")} onClick={closeMessageAction} disabled={action.busy}><FaTimes /></ActionIcon>
                            </Focusable>
                          </Focusable>
                        ) : (
                        <Focusable
                          className={`sg-chat-message ${kind}${continued ? " continued" : ""}${action ? " selected" : ""}${isSticker ? " sticker" : ""}`}
                          focusClassName="sg-focused"
                          noFocusRing
                          onActivate={() => selectMessage(message)}
                          onOKActionDescription={message.is_service ? (isViewable(message) ? t("viewImage") : undefined) : t("messageOptions")}
                        >
                          {showSender ? (
                            <span className="sg-chat-sender" style={{ color: senderColor(message.sender) }}>
                              {message.sender}
                            </span>
                          ) : null}
                          {message.reply ? (
                            <span className="sg-chat-quote" style={{ borderColor: senderColor(message.reply.sender || "?") }}>
                              <span className="sg-chat-quote-sender" style={{ color: senderColor(message.reply.sender || "?") }}>
                                <FaReply /> {message.reply.sender}
                              </span>
                              {message.reply.text ? <span className="sg-chat-quote-text">{message.reply.text}</span> : null}
                            </span>
                          ) : null}
                          {message.image ? (
                            <span
                              className={`sg-chat-image${isViewable(message) ? " viewable" : ""}${isSticker ? " sticker" : ""}`}
                              onClick={() => (isPlayable(message) ? playMedia(message) : openImage(message))}
                              style={{
                                aspectRatio: message.image.width && message.image.height
                                  ? `${message.image.width} / ${message.image.height}`
                                  : "4 / 3",
                              }}
                            >
                              {gifUrls.current.get(message.id) ? (
                                <video src={gifUrls.current.get(message.id)} autoPlay loop muted playsInline />
                              ) : imageCache.current.has(`${selectedChat.id}:${message.id}`) ? (
                                <img src={imageCache.current.get(`${selectedChat.id}:${message.id}`)} alt="" />
                              ) : null}
                              {isPlayable(message) && !gifUrls.current.get(message.id) ? (
                                <span className="sg-media-badge">
                                  {gifUrls.current.has(message.id) ? t("loadingVideo")
                                    : message.media === "GIF" ? "GIF"
                                      : <><FaPlay /> {message.media_duration}</>}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                          {message.media && !(message.image && (IMAGE_LABELS.has(message.media) || PLAYABLE_LABELS.has(message.media))
                            && imageCache.current.has(`${selectedChat.id}:${message.id}`)) ? (
                            <span className="sg-chat-media">{mediaLabel(message.media)}</span>
                          ) : null}
                          {message.text}
                          {time || message.status ? (
                            <span className="sg-chat-time">
                              {time}
                              <StatusIcon status={message.status} />
                            </span>
                          ) : null}
                        </Focusable>
                        )}
                        {action && action.mode !== "edit" ? (
                          <Focusable
                            ref={actionRowRef}
                            className={`sg-message-actions ${kind}${action.mode === "reply" ? " replying" : ""}`}
                            flow-children={action.mode === "reply" ? "column" : "row"}
                          >
                            {action.mode === "menu" ? (
                              <>
                                <ActionIcon label={t("reply")} onClick={() => startMessageMode("reply")}><FaReply /></ActionIcon>
                                <ActionIcon label={t("react")} onClick={() => startReact(selectedChat, message)}><FaRegSmile /></ActionIcon>
                                {message.is_outgoing && message.text ? (
                                  <ActionIcon label={t("edit")} onClick={() => startMessageMode("edit", message.text)}><FaPen /></ActionIcon>
                                ) : null}
                                <ActionIcon label={t("delete")} destructive onClick={() => startMessageMode("delete")}><FaTrashAlt /></ActionIcon>
                                {isViewable(message) ? (
                                  <ActionIcon label={t("viewImage")} onClick={() => openImage(message)}><FaExpand /></ActionIcon>
                                ) : null}
                                {isPlayable(message) ? (
                                  <ActionIcon label={t("playVideo")} onClick={() => playMedia(message)}><FaPlay /></ActionIcon>
                                ) : null}
                              </>
                            ) : action.mode === "reply" ? (
                              <>
                                <TextField
                                  {...{ placeholder: t("replyTo", { name: message.is_outgoing ? t("yourself") : message.sender || selectedChat.title }) }}
                                  value={action.text}
                                  onChange={(event) => updateMessageAction({ text: event.target.value })}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && action.text.trim()) {
                                      event.preventDefault();
                                      void runMessageAction(selectedChat, () => sendMessage(selectedChat.id, action.text, message.id));
                                    }
                                  }}
                                  focusOnMount
                                  disabled={action.busy}
                                />
                                <Focusable className="sg-message-actions outgoing" flow-children="row">
                                  <ActionIcon
                                    label={t("sendReply")}
                                    onClick={() => void runMessageAction(selectedChat, () => sendMessage(selectedChat.id, action.text, message.id))}
                                    disabled={action.busy || !action.text.trim()}
                                  >
                                    <FaPaperPlane />
                                  </ActionIcon>
                                  <ActionIcon label={t("cancel")} onClick={closeMessageAction} disabled={action.busy}><FaTimes /></ActionIcon>
                                </Focusable>
                              </>
                            ) : action.mode === "react" ? (
                              <>
                                {action.reactions === null ? <span className="sg-message-hint">{t("loadingReactions")}</span> : null}
                                {action.reactions?.map((option) => (
                                  <ActionIcon
                                    key={option.index}
                                    label={option.chosen ? t("removeReaction") : t("react")}
                                    chosen={option.chosen}
                                    style={reactionButtonStyle}
                                    onClick={() => void runMessageAction(selectedChat, () => reactToMessage(selectedChat.id, message.id, option.index))}
                                    disabled={action.busy}
                                  >
                                    {option.emoji || (option.image ? <img className="sg-reaction-image" src={option.image} alt="" /> : String(option.index + 1))}
                                  </ActionIcon>
                                ))}
                                {action.reactions?.length === 0 && !action.error ? (
                                  <span className="sg-message-hint">{t("reactionsOff")}</span>
                                ) : null}
                                <ActionIcon label={t("cancel")} onClick={closeMessageAction} disabled={action.busy}><FaTimes /></ActionIcon>
                              </>
                            ) : (
                              <>
                                <span className="sg-message-hint">{t("deleteFor")}</span>
                                {/* Telegram allows deleting your own messages, and any message in a private chat, for both sides. */}
                                {message.is_outgoing || !selectedChat.is_group ? (
                                  <ActionIcon
                                    label={t("deleteForEveryone")}
                                    destructive
                                    onClick={() => void deleteSelectedMessage(selectedChat, message, true)}
                                    disabled={action.busy}
                                  >
                                    <FaTrashAlt /><FaUsers />
                                  </ActionIcon>
                                ) : null}
                                <ActionIcon
                                  label={t("deleteForMe")}
                                  destructive
                                  onClick={() => void deleteSelectedMessage(selectedChat, message, false)}
                                  disabled={action.busy}
                                >
                                  <FaTrashAlt /><FaUser />
                                </ActionIcon>
                                <ActionIcon label={t("cancel")} onClick={closeMessageAction} disabled={action.busy}><FaTimes /></ActionIcon>
                              </>
                            )}
                          </Focusable>
                        ) : null}
                        {action?.error ? <div className={`sg-message-error ${kind}`}>{action.error}</div> : null}
                      </Fragment>
                    );
                  })}
                </div>
              </Focusable>
              <div ref={composerRef}>
              {windowChat && showStickers ? (
                <StickerPanel
                  chatId={selectedChat.id}
                  onClose={() => setShowStickers(false)}
                  onSent={() => {
                    setShowStickers(false);
                    void refreshMessages(selectedChat);
                    draftFieldRef.current?.querySelector("input")?.focus();
                  }}
                />
              ) : null}
              <Focusable className="sg-chat-composer" flow-children="column">
                {/* Never disabled: disabling a focused field drops focus, and the next message would need it reselected. */}
                <div ref={draftFieldRef}>
                  <TextField
                    {...{ placeholder: t("message") }}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleDraftKeyDown}
                    // Starting on the message box keeps the list at the newest messages; focusing a message
                    // first would scroll the list up to wherever that message sits.
                    focusOnMount
                  />
                </div>
                <Focusable className="sg-chat-actions" flow-children="row">
                  <DialogButton className="sg-chat-send" onClick={() => void sendDraft()} disabled={busy || !draft.trim()}>
                    {t("send")}
                  </DialogButton>
                  <DialogButton
                    onClick={() => openScreenshotPicker(selectedChat)}
                    disabled={busy}
                    onOKActionDescription={t("sendAScreenshot")}
                    style={composerIconStyle}
                  >
                    <FaImage />
                  </DialogButton>
                  {windowChat ? (
                    // Stickers only in the separate window, where there is room for the picker.
                    <DialogButton
                      onClick={() => setShowStickers((shown) => !shown)}
                      onOKActionDescription={t("stickers")}
                      style={composerIconStyle}
                    >
                      <FaRegGrinStars />
                    </DialogButton>
                  ) : null}
                  {windowChat ? null : (
                    <DialogButton
                      onClick={() => openChatWindow(selectedChat)}
                      onOKActionDescription={t("openInWindow")}
                      style={composerIconStyle}
                    >
                      <FaRegWindowRestore />
                    </DialogButton>
                  )}
                </Focusable>
              </Focusable>
              {notice ? <PanelSectionRow>{notice}</PanelSectionRow> : null}
              </div>
            </PanelSection>
          ) : windowChat ? (
            <PanelSection>
              <PanelSectionRow>{notice || <SteamSpinner background="transparent" />}</PanelSectionRow>
            </PanelSection>
          ) : (
            <PanelSection>
              <Focusable className="sg-toolbar" flow-children="row">
                <span className="sg-toolbar-title">{settings.chat_filter === "dms" ? t("directMessages") : t("chats")}</span>
                {/* Switches every Deckygram popup on or off; the same setting as Popups in Settings. */}
                <DialogButton
                  className={`sg-icon-button${settings.notifications === "off" ? " muted" : ""}`}
                  onClick={() => void changeSetting("notifications", settings.notifications === "off" ? "steam" : "off")}
                  disabled={settingsBusy}
                  onOKActionDescription={settings.notifications === "off" ? t("notificationsOn") : t("notificationsOff")}
                  style={iconButtonStyle}
                >
                  {settings.notifications === "off" ? <FaBellSlash /> : <FaBell />}
                </DialogButton>
                <DialogButton className="sg-icon-button" onClick={refreshChatList} disabled={busy} style={iconButtonStyle}>
                  <FaSyncAlt />
                </DialogButton>
                <DialogButton
                  className="sg-icon-button"
                  onClick={() => setShowSettings(true)}
                  disabled={busy}
                  onOKActionDescription={updateStatus?.update_available ? t("updateAvailable") : undefined}
                  style={{ ...iconButtonStyle, position: "relative" }}
                >
                  <FaCog />
                  {updateStatus?.update_available ? <span className="sg-update-dot" /> : null}
                </DialogButton>
              </Focusable>
              {visibleChats.map((chat, position) => (
                <Fragment key={chat.id}>
                {chat.is_pinned && !visibleChats[position - 1]?.is_pinned ? (
                  <div className="sg-list-heading"><FaThumbtack /> {t("pinned")}</div>
                ) : null}
                {!chat.is_pinned && visibleChats[position - 1]?.is_pinned ? (
                  <div className="sg-list-heading">{t("otherChats")}</div>
                ) : null}
                <PanelSectionRow>
                  {/* A Focusable, not a plain <button>: Steam's controller navigation only reaches its own focus nodes. */}
                  <Focusable
                    className="sg-chat-row"
                    focusClassName="sg-focused"
                    noFocusRing
                    onActivate={() => {
                      if (!busy) void openChat(chat);
                    }}
                    onClick={() => {
                      if (!busy) void openChat(chat);
                    }}
                    // X on the Deck pins or unpins the chat.
                    onSecondaryButton={chat.is_archive_folder ? undefined : () => togglePinned(chat)}
                    onSecondaryActionDescription={chat.is_archive_folder ? undefined : (chat.is_pinned ? t("unpinChat") : t("pinChat"))}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: scaled(10), minWidth: 0 }}>
                      <span style={{
                        position: "relative",
                        display: "grid",
                        flex: `0 0 ${scaled(40)}`,
                        width: scaled(40),
                        height: scaled(40),
                        placeItems: "center",
                        overflow: "hidden",
                        borderRadius: "50%",
                        background: "rgba(255,255,255,0.16)",
                      }}>
                        {(chat.title || "T").slice(0, 1).toUpperCase()}
                        {chat.avatar_url ? (
                          <img
                            src={chat.avatar_url}
                            alt=""
                            onError={(event) => { event.currentTarget.style.display = "none"; }}
                            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : null}
                      </span>
                      <span style={{ display: "block", flex: 1, minWidth: 0 }}>
                        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {chat.title}
                          </strong>
                          {chat.is_pinned && !showBadge(chat) ? (
                            <FaThumbtack className="sg-pin-mark" />
                          ) : null}
                          {showBadge(chat) ? (
                            <span className={`sg-unread${chat.is_muted ? " muted" : ""}`}>
                              {chat.unread_count > 999 ? "999+" : chat.unread_count}
                            </span>
                          ) : null}
                        </span>
                        <span style={{
                          display: "block",
                          marginTop: 3,
                          overflow: "hidden",
                          opacity: 0.72,
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                          {chat.typing_text ? (
                            <span className="sg-typing inline">{typingLabel(chat.typing_text)}</span>
                          ) : (
                            <>
                              <StatusIcon status={chat.last_message_status} />
                              {chat.last_message || (chat.is_archive_folder ? t("archivedConversations") : t("noRecentMessages"))}
                            </>
                          )}
                        </span>
                      </span>
                    </span>
                  </Focusable>
                </PanelSectionRow>
                </Fragment>
              ))}
              {visibleChats.length === 0 ? (
                <PanelSectionRow>
                  {state.chats.length === 0
                    ? t("noChatsFound")
                    : t("allChatsHidden")}
                </PanelSectionRow>
              ) : null}
              {notice ? <PanelSectionRow>{notice}</PanelSectionRow> : null}
            </PanelSection>
          )
        ) : (
          <PanelSection title="Telegram">
            <PanelSectionRow>
              {state.status === "password"
                ? t("cloudPasswordPrompt")
                : state.status === "login"
                  ? t("qrPrompt")
                  : state.status === "downloading"
                    ? t("downloadingRuntime")
                    : state.status === "connecting"
                      ? t("connecting")
                      : t("starting")}
            </PanelSectionRow>
            {state.status === "password" ? (
              <>
                <PanelSectionRow>
                  {/* bIsPassword alone shows the text on this Steam build; the class masks it with CSS either way. */}
                  <div className="sg-password">
                    <TextField
                      {...{ type: "password", autoComplete: "off" }}
                      label={t("cloudPassword")}
                      value={cloudPassword}
                      onChange={(event) => setCloudPassword(event.target.value)}
                      onKeyDown={handlePasswordKeyDown}
                      bIsPassword
                      disabled={busy}
                    />
                  </div>
                </PanelSectionRow>
                <PanelSectionRow>
                  <ButtonItem onClick={() => void submitPassword()} disabled={busy || !cloudPassword.trim()}>
                    {busy ? t("submitting") : t("signIn")}
                  </ButtonItem>
                </PanelSectionRow>
                {state.login_error ? <PanelSectionRow>{state.login_error}</PanelSectionRow> : null}
              </>
            ) : null}
            {state.status === "login" && state.qr_image ? (
              <PanelSectionRow>
                <div style={{ display: "flex", width: "100%", justifyContent: "center", boxSizing: "border-box" }}>
                  <img
                    src={`data:image/svg+xml;base64,${state.qr_image}`}
                    alt={t("qrAlt")}
                    style={{
                      display: "block",
                      width: `min(${scaled(312)}, 100%)`,
                      maxWidth: "100%",
                      height: "auto",
                      padding: scaled(16),
                      boxSizing: "border-box",
                      background: "white",
                      borderRadius: 8,
                    }}
                  />
                </div>
              </PanelSectionRow>
            ) : state.status === "login" ? (
              <PanelSectionRow>{t("loadingQr")}</PanelSectionRow>
            ) : state.status !== "error" ? (
              <PanelSectionRow><SteamSpinner background="transparent" /></PanelSectionRow>
            ) : null}
            {state.error ? <PanelSectionRow>{state.error}</PanelSectionRow> : null}
            {state.status === "error" ? (
              <PanelSectionRow>
                <ButtonItem onClick={() => void retryTelegram()} disabled={busy}>
                  {t("retry")}
                </ButtonItem>
              </PanelSectionRow>
            ) : null}
          </PanelSection>
        )}
        {notice && state.status !== "ready" ? (
          <PanelSection><PanelSectionRow>{notice}</PanelSectionRow></PanelSection>
        ) : null}
      </Focusable>
    </>
  );
}

// Chats without a photo get Telegram-style initials, so the notification never falls back to Steam's "?" avatar.
function initialsAvatar(title: string) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.fillStyle = "#2aabee";
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = "white";
    context.font = "600 30px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText((title || "T").slice(0, 1).toUpperCase(), 32, 34);
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

// A full-size window with one chat. B, the back arrow and closing the modal
// all go through the chat view, so it can leave Telegram's chat when the window owned it.
function ChatWindow({ closeModal, target }: { closeModal?: () => void; target: WindowTarget }) {
  const closeHandle = useRef<(() => void) | null>(null);
  const close = () => (closeHandle.current ? closeHandle.current() : closeModal?.());
  return (
    <ModalRoot closeModal={close} onCancel={close} bAllowFullSize>
      <Content windowChat={target} closeWindow={closeModal} closeHandle={closeHandle} />
    </ModalRoot>
  );
}

export default definePlugin(() => {
  const onMessage = (title: string, preview: string, playSound: boolean, avatarUrl = "", isGroup = false) => {
    showTelegramNotification({
      key: `${isGroup ? "group" : "chat"}:${title}`,
      name: `Telegram · ${title}`,
      body: preview || t("newMessage"),
      avatarUrl: avatarUrl || initialsAvatar(title),
      playSound,
      onSelect: () => showModal(<ChatWindow target={{ title, isGroup }} />),
    });
  };
  addEventListener("deckygram_message", onMessage);
  return {
    name: "Deckygram",
    titleView: <div className="deckygram-title">Deckygram</div>,
    content: <Content />,
    icon: <FaTelegramPlane />,
    onDismount: () => {
      removeEventListener("deckygram_message", onMessage);
      stopTelegramNotifications();
    },
  };
});
