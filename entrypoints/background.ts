import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { LIVE_DEFAULTS, migrateStyles, type LiveSettings } from "@/lib/settings";
import { translateBatch } from "@/lib/translate";
import * as P from "@/lib/subparse";
import { fromBase64 } from "@/lib/bytes";
import {
  sendToOffscreen, sendToPanel, sendToTab,
  type AnyMessage, type LiveOverlayMessage, type SubfileInfo, type SubfileTabMessage
} from "@/lib/messages";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ================= Live (AI) mode =================
async function getActiveTabId(): Promise<number | null> {
  const { activeTabId } = await browser.storage.session.get<{ activeTabId?: number }>("activeTabId");
  return activeTabId || null;
}

async function ensureOffscreen() {
  const contexts = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  await browser.offscreen.createDocument({
    url: "/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture the tab's audio to generate subtitles."
  });
}

async function closeOffscreen() {
  const contexts = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) await browser.offscreen.closeDocument();
}

function toTab(tabId: number | null, msg: LiveOverlayMessage) {
  if (tabId) sendToTab(tabId, msg).catch(() => {});
}

function injectLiveOverlay(tabId: number) {
  return browser.scripting.executeScript({ target: { tabId }, files: ["/content-scripts/live-overlay.js"] });
}

async function start(tabId: number, streamId: string) {
  const settings = await browser.storage.local.get<LiveSettings>(LIVE_DEFAULTS);
  await injectLiveOverlay(tabId);
  await ensureOffscreen();
  await sendToOffscreen({ target: "offscreen", type: "start", streamId, settings });
  await browser.storage.session.set({ activeTabId: tabId });
  browser.action.setBadgeText({ text: "ON", tabId });
  browser.action.setBadgeBackgroundColor({ color: "#4f7cff" });
  toTab(tabId, { type: "status", text: "🎧 Listening…" });
}

async function stop() {
  const tabId = await getActiveTabId();
  try { await sendToOffscreen({ target: "offscreen", type: "stop" }); } catch {}
  await closeOffscreen();
  toTab(tabId, { type: "remove" });
  if (tabId) browser.action.setBadgeText({ text: "", tabId }).catch(() => {});
  await browser.storage.session.remove("activeTabId");
}

// ================= Subtitle-file mode =================
// The loaded file of each tab lives in session storage, so it survives the service worker
// restarting and is put back automatically when the page reloads.
interface StoredFile {
  name: string;
  data: string; // file bytes, base64
  encoding: string; // "auto" or a TextDecoder label
  offset: number; // seconds; positive = subtitles later
  hidden: boolean;
}

type SubOffsets = Record<string, number>;

const fileKey = (tabId: number) => `subfile:${tabId}`;
const parsed = new Map<number, { data: string; encoding: string; cues: P.Cue[] }>();

async function getFile(tabId: number): Promise<StoredFile | null> {
  const key = fileKey(tabId);
  const stored = await browser.storage.session.get<Record<string, StoredFile | undefined>>(key);
  return stored[key] ?? null;
}

function putFile(tabId: number, file: StoredFile) {
  return browser.storage.session.set({ [fileKey(tabId)]: file });
}

async function removeFile(tabId: number) {
  parsed.delete(tabId);
  await browser.storage.session.remove(fileKey(tabId));
}

// Throws if the encoding can't read the file
function decodeCues(data: string, encoding: string): P.Cue[] {
  return P.parse(P.decode(fromBase64(data), encoding));
}

function cuesOf(tabId: number, file: StoredFile): P.Cue[] {
  const hit = parsed.get(tabId);
  if (hit && hit.data === file.data && hit.encoding === file.encoding) return hit.cues;
  const cues = decodeCues(file.data, file.encoding);
  parsed.set(tabId, { data: file.data, encoding: file.encoding, cues });
  return cues;
}

const SUBFILE_SCRIPT = "/content-scripts/subfile.js" as const;

async function injectSubfile(tabId: number) {
  try {
    // All frames, so videos inside embedded players (iframes) are covered too
    await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: [SUBFILE_SCRIPT] });
  } catch {
    await browser.scripting.executeScript({ target: { tabId }, files: [SUBFILE_SCRIPT] });
  }
}

function toFrames(tabId: number, msg: SubfileTabMessage) {
  return sendToTab(tabId, msg).catch(() => {});
}

function pushCues(tabId: number, file: StoredFile) {
  return toFrames(tabId, { type: "subfile-cues", cues: cuesOf(tabId, file), offset: file.offset, hidden: file.hidden });
}

function notifyPanel(tabId: number) {
  sendToPanel({ type: "subfile-changed", tabId }).catch(() => {}); // no side panel open is fine
}

async function savedOffset(name: string): Promise<number> {
  const { subOffsets = {} } = await browser.storage.local.get<{ subOffsets?: SubOffsets }>("subOffsets");
  return subOffsets[name] || 0;
}

async function saveOffset(name: string, offset: number) {
  const { subOffsets = {} } = await browser.storage.local.get<{ subOffsets?: SubOffsets }>("subOffsets");
  subOffsets[name] = offset;
  const keys = Object.keys(subOffsets);
  if (keys.length > 100) delete subOffsets[keys[0]!];
  await browser.storage.local.set({ subOffsets });
}

const NO_CUES = "No subtitle lines found. Supported formats: .srt, .vtt, .ass, .ssa";

