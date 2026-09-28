// All stored settings and their defaults, in one place.
import { browser } from "wxt/browser";
import * as STYLE from "./style";
import type { StyleSettings } from "./style";

export type Provider = "groq" | "openai";

// Live (AI) mode: provider, key and languages. Translation settings are shared with file mode.
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

export type TranslationSettings = Pick<LiveSettings, "targetLang" | "showOriginal">;

export const TRANSLATION_DEFAULTS: TranslationSettings = {
  targetLang: LIVE_DEFAULTS.targetLang,
  showOriginal: LIVE_DEFAULTS.showOriginal
};

// Everything the popup reads and writes besides the styles
export interface PanelSettings extends LiveSettings {
  panelMode: Mode;
  styleOpen: boolean; // the style section was left open
}

export const PANEL_DEFAULTS: PanelSettings = { ...LIVE_DEFAULTS, panelMode: "live", styleOpen: false };

// ---------- subtitle style: one per mode ----------
export type Mode = "live" | "file";

export const STYLE_KEYS = { live: "liveStyle", file: "fileStyle" } as const satisfies Record<Mode, string>;

export async function getStyle(mode: Mode): Promise<StyleSettings> {
  const key = STYLE_KEYS[mode];
  const stored = await browser.storage.local.get<Record<string, Partial<StyleSettings> | undefined>>(key);
  return { ...STYLE.DEFAULTS, ...stored[key] };
}

export function setStyle(mode: Mode, style: StyleSettings): Promise<void> {
  return browser.storage.local.set({ [STYLE_KEYS[mode]]: style });
}

export function onStyleChanged(mode: Mode, fn: (style: StyleSettings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[STYLE_KEYS[mode]];
    if (area === "local" && change) fn({ ...STYLE.DEFAULTS, ...(change.newValue as Partial<StyleSettings> | undefined) });
  });
}

// Versions up to 1.2 stored one style as top-level keys (fontSize, textColor, …).
// Copy it into both per-mode styles once, then remove the old keys.
export async function migrateStyles(): Promise<void> {
  const stored = await browser.storage.local.get<Record<string, unknown>>(null);
  if (stored[STYLE_KEYS.live] || stored[STYLE_KEYS.file]) return;
  const old: Partial<StyleSettings> = {};
  for (const k of STYLE.keys) if (k in stored) Object.assign(old, { [k]: stored[k] });
  if (!Object.keys(old).length) return;
  const style = { ...STYLE.DEFAULTS, ...old };
  await browser.storage.local.set({ [STYLE_KEYS.live]: style, [STYLE_KEYS.file]: style });
  await browser.storage.local.remove([...STYLE.keys, "popupMode", "styleOpen"]);
}
