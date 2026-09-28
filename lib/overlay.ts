// The subtitle box drawn over the video, shared by live mode and subtitle-file mode.
import * as S from "./style";
import type { LineKind, StyleSettings } from "./style";

// Only as much of a DOMRect as placement needs, so a plain object works too
export type Rect = Pick<DOMRect, "left" | "width" | "bottom" | "height">;

export function createBox(): HTMLDivElement {
  const box = document.createElement("div");
  box.setAttribute("dir", "auto");
  box.style.cssText = "all: initial;";
  Object.assign(box.style, {
    position: "fixed", left: "50%", bottom: "10%", transform: "translateX(-50%)",
    zIndex: "2147483647", pointerEvents: "none", textAlign: "center", display: "none",
    lineHeight: "1.35"
  });
  return box;
}

// One subtitle line. kind: "main" | "original" | "info"
export function lineEl(text: string, kind: LineKind, settings: Partial<StyleSettings>, color?: string): HTMLDivElement {
  const wrap = document.createElement("div");
  const span = document.createElement("span");
  span.textContent = text;
  span.setAttribute("dir", "auto");
  Object.assign(span.style, S.lineStyle(settings, kind, color));
  wrap.appendChild(span);
  return wrap;
}

// Inside a fullscreen player the box must be a child of the fullscreen element to stay visible
export function mountBox(box: HTMLElement): void {
  const fs = fullscreenElement();
  const parent = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
  if (box.parentNode !== parent) parent.appendChild(box);
}

// Centers the box over `rect` (a video's bounding box), at the user's height and width settings
export function placeBox(box: HTMLElement, rect: Rect, settings: StyleSettings, fontSize: number): void {
  const vh = window.innerHeight;
  box.style.fontSize = fontSize + "px";
  box.style.left = rect.left + rect.width / 2 + "px";
  box.style.bottom = Math.min(Math.max(4, vh - rect.bottom + rect.height * (settings.position / 100)), vh - 40) + "px";
  box.style.maxWidth = Math.max(200, rect.width * (settings.width / 100)) + "px";
}

export function onFullscreenChange(fn: () => void): void {
  document.addEventListener("fullscreenchange", fn);
  document.addEventListener("webkitfullscreenchange", fn);
}

// Standard API, with the webkit-prefixed fallback older Safari/Chrome builds use
export function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;
}