async function loadFile(tabId: number, name: string, data: string): Promise<number> {
  const cues = decodeCues(data, "auto");
  if (!cues.length) throw new Error(NO_CUES);
  const file: StoredFile = { name, data, encoding: "auto", offset: await savedOffset(name), hidden: false };
  await putFile(tabId, file);
  parsed.set(tabId, { data, encoding: "auto", cues });
  await injectSubfile(tabId);
  await pushCues(tabId, file);
  notifyPanel(tabId);
  return cues.length;
}

async function setEncoding(tabId: number, encoding: string) {
  const file = await getFile(tabId);
  if (!file) return;
  let cues: P.Cue[];
  try { cues = decodeCues(file.data, encoding); } catch { throw new Error("This encoding can't read the file. Try another one."); }
  if (!cues.length) throw new Error(NO_CUES);
  const next = { ...file, encoding };
  await putFile(tabId, next);
  await pushCues(tabId, next);
  notifyPanel(tabId);
}

async function setOffset(tabId: number, offset: number) {
  const file = await getFile(tabId);
  if (!file) return;
  offset = Math.round(offset * 100) / 100;
  await putFile(tabId, { ...file, offset });
  await toFrames(tabId, { type: "subfile-offset", offset });
  await saveOffset(file.name, offset);
  notifyPanel(tabId);
}

async function setHidden(tabId: number, hidden: boolean) {
  const file = await getFile(tabId);
  if (!file) return;
  await putFile(tabId, { ...file, hidden });
  await toFrames(tabId, { type: "subfile-hidden", hidden });
  notifyPanel(tabId);
}

async function closeFile(tabId: number) {
  await removeFile(tabId);
  await toFrames(tabId, { type: "subfile-close" });
  notifyPanel(tabId);
}

async function fileInfo(tabId: number): Promise<SubfileInfo | null> {
  const file = await getFile(tabId);
  if (!file) return null;
  return { name: file.name, encoding: file.encoding, offset: file.offset, hidden: file.hidden, cues: cuesOf(tabId, file) };
}

// Inject the script (for drag & drop) and hand it the loaded file, if any
async function attachSubfile(tabId: number) {
  await injectSubfile(tabId);
  const file = await getFile(tabId);
  if (file) await pushCues(tabId, file);
}

// ================= wiring =================
export default defineBackground(() => {
  // The toolbar icon opens the side panel. Clicking it also grants activeTab,
  // which live mode needs to capture that tab's audio.
  browser.action.onClicked.addListener((tab) => {
    if (tab.windowId !== undefined) browser.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  });

  browser.runtime.onInstalled.addListener(() => { migrateStyles().catch(() => {}); });

  browser.runtime.onMessage.addListener((msg: AnyMessage, sender, sendResponse) => {
    if ("target" in msg) return false; // meant for the offscreen document

    // Reply with { ok: true } (plus any extra fields) or { error }
    const reply = (p: Promise<object | void>) => {
      p.then((extra) => sendResponse({ ok: true, ...extra }), (e) => sendResponse({ error: errorText(e) }));
      return true;
    };
    const senderTab = sender.tab?.id;

    switch (msg.type) {
      case "start":
        return reply(start(msg.tabId, msg.streamId));
      case "stop":
        return reply(stop());
      case "subfile-attach":
        return reply(attachSubfile(msg.tabId));
      case "subfile-load": {
        const tabId = msg.tabId ?? senderTab;
        if (tabId === undefined) return false;
        return reply(loadFile(tabId, msg.name, msg.data).then((count) => ({ count })));
      }
      case "subfile-encoding":
        return reply(setEncoding(msg.tabId, msg.encoding));
      case "subfile-offset": {
        const tabId = msg.tabId ?? senderTab;
        if (tabId === undefined) return false;
        return reply(setOffset(tabId, msg.offset));
      }
      case "subfile-hidden":
        return reply(setHidden(msg.tabId, msg.hidden));
      case "subfile-close":
        return reply(closeFile(msg.tabId));
      case "subfile-get":
        fileInfo(msg.tabId).then(sendResponse, () => sendResponse(null));
        return true;
      case "translate-batch":
        translateBatch(msg.texts, msg.lang).then((texts) => sendResponse({ texts }), (e) => sendResponse({ error: errorText(e) }));
        return true;
      // Live-mode subtitle / status / error messages from the offscreen document → the page
      case "subtitle":
      case "status":
      case "error":
        if (sender.url?.includes("offscreen.html")) getActiveTabId().then((tabId) => toTab(tabId, msg));
        return false;
    }
    return false;
  });

  // Live-apply settings changes while live mode runs
  browser.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== "local") return;
    const tabId = await getActiveTabId();
    if (!tabId) return;
    const settings = await browser.storage.local.get<LiveSettings>(LIVE_DEFAULTS);
    sendToOffscreen({ target: "offscreen", type: "settings", settings }).catch(() => {});
  });

  // A reload wipes the page's scripts: put the subtitles back
  browser.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status !== "complete") return;
    if (tabId === (await getActiveTabId())) injectLiveOverlay(tabId).catch(() => {});
    const file = await getFile(tabId);
    if (file) attachSubfile(tabId).catch(() => {});
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    if (tabId === (await getActiveTabId())) stop();
    removeFile(tabId).catch(() => {});
  });
});
