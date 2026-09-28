import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import * as S from "@/lib/style";
import { createBox, lineEl, mountBox, placeBox, onFullscreenChange } from "@/lib/overlay";
import { findMainVideo } from "@/lib/video";

// Live (AI) mode: draws the subtitle box over the video (and inside fullscreen players).
export default defineContentScript({
  registration: "runtime",
  main() {
    if (window.__liveSubsLoaded) return;
    window.__liveSubsLoaded = true;

    let style = { ...S.DEFAULTS }, hideTimer = null;
    const lines = [];

    browser.storage.local.get(S.DEFAULTS).then((s) => { style = s; render(); });
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      let changed = false;
      for (const k of S.keys) if (ch[k]) { style[k] = ch[k].newValue; changed = true; }
      if (changed) render();
    });

    const box = createBox();
    box.id = "live-subs-overlay";

    // Sit over the video when there is one; otherwise use the whole window
    function position() {
      const v = findMainVideo();
      const vh = window.innerHeight;
      let r = v ? v.getBoundingClientRect() : null;
      if (!r || r.bottom < 0 || r.top > vh) r = { left: 0, width: window.innerWidth, top: 0, bottom: vh, height: vh };
      placeBox(box, r, style, style.fontSize || 24);
    }

    function render() {
      box.replaceChildren();
      for (const l of lines) {
        if (l.original) box.appendChild(lineEl(l.original, "original", style));
        box.appendChild(lineEl(l.text, l.kind || "main", style, l.color));
      }
      box.style.display = lines.length ? "block" : "none";
      if (lines.length) position();
    }

    function show(text, original = null, kind = "main", color, keepMs = 9000) {
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

    browser.runtime.onMessage.addListener((msg) => {
      if (msg.type === "subtitle") show(msg.text, msg.original);
      else if (msg.type === "status") show(msg.text, null, "info", "#9fb6ff", 4000);
      else if (msg.type === "error") show("⚠ " + msg.text, null, "info", "#ff9a9a", 7000);
      else if (msg.type === "remove") { lines.length = 0; clearTimeout(hideTimer); box.remove(); }
    });
  }
});
