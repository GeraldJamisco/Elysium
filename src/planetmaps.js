import * as THREE from 'three';
import {
  toVec, sampleAll, SETTLEMENT, settlementDistanceDeg, roadDistanceDeg,
} from './world.js';

// ============================================================
// AMARINE — SURFACE MAPS (Phase 5A / 5B)
//
// Builds three equirectangular maps from the geography model:
//
//   albedo   surface colour
//   data     R = water mask, G = night lights, B = ice/snow
//
// PERFORMANCE
// The geography field costs roughly 200 noise lookups per sample.
// Evaluating it per texel of a 1024x1024 map takes over six
// seconds, which is not something to spend at page load.  So the
// field is evaluated on a COARSE grid and bilinearly upsampled,
// with a cheap high-frequency term added back before the
// land/sea threshold so coastlines stay crisp at output
// resolution rather than turning to fudge.
//
// This is the right trade at orbit distance: the planet subtends
// roughly 500 px, so the map only needs about one texel per
// pixel, and the large forms — which is what the eye reads from
// space — come entirely from the coarse field.
// ============================================================

const OUT_W = 1024, OUT_H = 512;     // output map resolution
const FIELD_W = 400, FIELD_H = 200;  // geography evaluation grid

// ---- Palette ----
// Amarine is a green, livable world: the land ramp runs from a warm
// dry grassland to a deep temperate forest, with rock and snow only
// where the mountains actually rise.
const COL = {
  // Ocean is most of the planet, so its value sets how bright the whole
  // world reads. Pitched too dark, the lit hemisphere looks like it is
  // already half in shadow.
  oceanDeep:   [34, 76, 110],
  oceanMid:    [48, 108, 142],
  oceanShelf:  [62, 138, 156],
  shallows:    [116, 184, 182],
  strand:      [201, 188, 152],
  // A wide spread from open grassland to closed forest: one flat green
  // over a whole continent gives the eye nothing to read.
  grassDry:    [176, 178, 108],
  grassWet:    [124, 162, 86],
  forest:      [76, 122, 66],
  forestDeep:  [48, 88, 52],
  upland:      [128, 130, 100],
  rock:        [128, 124, 106],
  scree:       [152, 149, 141],
  snow:        [216, 222, 222],
  ice:         [214, 228, 232],
  // Worked land around the settlement: more uniform and a shade warmer
  // than wild ground, which is how cultivation reads from orbit.
  cultivated:  [150, 162, 100],
  township:    [172, 170, 148],
};

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// Cheap hash noise for the detail term added on upsample.
function h2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}

function fbm2(x, y, oct = 3) {
  let v = 0, amp = 1, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { v += amp * vnoise2(x * f, y * f); n += amp; amp *= 0.5; f *= 2.13; }
  return v / n * 2 - 1;
}

/** Bilinear sample of a coarse field, wrapping in longitude. */
function bilerp(field, w, h, u, v) {
  const fx = u * w - 0.5, fy = v * h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % w) + w) % w, xb = ((x0 + 1) % w + w) % w;
  const ya = Math.max(0, Math.min(h - 1, y0)), yb = Math.max(0, Math.min(h - 1, y0 + 1));
  const p00 = field[ya * w + xa], p10 = field[ya * w + xb];
  const p01 = field[yb * w + xa], p11 = field[yb * w + xb];
  return (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
}

let _cache = null;

/**
 * Build (and cache) Amarine's surface maps.
 * @returns {{albedo: THREE.CanvasTexture, data: THREE.CanvasTexture, stats: object}}
 */
