import { browser, type Browser } from "wxt/browser";
import { LANGUAGES } from "@/lib/languages";
import * as STYLE from "@/lib/style";
import type { Edge, LineKind, StyleSettings } from "@/lib/style";
import { DEFAULTS, type PopupSettings, type Provider } from "@/lib/settings";
import { sendToBackground } from "@/lib/messages";
import { lineEl } from "@/lib/overlay";

const RANGE_IDS = ["fontSize", "position", "width", "bgOpacity"] as const;
const VALUE_IDS = ["textColor", "bgColor", "origColor", "fontFamily", "edge"] as const;
const PRESETS: Record<string, Partial<StyleSettings>> = {
  classic: { textColor: "#ffffff", bgColor: "#000000", bgOpacity: 75, edge: "shadow", bold: true, fontFamily: "system" },
  yellow: { textColor: "#ffe14d", bgColor: "#000000", bgOpacity: 0, edge: "both", bold: true },
  clean: { textColor: "#ffffff", bgOpacity: 0, edge: "outline", bold: true },
  big: { fontSize: 38, position: 8, width: 95 }
};
const SWATCHES = ["#ffffff", "#ffe14d", "#7fe3ff", "#9dff8a", "#ffb0e0", "#ff9a5c"];

// Elements of popup/index.html (every id used here exists in the markup)
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const field = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id);

for (const [code, name] of LANGUAGES) {
  $<HTMLSelectElement>("sourceLang").add(new Option(name, code));
  $<HTMLSelectElement>("targetLang").add(new Option(name, code));
}

function setStatus(text: string, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function setMode(mode: PopupSettings["popupMode"]) {
  const file = mode === "file";
  $("tabLive").className = file ? "" : "on";
  $("tabFile").className = file ? "on" : "";
  $("live").hidden = file;
  $("file").hidden = !file;
  $("toggle").hidden = file;
  $("fileBtn").hidden = !file;
  setStatus("");
  browser.storage.local.set({ popupMode: mode });
}
$("tabLive").onclick = () => setMode("live");
$("tabFile").onclick = () => setMode("file");

function updateKeyHint() {
  $("keyHint").innerHTML = field("provider").value === "openai"
    ? 'Get a key: <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>'
    : 'Free key: <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>';
}

async function loadSettings() {
  const s = await browser.storage.local.get<PopupSettings>(DEFAULTS);
  field("provider").value = s.provider;
  input("apiKey").value = s.apiKey;
  field("sourceLang").value = s.sourceLang;
  field("targetLang").value = s.targetLang;
  input("showOriginal").checked = s.showOriginal;
  applyStyleToForm(s);
  $<HTMLDetailsElement>("styleBox").open = s.styleOpen;
  updateKeyHint();
  setMode(s.popupMode);
}

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
  add("This is how your subtitles look", "main");
  box.style.fontSize = Math.max(8, Math.round(st.fontSize * 0.5)) + "px";
  box.style.width = st.width + "%";
  box.style.bottom = (st.position / 100) * 92 + "px";
}

function saveSettings() {
  updateKeyHint();
  updatePreview();
  browser.storage.local.set({
    provider: field("provider").value as Provider,
    apiKey: input("apiKey").value.trim(),
    sourceLang: field("sourceLang").value,
    targetLang: field("targetLang").value,
    showOriginal: input("showOriginal").checked,
    ...readStyle()
  } satisfies Partial<PopupSettings>);
}

for (const id of ["provider", "apiKey", "sourceLang", "targetLang", "showOriginal", "bold", ...RANGE_IDS, ...VALUE_IDS]) {
  $(id).addEventListener("input", saveSettings);
  $(id).addEventListener("change", saveSettings);
}

for (const color of SWATCHES) {
  const dot = document.createElement("span");
  dot.style.background = color;
  dot.title = color;
  dot.onclick = () => { field("textColor").value = color; saveSettings(); };
  $("swatches").appendChild(dot);
}
document.querySelectorAll<HTMLElement>("[data-preset]").forEach((b) => {
  b.onclick = () => { applyStyleToForm({ ...readStyle(), ...PRESETS[b.dataset.preset ?? ""] }); saveSettings(); };
});
$("resetStyle").onclick = () => { applyStyleToForm(STYLE.DEFAULTS); saveSettings(); };
$("styleBox").addEventListener("toggle", () => browser.storage.local.set({ styleOpen: $<HTMLDetailsElement>("styleBox").open }));

async function currentTab(): Promise<Browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isRestricted(tab: Browser.tabs.Tab | undefined) {
  return !tab?.url || /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/.test(tab.url)
    || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(tab.url);
}

async function getActiveTabId(): Promise<number | undefined> {
  const { activeTabId } = await browser.storage.session.get<{ activeTabId?: number }>("activeTabId");
  return activeTabId;
}

async function refreshButton() {
  const activeTabId = await getActiveTabId();
  const tab = await currentTab();
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

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

$("toggle").addEventListener("click", async () => {
  saveSettings();
  const tab = await currentTab();
  const activeTabId = await getActiveTabId();

  if (tab?.id !== undefined && activeTabId === tab.id) {
    await sendToBackground({ type: "stop" });
    setStatus("Stopped.");
    return refreshButton();
  }

  if (!input("apiKey").value.trim()) return setStatus("Please paste an API key first.", true);
  if (isRestricted(tab) || tab?.id === undefined) return setStatus("Open a web page with a video first.", true);

  try {
    if (activeTabId) await sendToBackground({ type: "stop" });
    setStatus("Starting…");
    const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await sendToBackground({ type: "start", tabId: tab.id, streamId });
    if (res && "error" in res) throw new Error(res.error);
    setStatus("Listening. Play the video; subtitles appear after a few seconds.");
  } catch (e) {
    setStatus("Couldn't start: " + errorText(e), true);
  }
  refreshButton();
});

$("fileBtn").addEventListener("click", async () => {
  saveSettings();
  const tab = await currentTab();
  if (isRestricted(tab) || tab?.id === undefined) return setStatus("Open a web page with a video first.", true);
  try {
    const res = await sendToBackground({ type: "subfile-open", tabId: tab.id });
    if (res && "error" in res) throw new Error(res.error);
    window.close();
  } catch (e) {
    setStatus("Couldn't open the panel on this page: " + errorText(e), true);
  }
});

loadSettings().then(refreshButton);
