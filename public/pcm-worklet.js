// Runs on the audio thread: mixes the tab audio to mono and posts it to the offscreen page
// in blocks of 2048 samples (~43 ms at 48 kHz), so the page can cut chunks at exact sample positions.
// Plain JS in public/: extension pages only allow worklet modules loaded from the extension's own files.
const BLOCK = 2048;

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.len = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const n = channels[0].length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i];
      this.buf[this.len++] = s / channels.length;
      if (this.len === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTap);
