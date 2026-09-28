// Finds the video the user is most likely watching: the biggest one, preferring one that plays.
const MIN_AREA = 40000; // ignore thumbnails and previews (about 200×200 px)

export function findMainVideo(doc: Document = document): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null, bestScore = 0;
  for (const v of doc.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (area < MIN_AREA) continue;
    const score = area * (v.paused ? 1 : 2);
    if (score > bestScore) { best = v; bestScore = score; }
  }
  return best;
}
