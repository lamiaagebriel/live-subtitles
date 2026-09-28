// All stored settings and their defaults, in one place.
import * as STYLE from "./style";
import type { StyleSettings } from "./style";

export type Provider = "groq" | "openai";

// Live (AI) mode: provider, key and languages
export interface LiveSettings {
  provider: Provider;
  apiKey: string;
  sourceLang: string; // "auto" or a language code
  targetLang: string; // "none" or a language code
  showOriginal: boolean;
}

export const LIVE_DEFAULTS: LiveSettings = {
  provider: "groq",
  apiKey: "",
  sourceLang: "auto",
  targetLang: "none",
  showOriginal: false
};

// Subtitle-file mode: style plus the translation choices it shares with live mode
export type SubfileSettings = StyleSettings & Pick<LiveSettings, "targetLang" | "showOriginal">;

export const SUBFILE_DEFAULTS: SubfileSettings = {
  ...STYLE.DEFAULTS,
  targetLang: LIVE_DEFAULTS.targetLang,
  showOriginal: LIVE_DEFAULTS.showOriginal
};

// Everything the popup reads and writes
export interface PopupSettings extends LiveSettings, StyleSettings {
  popupMode: "live" | "file";
  styleOpen: boolean;
}

export const DEFAULTS: PopupSettings = {
  ...LIVE_DEFAULTS,
  ...STYLE.DEFAULTS,
  popupMode: "live",
  styleOpen: false
};
