import { browser } from "wxt/browser";
import { LANGUAGES } from "@/lib/languages";
import * as STYLE from "@/lib/style";
import { DEFAULTS } from "@/lib/settings";

const RANGE_IDS = ["fontSize", "position", "width", "bgOpacity"];
const VALUE_IDS = ["textColor", "bgColor", "origColor", "fontFamily", "edge"];
const PRESETS = {
  classic: { textColor: "#ffffff", bgColor: "#000000", bgOpacity: 75, edge: "shadow", bold: true, fontFamily: "system" },
  yellow: { textColor: "#ffe14d", bgColor: "#000000", bgOpacity: 0, edge: "both", bold: true },
  clean: { textColor: "#ffffff", bgOpacity: 0, edge: "outline", bold: true },
  big: { fontSize: 38, position: 8, width: 95 }
};
const SWATCHES = ["#ffffff", "#ffe14d", "#7fe3ff", "#9dff8a", "#ffb0e0", "#ff9a5c"];
const $ = (id) => document.getElementById(id);

for (const [code, name] of LANGUAGES) {
  $("sourceLang").add(new Option(name, code));
  $("targetLang").add(new Option(name, code));
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function setMode(mode) {
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
  $("keyHint").innerHTML = $("provider").value === "openai"
    ? 'Get a key: <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>'
    : 'Free key: <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>';
}

async function loadSettings() {
  const s = await browser.storage.local.get(DEFAULTS);
  $("provider").value = s.provider;
  $("apiKey").value = s.apiKey;
  $("sourceLang").value = s.sourceLang;
  $("targetLang").value = s.targetLang;
  $("showOriginal").checked = s.showOriginal;
  applyStyleToForm(s);
  $("styleBox").open = s.styleOpen;
  updateKeyHint();
  setMode(s.popupMode);
}

function applyStyleToForm(s) {
  for (const id of RANGE_IDS) $(id).value = s[id];
  for (const id of VALUE_IDS) $(id).value = s[id];
  $("bold").checked = !!s.bold;
  updatePreview();
}

function readStyle() {
  const st = {};
  for (const id of RANGE_IDS) st[id] = Number($(id).value);
  for (const id of VALUE_IDS) st[id] = $(id).value;
  st.bold = $("bold").checked;
  return st;
}

function updatePreview() {
  const st = readStyle();
  for (const id of ["fontSize", "position", "width", "bgOpacity"]) $(id + "Val").textContent = st[id];
  const box = $("previewInner");
  box.replaceChildren();
  const add = (text, kind) => {
    const wrap = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = text;
    span.setAttribute("dir", "auto");
    Object.assign(span.style, STYLE.lineStyle(st, kind));
    wrap.appendChild(span);
    box.appendChild(wrap);
  };
  if ($("showOriginal").checked) add("Original line appears here", "original");
  add("This is how your subtitles look", "main");
  box.style.fontSize = Math.max(8, Math.round(st.fontSize * 0.5)) + "px";
  box.style.width = st.width + "%";
  box.style.bottom = (st.position / 100) * 92 + "px";
}

function saveSettings() {
  updateKeyHint();
  updatePreview();
  browser.storage.local.set({
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    sourceLang: $("sourceLang").value,
    targetLang: $("targetLang").value,
    showOriginal: $("showOriginal").checked,
    ...readStyle()
  });
}

for (const id of ["provider", "apiKey", "sourceLang", "targetLang", "showOriginal", "bold", ...RANGE_IDS, ...VALUE_IDS]) {
  $(id).addEventListener("input", saveSettings);
  $(id).addEventListener("change", saveSettings);
}

for (const color of SWATCHES) {
  const dot = document.createElement("span");
  dot.style.background = color;
  dot.title = color;
  dot.onclick = () => { $("textColor").value = color; saveSettings(); };
  $("swatches").appendChild(dot);
}
document.querySelectorAll("[data-preset]").forEach((b) => {
  b.onclick = () => { applyStyleToForm({ ...readStyle(), ...PRESETS[b.dataset.preset] }); saveSettings(); };
});
$("resetStyle").onclick = () => { applyStyleToForm(STYLE.DEFAULTS); saveSettings(); };
$("styleBox").addEventListener("toggle", () => browser.storage.local.set({ styleOpen: $("styleBox").open }));

async function currentTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isRestricted(tab) {
  return !tab?.url || /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/.test(tab.url)
    || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(tab.url);
}

async function refreshButton() {
  const { activeTabId } = await browser.storage.session.get("activeTabId");
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

$("toggle").addEventListener("click", async () => {
  saveSettings();
  const tab = await currentTab();
  const { activeTabId } = await browser.storage.session.get("activeTabId");

  if (activeTabId === tab.id) {
    await browser.runtime.sendMessage({ type: "stop" });
    setStatus("Stopped.");
    return refreshButton();
  }

  if (!$("apiKey").value.trim()) return setStatus("Please paste an API key first.", true);
  if (isRestricted(tab)) return setStatus("Open a web page with a video first.", true);

  try {
    if (activeTabId) await browser.runtime.sendMessage({ type: "stop" });
    setStatus("Starting…");
    const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await browser.runtime.sendMessage({ type: "start", tabId: tab.id, streamId });
    if (res?.error) throw new Error(res.error);
    setStatus("Listening. Play the video; subtitles appear after a few seconds.");
  } catch (e) {
    setStatus("Couldn't start: " + (e.message || e), true);
  }
  refreshButton();
});

$("fileBtn").addEventListener("click", async () => {
  saveSettings();
  const tab = await currentTab();
  if (isRestricted(tab)) return setStatus("Open a web page with a video first.", true);
  try {
    const res = await browser.runtime.sendMessage({ type: "subfile-open", tabId: tab.id });
    if (res?.error) throw new Error(res.error);
    window.close();
  } catch (e) {
    setStatus("Couldn't open the panel on this page: " + (e.message || e), true);
  }
});

loadSettings().then(refreshButton);
