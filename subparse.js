// Subtitle file reading: text-encoding detection + SRT / VTT / ASS / SSA parsing + fast time lookup.
var LiveSubsParser = window.LiveSubsParser || (() => {
  // Letters typical for each legacy 8-bit encoding, used to guess the right one.
  // Order matters for ties (Western before Central European / Turkish).
  const LEGACY = [
    ["windows-1256", "اليمنوتبرعهدكسفقحجشصطزخذثضظغءأإآةىپچژگکی"],
    ["windows-1251", "оеаинтсрвлкмдпуяыьгзбчйхжшюцщэфъё"],
    ["windows-1253", "αοιετσνηυρπκμλωςάέίόύή"],
    ["windows-1255", "יוהלארבתמשנעדכקפחצגסזטםןךףץ"],
    ["windows-1252", "éèàçêâôîûëïäößñáíóúüãõ"],
    ["windows-1250", "ęąłńśćżźěščřžůňťďőűŻŚŁŹĆý"],
    ["windows-1254", "şğŞĞİı"]
  ];

  function decode(buf, enc = "auto") {
    const bytes = new Uint8Array(buf);
    const clean = (s) => s.replace(/^﻿/, "");
    if (enc && enc !== "auto") return clean(new TextDecoder(enc).decode(bytes));
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return clean(new TextDecoder("utf-16le").decode(bytes));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return clean(new TextDecoder("utf-16be").decode(bytes));
    try { return clean(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {}
    let best = "windows-1252", bestScore = -1;
    let outsideHebrew = 0;
    for (const b of bytes) if (b >= 0xC0 && (b < 0xE0 || b > 0xFA)) outsideHebrew++;
    const LATIN = new Set(["windows-1252", "windows-1250", "windows-1254"]);
    for (const [name, letters] of LEGACY) {
      const text = new TextDecoder(name).decode(bytes);
      let score = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch <= "\u007f") continue;
        // Letters are listed most-common first, so common letters count more
        const pos = letters.indexOf(ch);
        if (pos >= 0) score += 1 + (letters.length - pos) / letters.length;
        // Non-Latin scripts don't sit inside Latin words ("Cafй" means the guess is wrong)
        if (!LATIN.has(name) && (/[A-Za-z]/.test(text[i - 1] || "") || /[A-Za-z]/.test(text[i + 1] || ""))) score -= 2;
      }
      // Hebrew text only uses bytes E0–FA; Russian also uses capitals (C0–DF) and ы ь э ю я (FB–FF)
      if (name === "windows-1255" && outsideHebrew === 0) score *= 1.5;
      if (name === "windows-1251" && outsideHebrew === 0) score *= 0.5;
      if (score > bestScore) { best = name; bestScore = score; }
    }
    return clean(new TextDecoder(best).decode(bytes));
  }

  function parseTime(s) {
    if (!s) return NaN;
    const parts = s.trim().replace(",", ".").split(":").map(Number);
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return sec;
  }

  function cleanText(t) {
    return t
      .replace(/\{\\[^}]*\}/g, "")          // {\an8} style tags
      .replace(/<[^>]+>/g, "")              // <i>, <b>, <font>, <c.color>, <v Name>
      .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  }

  const TIMING = /((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)/;

  function parseSrtVtt(text) {
    const out = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = TIMING.exec(lines[i]);
      if (!m) continue;
      const buf = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && !TIMING.test(lines[j])) buf.push(lines[j++]);
      // Files without blank lines: drop the next cue's number that got swallowed
      if (j < lines.length && TIMING.test(lines[j]) && buf.length && /^\d+$/.test(buf[buf.length - 1].trim())) buf.pop();
      i = j - 1;
      const start = parseTime(m[1]), end = parseTime(m[2]);
      const t = cleanText(buf.join("\n"));
      if (t && isFinite(start) && isFinite(end) && end > start) out.push({ start, end, text: t });
    }
    return out;
  }

  function parseAss(text) {
    const out = [];
    let fmt = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    let inEvents = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
      if (!inEvents) continue;
      if (/^format\s*:/i.test(line)) {
        fmt = line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim().toLowerCase());
        continue;
      }
      if (!/^dialogue\s*:/i.test(line)) continue;
      let rest = line.slice(line.indexOf(":") + 1);
      const parts = [];
      for (let k = 0; k < fmt.length - 1; k++) {
        const c = rest.indexOf(",");
        if (c < 0) break;
        parts.push(rest.slice(0, c));
        rest = rest.slice(c + 1);
      }
      parts.push(rest);
      const get = (n) => parts[fmt.indexOf(n)];
      const start = parseTime(get("start")), end = parseTime(get("end"));
      const t = cleanText((get("text") || "")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N|\\n/g, "\n")
        .replace(/\\h/g, " "));
      if (t && isFinite(start) && isFinite(end) && end > start) out.push({ start, end, text: t });
    }
    return out;
  }

  function parse(text) {
    text = text.replace(/\r\n?/g, "\n");
    const isAss = /^\s*\[script info\]/im.test(text) || /^\s*dialogue\s*:/im.test(text);
    const cues = isAss ? parseAss(text) : parseSrtVtt(text);
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    // Drop exact duplicates (common in ASS files with multiple layers)
    return cues.filter((c, i) => !i || c.start !== cues[i - 1].start || c.text !== cues[i - 1].text);
  }

  function lastStartAtOrBefore(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Indexes of cues visible at time t (max 3)
  function activeAt(cues, t) {
    const out = [];
    const k = lastStartAtOrBefore(cues, t);
    for (let j = k; j >= 0 && k - j < 30; j--) if (cues[j].end > t) out.unshift(j);
    return out.slice(-3);
  }

  function nextIndex(cues, t) {
    const k = lastStartAtOrBefore(cues, t) + 1;
    return k < cues.length ? k : -1;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }

  return { decode, parse, activeAt, nextIndex, fmt };
})();
window.LiveSubsParser = LiveSubsParser;
