// Translation through Google Translate's free public endpoint.

export async function translateText(text, target) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl="
    + encodeURIComponent(target) + "&q=" + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error("translate " + res.status);
  const data = await res.json();
  return data[0].map((seg) => seg[0]).join("");
}

// Several lines in one request; falls back to one request per line if the line count doesn't match
export async function translateBatch(texts, target) {
  const flat = texts.map((t) => t.replace(/\s*\n\s*/g, " "));
  try {
    const parts = (await translateText(flat.join("\n"), target)).split("\n").map((s) => s.trim());
    if (parts.length === texts.length && parts.every(Boolean)) return parts;
  } catch {}
  return Promise.all(flat.map((t) => translateText(t, target).catch(() => t)));
}
