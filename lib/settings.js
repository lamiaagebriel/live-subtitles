// All stored settings and their defaults, in one place.
import * as STYLE from "./style";

// Live (AI) mode: provider, key and languages
export const LIVE_DEFAULTS = {
  provider: "groq",
  apiKey: "",
  sourceLang: "auto",
  targetLang: "none",
  showOriginal: false
};

// Subtitle-file mode: style plus the translation choices it shares with live mode
export const SUBFILE_DEFAULTS = {
  ...STYLE.DEFAULTS,
  targetLang: LIVE_DEFAULTS.targetLang,
  showOriginal: LIVE_DEFAULTS.showOriginal
};

// Everything the popup reads and writes
export const DEFAULTS = {
  ...LIVE_DEFAULTS,
  ...STYLE.DEFAULTS,
  popupMode: "live",
  styleOpen: false
};
