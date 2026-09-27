// Live (AI) mode: draws the subtitle box over the video (and inside fullscreen players).
(() => {
  if (window.__liveSubsLoaded) return;
  window.__liveSubsLoaded = true;

  const S = window.LiveSubsStyle;
  let style = { ...S.DEFAULTS }, hideTimer = null, posTimer = null;
  const lines = [];

  chrome.storage.local.get(S.DEFAULTS).then((s) => { style = s; render(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    let changed = false;
    for (const k of S.keys) if (ch[k]) { style[k] = ch[k].newValue; changed = true; }
    if (changed) render();
  });

  const box = document.createElement("div");
  box.id = "live-subs-overlay";
  box.setAttribute("dir", "auto");
  box.style.cssText = "all: initial;";
  Object.assign(box.style, {
    position: "fixed", left: "50%", bottom: "10%", transform: "translateX(-50%)",
    zIndex: "2147483647", pointerEvents: "none", textAlign: "center", display: "none"
  });

  function lineEl(text, kind, color) {
    const wrap = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = text;
    span.setAttribute("dir", "auto");
    Object.assign(span.style, S.lineStyle(style, kind, color));
    wrap.appendChild(span);
    return wrap;
  }

  function biggestVideo() {
    let best = null, bestArea = 40000;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // Sit over the video when there is one; otherwise use the whole window
  function position() {
    const v = biggestVideo();
    const vh = window.innerHeight;
    let r = v ? v.getBoundingClientRect() : null;
    if (!r || r.bottom < 0 || r.top > vh) r = { left: 0, width: window.innerWidth, top: 0, bottom: vh, height: vh };
    box.style.fontSize = (style.fontSize || 24) + "px";
    box.style.left = r.left + r.width / 2 + "px";
    box.style.bottom = Math.min(Math.max(4, vh - r.bottom + r.height * (style.position / 100)), vh - 40) + "px";
    box.style.maxWidth = Math.max(200, r.width * (style.width / 100)) + "px";
  }

  function render() {
    box.replaceChildren();
    for (const l of lines) {
      if (l.original) box.appendChild(lineEl(l.original, "original"));
      box.appendChild(lineEl(l.text, l.kind || "main", l.color));
    }
    box.style.display = lines.length ? "block" : "none";
    if (lines.length) position();
  }

  function show(text, original = null, kind = "main", color, keepMs = 9000) {
    lines.push({ text, original, kind, color });
    while (lines.length > 2) lines.shift();
    attach();
    render();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { lines.length = 0; render(); }, keepMs);
  }

  function attach() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const host = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
    if (box.parentNode !== host) host.appendChild(box);
  }
  document.addEventListener("fullscreenchange", () => { attach(); render(); });
  document.addEventListener("webkitfullscreenchange", () => { attach(); render(); });
  window.addEventListener("resize", () => lines.length && position());
  window.addEventListener("scroll", () => lines.length && position(), true);
  attach();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "subtitle") show(msg.text, msg.original);
    else if (msg.type === "status") show(msg.text, null, "info", "#9fb6ff", 4000);
    else if (msg.type === "error") show("⚠ " + msg.text, null, "info", "#ff9a9a", 7000);
    else if (msg.type === "remove") { lines.length = 0; clearTimeout(hideTimer); clearInterval(posTimer); box.remove(); }
  });
})();
