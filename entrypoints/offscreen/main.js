import { browser } from "wxt/browser";
import { translateText } from "@/lib/translate";

// Captures tab audio, cuts it into short chunks, transcribes each chunk,
// optionally translates, and sends the text back to be shown on the page.

const CHUNK_MS = 5000;          // length of each audio piece sent for transcription
const SILENCE_RMS = 0.012;      // chunks quieter than this are skipped (saves API calls, avoids hallucinations)
const HALLUCINATIONS = /^(you|thank you\.?|thanks for watching!?|thank you for watching\.?|subtitles by .*|\.+|♪+)$/i;

let stream = null, audioCtx = null, analyser = null, levelTimer = null;
let running = false, settings = null, peak = 0, lastText = "";
let queue = Promise.resolve();

browser.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") startCapture(msg.streamId, msg.settings);
  if (msg.type === "stop") stopCapture();
  if (msg.type === "settings") settings = msg.settings;
});

function send(type, extra) {
  browser.runtime.sendMessage({ type, ...extra }).catch(() => {});
}

async function startCapture(streamId, s) {
  settings = s;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (e) {
    return send("error", { text: "Could not capture tab audio: " + e.message });
  }

  // Keep the video audible for the user (tab capture mutes it otherwise)
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  // Loudness meter used to skip silent chunks
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  levelTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    peak = Math.max(peak, Math.sqrt(sum / buf.length));
  }, 100);

  running = true;
  recordChunk();
}

function recordChunk() {
  if (!running || !stream) return;
  const parts = [];
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  peak = 0;
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.onstop = () => {
    const loud = peak >= SILENCE_RMS;
    recordChunk(); // start the next chunk right away
    if (loud && parts.length) {
      const blob = new Blob(parts, { type: "audio/webm" });
      queue = queue.then(() => handleChunk(blob)).catch(() => {});
    }
  };
  rec.start();
  setTimeout(() => rec.state === "recording" && rec.stop(), CHUNK_MS);
}

function stopCapture() {
  running = false;
  clearInterval(levelTimer);
  stream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  stream = audioCtx = analyser = null;
  lastText = "";
}

async function handleChunk(blob) {
  if (!running) return;
  let text;
  try {
    text = (await transcribe(blob)).trim();
  } catch (e) {
    return send("error", { text: e.message });
  }
  if (!text || HALLUCINATIONS.test(text)) return;
  lastText = text;

  let shown = text, original = null;
  if (settings.targetLang && settings.targetLang !== "none") {
    try {
      shown = await translateText(text, settings.targetLang);
      if (settings.showOriginal && shown !== text) original = text;
    } catch {
      shown = text; // fall back to original if translation fails
    }
  }
  if (running) send("subtitle", { text: shown, original });
}

async function transcribe(blob) {
  const openai = settings.provider === "openai";
  const url = openai
    ? "https://api.openai.com/v1/audio/transcriptions"
    : "https://api.groq.com/openai/v1/audio/transcriptions";
  const fd = new FormData();
  fd.append("file", blob, "audio.webm");
  fd.append("model", openai ? "whisper-1" : "whisper-large-v3-turbo");
  fd.append("response_format", "json");
  fd.append("temperature", "0");
  if (settings.sourceLang && settings.sourceLang !== "auto") {
    fd.append("language", settings.sourceLang.split("-")[0]);
  }
  if (lastText) fd.append("prompt", lastText.slice(-200)); // context helps continuity

  const res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + settings.apiKey }, body: fd });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    if (res.status === 401) throw new Error("API key rejected — check it in the extension popup.");
    if (res.status === 429) throw new Error("Rate limit reached — wait a moment.");
    throw new Error(`Transcription failed (${res.status}) ${detail}`);
  }
  return (await res.json()).text || "";
}

