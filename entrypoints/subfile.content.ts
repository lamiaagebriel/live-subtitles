import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import * as S from "@/lib/style";
import type { LineKind, StyleSettings } from "@/lib/style";
import * as P from "@/lib/subparse";
import { TRANSLATION_DEFAULTS, getStyle, onStyleChanged, type TranslationSettings } from "@/lib/settings";
import { createBox, lineEl as makeLine, mountBox, placeBox, onFullscreenChange, fullscreenElement } from "@/lib/overlay";
import { sendToBackground, type LoadReply, type PlayerTime, type SubfileTabMessage, type TranslateReply } from "@/lib/messages";
import { toBase64 } from "@/lib/bytes";
import { findMainVideo } from "@/lib/video";

declare global {
  interface Window { __liveSubsFileLoaded?: boolean }
}

interface Line { text: string; original?: string | null }

// The browser's own subtitle track we add to a video (for bare-video fullscreen)
interface NativeTrack { track: TextTrack; cue: VTTCue | null; text: string }

// "Subtitle file" mode: shows a loaded .srt/.vtt/.ass file perfectly synced to the video.
// Injected into every frame of the tab; any frame that contains the video draws the subtitles over it.
// The file itself is chosen in the popup or dropped onto the page, and kept by the background.
export default defineContentScript({
  registration: "runtime",
  main() {
    if (window.__liveSubsFileLoaded) return;
    window.__liveSubsFileLoaded = true;

    let cues: P.Cue[] = [], offset = 0, hidden = false;
    let style: StyleSettings = { ...S.DEFAULTS };
    let lang: TranslationSettings = { ...TRANSLATION_DEFAULTS };
    let video: HTMLVideoElement | null = null, lastPick = -1e9, raf = 0;
    let box: HTMLDivElement | null = null, lastKey = "", toast = "", toastUntil = 0;
    const tr = new Map<number, string>(), pending = new Set<number>();
    const nativeTracks = new WeakMap<HTMLVideoElement, NativeTrack>();
    let lastTrIdx = -1;

    getStyle("file").then((s) => { style = s; lastKey = ""; applyCueCss(); });
    onStyleChanged("file", (s) => { style = s; lastKey = ""; applyCueCss(); });
    browser.storage.local.get<TranslationSettings>(TRANSLATION_DEFAULTS).then((s) => { lang = s; lastKey = ""; });
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || (!ch.targetLang && !ch.showOriginal)) return;
      if (ch.targetLang) { lang = { ...lang, targetLang: ch.targetLang.newValue as string }; tr.clear(); lastTrIdx = -1; }
      if (ch.showOriginal) lang = { ...lang, showOriginal: ch.showOriginal.newValue as boolean };
      lastKey = "";
    });

    browser.runtime.onMessage.addListener((msg: SubfileTabMessage, _sender, sendResponse) => {
      switch (msg.type) {
        case "subfile-cues":
          cues = msg.cues; offset = msg.offset; hidden = msg.hidden;
          tr.clear(); pending.clear(); lastTrIdx = -1; lastKey = "";
          startLoop();
          break;
        case "subfile-offset":
          offset = msg.offset; lastKey = "";
          if (video) flash(delayText(offset));
          break;
        case "subfile-hidden":
          hidden = msg.hidden; lastKey = "";
          break;
        case "subfile-sync-now": {
          const cue = cues[msg.index];
          if (video && cue) setOffset(video.currentTime - cue.start);
          break;
        }
        case "subfile-time-query":
          // Only the frame that plays the video answers
          if (video) sendResponse({ t: video.currentTime, paused: video.paused } satisfies PlayerTime);
          break;
        case "subfile-close":
          clearSubtitles();
          break;
      }
      return false;
    });

    // ---------- offset / delay ----------
    function setOffset(v: number) {
      sendToBackground({ type: "subfile-offset", offset: v }).catch(() => {});
    }
    function delayText(o: number) {
      if (Math.abs(o) < 0.05) return "Delay 0.0s (original timing)";
      return `Delay ${o > 0 ? "+" : "−"}${Math.abs(o).toFixed(1)}s (subtitles ${o > 0 ? "later" : "earlier"})`;
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

    // ---------- drop a subtitle file anywhere on the page ----------
    const SUB_EXT = /\.(srt|vtt|ass|ssa|txt)$/i;
    window.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    }, true);
    window.addEventListener("drop", async (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f || !SUB_EXT.test(f.name)) return;
      e.preventDefault(); e.stopPropagation();
      const data = toBase64(await f.arrayBuffer());
      const res = await sendToBackground<LoadReply>({ type: "subfile-load", name: f.name, data }).catch((err) => ({ error: String(err) }));
      notice(res && "error" in res ? "⚠ " + res.error : `✓ ${f.name}`);
    }, true);

    // A short message over the video, shown even when no subtitles are loaded yet
    function notice(text: string) {
      flash(text);
      if (cues.length) return;
      const b = ensureBox();
      b.replaceChildren(lineEl(text, "info"));
      b.style.display = "block";
      b.style.visibility = "visible";
      const v = findMainVideo();
      const vh = window.innerHeight;
      placeBox(b, v?.getBoundingClientRect() ?? { left: 0, width: window.innerWidth, bottom: vh, height: vh }, style, style.fontSize || 24);
      setTimeout(() => { if (!cues.length) b.style.display = "none"; }, 3000);
    }

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
      if (!lang.targetLang || lang.targetLang === "none") return { text: orig };
      const t = tr.get(i);
      if (t == null) return { text: orig };
      return { text: t, original: lang.showOriginal && t !== orig ? orig : null };
    }

    function tick(now: number) {
      raf = requestAnimationFrame(tick);
      if (now - lastPick > 1000) { lastPick = now; pickVideo(); }
      if (!video || !cues.length) { if (box) box.style.display = "none"; return; }

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
      return makeLine(text, kind, style);
    }

    // Look of the browser's own subtitle display (bare-video fullscreen)
    let cueStyleEl: HTMLStyleElement | null = null;
    function applyCueCss() {
      if (!cueStyleEl) {
        cueStyleEl = document.createElement("style");
        cueStyleEl.id = "live-subs-cue-style";
      }
      cueStyleEl.textContent = S.cueCss(style);
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
      placeBox(box, r, style, Math.round((style.fontSize || 24) * scale));
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
      const target = lang.targetLang;
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
          if (target !== lang.targetLang || snapshot !== cues || !res || !("texts" in res)) return;
          batch.forEach((i, k) => tr.set(i, res.texts[k] || snapshot[i]!.text));
          lastKey = "";
        })
        .catch(() => {})
        .finally(() => batch.forEach((i) => pending.delete(i)));
    }

    // Remove the subtitles but keep listening, so a new file can be dropped
    function clearSubtitles() {
      cues = []; offset = 0; hidden = false;
      tr.clear(); pending.clear(); lastTrIdx = -1; lastKey = "";
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearNative();
      box?.remove(); box = null;
    }
  }
});
