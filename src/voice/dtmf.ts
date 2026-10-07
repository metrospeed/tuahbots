/**
 * Keypad tones as 8 kHz G.711 μ-law audio, for pressing menu options on calls
 * whose audio we stream ourselves (Twilio Media Streams cannot send DTMF).
 */
const RATE = 8000;
const TONES: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

/** Encode one 16-bit linear PCM sample as G.711 μ-law. */
export function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  s = Math.min(s, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function silence(ms: number): number[] {
  return new Array((RATE * ms) / 1000).fill(linearToMulaw(0));
}

/** Digits 0-9 * # play for 200 ms with 100 ms gaps; "w" pauses half a second. */
export function dtmfAudio(digits: string): Buffer {
  const out: number[] = [];
  for (const d of digits) {
    if (d === "w") {
      out.push(...silence(500));
      continue;
    }
    const tone = TONES[d];
    if (!tone) continue;
    const n = (RATE * 200) / 1000;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const v = 0.3 * Math.sin(2 * Math.PI * tone[0] * t) + 0.3 * Math.sin(2 * Math.PI * tone[1] * t);
      out.push(linearToMulaw(v * 32767));
    }
    out.push(...silence(100));
  }
  return Buffer.from(out);
}
