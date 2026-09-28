import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { LIVE_DEFAULTS } from "@/lib/settings";
import { translateBatch } from "@/lib/translate";

async function getActiveTabId() {
  const { activeTabId } = await browser.storage.session.get("activeTabId");
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

function toTab(tabId, msg) {
  if (tabId) browser.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ---------- Live (AI) mode ----------
async function start(tabId, streamId) {
  const settings = await browser.storage.local.get(LIVE_DEFAULTS);
  await browser.scripting.executeScript({ target: { tabId }, files: ["/content-scripts/live-overlay.js"] });
  await ensureOffscreen();
  await browser.runtime.sendMessage({ target: "offscreen", type: "start", streamId, settings });
  await browser.storage.session.set({ activeTabId: tabId });
  browser.action.setBadgeText({ text: "ON", tabId });
  browser.action.setBadgeBackgroundColor({ color: "#4f7cff" });
  toTab(tabId, { type: "status", text: "🎧 Listening…" });
}

async function stop() {
  const tabId = await getActiveTabId();
  try { await browser.runtime.sendMessage({ target: "offscreen", type: "stop" }); } catch {}
  await closeOffscreen();
  toTab(tabId, { type: "remove" });
  if (tabId) browser.action.setBadgeText({ text: "", tabId }).catch(() => {});
  await browser.storage.session.remove("activeTabId");
}

// ---------- Subtitle-file mode ----------
const SUBFILE_SCRIPTS = ["/content-scripts/subfile.js"];

async function openSubfile(tabId) {
  try {
    // All frames, so videos inside embedded players (iframes) are covered too
    await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: SUBFILE_SCRIPTS });
  } catch {
    await browser.scripting.executeScript({ target: { tabId }, files: SUBFILE_SCRIPTS });
  }
  await browser.tabs.sendMessage(tabId, { type: "subfile-panel" }, { frameId: 0 });
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target === "offscreen") return false;

    if (msg.type === "start") {
      start(msg.tabId, msg.streamId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
      return true;
    }
    if (msg.type === "stop") {
      stop().then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
      return true;
    }
    if (msg.type === "subfile-open") {
      openSubfile(msg.tabId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
      return true;
    }
    // Relay subtitle-file messages to every frame of the same tab
    if (msg.type === "subfile-broadcast" && sender.tab) {
      browser.tabs.sendMessage(sender.tab.id, msg.payload).catch(() => {});
      return false;
    }
    if (msg.type === "translate-batch") {
      translateBatch(msg.texts, msg.target).then((texts) => sendResponse({ texts }), (e) => sendResponse({ error: e.message }));
      return true;
    }
    // Live-mode subtitle / status / error messages from the offscreen document → the page
    if (["subtitle", "status", "error"].includes(msg.type) && sender.url?.includes("offscreen.html")) {
      getActiveTabId().then((tabId) => toTab(tabId, msg));
    }
    return false;
  });

  // Live-apply settings changes while live mode runs
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    const tabId = await getActiveTabId();
    if (!tabId) return;
    const settings = await browser.storage.local.get(LIVE_DEFAULTS);
    browser.runtime.sendMessage({ target: "offscreen", type: "settings", settings }).catch(() => {});
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    if (tabId === (await getActiveTabId())) stop();
  });
});
