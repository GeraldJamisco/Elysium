import * as THREE from 'three';

function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function rnd(seed) { let s = seed | 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ============================================================
// GROUND SURFACES — Phase 5C
//
// Every ground texture below is a SEAMLESS tile with a declared
// world size (TILE_M).  Callers scale UVs by world extent / tile
// size, so a 200 m avenue and a 2 m stoop get the same grain.
// Previously one unscaled tile was stretched across each surface,
// which is why the roads read as painted rather than paved.
// ============================================================

// The plain tiles under everything the procedural layer has not reached.
// At 300 m it repeated ten times across the 3 km plate and the repeat was
// plainly visible from Eagle as a grid; at 850 it repeats three times and
// reads as ground.
export const TILE_M = { asphalt: 5, paving: 2, grass: 6, parkPath: 3, plain: 850 };

function finish(c, aniso) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso || 8;
  return t;
}

// ---- Asphalt: cool dark aggregate, gently patchy ----
export function asphaltTex(seed = 19) {
  const w = 256, h = 256, c = cv(w, h), g = c.getContext('2d');
  const r = rnd(seed);
  g.fillStyle = '#4a4e50'; g.fillRect(0, 0, w, h);
  // Broad tonal patches — repair scars and wear, kept low-contrast.
  for (let i = 0; i < 26; i++) {
    const x = r() * w, y = r() * h, rad = 22 + r() * 60;
    const v = r() > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${0.012 + r() * 0.022})`;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  // Aggregate
  for (let i = 0; i < 14000; i++) {
    const t = r();
    g.fillStyle = t > 0.55
      ? `rgba(158,163,166,${0.05 + r() * 0.16})`
      : `rgba(18,20,22,${0.05 + r() * 0.18})`;
    g.fillRect(Math.floor(r() * w), Math.floor(r() * h), 1, 1);
  }
  return finish(c);
}

// ---- Sidewalk paving: 1 m slabs with scored joints ----
export function pavingTex(seed = 11) {
  const w = 256, h = 256, c = cv(w, h), g = c.getContext('2d');
  const r = rnd(seed);
  const n = 2;                       // slabs per tile edge (tile = 2 m)
  const s = w / n;
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const v = 188 + Math.floor(r() * 16);
    g.fillStyle = `rgb(${v + 8},${v + 3},${v - 12})`;
    g.fillRect(ix * s, iy * s, s, s);
  }
  // Grain
  for (let i = 0; i < 9000; i++) {
    const t = r();
    g.fillStyle = t > 0.5
      ? `rgba(255,252,244,${0.04 + r() * 0.10})`
      : `rgba(96,92,82,${0.03 + r() * 0.09})`;
    g.fillRect(Math.floor(r() * w), Math.floor(r() * h), 1, 1);
  }
  // Joints: a dark line with a light nosing, so slabs read in raking light.
  g.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    const o = i * s;
    g.strokeStyle = 'rgba(74,70,62,0.55)';
    g.beginPath(); g.moveTo(o, 0); g.lineTo(o, h); g.moveTo(0, o); g.lineTo(w, o); g.stroke();
    g.strokeStyle = 'rgba(255,252,242,0.28)';
    g.beginPath(); g.moveTo(o + 2, 0); g.lineTo(o + 2, h); g.moveTo(0, o + 2); g.lineTo(w, o + 2); g.stroke();
  }
  return finish(c);
}

// ---- Park path: warm bound gravel ----
export function parkPathTex(seed = 31) {
  const w = 256, h = 256, c = cv(w, h), g = c.getContext('2d');
  const r = rnd(seed);
  g.fillStyle = '#b7a98c'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 16000; i++) {
    const t = r();
    g.fillStyle = t > 0.5
      ? `rgba(214,204,180,${0.08 + r() * 0.18})`
      : `rgba(118,106,84,${0.06 + r() * 0.16})`;
    const sz = r() > 0.85 ? 2 : 1;
    g.fillRect(Math.floor(r() * w), Math.floor(r() * h), sz, sz);
  }
  return finish(c);
}

// ---- Open country beyond the settlement ----
export function plainTex(seed = 61) {
  const w = 256, h = 256, c = cv(w, h), g = c.getContext('2d');
  const r = rnd(seed);
  g.fillStyle = '#6f9553'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 220; i++) {
    const x = r() * w, y = r() * h, rad = 18 + r() * 86;
    const warm = r() > 0.5;
    g.fillStyle = warm
      ? 'rgba(150,166,96,' + (0.05 + r() * 0.09) + ')'
      : 'rgba(78,112,62,' + (0.05 + r() * 0.10) + ')';
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = 'rgba(0,0,0,' + (0.01 + r() * 0.02) + ')';
    g.fillRect(Math.floor(r() * w), Math.floor(r() * h), 2, 2);
  }
  return finish(c, 4);
}

// ---- Lawn: two-tone, clumped, with a faint mown direction ----
export function grassTex(seed = 3) {
  const w = 256, h = 256, c = cv(w, h), g = c.getContext('2d');
  const r = rnd(seed);
  g.fillStyle = '#6f9553'; g.fillRect(0, 0, w, h);
  // Clumps give the lawn a scale; a flat green plane has none.
  for (let i = 0; i < 260; i++) {
    const x = r() * w, y = r() * h, rad = 6 + r() * 26;
    const lighter = r() > 0.5;
    g.fillStyle = lighter
      ? `rgba(146,176,102,${0.10 + r() * 0.16})`
      : `rgba(70,104,58,${0.10 + r() * 0.18})`;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 16000; i++) {
    const t = r();
    g.fillStyle = t > 0.5
      ? `rgba(150,184,104,${0.10 + r() * 0.22})`
      : `rgba(62,96,52,${0.10 + r() * 0.22})`;
    g.fillRect(Math.floor(r() * w), Math.floor(r() * h), 1, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.022)';
  for (let y = 0; y < h; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  return finish(c);
}

// ---- Globe: ocean, continents, coastlines, biolum ----
export function globeTex(seed = 83) {
  const w = 1024, h = 512, c = cv(w, h), g = c.getContext('2d', { willReadFrequently: true });
  const r = rnd(seed);

  // Ocean base
  g.fillStyle = '#1a3840'; g.fillRect(0, 0, w, h);

  // Fractal noise: more octaves for sharp land/ocean separation
  function fbm(x, y, o) {
    let v = 0, a = 1, f = 1;
    for (let i = 0; i < o; i++) { v += a * Math.sin(x * f * 0.025) * Math.cos(y * f * 0.03 + i * 3.7); a *= 0.5; f *= 2.3; }
    return v;
  }

  // Land mask fill
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = fbm(x, y, 7);
    const rv = Math.sin(x * 0.005) * 0.06 + Math.cos(y * 0.01) * 0.05 + 0.12;
    if (n > rv) {
      const v = Math.min(1, (n - rv) * 2.0);
      g.fillStyle = `rgb(${80 + 80 * v | 0},${120 + 70 * v | 0},${60 + 40 * v | 0})`;
      g.fillRect(x, y, 1, 1);
    }
  }

  // Coastlines: thin bright edge at land/water boundary
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const px = g.getImageData(x, y, 1, 1).data;
    if (px[1] > 90) {
      const l = g.getImageData(x - 1, y, 3, 1).data;
      const isCoast = (l[1] <= 90 || l[5] <= 90);
      if (isCoast && px[1] > 130) {
        g.fillStyle = `rgba(120,200,160,${0.25 + Math.random() * 0.15})`;
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  // Biolum dots on land
  for (let i = 0; i < 2000; i++) {
    const x = Math.floor(r() * w), y = Math.floor(r() * h);
    const px = g.getImageData(x, y, 1, 1).data;
    if (px[1] > 120) { g.fillStyle = `rgba(80,255,200,${0.1 + r() * 0.3})`; g.fillRect(x, y, 2, 2); }
  }

  // Subtle grid lines (longitude/latitude)
  g.strokeStyle = 'rgba(80,200,160,0.02)';
  for (let x = 0; x <= w; x += w / 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y <= h; y += h / 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}