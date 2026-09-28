import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import * as S from "@/lib/style";
import type { LineKind, StyleSettings } from "@/lib/style";
import {
  sendToBackground,
  type LiveOverlayMessage, type LiveTime, type LiveTiming, type TranslateReply
} from "@/lib/messages";
import { TRANSLATION_DEFAULTS, getStyle, onStyleChanged, type TranslationSettings } from "@/lib/settings";
import { createBox, lineEl, mountBox, placeBox, onFullscreenChange, type Rect } from "@/lib/overlay";
import { Timeline, type TimedCue } from "@/lib/timeline";
import { findMainVideo } from "@/lib/video";

declare global {
  interface Window { __liveSubsLoaded?: boolean }
}

interface Shown { text: string; original: string | null; kind: LineKind; color?: string }

const MAX_TIMELINES = 5;      // videos remembered per page (an ad in the middle counts as one)
// One subtitle at a time: each new line replaces the previous one
const HOLD = 2.5;             // keep a line this long after its last words (video seconds)
const SHOW_AFTER_ARRIVAL = 7000; // ms a line that just arrived stays up, even if its moment has passed

// Live (AI) mode: draws the subtitles over the video. Injected into every frame; the frame that plays
// the video keeps its subtitles by video time, so rewinding shows them again instantly and in sync.
export default defineContentScript({
  registration: "runtime",
  main() {
    if (window.__liveSubsLoaded) return;
    window.__liveSubsLoaded = true;

    let style: StyleSettings = { ...S.DEFAULTS };
    let lang: TranslationSettings = { ...TRANSLATION_DEFAULTS };
    let video: HTMLVideoElement | null = null, key = "", reportedArea = -1, lastPick = -1e9, lastReport = 0;
    let raf = 0, lastRender = "", active = true;
    let toast: { text: string; color: string; until: number } | null = null;
    const timelines = new Map<string, Timeline>();
    const arrivals = new WeakMap<TimedCue, number>(); // when each line arrived (performance.now)
    let untimed: TimedCue | null = null, lastUntimed = -1e9; // newest line with no video to time it against
    const pending = new Set<TimedCue>();
    const box = createBox();
    box.id = "live-subs-overlay";

    // ---------- sound off, subtitles on ----------
    // Muting the player would silence the audio we transcribe. So when the player mutes (or its volume
    // hits 0), we un-mute the element and silence the sound on our side instead (the offscreen playback).
    let extMuted = false, ignoreVolumeUntil = 0, lastVolume = 1;
    let watched: HTMLVideoElement | null = null;
    const chip = document.createElement("button");
    chip.textContent = "🔇 Sound off · subtitles on — click for sound";
    chip.style.cssText = "all: initial;";
    Object.assign(chip.style, {
      position: "fixed", zIndex: "2147483647", display: "none", cursor: "pointer",
      font: "600 12px system-ui, sans-serif", color: "#fff", background: "rgba(20, 22, 28, 0.85)",
      padding: "5px 10px", borderRadius: "999px", border: "1px solid rgba(255,255,255,0.25)"
    });
    chip.onclick = (e) => { e.stopPropagation(); sendToBackground({ type: "live-mute", muted: false }).catch(() => {}); };

    function onVolume() {
      const v = video;
      if (!v || !active || performance.now() < ignoreVolumeUntil) return;
      if (v.muted || v.volume === 0) {
        ignoreVolumeUntil = performance.now() + 300; // our own change below fires volumechange too
        v.muted = false;
        if (v.volume === 0) v.volume = lastVolume;
        if (!extMuted) sendToBackground({ type: "live-mute", muted: true }).catch(() => {});
      } else {
        lastVolume = v.volume;
        if (extMuted) sendToBackground({ type: "live-mute", muted: false }).catch(() => {}); // un-muted in the player
      }
    }

    function watchVolume(v: HTMLVideoElement | null) {
      if (v === watched) return;
      watched?.removeEventListener("volumechange", onVolume);
      v?.addEventListener("volumechange", onVolume);
      watched = v;
      if (v) onVolume(); // already muted when live mode started
    }

    // AI subtitles have their own style (edited in the side panel)
    getStyle("live").then((s) => { style = s; lastRender = ""; });
    onStyleChanged("live", (s) => { style = s; lastRender = ""; });
    browser.storage.local.get<TranslationSettings>(TRANSLATION_DEFAULTS).then((s) => { lang = s; lastRender = ""; });
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.targetLang) lang = { ...lang, targetLang: ch.targetLang.newValue as string };
      if (ch.showOriginal) lang = { ...lang, showOriginal: ch.showOriginal.newValue as boolean };
      lastRender = "";
    });

    // ---------- which video, and which of its timelines ----------
    // Same page and same length = same video (time parameters in the URL don't matter)
    function videoKey(v: HTMLVideoElement): string {
      const u = new URL(location.href);
      for (const p of ["t", "start", "time_continue"]) u.searchParams.delete(p);
      u.hash = "";
      return u.toString() + "|" + (Number.isFinite(v.duration) ? Math.round(v.duration) : "live");
    }

    function timeline(k: string): Timeline {
      let tl = timelines.get(k);
      if (!tl) {
        tl = new Timeline();
        timelines.set(k, tl);
        if (timelines.size > MAX_TIMELINES) timelines.delete(timelines.keys().next().value!);
      }
      return tl;
    }

    function pickVideo(now: number) {
      video = findMainVideo();
      watchVolume(video);
      key = video ? videoKey(video) : "";
      const r = video?.getBoundingClientRect();
      const area = r ? Math.round(r.width * r.height) : 0;
      // Tell the background this frame plays the video (repeated so a restarted background learns it again)
      if (area !== reportedArea || (area && now - lastReport > 2000)) {
        reportedArea = area;
        lastReport = now;
        sendToBackground({ type: "live-video-frame", area }).catch(() => {});
      }
    }

    // ---------- messages ----------
    browser.runtime.onMessage.addListener((msg: LiveOverlayMessage, _sender, sendResponse) => {
      switch (msg.type) {
        case "live-time-query": {
          if (!video) return false; // only the frame with the video answers
          const t = video.currentTime;
          sendResponse({
            t, paused: video.paused, rate: video.playbackRate, volume: video.muted ? 0 : video.volume, videoKey: key,
            covered: msg.from !== null && timeline(key).isCovered(msg.from, t)
          } satisfies LiveTime);
          return false;
        }
        case "subtitle":
          wake();
          addLine(msg.source, msg.translated, msg.lang, msg.timing);
          break;
        case "live-covered":
          timeline(msg.timing.videoKey).cover(msg.timing.start, msg.timing.end);
          break;
        case "status":
          wake();
          toast = { text: msg.text, color: "#9fb6ff", until: performance.now() + 4000 };
          break;
        case "error":
          wake();
          toast = { text: "⚠ " + msg.text, color: "#ff9a9a", until: performance.now() + 7000 };
          break;
        case "live-muted":
          extMuted = msg.muted;
          break;
        case "remove":
          // Live mode is over: the sound comes back through the page, so honour a mute made during it
          if (extMuted && video) { ignoreVolumeUntil = performance.now() + 300; video.muted = true; }
          extMuted = false;
          chip.remove();
          watchVolume(null);
          active = false;
          untimed = null; toast = null;
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
          box.remove();
          break;
      }
      lastRender = "";
      return false;
    });

    function addLine(source: string, translated: string | null, textLang: string, timing: LiveTiming | null) {
      const now = performance.now();
      let cue: TimedCue;
      if (timing) {
        cue = timeline(timing.videoKey).add(timing.start, timing.end, source);
      } else {
        cue = { start: 0, end: 0, text: source, translations: new Map() };
        untimed = cue;
        lastUntimed = now;
      }
      arrivals.set(cue, now);
      if (translated) cue.translations.set(textLang, translated);
    }

    // ---------- the subtitle on screen: the newest line only ----------
    // Works the same on a first watch (lines arrive a little late) and on a rewind (all lines known).
    function currentCue(now: number): TimedCue | null {
      const tl = video && key ? timelines.get(key) : undefined;
      if (video && tl) {
        const t = video.currentTime;
        const next = tl.nextIndex(t);
        const last = tl.cues[(next >= 0 ? next : tl.cues.length) - 1]; // newest line that started by now
        if (last && (t <= last.end + HOLD || now - (arrivals.get(last) ?? -1e9) < SHOW_AFTER_ARRIVAL)) {
          ensureTranslated([last, ...(next >= 0 ? tl.cues.slice(next, next + 8) : [])]);
          return last;
        }
      }
      if (untimed && now - lastUntimed < SHOW_AFTER_ARRIVAL) {
        ensureTranslated([untimed]);
        return untimed;
      }
      return null;
    }

    function caption(c: TimedCue | null): Shown | null {
      if (!c) return null;
      const target = lang.targetLang;
      const t = target && target !== "none" ? c.translations.get(target) : undefined;
      if (t == null) return { text: c.text, original: null, kind: "main" }; // not translating, or translation on its way
      return { text: t, original: lang.showOriginal && t !== c.text ? c.text : null, kind: "main" };
    }

    // ---------- translation of remembered lines (e.g. after changing the language) ----------
    function ensureTranslated(cues: TimedCue[]) {
      const target = lang.targetLang;
      if (!target || target === "none") return;
      const batch = cues.filter((c) => !c.translations.has(target) && !pending.has(c)).slice(0, 12);
      if (!batch.length) return;
      batch.forEach((c) => pending.add(c));
      sendToBackground<TranslateReply>({ type: "translate-batch", lang: target, texts: batch.map((c) => c.text) })
        .then((res) => {
          if (res && "texts" in res) batch.forEach((c, i) => c.translations.set(target, res.texts[i] || c.text));
          lastRender = "";
        })
        .catch(() => {})
        .finally(() => batch.forEach((c) => pending.delete(c)));
    }

    // ---------- drawing ----------
    function wake() {
      active = true;
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function tick(now: number) {
      raf = active ? requestAnimationFrame(tick) : 0;
      if (now - lastPick > 1000) { lastPick = now; pickVideo(now); }

      const lines: Shown[] = [];
      const main = caption(currentCue(now));
      if (main) lines.push(main);
      if (toast && toast.until > now) lines.push({ text: toast.text, original: null, kind: "info", color: toast.color });
      else toast = null;

      const renderKey = JSON.stringify(lines);
      if (renderKey !== lastRender) { lastRender = renderKey; render(lines); }
      if (lines.length) position();
      placeChip();
    }

    // The "sound off" chip sits in the top-left corner of the video
    function placeChip() {
      const r = extMuted && video ? video.getBoundingClientRect() : null;
      if (!r || r.bottom < 0 || r.top > window.innerHeight) { chip.style.display = "none"; return; }
      mountBox(chip);
      chip.style.display = "block";
      chip.style.left = Math.max(4, r.left + 12) + "px";
      chip.style.top = Math.max(4, r.top + 12) + "px";
    }

    function render(lines: Shown[]) {
      box.replaceChildren();
      for (const l of lines) {
        if (l.original) box.appendChild(lineEl(l.original, "original", style));
        box.appendChild(lineEl(l.text, l.kind, style, l.color));
      }
      box.style.display = lines.length ? "block" : "none";
      if (lines.length) mountBox(box);
    }

    // Sit over the video when there is one; otherwise use the whole window
    function position() {
      const vh = window.innerHeight;
      const vr = video?.getBoundingClientRect();
      const r: Rect = vr && vr.bottom >= 0 && vr.top <= vh ? vr : { left: 0, width: window.innerWidth, bottom: vh, height: vh };
      placeBox(box, r, style, style.fontSize || 24);
    }

    onFullscreenChange(() => { lastRender = ""; mountBox(box); });
    wake();
  }
});
