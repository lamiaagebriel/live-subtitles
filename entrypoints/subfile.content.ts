import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { LANGUAGES } from "@/lib/languages";
import * as S from "@/lib/style";
import type { LineKind } from "@/lib/style";
import * as P from "@/lib/subparse";
import { SUBFILE_DEFAULTS as SETTING_DEFAULTS, type SubfileSettings } from "@/lib/settings";
import { createBox, lineEl as makeLine, mountBox, placeBox, onFullscreenChange, fullscreenElement } from "@/lib/overlay";
import { sendToBackground, type SubfileMessage, type TranslateReply } from "@/lib/messages";
import { findMainVideo } from "@/lib/video";

declare global {
  interface Window { __liveSubsFileLoaded?: boolean }
}

interface Line { text: string; original?: string | null }

// The browser's own subtitle track we add to a video (for bare-video fullscreen)
interface NativeTrack { track: TextTrack; cue: VTTCue | null; text: string }

type SubOffsets = Record<string, number>;

// "Subtitle file" mode: shows a loaded .srt/.vtt/.ass file perfectly synced to the video.
// Injected into every frame of the tab. The top frame shows the control panel;
// any frame that contains the video draws the subtitles over it.
export default defineContentScript({
  registration: "runtime",
  main() {
    if (window.__liveSubsFileLoaded) return;
    window.__liveSubsFileLoaded = true;

    const isTop = window === window.top;
    const ENCODINGS: [code: string, name: string][] = [
      ["auto", "Automatic"], ["utf-8", "UTF-8"],
      ["windows-1256", "Arabic (Windows-1256)"], ["iso-8859-6", "Arabic (ISO-8859-6)"],
      ["windows-1252", "Western (Windows-1252)"], ["windows-1250", "Central European (Windows-1250)"],
      ["windows-1251", "Cyrillic (Windows-1251)"], ["windows-1253", "Greek (Windows-1253)"],
      ["windows-1254", "Turkish (Windows-1254)"], ["windows-1255", "Hebrew (Windows-1255)"],
      ["gbk", "Chinese Simplified (GBK)"], ["big5", "Chinese Traditional (Big5)"],
      ["shift_jis", "Japanese (Shift_JIS)"], ["euc-kr", "Korean (EUC-KR)"], ["utf-16le", "UTF-16"]
    ];

    // ---------- shared state (every frame) ----------
    let cues: P.Cue[] = [], fileName = "", offset = 0, hidden = false;
    let settings: SubfileSettings = { ...SETTING_DEFAULTS };
    let video: HTMLVideoElement | null = null, lastPick = -1e9, raf = 0, lastTimeSent = 0;
    let box: HTMLDivElement | null = null, lastKey = "", toast = "", toastUntil = 0;
    const tr = new Map<number, string>(), pending = new Set<number>();
    const nativeTracks = new WeakMap<HTMLVideoElement, NativeTrack>();
    let lastTrIdx = -1;

    // ---------- top-frame panel state ----------
    let host: HTMLDivElement | null = null, root: ShadowRoot | null = null;
    let fileBuf: ArrayBuffer | null = null, encoding = "auto";
    let remoteTime: { t: number; paused: boolean; rate: number; at: number } | null = null;
    let shownIdx = 0, manualUntil = 0, panelTimer: ReturnType<typeof setInterval> | undefined;

    // An element of the panel. Only called while the panel exists, and the markup is ours.
    function $<T extends HTMLElement = HTMLElement>(sel: string): T {
      return root!.querySelector<T>(sel)!;
    }

    browser.storage.local.get<SubfileSettings>(SETTING_DEFAULTS).then((s) => {
      settings = s;
      lastKey = "";
      applyCueCss();
      syncPanelControls();
    });
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      for (const k of Object.keys(SETTING_DEFAULTS) as (keyof SubfileSettings)[]) {
        if (ch[k]) settings = { ...settings, [k]: ch[k].newValue };
      }
      applyCueCss();
      if (ch.targetLang) { tr.clear(); lastTrIdx = -1; }
      lastKey = "";
      syncPanelControls();
    });

    function broadcast(payload: SubfileMessage) {
      sendToBackground({ type: "subfile-broadcast", payload }).catch(() => {});
    }

    browser.runtime.onMessage.addListener((msg: SubfileMessage) => {
      switch (msg.type) {
        case "subfile-panel":
          if (isTop) openPanel();
          break;
        case "subfile-cues":
          cues = msg.cues; fileName = msg.name; offset = msg.offset || 0;
          tr.clear(); pending.clear(); lastTrIdx = -1; lastKey = "";
          startLoop();
          updatePanelLoaded();
          break;
        case "subfile-offset":
          offset = msg.offset; lastKey = "";
          if (video) flash(delayText(offset));
          updateOffsetLabel();
          if (isTop && fileName) saveOffset();
          break;
        case "subfile-hidden":
          hidden = msg.hidden; lastKey = "";
          break;
        case "subfile-sync-now": {
          const cue = cues[msg.index];
          if (video && cue) setOffset(video.currentTime - cue.start);
          break;
        }
        case "subfile-time":
          if (isTop) remoteTime = { t: msg.t, paused: msg.paused, rate: msg.rate, at: performance.now() };
          break;
        case "subfile-close":
          teardown();
          break;
      }
    });

    // ---------- offset / delay ----------
    function setOffset(v: number) {
      broadcast({ type: "subfile-offset", offset: Math.round(v * 100) / 100 });
    }
    function delayText(o: number) {
      if (Math.abs(o) < 0.05) return "Delay 0.0s (original timing)";
      return `Delay ${o > 0 ? "+" : "−"}${Math.abs(o).toFixed(1)}s (subtitles ${o > 0 ? "later" : "earlier"})`;
    }
    async function saveOffset() {
      const { subOffsets = {} } = await browser.storage.local.get<{ subOffsets?: SubOffsets }>("subOffsets");
      subOffsets[fileName] = offset;
      const keys = Object.keys(subOffsets);
      if (keys.length > 100) delete subOffsets[keys[0]!];
      browser.storage.local.set({ subOffsets });
    }
    function flash(text: string) {
      toast = text; toastUntil = performance.now() + 1500; lastKey = "";
    }

    // Keyboard: G = subtitles earlier, H = later (Shift = 1 second steps)
    window.addEventListener("keydown", (e) => {
      if (!cues.length || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k !== "g" && k !== "h") return;
      const el = (e.composedPath()[0] ?? e.target) as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""))) return;
      e.preventDefault(); e.stopPropagation();
      setOffset(offset + (k === "g" ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
    }, true);

    // ---------- video + rendering ----------
    function pickVideo() {
      const best = findMainVideo();
      if (best !== video) { clearNative(); video = best; lastKey = ""; }
    }

    function startLoop() {
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function lineFor(i: number): Line {
      const orig = cues[i]!.text;
      if (!settings.targetLang || settings.targetLang === "none") return { text: orig };
      const t = tr.get(i);
      if (t == null) return { text: orig };
      return { text: t, original: settings.showOriginal && t !== orig ? orig : null };
    }

    function tick(now: number) {
      raf = requestAnimationFrame(tick);
      if (now - lastPick > 1000) { lastPick = now; pickVideo(); }
      if (!video || !cues.length) { if (box) box.style.display = "none"; return; }

      if (!isTop && now - lastTimeSent > 500) {
        lastTimeSent = now;
        broadcast({ type: "subfile-time", t: video.currentTime, paused: video.paused, rate: video.playbackRate });
      }

      const t = video.currentTime - offset;
      const idxs = hidden ? [] : P.activeAt(cues, t);
      const anchor = idxs[0] ?? P.nextIndex(cues, t);
      if (anchor >= 0 && anchor !== lastTrIdx) { lastTrIdx = anchor; ensureTranslated(anchor); }

      const nativeMode = fullscreenElement() === video;
      const lines = idxs.map(lineFor);
      const toastOn = now < toastUntil;
      const key = JSON.stringify(lines) + "|" + (toastOn ? toast : "") + "|" + nativeMode;
      if (key !== lastKey) { lastKey = key; render(lines, toastOn ? toast : "", nativeMode); }
      if (!nativeMode) position();
    }

    function ensureBox(): HTMLDivElement {
      if (!box) box = createBox();
      mountBox(box);
      return box;
    }

    function lineEl(text: string, kind: LineKind) {
      return makeLine(text, kind, settings);
    }

    // Look of the browser's own subtitle display (bare-video fullscreen)
    let cueStyleEl: HTMLStyleElement | null = null;
    function applyCueCss() {
      if (!cueStyleEl) {
        cueStyleEl = document.createElement("style");
        cueStyleEl.id = "live-subs-cue-style";
      }
      cueStyleEl.textContent = S.cueCss(settings);
      if (!cueStyleEl.isConnected) (document.head || document.documentElement).appendChild(cueStyleEl);
    }

    function render(lines: Line[], toastText: string, nativeMode: boolean) {
      if (nativeMode) {
        if (box) box.style.display = "none";
        const text = lines.map((l) => (l.original ? l.original + "\n" : "") + l.text).join("\n");
        setNative(text || toastText);
        return;
      }
      clearNative();
      const b = ensureBox();
      b.replaceChildren();
      for (const l of lines) {
        if (l.original) b.appendChild(lineEl(l.original, "original"));
        b.appendChild(lineEl(l.text, "main"));
      }
      if (toastText) b.appendChild(lineEl(toastText, "info"));
      b.style.display = b.childNodes.length ? "block" : "none";
    }

    function position() {
      if (!box || box.style.display === "none" || !video) return;
      const r = video.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh) { box.style.visibility = "hidden"; return; }
      box.style.visibility = "visible";
      const scale = Math.min(2.2, Math.max(0.75, r.height / 480));
      placeBox(box, r, settings, Math.round((settings.fontSize || 24) * scale));
    }

    // When the <video> element itself goes fullscreen nothing can be drawn over it,
    // so the browser's own subtitle track is used for that case.
    function setNative(text: string) {
      if (!video) return;
      let n = nativeTracks.get(video);
      if (!n) {
        n = { track: video.addTextTrack("subtitles", "Subtitles (file)", ""), cue: null, text: "" };
        nativeTracks.set(video, n);
      }
      n.track.mode = "showing";
      if (n.text === text) return;
      if (n.cue) { try { n.track.removeCue(n.cue); } catch {} }
      n.cue = null;
      n.text = text;
      if (text) {
        n.cue = new VTTCue(0, 1e9, text);
        n.track.addCue(n.cue);
      }
    }
    function clearNative() {
      const n = video && nativeTracks.get(video);
      if (!n) return;
      if (n.cue) { try { n.track.removeCue(n.cue); } catch {} }
      n.cue = null; n.text = "";
      n.track.mode = "disabled";
    }
    onFullscreenChange(() => { lastKey = ""; });

    // ---------- translation (a few lines ahead, cached) ----------
    function ensureTranslated(from: number) {
      const target = settings.targetLang;
      if (!target || target === "none") return;
      const batch: number[] = [];
      let len = 0;
      for (let i = from; i < cues.length && i < from + 25 && batch.length < 12; i++) {
        if (tr.has(i) || pending.has(i)) continue;
        const size = cues[i]!.text.length;
        if (batch.length && len + size > 1200) break;
        batch.push(i);
        len += size;
      }
      if (!batch.length) return;
      batch.forEach((i) => pending.add(i));
      const snapshot = cues;
      sendToBackground<TranslateReply>({ type: "translate-batch", lang: target, texts: batch.map((i) => snapshot[i]!.text) })
        .then((res) => {
          if (target !== settings.targetLang || snapshot !== cues || !res || !("texts" in res)) return;
          batch.forEach((i, k) => tr.set(i, res.texts[k] || snapshot[i]!.text));
          lastKey = "";
        })
        .catch(() => {})
        .finally(() => batch.forEach((i) => pending.delete(i)));
    }

    // ---------- teardown ----------
    function teardown() {
      cues = []; fileName = ""; offset = 0; hidden = false;
      tr.clear(); pending.clear();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearNative();
      box?.remove(); box = null;
      cueStyleEl?.remove(); cueStyleEl = null;
      if (host) { host.remove(); host = null; root = null; clearInterval(panelTimer); }
      fileBuf = null; remoteTime = null;
    }

    // ================= control panel (top frame only) =================
    const PANEL_CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, 'Segoe UI', Tahoma, Arial, sans-serif; }
      .panel { width: 290px; background: #16181d; color: #e8e8ea; border: 1px solid #2c303a; border-radius: 12px;
               box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 12.5px; overflow: hidden; }
      .head { display: flex; align-items: center; gap: 6px; padding: 9px 10px 9px 12px; background: #1d2027; cursor: move; user-select: none; }
      .title { flex: 1; font-weight: 600; font-size: 13px; }
      .icon { background: none; border: 0; color: #a9adb8; font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
      .icon:hover { color: #fff; }
      .body { padding: 10px 12px 12px; }
      button.btn { width: 100%; padding: 8px; border: 0; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; background: #4f7cff; color: #fff; }
      button.btn.alt { background: #2a2f3a; color: #e8e8ea; }
      button.btn:hover { filter: brightness(1.1); }
      .muted { color: #8b909c; font-size: 11.5px; }
      .fname { margin-top: 6px; word-break: break-all; }
      .err { color: #ff8589; }
      .ok { color: #7fd4a0; }
      label.cap { display: block; margin: 12px 0 5px; color: #a9adb8; font-size: 11.5px; }
      .row { display: flex; align-items: center; gap: 4px; }
      .row button { flex: none; padding: 6px 7px; border: 0; border-radius: 6px; background: #2a2f3a; color: #e8e8ea; cursor: pointer; font-size: 12px; }
      .row button:hover { background: #363c4a; }
      .off { flex: 1; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
      .cue { flex: 1; min-width: 0; padding: 6px 8px; background: #20232b; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .now { margin-top: 6px; }
      select { width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #333844; background: #20232b; color: #e8e8ea; font-size: 12px; }
      .chk { margin-top: 8px; gap: 7px; }
      .chk label { color: #e8e8ea; cursor: pointer; }
      .hint { margin-top: 10px; line-height: 1.45; }
      [hidden] { display: none !important; }
    `;

    function openPanel() {
      if (host) { $(".body").hidden = false; return; }
      const panelHost = document.createElement("div");
      host = panelHost;
      panelHost.style.cssText = "all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;";
      root = panelHost.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>${PANEL_CSS}</style>
        <div class="panel">
          <div class="head">
            <span class="title">📄 Subtitle file</span>
            <button class="icon min" title="Minimize">–</button>
            <button class="icon close" title="Close and remove subtitles">×</button>
          </div>
          <div class="body">
            <button class="btn pick">Choose subtitle file…</button>
            <input type="file" class="file" accept=".srt,.vtt,.ass,.ssa,.txt" hidden>
            <div class="fname muted">No file yet. You can also drop a .srt / .vtt / .ass file onto the page.</div>
            <div class="loaded" hidden>
              <label class="cap">Delay <span class="muted">(keys: G earlier · H later · Shift = 1s)</span></label>
              <div class="row">
                <button data-d="-1">−1s</button><button data-d="-0.1">−0.1</button>
                <span class="off">0.0s</span>
                <button data-d="0.1">+0.1</button><button data-d="1">+1s</button>
                <button class="reset" title="Reset delay">↺</button>
              </div>
              <label class="cap">Quick sync: pick a line, press the button when you hear it</label>
              <div class="row">
                <button class="prev" title="Previous line">◀</button>
                <div class="cue">…</div>
                <button class="next" title="Next line">▶</button>
              </div>
              <button class="btn alt now">🎯 This line is being said now</button>
              <label class="cap">Show subtitles in</label>
              <select class="lang"><option value="none">Same as the file (no translation)</option></select>
              <div class="row chk"><input type="checkbox" class="orig" id="orig"><label for="orig">Also show original line</label></div>
              <div class="row chk"><input type="checkbox" class="hide" id="hide"><label for="hide">Hide subtitles</label></div>
              <label class="cap">Text encoding <span class="muted">(change if letters look broken)</span></label>
              <select class="enc"></select>
              <div class="status muted hint"></div>
            </div>
          </div>
        </div>`;
      document.documentElement.appendChild(panelHost);

      const lang = $<HTMLSelectElement>(".lang"), enc = $<HTMLSelectElement>(".enc");
      const file = $<HTMLInputElement>(".file"), orig = $<HTMLInputElement>(".orig"), hide = $<HTMLInputElement>(".hide");
      for (const [code, name] of LANGUAGES) lang.add(new Option(name, code));
      for (const [code, name] of ENCODINGS) enc.add(new Option(name, code));

      $(".pick").onclick = () => file.click();
      file.onchange = () => { const f = file.files?.[0]; if (f) loadFile(f); file.value = ""; };
      $(".min").onclick = () => { $(".body").hidden = !$(".body").hidden; };
      $(".close").onclick = () => { broadcast({ type: "subfile-close" }); teardown(); };
      root.querySelectorAll<HTMLButtonElement>("[data-d]").forEach((b) => { b.onclick = () => setOffset(offset + Number(b.dataset.d)); });
      $(".reset").onclick = () => setOffset(0);
      $(".prev").onclick = () => moveHelper(-1);
      $(".next").onclick = () => moveHelper(1);
      $(".now").onclick = () => { broadcast({ type: "subfile-sync-now", index: shownIdx }); manualUntil = 0; };
      lang.onchange = () => browser.storage.local.set({ targetLang: lang.value });
      orig.onchange = () => browser.storage.local.set({ showOriginal: orig.checked });
      hide.onchange = () => broadcast({ type: "subfile-hidden", hidden: hide.checked });
      enc.onchange = () => { encoding = enc.value; if (fileBuf) applyFile(true); };

      // Drag the panel by its header
      const head = $(".head");
      head.addEventListener("pointerdown", (e) => {
        if ((e.target as Element).closest("button")) return;
        const r = panelHost.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        head.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          panelHost.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)) + "px";
          panelHost.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + "px";
          panelHost.style.right = "auto";
        };
        const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
      });

      syncPanelControls();
      if (cues.length) updatePanelLoaded();
      panelTimer = setInterval(updateHelper, 250);
    }

    // Drop a subtitle file anywhere on the page while the panel is open
    const SUB_EXT = /\.(srt|vtt|ass|ssa|txt)$/i;
    window.addEventListener("dragover", (e) => {
      if (host && e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    }, true);
    window.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!host || !f || !SUB_EXT.test(f.name)) return;
      e.preventDefault(); e.stopPropagation();
      loadFile(f);
    }, true);

    function setStatus(text: string, cls = "") {
      if (!root) return;
      const s = $(".status");
      s.textContent = text;
      s.className = "status hint " + (cls || "muted");
    }

    async function loadFile(file: File) {
      fileBuf = await file.arrayBuffer();
      fileName = file.name;
      encoding = "auto";
      if (root) $<HTMLSelectElement>(".enc").value = "auto";
      applyFile(false);
    }

    async function applyFile(keepOffset: boolean) {
      if (!fileBuf) return;
      let text: string;
      try { text = P.decode(fileBuf, encoding); } catch { return showFileError("This encoding can't read the file. Try another one."); }
      const parsed = P.parse(text);
      if (!parsed.length) return showFileError("No subtitle lines found. Supported formats: .srt, .vtt, .ass, .ssa");
      let startOffset = offset;
      if (!keepOffset) {
        const { subOffsets = {} } = await browser.storage.local.get<{ subOffsets?: SubOffsets }>("subOffsets");
        startOffset = subOffsets[fileName] || 0;
      }
      broadcast({ type: "subfile-cues", cues: parsed, name: fileName, offset: startOffset });
    }

    function showFileError(text: string) {
      if (!root) return;
      const f = $(".fname");
      f.textContent = text;
      f.className = "fname err";
    }

    function updatePanelLoaded() {
      if (!root) return;
      const f = $(".fname");
      f.textContent = `✓ ${fileName} (${cues.length} lines)`;
      f.className = "fname ok";
      $(".loaded").hidden = false;
      $<HTMLInputElement>(".hide").checked = hidden;
      updateOffsetLabel();
    }

    function updateOffsetLabel() {
      if (!root) return;
      const o = offset;
      $(".off").textContent = (o > 0 ? "+" : o < 0 ? "−" : "") + Math.abs(o).toFixed(1) + "s";
    }

    function syncPanelControls() {
      if (!root) return;
      $<HTMLSelectElement>(".lang").value = settings.targetLang || "none";
      $<HTMLInputElement>(".orig").checked = !!settings.showOriginal;
    }

    function playerTime(): number | null {
      if (video) return video.currentTime;
      if (remoteTime && performance.now() - remoteTime.at < 3000) {
        return remoteTime.t + (remoteTime.paused ? 0 : (performance.now() - remoteTime.at) / 1000 * (remoteTime.rate || 1));
      }
      return null;
    }

    function moveHelper(d: number) {
      if (!cues.length) return;
      shownIdx = Math.max(0, Math.min(cues.length - 1, shownIdx + d));
      manualUntil = performance.now() + 10000;
      drawHelper();
    }

    function updateHelper() {
      if (!root || !cues.length) return;
      const t = playerTime();
      if (performance.now() > manualUntil && t != null) {
        const a = P.activeAt(cues, t - offset);
        const n = a[0] ?? P.nextIndex(cues, t - offset);
        shownIdx = n >= 0 ? n : cues.length - 1;
      }
      drawHelper();
      if (t == null) setStatus("No video found yet. Start playing the video on this page.", "err");
      else setStatus(`Tip: jump anywhere in the video and the subtitles follow. If they're off, use the delay buttons or Quick sync. The delay is remembered for this file.`);
    }

    function drawHelper() {
      const c = cues[shownIdx];
      if (!root || !c) return;
      const el = $(".cue");
      el.textContent = `${P.fmt(c.start)}  ${c.text.replace(/\n/g, " ")}`;
      el.title = c.text;
    }
  }
});
