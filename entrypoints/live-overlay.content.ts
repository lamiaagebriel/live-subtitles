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
// One growing caption instead of separate lines:
const GROUP_GAP = 1.5;        // seconds of video without speech that start a new caption
const HOLD = 2.5;             // keep the caption this long after its last words (video seconds)
const SHOW_AFTER_ARRIVAL = 7000; // ms a line that just arrived stays up, even if its moment has passed
const MAX_CHARS = 110;        // longer than this: the oldest words drop off the front

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
    let untimed: TimedCue[] = [], lastUntimed = -1e9;  // lines with no video to time them against
    const pending = new Set<TimedCue>();
    const box = createBox();
    box.id = "live-subs-overlay";

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
            t, paused: video.paused, rate: video.playbackRate, videoKey: key,
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
        case "remove":
          active = false;
          untimed = []; toast = null;
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
        if (now - lastUntimed > SHOW_AFTER_ARRIVAL) untimed = []; // a pause: start a new caption
        untimed.push(cue);
        lastUntimed = now;
      }
      arrivals.set(cue, now);
      if (translated) cue.translations.set(textLang, translated);
    }

    // ---------- the caption: the lines of the current stretch of speech, joined ----------
    // Works the same on a first watch (lines arrive a little late) and on a rewind (all lines known).
    function captionCues(now: number): TimedCue[] {
      const tl = video && key ? timelines.get(key) : undefined;
      if (video && tl) {
        const t = video.currentTime;
        const next = tl.nextIndex(t);
        const k = (next >= 0 ? next : tl.cues.length) - 1; // last line that started by now
        const last = tl.cues[k];
        if (last && (t <= last.end + HOLD || now - (arrivals.get(last) ?? -1e9) < SHOW_AFTER_ARRIVAL)) {
          const group = [last];
          for (let j = k - 1; j >= 0 && group[0]!.start - tl.cues[j]!.end <= GROUP_GAP; j--) group.unshift(tl.cues[j]!);
          ensureTranslated([...group, ...(next >= 0 ? tl.cues.slice(next, next + 8) : [])]);
          return group;
        }
      }
      if (untimed.length && now - lastUntimed < SHOW_AFTER_ARRIVAL) {
        ensureTranslated(untimed);
        return untimed;
      }
      return [];
    }

    function textOf(c: TimedCue): { text: string; translated: boolean } {
      const target = lang.targetLang;
      const t = target && target !== "none" ? c.translations.get(target) : undefined;
      return t == null ? { text: c.text, translated: false } : { text: t, translated: true };
    }

    function caption(cues: TimedCue[]): Shown | null {
      if (!cues.length) return null;
      // Keep the newest words: drop whole lines from the front until it fits
      let from = 0, length = cues.reduce((n, c) => n + textOf(c).text.length + 1, 0);
      while (from < cues.length - 1 && length > MAX_CHARS) length -= textOf(cues[from++]!).text.length + 1;
      const shown = cues.slice(from);
      const texts = shown.map(textOf);
      const anyTranslated = texts.some((t) => t.translated);
      return {
        text: texts.map((t) => t.text).join(" "),
        original: lang.showOriginal && anyTranslated ? shown.map((c) => c.text).join(" ") : null,
        kind: "main"
      };
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
      const main = caption(captionCues(now));
      if (main) lines.push(main);
      if (toast && toast.until > now) lines.push({ text: toast.text, original: null, kind: "info", color: toast.color });
      else toast = null;

      const renderKey = JSON.stringify(lines);
      if (renderKey !== lastRender) { lastRender = renderKey; render(lines); }
      if (lines.length) position();
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
