/**
 * The ka-ching and the chime, synthesised with Web Audio: no audio file, no network, a few
 * milliseconds to build. The ka-ching is coins dropping into a box: a dull thunk as the first
 * coin hits the bottom, then short metallic clinks that bounce faster and quieter as the coins
 * settle. Every timing and pitch comes from a fixed table, so it sounds the same every time.
 * Played only after a tap (browsers allow sound then) and only when Sounds is on.
 */
import type { Sound } from "./catalog.ts";

type Ctx = AudioContext;
let ctx: Ctx | null = null;

function audio(): Ctx | null {
  if (ctx) return ctx;
  const AC =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}

/** A burst of fixed pseudo-noise (xorshift, not Math.random) shaped by a filter. */
function noise(
  c: Ctx,
  at: number,
  seconds: number,
  type: BiquadFilterType,
  freq: number,
  level: number,
): void {
  const length = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  let x = 0x2545f491;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = ((x >>> 0) / 0xffffffff - 0.5) * (1 - i / length) ** 2;
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = level;
  src.connect(filter).connect(g).connect(c.destination);
  src.start(at);
}

/** One struck metal piece: inharmonic partials (a small disc rings at these ratios), fast decay. */
function ring(
  c: Ctx,
  at: number,
  base: number,
  ratios: number[],
  level: number,
  decay: number,
): void {
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(level, at + 0.002);
  out.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  out.connect(c.destination);
  ratios.forEach((ratio, i) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base * ratio, at);
    g.gain.value = 1 / (i + 1);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  });
}

/** The box: a short low knock with a falling pitch, and a muffled tap of air. */
function thunk(c: Ctx, at: number, level: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(190, at);
  osc.frequency.exponentialRampToValueAtTime(95, at + 0.12);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
  osc.connect(g).connect(c.destination);
  osc.start(at);
  osc.stop(at + 0.2);
  noise(c, at, 0.05, "lowpass", 700, level * 0.8);
}

const COIN = [1, 2.32, 4.25, 6.63];
// [delay after the first hit (s), coin pitch (Hz), loudness, ring time (s), box thunk?]
const DROP: Array<[number, number, number, number, boolean]> = [
  [0, 3150, 0.2, 0.22, true],
  [0.075, 3560, 0.16, 0.18, true],
  [0.13, 2980, 0.13, 0.16, false],
  [0.175, 3720, 0.11, 0.14, false],
  [0.21, 3330, 0.08, 0.12, false],
  [0.235, 3610, 0.06, 0.1, false],
  [0.255, 3420, 0.04, 0.09, false],
];

export function playSound(sound: Sound): void {
  if (sound === "none") return;
  const c = audio();
  if (!c) return;
  void c.resume?.();
  const t = c.currentTime + 0.01;
  if (sound === "kaching") {
    for (const [delay, pitch, level, decay, box] of DROP) {
      noise(c, t + delay, 0.008, "bandpass", 5200, level * 1.4); // the tick of contact
      ring(c, t + delay, pitch, COIN, level, decay);
      if (box) thunk(c, t + delay, level * 1.6);
    }
    noise(c, t + 0.27, 0.12, "bandpass", 4200, 0.04); // coins settling against each other
  } else {
    ring(c, t, 1319, [1, 1.5, 2], 0.14, 0.6);
  }
}
