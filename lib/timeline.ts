// Live subtitles of one video, kept by video time (in memory only).
// Remembers which parts of the video were already transcribed, so rewinding
// shows the lines again at the right moment without sending that audio again.
import * as P from "./subparse";

export interface TimedCue extends P.Cue {
  translations: Map<string, string>; // language code → translated text
}

const SLACK = 0.3; // seconds of tolerance when checking coverage

export class Timeline {
  readonly cues: TimedCue[] = [];            // sorted by start
  private covered: [number, number][] = [];  // merged, sorted ranges already handled

  // Adds a transcribed line and marks its range as handled. Returns the stored cue.
  add(start: number, end: number, text: string): TimedCue {
    this.cover(start, end);
    // The same range transcribed twice (e.g. two chunks in flight over a rewind): keep the first
    const same = this.cues.find((c) => Math.abs(c.start - start) < SLACK && c.text === text);
    if (same) return same;
    const cue: TimedCue = { start, end, text, translations: new Map() };
    let i = this.cues.length;
    while (i > 0 && this.cues[i - 1]!.start > start) i--;
    this.cues.splice(i, 0, cue);
    return cue;
  }

  // Marks a range as handled (also used for silent stretches that have no text)
  cover(start: number, end: number): void {
    if (!(end > start)) return;
    const merged: [number, number][] = [];
    let a = start, b = end;
    for (const [s, e] of this.covered) {
      if (e < a - SLACK || s > b + SLACK) merged.push([s, e]);
      else { a = Math.min(a, s); b = Math.max(b, e); }
    }
    merged.push([a, b]);
    merged.sort((x, y) => x[0] - y[0]);
    this.covered = merged;
  }

  // True if [start, end] was already handled, give or take SLACK at each end
  isCovered(start: number, end: number): boolean {
    return this.covered.some(([s, e]) => s <= start + SLACK && e >= end - SLACK);
  }

  // Indexes of the cues on screen at time t
  activeAt(t: number): number[] {
    return P.activeAt(this.cues, t);
  }

  nextIndex(t: number): number {
    return P.nextIndex(this.cues, t);
  }

  clear(): void {
    this.cues.length = 0;
    this.covered = [];
  }
}
