// A small seeded PRNG (mulberry32) so `npm run benchmark` is reproducible --
// the same seed always generates the same synthetic dataset, which is what
// makes benchmark-to-benchmark comparisons meaningful. This does NOT mean
// the measured results are hard-coded: the correlation engine still has to
// actually score and rank this generated data every time the script runs.
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randomFloat(rng: () => number, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[randomInt(rng, 0, items.length - 1)]!;
}

export function chance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

const HEX = "0123456789abcdef";

/** A 40-char string that looks like a git SHA-1 but is just RNG output -- uniqueness is all correlation needs. */
export function fakeSha(rng: () => number): string {
  let out = "";
  for (let i = 0; i < 40; i++) out += HEX[randomInt(rng, 0, 15)];
  return out;
}
