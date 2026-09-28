import { browser, type Browser } from "wxt/browser";
import { LANGUAGES } from "@/lib/languages";
import * as STYLE from "@/lib/style";
import type { Edge, LineKind, StyleSettings } from "@/lib/style";
import * as P from "@/lib/subparse";
import { PANEL_DEFAULTS, getStyle, setStyle, type Mode, type PanelSettings, type Provider } from "@/lib/settings";
import {
  sendToBackground, sendToTab,
  type LoadReply, type PanelMessage, type PlayerTime, type Reply, type SubfileInfo
} from "@/lib/messages";
import { toBase64 } from "@/lib/bytes";
import { lineEl } from "@/lib/overlay";

const RANGE_IDS = ["fontSize", "position", "width", "bgOpacity"] as const;
const VALUE_IDS = ["textColor", "bgColor", "origColor", "fontFamily", "edge"] as const;
const LIVE_IDS = ["provider", "apiKey", "sourceLang", "targetLang", "showOriginal"] as const;
const PRESETS: Record<string, Partial<StyleSettings>> = {
  classic: { textColor: "#ffffff", bgColor: "#000000", bgOpacity: 75, edge: "shadow", bold: true, fontFamily: "system" },
  yellow: { textColor: "#ffe14d", bgColor: "#000000", bgOpacity: 0, edge: "both", bold: true },
  clean: { textColor: "#ffffff", bgOpacity: 0, edge: "outline", bold: true },
  big: { fontSize: 38, position: 8, width: 95 }
};
const SWATCHES = ["#ffffff", "#ffe14d", "#7fe3ff", "#9dff8a", "#ffb0e0", "#ff9a5c"];
const ENCODINGS: [code: string, name: string][] = [
  ["auto", "Automatic"], ["utf-8", "UTF-8"],
  ["windows-1256", "Arabic (Windows-1256)"], ["iso-8859-6", "Arabic (ISO-8859-6)"],
  ["windows-1252", "Western (Windows-1252)"], ["windows-1250", "Central European (Windows-1250)"],
  ["windows-1251", "Cyrillic (Windows-1251)"], ["windows-1253", "Greek (Windows-1253)"],
  ["windows-1254", "Turkish (Windows-1254)"], ["windows-1255", "Hebrew (Windows-1255)"],
  ["gbk", "Chinese Simplified (GBK)"], ["big5", "Chinese Traditional (Big5)"],
  ["shift_jis", "Japanese (Shift_JIS)"], ["euc-kr", "Korean (EUC-KR)"], ["utf-16le", "UTF-16"]
];
const SUB_EXT = /\.(srt|vtt|ass|ssa|txt)$/i;

// Elements of popup/index.html (every id used here exists in the markup)
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const field = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- state ----------
let tab: Browser.tabs.Tab | undefined;                  // the tab the panel is controlling (active tab of this window)
let windowId: number | undefined;
let mode: Mode = "live";
let styleFor: Mode = "live";                             // which style the editor changes
const styles: Record<Mode, StyleSettings> = { live: { ...STYLE.DEFAULTS }, file: { ...STYLE.DEFAULTS } };
let file: SubfileInfo | null = null;                     // subtitle file loaded on this tab
let shownIdx = 0, manualUntil = 0, timeQuery = false;

function setStatus(text: string, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function isRestricted(t: Browser.tabs.Tab | undefined) {
  return !t?.url || /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/.test(t.url)
    || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(t.url);
}

// ================= mode tabs =================
function setMode(m: Mode) {
  mode = m;
  $("tabLive").className = m === "live" ? "on" : "";
  $("tabFile").className = m === "file" ? "on" : "";
  $("live").hidden = m !== "live";
  $("file").hidden = m !== "file";
  setStatus("");
  setStyleFor(m); // edit the style of the mode you're looking at
  browser.storage.local.set({ panelMode: m } satisfies Partial<PanelSettings>);
  if (m === "file") attachFileMode();
}
$("tabLive").onclick = () => setMode("live");
$("tabFile").onclick = () => setMode("file");

// ================= the tab being controlled =================
async function refreshTab() {
  [tab] = await browser.tabs.query({ active: true, windowId });
  manualUntil = 0;
  await Promise.all([refreshLiveButton(), refreshFile()]);
  if (mode === "file") attachFileMode();
}

browser.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) refreshTab(); });
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === tab?.id && (info.status === "complete" || info.url)) refreshTab();
});

