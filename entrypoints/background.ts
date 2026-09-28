import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { LIVE_DEFAULTS, type LiveSettings } from "@/lib/settings";
import { translateBatch } from "@/lib/translate";
import { sendToOffscreen, sendToTab, type AnyMessage, type LiveOverlayMessage } from "@/lib/messages";

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

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- Live (AI) mode ----------
async function start(tabId: number, streamId: string) {
  const settings = await browser.storage.local.get<LiveSettings>(LIVE_DEFAULTS);
  await browser.scripting.executeScript({ target: { tabId }, files: ["/content-scripts/live-overlay.js"] });
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

// ---------- Subtitle-file mode ----------
const SUBFILE_SCRIPT = "/content-scripts/subfile.js" as const;

async function openSubfile(tabId: number) {
  try {
    // All frames, so videos inside embedded players (iframes) are covered too
    await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: [SUBFILE_SCRIPT] });
  } catch {
    await browser.scripting.executeScript({ target: { tabId }, files: [SUBFILE_SCRIPT] });
  }
  await sendToTab(tabId, { type: "subfile-panel" }, 0);
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: AnyMessage, sender, sendResponse) => {
    if ("target" in msg) return false; // meant for the offscreen document

    switch (msg.type) {
      case "start":
        start(msg.tabId, msg.streamId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: errorText(e) }));
        return true;
      case "stop":
        stop().then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: errorText(e) }));
        return true;
      case "subfile-open":
        openSubfile(msg.tabId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: errorText(e) }));
        return true;
      // Relay subtitle-file messages to every frame of the same tab
      case "subfile-broadcast":
        if (sender.tab?.id !== undefined) sendToTab(sender.tab.id, msg.payload).catch(() => {});
        return false;
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

  browser.tabs.onRemoved.addListener(async (tabId) => {
    if (tabId === (await getActiveTabId())) stop();
  });
});
