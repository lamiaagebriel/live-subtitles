import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import * as S from "@/lib/style";
import type { LineKind, StyleSettings } from "@/lib/style";
import type { LiveOverlayMessage } from "@/lib/messages";
import { getStyle, onStyleChanged } from "@/lib/settings";
import { createBox, lineEl, mountBox, placeBox, onFullscreenChange, type Rect } from "@/lib/overlay";
import { findMainVideo } from "@/lib/video";

declare global {
  interface Window { __liveSubsLoaded?: boolean }
}

interface Line {
  text: string;
  original: string | null;
  kind: LineKind;
  color?: string;
}

// Live (AI) mode: draws the subtitle box over the video (and inside fullscreen players).
export default defineContentScript({
  registration: "runtime",
  main() {
    if (window.__liveSubsLoaded) return;
    window.__liveSubsLoaded = true;

    let style: StyleSettings = { ...S.DEFAULTS };
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const lines: Line[] = [];

    // AI subtitles have their own style (edited in the side panel)
    getStyle("live").then((s) => { style = s; render(); });
    onStyleChanged("live", (s) => { style = s; render(); });

    const box = createBox();
    box.id = "live-subs-overlay";

    // Sit over the video when there is one; otherwise use the whole window
    function position() {
      const v = findMainVideo();
      const vh = window.innerHeight;
      const vr = v?.getBoundingClientRect();
      const r: Rect = vr && vr.bottom >= 0 && vr.top <= vh ? vr : { left: 0, width: window.innerWidth, bottom: vh, height: vh };
      placeBox(box, r, style, style.fontSize || 24);
    }

    function render() {
      box.replaceChildren();
      for (const l of lines) {
        if (l.original) box.appendChild(lineEl(l.original, "original", style));
        box.appendChild(lineEl(l.text, l.kind, style, l.color));
      }
      box.style.display = lines.length ? "block" : "none";
      if (lines.length) position();
    }

    function show(text: string, original: string | null = null, kind: LineKind = "main", color?: string, keepMs = 9000) {
      lines.push({ text, original, kind, color });
      while (lines.length > 2) lines.shift();
      mountBox(box);
      render();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { lines.length = 0; render(); }, keepMs);
    }

    onFullscreenChange(() => { mountBox(box); render(); });
    window.addEventListener("resize", () => lines.length && position());
    window.addEventListener("scroll", () => lines.length && position(), true);
    mountBox(box);

    browser.runtime.onMessage.addListener((msg: LiveOverlayMessage) => {
      if (msg.type === "subtitle") show(msg.text, msg.original);
      else if (msg.type === "status") show(msg.text, null, "info", "#9fb6ff", 4000);
      else if (msg.type === "error") show("⚠ " + msg.text, null, "info", "#ff9a9a", 7000);
      else if (msg.type === "remove") { lines.length = 0; clearTimeout(hideTimer); box.remove(); }
    });
  }
});