// ================= live (AI) mode =================
for (const [code, name] of LANGUAGES) {
  $<HTMLSelectElement>("sourceLang").add(new Option(name, code));
  $<HTMLSelectElement>("targetLang").add(new Option(name, code));
}

function updateKeyHint() {
  $("keyHint").innerHTML = field("provider").value === "openai"
    ? 'Get a key: <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>'
    : 'Free key: <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>';
}

function saveLiveSettings() {
  updateKeyHint();
  updatePreview();
  browser.storage.local.set({
    provider: field("provider").value as Provider,
    apiKey: input("apiKey").value.trim(),
    sourceLang: field("sourceLang").value,
    targetLang: field("targetLang").value,
    showOriginal: input("showOriginal").checked
  } satisfies Partial<PanelSettings>);
}
for (const id of LIVE_IDS) {
  $(id).addEventListener("input", saveLiveSettings);
  $(id).addEventListener("change", saveLiveSettings);
}

async function getActiveTabId(): Promise<number | undefined> {
  const { activeTabId } = await browser.storage.session.get<{ activeTabId?: number }>("activeTabId");
  return activeTabId;
}

async function refreshLiveButton() {
  const activeTabId = await getActiveTabId();
  const { liveMuted = false } = await browser.storage.session.get<{ liveMuted?: boolean }>("liveMuted");
  $("muteRow").hidden = !(activeTabId && activeTabId === tab?.id);
  input("liveMute").checked = liveMuted;
  const btn = $("toggle");
  if (activeTabId && activeTabId === tab?.id) {
    btn.textContent = "Stop subtitles";
    btn.className = "stop";
  } else if (activeTabId) {
    btn.textContent = "Move subtitles to this tab";
    btn.className = "";
  } else {
    btn.textContent = "Start subtitles on this tab";
    btn.className = "";
  }
}
browser.storage.onChanged.addListener((ch, area) => {
  if (area === "session" && (ch.activeTabId || ch.liveMuted)) refreshLiveButton();
});

// Silences what you hear; the audio is still captured, so the subtitles keep going
input("liveMute").onchange = () => {
  sendToBackground({ type: "live-mute", muted: input("liveMute").checked }).catch(() => {});
};

// A capture that was just stopped can take a moment to be released: try once more before giving up
async function getStreamId(tabId: number): Promise<string> {
  try {
    return await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    if (!/active stream/i.test(errorText(e))) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
}

$("toggle").addEventListener("click", async () => {
  saveLiveSettings();
  const activeTabId = await getActiveTabId();

  if (tab?.id !== undefined && activeTabId === tab.id) {
    await sendToBackground({ type: "stop" });
    return setStatus("Stopped.");
  }

  if (!input("apiKey").value.trim()) return setStatus("Please paste an API key first.", true);
  if (isRestricted(tab) || tab?.id === undefined) return setStatus("Open a web page with a video first.", true);

  try {
    setStatus("Starting…");
    // Release any capture still running (another tab, or one left over): Chrome allows one per tab
    await sendToBackground({ type: "stop" }).catch(() => {});
    const streamId = await getStreamId(tab.id);
    const res = await sendToBackground({ type: "start", tabId: tab.id, streamId });
    if (res && "error" in res) throw new Error(res.error);
    setStatus("Listening. Play the video; subtitles appear after a few seconds.");
  } catch (e) {
    const msg = errorText(e);
    // Chrome only lets an extension capture a tab after you click its icon on that tab
    if (/invoked|activeTab/i.test(msg)) {
      setStatus("Chrome didn't allow capturing this tab. Close this popup, click the 🎬 icon again on this tab, and press Start.", true);
    } else if (/active stream/i.test(msg)) {
      setStatus("Something else is already capturing this tab: another extension (a recorder or translator), or sharing this tab in Meet, Zoom or Discord. Stop that, then press Start again.", true);
    } else {
      setStatus("Couldn't start: " + msg, true);
    }
  }
});

// ================= subtitle-file mode =================
for (const [code, name] of ENCODINGS) $<HTMLSelectElement>("encoding").add(new Option(name, code));

// Put the page script in place so files can be dropped onto the video
function attachFileMode() {
  if (tab?.id === undefined || isRestricted(tab)) return;
  sendToBackground({ type: "subfile-attach", tabId: tab.id }).catch(() => {});
}

async function refreshFile() {
  file = tab?.id === undefined ? null : await sendToBackground<SubfileInfo | null>({ type: "subfile-get", tabId: tab.id }).catch(() => null);
  $("loaded").hidden = !file;
  if (!file) return;
  $("fileName").textContent = `✓ ${file.name} (${file.cues.length} lines)`;
  const o = file.offset;
  $("offset").textContent = (o > 0 ? "+" : o < 0 ? "−" : "") + Math.abs(o).toFixed(1) + "s";
  input("hideSubs").checked = file.hidden;
  field("encoding").value = file.encoding;
  shownIdx = Math.min(shownIdx, file.cues.length - 1);
  drawHelper();
}

browser.runtime.onMessage.addListener((msg: PanelMessage) => {
  if (msg.type === "subfile-changed" && msg.tabId === tab?.id) refreshFile();
});

async function loadFile(f: File) {
  if (tab?.id === undefined || isRestricted(tab)) return setStatus("Open a web page with a video first.", true);
  if (!SUB_EXT.test(f.name)) return setStatus("That's not a subtitle file. Supported: .srt, .vtt, .ass, .ssa", true);
  setStatus("Loading…");
  const res = await sendToBackground<LoadReply>({ type: "subfile-load", tabId: tab.id, name: f.name, data: toBase64(await f.arrayBuffer()) })
    .catch((e) => ({ error: errorText(e) }));
  if (res && "error" in res) return setStatus(res.error, true);
  setStatus("Loaded. Play the video; jump anywhere and the subtitles follow.");
}

$("pickFile").onclick = () => input("fileInput").click();
input("fileInput").onchange = () => {
  const f = input("fileInput").files?.[0];
  if (f) loadFile(f);
  input("fileInput").value = "";
};

// Drop a file onto the popup
document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  $("dropZone").classList.add("over");
});
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("dropZone").classList.remove("over"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  $("dropZone").classList.remove("over");
  const f = e.dataTransfer?.files[0];
  if (f) { setMode("file"); loadFile(f); }
});

