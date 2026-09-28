// Every message sent through chrome.runtime / chrome.tabs messaging.
//
//   popup ──start/stop/subfile-*──▶ background ──start/stop/settings──▶ offscreen
//   offscreen ──subtitle/status/error/live-covered──▶ background ──▶ live overlay (the frame playing the video)
//   offscreen ──live-time-query──▶ background ──▶ live overlay, which answers with LiveTime
//   live overlay ──live-video-frame──▶ background (which frame of the tab plays the video)
//   background ──subfile-cues/offset/…──▶ subfile script (every frame of the tab)
//   subfile script ──subfile-load (drop) / subfile-offset (G/H keys)──▶ background
//   background ──subfile-changed──▶ popup
import { browser } from "wxt/browser";
import type { Cue } from "./subparse";
import type { LiveSettings } from "./settings";

// Where a live subtitle sits in the video: seconds of video time, for one video
export interface LiveTiming { videoKey: string; start: number; end: number }

// Live mode messages for the page (offscreen → background → live overlay)
export type LiveTextMessage =
  // source: what Whisper heard; translated: the same line in `lang` (null when not translating)
  | { type: "subtitle"; source: string; translated: string | null; lang: string; timing: LiveTiming | null }
  | { type: "live-covered"; timing: LiveTiming } // this stretch was handled but had no words
  | { type: "status"; text: string }
  | { type: "error"; text: string };

// The video frame's answer to live-time-query. `covered`: [from, t] was already transcribed.
// volume: the element's volume (0–1), so quiet audio can be boosted back up before transcription
export interface LiveTime { t: number; paused: boolean; rate: number; volume: number; videoKey: string; covered: boolean }

export type LiveTimeQuery = { type: "live-time-query"; from: number | null };

// liveMuted: the extension silences the video's sound itself (subtitles keep going)
export type LiveOverlayMessage = LiveTextMessage | LiveTimeQuery | { type: "remove" } | { type: "live-muted"; muted: boolean };

// Background → offscreen document
export type OffscreenMessage = { target: "offscreen" } & (
  | { type: "start"; streamId: string; settings: LiveSettings }
  | { type: "stop" }
  | { type: "settings"; settings: LiveSettings }
  | { type: "output"; muted: boolean } // play the tab's sound or not (capture continues either way)
);

// Background / popup → subtitle-file script in every frame of a tab
export type SubfileTabMessage =
  | { type: "subfile-cues"; cues: Cue[]; offset: number; hidden: boolean }
  | { type: "subfile-offset"; offset: number }
  | { type: "subfile-hidden"; hidden: boolean }
  | { type: "subfile-close" }
  | { type: "subfile-sync-now"; index: number } // the frame playing the video sets the delay so cue `index` starts now
  | { type: "subfile-time-query" }; // answered only by the frame playing the video, with PlayerTime

export interface PlayerTime { t: number; paused: boolean }

// What the popup shows about the loaded file
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
  | { type: "live-video-frame"; area: number } // from a content script: its main video's size (0 = none)
  | { type: "live-mute"; muted: boolean } // from the popup or the page: mute the sound, keep the subtitles
  | LiveTimeQuery // from the offscreen document; answered with LiveTime or null
  | LiveTextMessage;

// Background → popup
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

// Without frameId the message goes to every frame of the tab
export function sendToTab<R = unknown>(tabId: number, msg: LiveOverlayMessage | SubfileTabMessage, frameId?: number): Promise<R> {
  return frameId === undefined ? browser.tabs.sendMessage(tabId, msg) : browser.tabs.sendMessage(tabId, msg, { frameId });
}
