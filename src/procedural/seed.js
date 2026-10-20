// ============================================================
// DETERMINISTIC SEEDED RNG — Phase 7
//
// Shared across all procedural modules so the entire world is
// reproducible from one global seed. Each subsystem gets its own
// seed offset via the `fork(offset)` method.
//
// Uses mulberry32, same algorithm as buildings.js and citykit.js,
// so the procedural world is deterministic in the same sense the
// authored town is.
// ============================================================

/**
 * Create a seeded PRNG. If seed is undefined or null, uses
 * Math.random (for ad-hoc use; the procedural system always
 * passes an explicit seed).
 */
export function createRNG(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Uniform [0, 1) */
    next,
    /** Uniform [lo, hi) */
    range(lo, hi) { return lo + next() * (hi - lo); },
    /** Integer [lo, hi] inclusive */
    int(lo, hi) { return Math.floor(lo + next() * (hi - lo + 1)); },
    /** Pick a random element from an array */
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    /** Shuffle array in place (Fisher-Yates) */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    /** Normal-distribution approximation (Box-Muller) */
    gaussian() {
      const u = 1 - next();
      const v = 1 - next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** Return a new RNG with its own stream, offset from this one */
    fork(offset) {
      for (let i = 0; i < Math.abs(offset || 0) % 20; i++) next();
      return createRNG((a * 9301 + 49297) & 0x7fffffff);
    },
  };
}

/**
 * Deterministic hash from two integers, useful for per-chunk
 * seeding without needing a full RNG.
 */
export function hash2(x, y) {
  let h = Math.imul(x ^ y, 0x9E3779B9);
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Simple 2D value noise for organic boundary perturbation.
 * Deterministic — uses hash2 internally.
 */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const smoothX = xf * xf * (3 - 2 * xf);
  const smoothY = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a * (1 - smoothX) + b * smoothX) * (1 - smoothY)
       + (c * (1 - smoothX) + d * smoothX) * smoothY;
}

/**
 * fBm (fractal Brownian motion) on 2D noise.
 */
export function fbm2(x, y, octaves = 3, lacunarity = 2.0, gain = 0.5) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * noise2(x * f, y * f);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return v / norm;
}