import { browser } from "wxt/browser";
import { translateText } from "@/lib/translate";
import { LIVE_DEFAULTS, type LiveSettings } from "@/lib/settings";
import { sendToBackground, type LiveTextMessage, type LiveTime, type LiveTiming, type OffscreenMessage } from "@/lib/messages";
import { Chunker, type Chunk } from "@/lib/chunker";
import { downsample, encodeWav } from "@/lib/wav";
import { PROVIDER_BUDGETS, RateBudget } from "@/lib/budget";

// Captures tab audio, cuts it into short chunks at pauses, and transcribes them (optionally translated).
// Each chunk is stamped with the video time it covers, so the page can keep the subtitles on the video's
// timeline: a rewind shows them again instantly, and audio that was already transcribed is never sent again.

const SILENCE_RMS = 0.012;      // quieter than this is silence (silent chunks are skipped: saves API calls, avoids hallucinations)
const HALLUCINATIONS = /^(you|thank you\.?|thanks for watching!?|thank you for watching\.?|subtitles by .*|\.+|♪+)$/i;
const MAX_IN_FLIGHT = 3;        // transcriptions running at the same time
const STALE_MS = 10000;         // chunks still waiting this long are dropped (they'd only show up late)
const JUMP_TOLERANCE = 0.75;    // seconds: more drift than this during a chunk means the video was seeked

// Transcription failure with the HTTP status (0 = network error)
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface Job { chunk: Chunk; rate: number; timing: LiveTiming | null; queuedAt: number }

let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let chunker: Chunker | null = null;
let running = false, settings: LiveSettings = LIVE_DEFAULTS, lastText = "";
let chunkStart: Promise<LiveTime | null> | null = null; // video time when the current chunk began
const waiting: Job[] = [];
let inFlight = 0, pumpTimer: ReturnType<typeof setTimeout> | undefined;
let budget = new RateBudget(PROVIDER_BUDGETS.groq, performance.now());
let backoffMs = 0, backoffUntil = 0, errorShown = false;
let output: GainNode | null = null, muted = false;
let boost = 1; // the video's volume was turned down: scale the audio back up for transcription

browser.runtime.onMessage.addListener((msg: OffscreenMessage | { target?: undefined }) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") startCapture(msg.streamId, msg.settings);
  if (msg.type === "stop") stopCapture();
  if (msg.type === "output") setMuted(msg.muted);
  if (msg.type === "settings") {
    if (msg.settings.provider !== settings.provider) budget = new RateBudget(PROVIDER_BUDGETS[msg.settings.provider], performance.now());
    settings = msg.settings;
  }
});

function send(msg: LiveTextMessage) {
  sendToBackground(msg).catch(() => {});
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Asks the frame playing the video for its current time; null when no video was found
function queryTime(from: number | null): Promise<LiveTime | null> {
  return sendToBackground<LiveTime | null>({ type: "live-time-query", from }).catch(() => null);
}

async function startCapture(streamId: string, s: LiveSettings) {
  settings = s;
  budget = new RateBudget(PROVIDER_BUDGETS[s.provider], performance.now());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Chrome's non-standard constraint for tab capture streams
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } as MediaTrackConstraints,
      video: false
    });
  } catch (e) {
    return send({ type: "error", text: "Could not capture tab audio: " + errorText(e) });
  }

  // Keep the video audible for the user (tab capture mutes it otherwise)
  audioCtx = new AudioContext();
  const ctx = audioCtx;
  const source = ctx.createMediaStreamSource(stream);
  output = ctx.createGain();
  output.gain.value = muted ? 0 : 1;
  source.connect(output).connect(ctx.destination);

  // Raw samples from the audio thread, cut into chunks with no gaps between them
  await ctx.audioWorklet.addModule(browser.runtime.getURL("/pcm-worklet.js"));
  const tap = new AudioWorkletNode(ctx, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1 });
  const mute = ctx.createGain();
  mute.gain.value = 0; // the worklet only runs while connected to the output; keep it silent
  source.connect(tap).connect(mute).connect(ctx.destination);
  chunker = new Chunker({ sampleRate: ctx.sampleRate, silenceRms: SILENCE_RMS });
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data, ctx.sampleRate);

  running = true;
}

function stopCapture() {
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  stream = audioCtx = chunker = null;
  chunkStart = null;
  waiting.length = 0;
  clearTimeout(pumpTimer);
  pumpTimer = undefined;
  lastText = "";
  backoffMs = backoffUntil = 0;
  output = null;
  muted = false;
  boost = 1;
  errorShown = false;
}

// What you hear. The captured audio is not affected, so the subtitles keep going while muted.
function setMuted(m: boolean) {
  muted = m;
  if (output) output.gain.value = m ? 0 : 1;
}

function onBlock(block: Float32Array, rate: number) {
  if (!running || !chunker) return;
  if (boost !== 1) for (let i = 0; i < block.length; i++) block[i]! *= boost;
  if (!chunker.started) chunkStart = queryTime(null);
  // Only cut speech into a new request when the rate limit has one to spare (queued ones count)
  const canSend = budget.available(performance.now()) - waiting.length >= 1;
  const chunk = chunker.push(block, canSend);
  if (!chunk) return;
  const start = chunkStart;
  chunkStart = null;
  finishChunk(chunk, rate, start).catch(() => {});
}