export function planetMaps() {
  if (_cache) return _cache;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ---- 1. Geography on the coarse grid ----
  const N = FIELD_W * FIELD_H;
  const fElev = new Float32Array(N);
  const fMoist = new Float32Array(N);
  const fMass = new Float32Array(N);
  for (let y = 0; y < FIELD_H; y++) {
    const lat = 90 - (y + 0.5) / FIELD_H * 180;
    for (let x = 0; x < FIELD_W; x++) {
      const lon = -180 + (x + 0.5) / FIELD_W * 360;
      const s = sampleAll(toVec(lat, lon));
      const i = y * FIELD_W + x;
      fElev[i] = s.elev; fMoist[i] = s.moist; fMass[i] = s.mass;
    }
  }

  // ---- 2. Compose the output maps ----
  const albCanvas = document.createElement('canvas');
  albCanvas.width = OUT_W; albCanvas.height = OUT_H;
  const albCtx = albCanvas.getContext('2d');
  const albImg = albCtx.createImageData(OUT_W, OUT_H);
  const A = albImg.data;

  const datCanvas = document.createElement('canvas');
  datCanvas.width = OUT_W; datCanvas.height = OUT_H;
  const datCtx = datCanvas.getContext('2d');
  const datImg = datCtx.createImageData(OUT_W, OUT_H);
  const D = datImg.data;

  let landTexels = 0, weighted = 0, landWeighted = 0;

  for (let y = 0; y < OUT_H; y++) {
    const v = (y + 0.5) / OUT_H;
    const lat = 90 - v * 180;
    const latAbs = Math.abs(lat);
    const cosLat = Math.cos(lat * Math.PI / 180);

    for (let x = 0; x < OUT_W; x++) {
      const u = (x + 0.5) / OUT_W;
      const lon = -180 + u * 360;
      const i = (y * OUT_W + x) * 4;

      // Coarse field, plus a high-frequency term that re-roughens the
      // coastline at output resolution. Without it, upsampling turns
      // every shore into a soft gradient.
      const nx = x * 0.055, ny = y * 0.055;
      const detail = fbm2(nx, ny, 3) * 0.035 * (0.35 + 0.65 * cosLat);
      let elev = bilerp(fElev, FIELD_W, FIELD_H, u, v) + detail;
      const moist = bilerp(fMoist, FIELD_W, FIELD_H, u, v) + fbm2(nx * 0.5 + 40, ny * 0.5, 2) * 0.10;
      const mass = bilerp(fMass, FIELD_W, FIELD_H, u, v);

      // Ice caps, with a noisy edge so the boundary is not a latitude line.
      const iceEdge = 68 + fbm2(nx * 0.35, ny * 0.35 + 80, 2) * 9;
      const ice = Math.max(0, Math.min(1, (latAbs - iceEdge) / 7));

      let col;
      let water = 0;
      let snow = 0;

      if (elev <= 0) {
        water = 1;
        // Depth is read from the CONTINENTAL MASS, not from the noisy
        // elevation: that is what gives every coast a clean shelf
        // instead of a scatter of random light patches mid-ocean.
        const byMass = Math.max(0, Math.min(1, mass / 0.34));
        const byDepth = Math.max(0, Math.min(1, (elev + 0.24) / 0.24));
        const shelf = Math.max(byMass, byDepth);
        const near = Math.max(0, Math.min(1, (elev + 0.07) / 0.07));
        col = mix(COL.oceanDeep, COL.oceanMid, Math.max(Math.min(1, mass / 0.12), byDepth * 0.9));
        col = mix(col, COL.oceanShelf, shelf * shelf * 0.80);
        col = mix(col, COL.shallows, shelf * near * near * 0.75);
      } else {
        // ---- Land ----
        const m = Math.max(0, Math.min(1, moist));
        // Base vegetation by moisture
        const mm = Math.max(0, Math.min(1, (m - 0.34) * 1.9));
        let g = mix(COL.grassDry, COL.grassWet, Math.min(1, mm * 1.7));
        g = mix(g, COL.forest, Math.max(0, (mm - 0.42) * 1.9));
        g = mix(g, COL.forestDeep, Math.max(0, (mm - 0.72) * 2.6));

        // Strand: a narrow warm fringe at the waterline
        const strand = Math.max(0, 1 - elev / 0.030);
        g = mix(g, COL.strand, strand * 0.75);

        // Relief: grassland gives way to upland, rock, then scree.
        // Thresholds track the measured elevation distribution — most land
        // sits under 0.30, so the rock bands start where mountains actually
        // are rather than across every continental interior.
        g = mix(g, COL.upland, Math.max(0, Math.min(1, (elev - 0.24) / 0.13)));
        g = mix(g, COL.rock, Math.max(0, Math.min(1, (elev - 0.37) / 0.13)));
        g = mix(g, COL.scree, Math.max(0, Math.min(1, (elev - 0.50) / 0.12)));

        // Snowline drops toward the poles
        const snowAt = 0.62 - Math.max(0, (latAbs - 30)) * 0.0058;
        snow = Math.max(0, Math.min(1, (elev - snowAt) / 0.13));
        g = mix(g, COL.snow, snow);

        // Poleward cooling: colour drifts grey-green before the ice starts
        const cold = Math.max(0, Math.min(1, (latAbs - 46) / 26));
        g = mix(g, [136, 148, 138], cold * 0.45);

        col = g;
        landTexels++;
      }

      col = mix(col, COL.ice, ice);
      if (ice > 0.5) water = 0;
      snow = Math.max(snow, ice);

      // ---- Settlement region (Phase 5B) ----
      // Only Veridian Cap is inhabited, so this treatment appears exactly
      // once on the whole planet. That scarcity is what makes it read as
      // a place rather than as texture.
      let lights = 0;
      if (elev > 0 && ice < 0.5) {
        const p = toVec(lat, lon);
        const dist = settlementDistanceDeg(p);
        const wobble = 1 + fbm2(nx * 0.9 + 61, ny * 0.9, 3) * 0.42;
        const reach = SETTLEMENT.cultivatedDeg * wobble;
        if (dist < reach) {
          // Worked land: more uniform and a touch warmer than wild ground.
          const t = 1 - dist / reach;
          const edge = t * t * (3 - 2 * t);
          const grain = 0.62 + 0.38 * (fbm2(nx * 2.4 + 7, ny * 2.4, 3) * 0.5 + 0.5);
          col = mix(col, COL.cultivated, edge * 0.58 * grain);
        }
        if (dist < SETTLEMENT.coreDeg) {
          // The built-up area itself.
          const t = 1 - dist / SETTLEMENT.coreDeg;
          col = mix(col, COL.township, Math.min(1, t * 1.6) * 0.85);
        }
        // Night lights: a compact cluster, plus a thread along the road
        // out of town. Restraint matters here — a sprawl of light would
        // contradict a settlement the player walks across in a minute.
        const core = Math.exp(-(dist * dist) / (2 * 0.95 * 0.95));
        const halo = Math.exp(-(dist * dist) / (2 * 2.6 * 2.6)) * 0.30;
        const rd = roadDistanceDeg(p);
        const road = rd < 0.9 ? Math.exp(-(rd * rd) / 0.32) * 0.34
                                 * Math.max(0, 1 - dist / SETTLEMENT.roadDeg) : 0;
        lights = Math.min(1, core + halo + road);
      }

      A[i] = col[0]; A[i + 1] = col[1]; A[i + 2] = col[2]; A[i + 3] = 255;
      D[i] = Math.round(water * 255);
      D[i + 1] = Math.round(lights * 255);
      D[i + 2] = Math.round(Math.min(1, snow) * 255);
      D[i + 3] = 255;

      weighted += cosLat;
      if (elev > 0) landWeighted += cosLat;
    }
  }

  albCtx.putImageData(albImg, 0, 0);
  datCtx.putImageData(datImg, 0, 0);

  const albedo = new THREE.CanvasTexture(albCanvas);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.anisotropy = 8;

  const data = new THREE.CanvasTexture(datCanvas);
  data.colorSpace = THREE.NoColorSpace;   // mask data, never colour-managed
  data.wrapS = THREE.RepeatWrapping;

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  _cache = {
    albedo, data,
    stats: {
      ms: Math.round(t1 - t0),
      landPercent: +(landWeighted / weighted * 100).toFixed(1),
      landTexels,
      settlement: { lat: +SETTLEMENT.lat.toFixed(2), lon: +SETTLEMENT.lon.toFixed(2) },
    },
  };
  return _cache;
}
