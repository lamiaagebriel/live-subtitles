// Every message sent through chrome.runtime / chrome.tabs messaging.
//
//   side panel ──start/stop/subfile-*──▶ background ──start/stop/settings──▶ offscreen
//   offscreen ──subtitle/status/error──▶ background ──▶ live overlay (tab)
//   background ──subfile-cues/offset/…──▶ subfile script (every frame of the tab)
//   subfile script ──subfile-load (drop) / subfile-offset (G/H keys)──▶ background
//   background ──subfile-changed──▶ side panel
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

// Background / side panel → subtitle-file script in every frame of a tab
export type SubfileTabMessage =
  | { type: "subfile-cues"; cues: Cue[]; offset: number; hidden: boolean }
  | { type: "subfile-offset"; offset: number }
  | { type: "subfile-hidden"; hidden: boolean }
  | { type: "subfile-close" }
  | { type: "subfile-sync-now"; index: number } // the frame playing the video sets the delay so cue `index` starts now
  | { type: "subfile-time-query" }; // answered only by the frame playing the video, with PlayerTime

export interface PlayerTime { t: number; paused: boolean }

// What the side panel shows about the loaded file
export interface SubfileInfo {
  name: string;
  encoding: string;
  offset: number;
  hidden: boolean;
  cues: Cue[];
}

// Requests the background handles. `tabId` is omitted when a content script sends it (the sender's tab is used).
export type BackgroundMessage =
  | { type: "start"; tabId: number; streamId: string }
  | { type: "stop" }
  | { type: "subfile-attach"; tabId: number }
  | { type: "subfile-load"; tabId?: number; name: string; data: string } // data: file bytes as base64
  | { type: "subfile-encoding"; tabId: number; encoding: string }
  | { type: "subfile-offset"; tabId?: number; offset: number }
  | { type: "subfile-hidden"; tabId: number; hidden: boolean }
  | { type: "subfile-close"; tabId: number }
  | { type: "subfile-get"; tabId: number }
  | { type: "translate-batch"; texts: string[]; lang: string }
  | LiveTextMessage;

// Background → side panel
export type PanelMessage = { type: "subfile-changed"; tabId: number };

export type Reply = { ok: true } | { error: string };
export type LoadReply = { ok: true; count: number } | { error: string };
export type TranslateReply = { texts: string[] } | { error: string };

// Anything the background's onMessage listener can receive
export type AnyMessage = BackgroundMessage | OffscreenMessage | PanelMessage;

// Typed senders, so every message matches one of the shapes above

export function sendToBackground<R = Reply>(msg: BackgroundMessage): Promise<R> {
  return browser.runtime.sendMessage<BackgroundMessage, R>(msg);
}

export function sendToOffscreen(msg: OffscreenMessage): Promise<unknown> {
  return browser.runtime.sendMessage<OffscreenMessage>(msg);
}

export function sendToPanel(msg: PanelMessage): Promise<unknown> {
  return browser.runtime.sendMessage<PanelMessage>(msg);
}

export function sendToTab<R = unknown>(tabId: number, msg: LiveOverlayMessage | SubfileTabMessage): Promise<R> {
  return browser.tabs.sendMessage(tabId, msg);
}
