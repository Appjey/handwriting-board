/**
 * Deterministic PRNG (Mulberry32) + smooth 1D value noise
 * for reproducible yet organic human handwriting variations.
 */
export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 1337;
  }

  /** Returns float in [0, 1) */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns float in [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Approximate Gaussian N(0, 1) via Box-Muller */
  gaussian(): number {
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /** Returns true with probability p */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick random element */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/**
 * Smooth 1D value noise for hand tremor and baseline sway.
 */
export class Noise1D {
  private table: Float32Array;
  private mask = 255;

  constructor(rng: RNG) {
    this.table = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      this.table[i] = rng.range(-1, 1);
    }
  }

  sample(x: number): number {
    const xi = Math.floor(x);
    const xf = x - xi;
    const u = xf * xf * (3 - 2 * xf); // smoothstep
    const a = this.table[xi & this.mask];
    const b = this.table[(xi + 1) & this.mask];
    return a + (b - a) * u;
  }

  fbm(x: number, octaves = 3): number {
    let sum = 0;
    let amp = 0.6;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.sample(x * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }
}
