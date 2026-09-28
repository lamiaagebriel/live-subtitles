// Every message sent through chrome.runtime / chrome.tabs messaging.
//
//   popup ──start/stop/subfile-open──▶ background ──start/stop/settings──▶ offscreen
//   offscreen ──subtitle/status/error──▶ background ──▶ live overlay (tab)
//   subfile (any frame) ──subfile-broadcast──▶ background ──▶ subfile (every frame of the tab)
import { browser } from "wxt/browser";
import type { Cue } from "./subparse";
import type { LiveSettings } from "./settings";

// Live mode text shown on the page (offscreen → background → live overlay)
export type LiveTextMessage =
  | { type: "subtitle"; text: string; original: string | null }
  | { type: "status"; text: string }
  | { type: "error"; text: string };

export type LiveOverlayMessage = LiveTextMessage | { type: "remove" };

// Background → offscreen document
export type OffscreenMessage = { target: "offscreen" } & (
  | { type: "start"; streamId: string; settings: LiveSettings }
  | { type: "stop" }
  | { type: "settings"; settings: LiveSettings }
);

// Between the frames of a tab in subtitle-file mode (relayed by the background)
export type SubfileMessage =
  | { type: "subfile-panel" }
  | { type: "subfile-cues"; cues: Cue[]; name: string; offset: number }
  | { type: "subfile-offset"; offset: number }
  | { type: "subfile-hidden"; hidden: boolean }
  | { type: "subfile-sync-now"; index: number }
  | { type: "subfile-time"; t: number; paused: boolean; rate: number }
  | { type: "subfile-close" };

// Requests the background handles
export type BackgroundMessage =
  | { type: "start"; tabId: number; streamId: string }
  | { type: "stop" }
  | { type: "subfile-open"; tabId: number }
  | { type: "subfile-broadcast"; payload: SubfileMessage }
  | { type: "translate-batch"; texts: string[]; lang: string }
  | LiveTextMessage;

export type Reply = { ok: true } | { error: string };
export type TranslateReply = { texts: string[] } | { error: string };

// Anything the background's onMessage listener can receive
export type AnyMessage = BackgroundMessage | OffscreenMessage;

// Typed senders, so every message matches one of the shapes above

export function sendToBackground<R = Reply>(msg: BackgroundMessage): Promise<R> {
  return browser.runtime.sendMessage<BackgroundMessage, R>(msg);
}

export function sendToOffscreen(msg: OffscreenMessage): Promise<unknown> {
  return browser.runtime.sendMessage<OffscreenMessage>(msg);
}

export function sendToTab(tabId: number, msg: LiveOverlayMessage | SubfileMessage, frameId?: number): Promise<unknown> {
  return frameId === undefined
    ? browser.tabs.sendMessage(tabId, msg)
    : browser.tabs.sendMessage(tabId, msg, { frameId });
}