function fileRequest(p: Promise<Reply>) {
  p.then((res) => { if (res && "error" in res) setStatus(res.error, true); }, (e) => setStatus(errorText(e), true));
}

document.querySelectorAll<HTMLButtonElement>("[data-d]").forEach((b) => {
  b.onclick = () => {
    if (file && tab?.id !== undefined) fileRequest(sendToBackground({ type: "subfile-offset", tabId: tab.id, offset: file.offset + Number(b.dataset.d) }));
  };
});
$("resetDelay").onclick = () => {
  if (file && tab?.id !== undefined) fileRequest(sendToBackground({ type: "subfile-offset", tabId: tab.id, offset: 0 }));
};
input("hideSubs").onchange = () => {
  if (tab?.id !== undefined) fileRequest(sendToBackground({ type: "subfile-hidden", tabId: tab.id, hidden: input("hideSubs").checked }));
};
field("encoding").onchange = () => {
  if (tab?.id !== undefined) fileRequest(sendToBackground({ type: "subfile-encoding", tabId: tab.id, encoding: field("encoding").value }));
};
$("removeFile").onclick = () => {
  if (tab?.id !== undefined) fileRequest(sendToBackground({ type: "subfile-close", tabId: tab.id }));
  setStatus("");
};

// ---------- quick sync ----------
function moveHelper(d: number) {
  if (!file?.cues.length) return;
  shownIdx = Math.max(0, Math.min(file.cues.length - 1, shownIdx + d));
  manualUntil = performance.now() + 10000;
  drawHelper();
}
$("prevCue").onclick = () => moveHelper(-1);
$("nextCue").onclick = () => moveHelper(1);
$("syncNow").onclick = () => {
  if (tab?.id !== undefined) sendToTab(tab.id, { type: "subfile-sync-now", index: shownIdx }).catch(() => {});
  manualUntil = 0;
};

function drawHelper() {
  const c = file?.cues[shownIdx];
  const el = $("cueText");
  el.textContent = c ? `${P.fmt(c.start)}  ${c.text.replace(/\n/g, " ")}` : "…";
  el.title = c?.text ?? "";
}

