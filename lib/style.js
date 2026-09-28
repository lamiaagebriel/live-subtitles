// Shared subtitle look (used by the popup preview, live mode and subtitle-file mode).
export const DEFAULTS = {
  fontSize: 24,          // px (file mode scales it with the video's size)
  textColor: "#ffffff",
  bgColor: "#000000",
  bgOpacity: 75,         // 0 = no box, 100 = solid
  position: 10,          // distance from the bottom of the video, in % of its height
  width: 90,             // max line width, in % of the video's width
  fontFamily: "system",
  bold: true,
  edge: "shadow",        // none | shadow | outline | both
  origColor: "#d7d7d7"   // color of the original line when "also show original" is on
};

export const FONTS = {
  system: "system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
  arial: "Arial, Helvetica, sans-serif",
  tahoma: "Tahoma, Verdana, sans-serif",
  verdana: "Verdana, Geneva, sans-serif",
  trebuchet: "'Trebuchet MS', Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  times: "'Times New Roman', Times, serif",
  arabic: "'Noto Naskh Arabic', 'Traditional Arabic', 'Simplified Arabic', 'Segoe UI', Tahoma, serif",
  mono: "'Courier New', Consolas, monospace"
};

function rgba(hex, opacity) {
  const h = (hex || "#000000").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(100, opacity)) / 100})`;
}

function textShadow(edge) {
  const o = "0.06em";
  const outline = `-${o} -${o} 0 #000, ${o} -${o} 0 #000, -${o} ${o} 0 #000, ${o} ${o} 0 #000, 0 -${o} 0 #000, 0 ${o} 0 #000, -${o} 0 0 #000, ${o} 0 0 #000`;
  const shadow = "0 0.05em 0.12em rgba(0,0,0,0.95), 0 0 0.25em rgba(0,0,0,0.6)";
  return edge === "none" ? "none" : edge === "outline" ? outline : edge === "both" ? outline + ", " + shadow : shadow;
}

// Inline styles for one subtitle line. kind: "main" | "original" | "info"
export function lineStyle(s, kind = "main", infoColor = "#9fb6ff") {
  s = { ...DEFAULTS, ...s };
  const small = kind !== "main";
  return {
    display: "inline-block",
    margin: "0.08em 0",
    padding: s.bgOpacity > 0 ? "0.12em 0.45em" : "0 0.2em",
    borderRadius: "0.22em",
    background: rgba(s.bgColor, s.bgOpacity),
    color: kind === "original" ? s.origColor : kind === "info" ? infoColor : s.textColor,
    fontSize: small ? "0.7em" : "1em",
    fontWeight: s.bold && !small ? "600" : "400",
    fontFamily: FONTS[s.fontFamily] || FONTS.system,
    textShadow: textShadow(s.edge),
    lineHeight: "1.35",
    whiteSpace: "pre-wrap",
    boxDecorationBreak: "clone",
    webkitBoxDecorationBreak: "clone"
  };
}

// CSS for the browser's own subtitle display (used when the bare <video> is fullscreen)
export function cueCss(s) {
  s = { ...DEFAULTS, ...s };
  return `video::cue { color: ${s.textColor}; background-color: ${rgba(s.bgColor, s.bgOpacity)};
    font-family: ${FONTS[s.fontFamily] || FONTS.system}; font-weight: ${s.bold ? 600 : 400};
    text-shadow: ${textShadow(s.edge)}; }`;
}

export const keys = Object.keys(DEFAULTS);
