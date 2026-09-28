// Keeps transcription requests inside the provider's rate limits (a token bucket).
//
// Groq's free tier allows 20 requests/minute and 7,200 audio-seconds/hour, and bills every request
// as at least 10 seconds of audio: in practice about 12 requests a minute, sustained.
// Going over means "rate limit" errors and missing subtitles, so we pace ourselves instead.

export interface BudgetOptions {
  perMinute: number; // sustained rate
  burst: number;     // requests that may go out back to back (e.g. after a silence)
}

export const PROVIDER_BUDGETS = {
  groq: { perMinute: 11, burst: 3 },
  openai: { perMinute: 45, burst: 5 }
} as const satisfies Record<string, BudgetOptions>;

export class RateBudget {
  private readonly opts: BudgetOptions;
  private tokens: number;
  private last: number;
  private readonly refillPerMs: number;

  constructor(opts: BudgetOptions, now: number) {
    this.opts = opts;
    this.tokens = opts.burst;
    this.last = now;
    this.refillPerMs = opts.perMinute / 60000;
  }

  private refill(now: number) {
    this.tokens = Math.min(this.opts.burst, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }

  // Requests that could go out right now
  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  spend(now: number): void {
    this.refill(now);
    this.tokens -= 1;
  }

  // Milliseconds until one more request is allowed
  waitMs(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
  }
}