// Follow the video: show the line playing now (unless you're picking one with ◀ ▶)
async function updateHelper() {
  if (!file?.cues.length || tab?.id === undefined || mode !== "file" || document.hidden || timeQuery) return;
  timeQuery = true;
  const now = await sendToTab<PlayerTime | undefined>(tab.id, { type: "subfile-time-query" }).catch(() => undefined);
  timeQuery = false;
  if (!file) return;
  if (!now) { setStatus("No video found yet. Start playing the video on this page.", true); return; }
  if ($("status").textContent?.startsWith("No video found")) setStatus("");
  if (performance.now() > manualUntil) {
    const t = now.t - file.offset;
    const n = P.activeAt(file.cues, t)[0] ?? P.nextIndex(file.cues, t);
    shownIdx = n >= 0 ? n : file.cues.length - 1;
  }
  drawHelper();
}
setInterval(updateHelper, 250);

// ================= style editor =================
function setStyleFor(m: Mode) {
  styleFor = m;
  $("styleForLive").className = m === "live" ? "on" : "";
  $("styleForFile").className = m === "file" ? "on" : "";
  applyStyleToForm(styles[m]);
}
$("styleForLive").onclick = () => setStyleFor("live");
$("styleForFile").onclick = () => setStyleFor("file");

function applyStyleToForm(s: StyleSettings) {
  for (const id of RANGE_IDS) field(id).value = String(s[id]);
  for (const id of VALUE_IDS) field(id).value = s[id];
  input("bold").checked = !!s.bold;
  updatePreview();
}

function readStyle(): StyleSettings {
  const num = (id: (typeof RANGE_IDS)[number]) => Number(field(id).value);
  return {
    fontSize: num("fontSize"),
    position: num("position"),
    width: num("width"),
    bgOpacity: num("bgOpacity"),
    textColor: field("textColor").value,
    bgColor: field("bgColor").value,
    origColor: field("origColor").value,
    fontFamily: field("fontFamily").value,
    edge: field("edge").value as Edge,
    bold: input("bold").checked
  };
}

function updatePreview() {
  const st = readStyle();
  for (const id of RANGE_IDS) $(id + "Val").textContent = String(st[id]);
  const box = $("previewInner");
  box.replaceChildren();
  const add = (text: string, kind: LineKind) => box.appendChild(lineEl(text, kind, st));
  if (input("showOriginal").checked) add("Original line appears here", "original");
  add(styleFor === "live" ? "This is how AI subtitles look" : "This is how file subtitles look", "main");
  box.style.fontSize = Math.max(8, Math.round(st.fontSize * 0.5)) + "px";
  box.style.width = st.width + "%";
  box.style.bottom = (st.position / 100) * 92 + "px";
}

// Every change is saved at once, and the subtitles on the page update live
function saveStyle() {
  styles[styleFor] = readStyle();
  updatePreview();
  setStyle(styleFor, styles[styleFor]);
}
for (const id of ["bold", ...RANGE_IDS, ...VALUE_IDS]) {
  $(id).addEventListener("input", saveStyle);
  $(id).addEventListener("change", saveStyle);
}

for (const color of SWATCHES) {
  const dot = document.createElement("span");
  dot.style.background = color;
  dot.title = color;
  dot.onclick = () => { field("textColor").value = color; saveStyle(); };
  $("swatches").appendChild(dot);
}
document.querySelectorAll<HTMLElement>("[data-preset]").forEach((b) => {
  b.onclick = () => { applyStyleToForm({ ...readStyle(), ...PRESETS[b.dataset.preset ?? ""] }); saveStyle(); };
});
$("resetStyle").onclick = () => { applyStyleToForm(STYLE.DEFAULTS); saveStyle(); };

// ================= start =================
async function init() {
  windowId = (await browser.windows.getCurrent()).id;
  const [s, live, fileStyle] = await Promise.all([
    browser.storage.local.get<PanelSettings>(PANEL_DEFAULTS), getStyle("live"), getStyle("file")
  ]);
  styles.live = live;
  styles.file = fileStyle;
  field("provider").value = s.provider;
  input("apiKey").value = s.apiKey;
  field("sourceLang").value = s.sourceLang;
  field("targetLang").value = s.targetLang;
  input("showOriginal").checked = s.showOriginal;
  $<HTMLDetailsElement>("styleBox").open = s.styleOpen;
  updateKeyHint();
  await refreshTab();
  setMode(s.panelMode);
}
$("styleBox").addEventListener("toggle", () => {
  browser.storage.local.set({ styleOpen: $<HTMLDetailsElement>("styleBox").open } satisfies Partial<PanelSettings>);
});

init();
