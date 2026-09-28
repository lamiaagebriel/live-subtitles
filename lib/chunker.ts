// Cuts a stream of audio blocks into short chunks for transcription.
// A chunk ends at the first short pause once it is long enough, or at a soft limit,
// so words are rarely split and subtitles arrive a lot sooner than with fixed 5 s pieces.
// When the caller has no request to spare (rate limits), speech keeps collecting until it has,
// up to a hard cap; silent chunks can always be cut since they are never sent.
import { rms } from "./wav";

export interface ChunkerOptions {
  sampleRate: number;
  minSec?: number;     // don't cut before this, even at a pause
  maxSec?: number;     // cut here if a request is available
  capSec?: number;     // always cut here
  pauseSec?: number;   // this much quiet counts as a pause
  silenceRms?: number; // blocks quieter than this are "quiet"
  leadInSec?: number;  // after a hard cut, repeat this much audio at the start of the next chunk
}

export interface Chunk {
  samples: Float32Array; // at the input sample rate, lead-in included
  seconds: number;       // new audio in this chunk (lead-in not counted)
  loud: boolean;         // false = nothing but silence (no need to transcribe)
  hardCut: boolean;      // ended at maxSec rather than at a pause
}

export class Chunker {
  private readonly rate: number;
  private readonly minSec: number;
  private readonly maxSec: number;
  private readonly capSec: number;
  private readonly pauseSec: number;
  private readonly silenceRms: number;
  private readonly leadInSec: number;
  private blocks: Float32Array[] = [];
  private length = 0;
  private quiet = 0; // samples of quiet at the end of the current chunk
  private loud = false;
  private leadIn: Float32Array | null = null;

  constructor(o: ChunkerOptions) {
    this.rate = o.sampleRate;
    this.minSec = o.minSec ?? 1.5;
    this.maxSec = o.maxSec ?? 4;
    this.capSec = o.capSec ?? 12;
    this.pauseSec = o.pauseSec ?? 0.25;
    this.silenceRms = o.silenceRms ?? 0.012;
    this.leadInSec = o.leadInSec ?? 0.3;
  }

  // True while a chunk has begun but not been cut yet
  get started(): boolean {
    return this.length > 0;
  }

  // Adds one block; returns a finished chunk when this block completes one.
  // canSend: false while the rate limit has no request to spare.
  push(block: Float32Array, canSend = true): Chunk | null {
    this.blocks.push(block);
    this.length += block.length;
    if (rms(block) >= this.silenceRms) { this.loud = true; this.quiet = 0; } else this.quiet += block.length;

    const seconds = this.length / this.rate;
    const mayCut = canSend || !this.loud;
    const atPause = mayCut && seconds >= this.minSec && this.quiet >= this.pauseSec * this.rate;
    const hardCut = !atPause && ((mayCut && seconds >= this.maxSec) || seconds >= this.capSec);
    if (!atPause && !hardCut) return null;

    const own = concat(this.blocks, this.length);
    const samples = this.leadIn ? concat([this.leadIn, own], this.leadIn.length + own.length) : own;
    const chunk: Chunk = { samples, seconds, loud: this.loud, hardCut };
    // A hard cut may split a word: give the next chunk the tail of this one
    this.leadIn = hardCut ? own.slice(Math.max(0, own.length - Math.round(this.leadInSec * this.rate))) : null;
    this.blocks = [];
    this.length = 0;
    this.quiet = 0;
    this.loud = false;
    return chunk;
  }

  // Forget the audio in progress (e.g. after the video jumped)
  reset(): void {
    this.blocks = [];
    this.length = 0;
    this.quiet = 0;
    this.loud = false;
    this.leadIn = null;
  }
}

function concat(parts: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