// Works out which stretch of the video a chunk covers, then queues it (or skips it)
async function finishChunk(chunk: Chunk, rate: number, start: Promise<LiveTime | null> | null) {
  const s = start && (await start);
  // Up to 20× louder when the player's volume is low, so quiet speech is still heard
  boost = s ? Math.min(20, 1 / Math.max(0.05, s.volume)) : 1;
  if (!s) {
    // No video found (audio-only page, or a player we can't see): just show the text when it's ready
    if (chunk.loud) enqueue({ chunk, rate, timing: null, queuedAt: performance.now() });
    return;
  }
  const e = await queryTime(s.t);
  // The video changed, paused, or was seeked while this chunk was recorded: its timing is unknown
  if (!e || e.videoKey !== s.videoKey || s.paused || e.paused) return;
  const length = chunk.seconds * s.rate;
  if (Math.abs(e.t - s.t - length) > JUMP_TOLERANCE) return;

  const timing: LiveTiming = { videoKey: s.videoKey, start: s.t, end: s.t + length };
  if (e.covered) return; // already transcribed: the page shows it from its timeline
  if (!chunk.loud) return send({ type: "live-covered", timing });
  enqueue({ chunk, rate, timing, queuedAt: performance.now() });
}

// ---------- transcription queue: a few at once, within the rate limit, never a growing backlog ----------
function enqueue(job: Job) {
  waiting.push(job);
  pump();
}

function pump() {
  while (running && inFlight < MAX_IN_FLIGHT && waiting.length) {
    const now = performance.now();
    // Too old, or the provider asked us to slow down: drop it (a rewind will send it again)
    if (now - waiting[0]!.queuedAt > STALE_MS || now < backoffUntil) { waiting.shift(); continue; }
    // No request left this minute: try again when there is one
    const wait = budget.waitMs(now);
    if (wait > 0) {
      if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = undefined; pump(); }, wait);
      return;
    }
    budget.spend(now);
    const job = waiting.shift()!;
    inFlight++;
    handleJob(job).finally(() => { inFlight--; pump(); });
  }
}

async function handleJob({ chunk, rate, timing }: Job) {
  const blob = new Blob([encodeWav(downsample(chunk.samples, rate))], { type: "audio/wav" });
  let text: string;
  try {
    text = (await transcribe(blob)).trim();
    backoffMs = 0;
    errorShown = false;
  } catch (e) {
    return handleError(e);
  }
  if (!running) return;
  if (!text || HALLUCINATIONS.test(text)) {
    if (timing) send({ type: "live-covered", timing });
    return;
  }
  lastText = text;

  const lang = settings.targetLang;
  let translated: string | null = null;
  if (lang && lang !== "none") {
    try { translated = await translateText(text, lang); } catch {} // the page translates it later
  }
  if (running) send({ type: "subtitle", source: text, translated, lang, timing });
}

function handleError(e: unknown) {
  if (!running) return;
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 401) {
    send({ type: "error", text: errorText(e) });
    sendToBackground({ type: "stop" }).catch(() => {}); // no point listening with a rejected key
    return;
  }
  // Rate limits, server errors and network trouble: wait 1 s, 2 s, 4 s … (max 15 s) before sending more
  if (status === 429 || status >= 500 || status === 0) {
    backoffMs = Math.min(15000, backoffMs ? backoffMs * 2 : 1000);
    backoffUntil = performance.now() + backoffMs;
  }
  // Show each streak of errors once, not for every chunk
  if (!errorShown) send({ type: "error", text: errorText(e) });
  errorShown = true;
}

async function transcribe(blob: Blob): Promise<string> {
  const openai = settings.provider === "openai";
  const url = openai
    ? "https://api.openai.com/v1/audio/transcriptions"
    : "https://api.groq.com/openai/v1/audio/transcriptions";
  const fd = new FormData();
  fd.append("file", blob, "audio.wav");
  fd.append("model", openai ? "whisper-1" : "whisper-large-v3-turbo");
  fd.append("response_format", "json");
  fd.append("temperature", "0");
  if (settings.sourceLang && settings.sourceLang !== "auto") {
    fd.append("language", settings.sourceLang.split("-")[0]!);
  }
  if (lastText) fd.append("prompt", lastText.slice(-200)); // context helps continuity

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + settings.apiKey }, body: fd });
  } catch {
    throw new ApiError("Can't reach the speech service — check your connection.", 0);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message || ""; } catch {}
    if (res.status === 401) throw new ApiError("API key rejected — check it in the side panel.", 401);
    if (res.status === 429) throw new ApiError("Rate limit reached — slowing down for a moment.", 429);
    throw new ApiError(`Transcription failed (${res.status}) ${detail}`, res.status);
  }
  return ((await res.json()) as { text?: string }).text || "";
}
