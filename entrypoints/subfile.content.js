import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { LANGUAGES } from "@/lib/languages";
import * as S from "@/lib/style";
import * as P from "@/lib/subparse";

// "Subtitle file" mode: shows a loaded .srt/.vtt/.ass file perfectly synced to the video.
// Injected into every frame of the tab. The top frame shows the control panel;
// any frame that contains the video draws the subtitles over it.
export default defineContentScript({
  registration: "runtime",
  main() {
    if (window.__liveSubsFileLoaded) return;
    window.__liveSubsFileLoaded = true;

    const isTop = window === window.top;
    const ENCODINGS = [
      ["auto", "Automatic"], ["utf-8", "UTF-8"],
      ["windows-1256", "Arabic (Windows-1256)"], ["iso-8859-6", "Arabic (ISO-8859-6)"],
      ["windows-1252", "Western (Windows-1252)"], ["windows-1250", "Central European (Windows-1250)"],
      ["windows-1251", "Cyrillic (Windows-1251)"], ["windows-1253", "Greek (Windows-1253)"],
      ["windows-1254", "Turkish (Windows-1254)"], ["windows-1255", "Hebrew (Windows-1255)"],
      ["gbk", "Chinese Simplified (GBK)"], ["big5", "Chinese Traditional (Big5)"],
      ["shift_jis", "Japanese (Shift_JIS)"], ["euc-kr", "Korean (EUC-KR)"], ["utf-16le", "UTF-16"]
    ];

    // ---------- shared state (every frame) ----------
    let cues = [], fileName = "", offset = 0, hidden = false;
    const SETTING_DEFAULTS = { ...S.DEFAULTS, targetLang: "none", showOriginal: false };
    let settings = { ...SETTING_DEFAULTS };
    let video = null, lastPick = -1e9, raf = 0, lastTimeSent = 0;
    let box = null, lastKey = "", toast = "", toastUntil = 0;
    const tr = new Map(), pending = new Set();
    let lastTrIdx = -1;

    // ---------- top-frame panel state ----------
    let host = null, root = null, fileBuf = null, encoding = "auto";
    let remoteTime = null, shownIdx = 0, manualUntil = 0, panelTimer = 0;

    browser.storage.local.get(SETTING_DEFAULTS).then((s) => {
      settings = s;
      lastKey = "";
      applyCueCss();
      syncPanelControls();
    });
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      for (const k of Object.keys(SETTING_DEFAULTS)) if (ch[k]) settings[k] = ch[k].newValue;
      applyCueCss();
      if (ch.targetLang) { tr.clear(); lastTrIdx = -1; }
      lastKey = "";
      syncPanelControls();
    });

    function broadcast(payload) {
      browser.runtime.sendMessage({ type: "subfile-broadcast", payload }).catch(() => {});
    }

    browser.runtime.onMessage.addListener((msg) => {
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
        case "subfile-sync-now":
          if (video && cues[msg.index]) setOffset(video.currentTime - cues[msg.index].start);
          break;
        case "subfile-time":
          if (isTop) remoteTime = { t: msg.t, paused: msg.paused, rate: msg.rate, at: performance.now() };
          break;
        case "subfile-close":
          teardown();
          break;
      }
    });

    // ---------- offset / delay ----------
    function setOffset(v) {
      broadcast({ type: "subfile-offset", offset: Math.round(v * 100) / 100 });
    }
    function delayText(o) {
      if (Math.abs(o) < 0.05) return "Delay 0.0s (original timing)";
      return `Delay ${o > 0 ? "+" : "−"}${Math.abs(o).toFixed(1)}s (subtitles ${o > 0 ? "later" : "earlier"})`;
    }
    async function saveOffset() {
      const { subOffsets = {} } = await browser.storage.local.get("subOffsets");
      subOffsets[fileName] = offset;
      const keys = Object.keys(subOffsets);
      if (keys.length > 100) delete subOffsets[keys[0]];
      browser.storage.local.set({ subOffsets });
    }
    function flash(text) {
      toast = text; toastUntil = performance.now() + 1500; lastKey = "";
    }

    // Keyboard: G = subtitles earlier, H = later (Shift = 1 second steps)
    window.addEventListener("keydown", (e) => {
      if (!cues.length || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k !== "g" && k !== "h") return;
      const el = e.composedPath ? e.composedPath()[0] : e.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""))) return;
      e.preventDefault(); e.stopPropagation();
      setOffset(offset + (k === "g" ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
    }, true);

    // ---------- video + rendering ----------
    function pickVideo() {
      let best = null, bestScore = 0;
      for (const v of document.querySelectorAll("video")) {
        const r = v.getBoundingClientRect();
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        if (area < 40000) continue;
        const score = area * (v.paused ? 1 : 2);
        if (score > bestScore) { best = v; bestScore = score; }
      }
      if (best !== video) { clearNative(); video = best; lastKey = ""; }
    }

    function startLoop() {
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function lineFor(i) {
      const orig = cues[i].text;
      if (!settings.targetLang || settings.targetLang === "none") return { text: orig };
      const t = tr.get(i);
      if (t == null) return { text: orig };
      return { text: t, original: settings.showOriginal && t !== orig ? orig : null };
    }

    function tick(now) {
      raf = requestAnimationFrame(tick);
      if (now - lastPick > 1000) { lastPick = now; pickVideo(); }
      if (!video || !cues.length) { if (box) box.style.display = "none"; return; }

      if (!isTop && now - lastTimeSent > 500) {
        lastTimeSent = now;
        broadcast({ type: "subfile-time", t: video.currentTime, paused: video.paused, rate: video.playbackRate });
      }

      const t = video.currentTime - offset;
      const idxs = hidden ? [] : P.activeAt(cues, t);
      const anchor = idxs.length ? idxs[0] : P.nextIndex(cues, t);
      if (anchor >= 0 && anchor !== lastTrIdx) { lastTrIdx = anchor; ensureTranslated(anchor); }

      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const nativeMode = fs === video;
      const lines = idxs.map(lineFor);
      const toastOn = now < toastUntil;
      const key = JSON.stringify(lines) + "|" + (toastOn ? toast : "") + "|" + nativeMode;
      if (key !== lastKey) { lastKey = key; render(lines, toastOn ? toast : "", nativeMode); }
      if (!nativeMode) position();
    }

    function ensureBox() {
      if (!box) {
        box = document.createElement("div");
        box.setAttribute("dir", "auto");
        box.style.cssText = "all: initial;";
        Object.assign(box.style, {
          position: "fixed", left: "50%", bottom: "10%", transform: "translateX(-50%)",
          zIndex: "2147483647", pointerEvents: "none", textAlign: "center", display: "none",
          lineHeight: "1.35"
        });
      }
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const parent = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
      if (box.parentNode !== parent) parent.appendChild(box);
    }

    function lineEl(text, kind) {
      const wrap = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = text;
      span.setAttribute("dir", "auto");
      Object.assign(span.style, S.lineStyle(settings, kind));
      wrap.appendChild(span);
      return wrap;
    }

    // Look of the browser's own subtitle display (bare-video fullscreen)
    let cueStyleEl = null;
    function applyCueCss() {
      if (!cueStyleEl) {
        cueStyleEl = document.createElement("style");
        cueStyleEl.id = "live-subs-cue-style";
      }
      cueStyleEl.textContent = S.cueCss(settings);
      if (!cueStyleEl.isConnected) (document.head || document.documentElement).appendChild(cueStyleEl);
    }

    function render(lines, toastText, nativeMode) {
      if (nativeMode) {
        if (box) box.style.display = "none";
        const text = lines.map((l) => (l.original ? l.original + "\n" : "") + l.text).join("\n");
        setNative(text || toastText);
        return;
      }
      clearNative();
      ensureBox();
      box.replaceChildren();
      for (const l of lines) {
        if (l.original) box.appendChild(lineEl(l.original, "original"));
        box.appendChild(lineEl(l.text, "main"));
      }
      if (toastText) box.appendChild(lineEl(toastText, "info"));
      box.style.display = box.childNodes.length ? "block" : "none";
    }

    function position() {
      if (!box || box.style.display === "none" || !video) return;
      const r = video.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh) { box.style.visibility = "hidden"; return; }
      box.style.visibility = "visible";
      const scale = Math.min(2.2, Math.max(0.75, r.height / 480));
      box.style.fontSize = Math.round((settings.fontSize || 24) * scale) + "px";
      box.style.left = r.left + r.width / 2 + "px";
      box.style.bottom = Math.min(Math.max(4, vh - r.bottom + r.height * (settings.position / 100)), vh - 40) + "px";
      box.style.maxWidth = Math.max(200, r.width * (settings.width / 100)) + "px";
    }

    // When the <video> element itself goes fullscreen nothing can be drawn over it,
    // so the browser's own subtitle track is used for that case.
    function setNative(text) {
      if (!video) return;
      let track = video.__liveSubsTrack;
      if (!track) { track = video.addTextTrack("subtitles", "Subtitles (file)", ""); video.__liveSubsTrack = track; }
      track.mode = "showing";
      if (video.__liveSubsText === text) return;
      if (video.__liveSubsCue) { try { track.removeCue(video.__liveSubsCue); } catch {} }
      video.__liveSubsCue = null;
      video.__liveSubsText = text;
      if (text) {
        const cue = new VTTCue(0, 1e9, text);
        track.addCue(cue);
        video.__liveSubsCue = cue;
      }
    }
    function clearNative() {
      const v = video;
      if (!v || !v.__liveSubsTrack) return;
      if (v.__liveSubsCue) { try { v.__liveSubsTrack.removeCue(v.__liveSubsCue); } catch {} }
      v.__liveSubsCue = null; v.__liveSubsText = "";
      v.__liveSubsTrack.mode = "disabled";
    }
    document.addEventListener("fullscreenchange", () => { lastKey = ""; });
    document.addEventListener("webkitfullscreenchange", () => { lastKey = ""; });

    // ---------- translation (a few lines ahead, cached) ----------
    function ensureTranslated(from) {
      const target = settings.targetLang;
      if (!target || target === "none") return;
      const batch = [];
      let len = 0;
      for (let i = from; i < cues.length && i < from + 25 && batch.length < 12; i++) {
        if (tr.has(i) || pending.has(i)) continue;
        if (batch.length && len + cues[i].text.length > 1200) break;
        batch.push(i);
        len += cues[i].text.length;
      }
      if (!batch.length) return;
      batch.forEach((i) => pending.add(i));
      const snapshot = cues;
      browser.runtime.sendMessage({ type: "translate-batch", target, texts: batch.map((i) => cues[i].text) })
        .then((res) => {
          if (target !== settings.targetLang || snapshot !== cues || !res?.texts) return;
          batch.forEach((i, k) => tr.set(i, res.texts[k] || cues[i].text));
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
      if (host) { root.querySelector(".body").hidden = false; return; }
      host = document.createElement("div");
      host.style.cssText = "all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;";
      root = host.attachShadow({ mode: "open" });
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
      document.documentElement.appendChild(host);

      const q = (s) => root.querySelector(s);
      for (const [code, name] of LANGUAGES) q(".lang").add(new Option(name, code));
      for (const [code, name] of ENCODINGS) q(".enc").add(new Option(name, code));

      q(".pick").onclick = () => q(".file").click();
      q(".file").onchange = (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; };
      q(".min").onclick = () => { q(".body").hidden = !q(".body").hidden; };
      q(".close").onclick = () => { broadcast({ type: "subfile-close" }); teardown(); };
      root.querySelectorAll("[data-d]").forEach((b) => { b.onclick = () => setOffset(offset + Number(b.dataset.d)); });
      q(".reset").onclick = () => setOffset(0);
      q(".prev").onclick = () => moveHelper(-1);
      q(".next").onclick = () => moveHelper(1);
      q(".now").onclick = () => { broadcast({ type: "subfile-sync-now", index: shownIdx }); manualUntil = 0; };
      q(".lang").onchange = (e) => browser.storage.local.set({ targetLang: e.target.value });
      q(".orig").onchange = (e) => browser.storage.local.set({ showOriginal: e.target.checked });
      q(".hide").onchange = (e) => broadcast({ type: "subfile-hidden", hidden: e.target.checked });
      q(".enc").onchange = (e) => { encoding = e.target.value; if (fileBuf) applyFile(true); };

      // Drag the panel by its header
      const head = q(".head");
      head.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        const r = host.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        head.setPointerCapture(e.pointerId);
        const move = (ev) => {
          host.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)) + "px";
          host.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + "px";
          host.style.right = "auto";
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

    function setStatus(text, cls = "") {
      if (!root) return;
      const s = root.querySelector(".status");
      s.textContent = text;
      s.className = "status hint " + (cls || "muted");
    }

    async function loadFile(file) {
      fileBuf = await file.arrayBuffer();
      fileName = file.name;
      encoding = "auto";
      if (root) root.querySelector(".enc").value = "auto";
      applyFile(false);
    }

    async function applyFile(keepOffset) {
      let text;
      try { text = P.decode(fileBuf, encoding); } catch { return showFileError("This encoding can't read the file. Try another one."); }
      const parsed = P.parse(text);
      if (!parsed.length) return showFileError("No subtitle lines found. Supported formats: .srt, .vtt, .ass, .ssa");
      let startOffset = offset;
      if (!keepOffset) {
        const { subOffsets = {} } = await browser.storage.local.get("subOffsets");
        startOffset = subOffsets[fileName] || 0;
      }
      broadcast({ type: "subfile-cues", cues: parsed, name: fileName, offset: startOffset });
    }

    function showFileError(text) {
      if (!root) return;
      const f = root.querySelector(".fname");
      f.textContent = text;
      f.className = "fname err";
    }

    function updatePanelLoaded() {
      if (!root) return;
      const f = root.querySelector(".fname");
      f.textContent = `✓ ${fileName} (${cues.length} lines)`;
      f.className = "fname ok";
      root.querySelector(".loaded").hidden = false;
      root.querySelector(".hide").checked = hidden;
      updateOffsetLabel();
    }

    function updateOffsetLabel() {
      if (!root) return;
      const o = offset;
      root.querySelector(".off").textContent = (o > 0 ? "+" : o < 0 ? "−" : "") + Math.abs(o).toFixed(1) + "s";
    }

    function syncPanelControls() {
      if (!root) return;
      root.querySelector(".lang").value = settings.targetLang || "none";
      root.querySelector(".orig").checked = !!settings.showOriginal;
    }

    function playerTime() {
      if (video) return video.currentTime;
      if (remoteTime && performance.now() - remoteTime.at < 3000) {
        return remoteTime.t + (remoteTime.paused ? 0 : (performance.now() - remoteTime.at) / 1000 * (remoteTime.rate || 1));
      }
      return null;
    }

    function moveHelper(d) {
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
        const n = a.length ? a[0] : P.nextIndex(cues, t - offset);
        shownIdx = n >= 0 ? n : cues.length - 1;
      }
      drawHelper();
      if (t == null) setStatus("No video found yet. Start playing the video on this page.", "err");
      else setStatus(`Tip: jump anywhere in the video and the subtitles follow. If they're off, use the delay buttons or Quick sync. The delay is remembered for this file.`);
    }

    function drawHelper() {
      const c = cues[shownIdx];
      if (!root || !c) return;
      const el = root.querySelector(".cue");
      el.textContent = `${P.fmt(c.start)}  ${c.text.replace(/\n/g, " ")}`;
      el.title = c.text;
    }
  }
});
