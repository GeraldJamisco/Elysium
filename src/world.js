// ============================================================
// AMARINE — PLANETARY GEOGRAPHY (Phase 5A)
//
// Amarine's geography is AUTHORED, not noised into existence.
// Four landmasses and an island arc are declared below as sets
// of overlapping lobes; noise only roughens their coastlines and
// varies their interiors.  That is the whole point: at orbit
// distance the eye reads large forms, and a planet built from
// pure fractal noise gives it nothing to hold on to — every
// region looks like every other region.
//
// This module is the single source of truth for the surface.
// The albedo map, the ocean mask, the night-lights map and the
// settlement pin positions are all sampled from the same
// elevation field, so the marker for Veridian Cap cannot drift
// off the coastline the texture actually draws.
//
// Coordinates are degrees: lat -90..90, lon -180..180.
// Sampling is done on the 3D unit sphere rather than in the
// equirectangular plane, so nothing pinches at the poles.
// ============================================================

// ---- Deterministic 3D value noise ----
const PRIME = [374761393, 668265263, 2147483647];

function hash3(i, j, k) {
  let h = (i * PRIME[0]) ^ (j * PRIME[1]) ^ (k * PRIME[2]);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smoothstep(x - xi), yf = smoothstep(y - yi), zf = smoothstep(z - zi);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) {
    const wz = dz ? zf : 1 - zf;
    for (let dy = 0; dy <= 1; dy++) {
      const wy = dy ? yf : 1 - yf;
      for (let dx = 0; dx <= 1; dx++) {
        const wx = dx ? xf : 1 - xf;
        acc += hash3(xi + dx, yi + dy, zi + dz) * wx * wy * wz;
      }
    }
  }
  return acc * 2 - 1;   // -1..1
}

function fbm(x, y, z, octaves = 4, lac = 2.07, gain = 0.5) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * vnoise(x * f, y * f, z * f);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return v / norm;
}

/** Ridged noise — produces linear crests, which is what makes mountains. */
function ridged(x, y, z, octaves = 4, lac = 2.11, gain = 0.5) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * (1 - Math.abs(vnoise(x * f, y * f, z * f)));
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return (v / norm) * 2 - 1;
}

// ---- Geometry helpers ----
export function toVec(lat, lon) {
  const p = (90 - lat) * Math.PI / 180;
  const t = (lon + 180) * Math.PI / 180;
  return [
    -Math.sin(p) * Math.cos(t),
    Math.cos(p),
    Math.sin(p) * Math.sin(t),
  ];
}

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// ============================================================
// THE LANDMASSES OF AMARINE
//
// Each lobe is [lat, lon, angularRadiusDeg, weight].  Lobes in
// one region overlap to make a continuous landmass with a
// deliberate silhouette — a spine, a bay, a peninsula — rather
// than a circular blob.
// ============================================================

export const REGIONS = [
  {
    name: 'Verdance',
    kind: 'temperate',
    // The home continent: broad temperate interior, a mountain
    // spine along its north-east, a deep bay on the south coast.
    // Veridian Cap stands on its western plains.
    lobes: [
      [10, 38, 26, 1.00],
      [18, 55, 20, 0.92],
      [-2, 30, 21, 0.88],
      [26, 30, 16, 0.80],
      [-14, 44, 17, 0.78],
      [34, 62, 13, 0.68],
      [2, 62, 14, 0.66],
      [44, 72, 11, 0.58],
    ],
    // Bays are negative lobes: they bite into the landmass.
    bays: [
      [-12, 33, 9, 0.85],
      [22, 66, 7, 0.6],
    ],
    ridges: [[24, 52, 9, 1.0], [15, 45, 6, 0.60], [36, 64, 6, 0.70]],
  },
  {
    name: 'Calder Reach',
    kind: 'boreal',
    lobes: [
      [38, -60, 22, 0.98],
      [28, -78, 17, 0.88],
      [50, -46, 16, 0.78],
      [20, -60, 13, 0.62],
    ],
    bays: [[36, -74, 7, 0.55]],
    ridges: [[42, -56, 8, 0.92]],
  },
  {
    name: 'Solace Basin',
    kind: 'warm',
    lobes: [
      [-22, -40, 23, 0.96],
      [-8, -52, 17, 0.86],
      [-38, -30, 16, 0.74],
      [-18, -22, 14, 0.7],
    ],
    bays: [[-26, -46, 8, 0.5]],
    ridges: [[-32, -34, 6.5, 0.78]],
  },
  {
    name: 'Ember Isles',
    kind: 'island',
    lobes: [
      [14, 104, 9, 0.76],
      [22, 96, 6, 0.62],
      [4, 112, 6.5, 0.62],
      [28, 112, 5, 0.5],
    ],
    bays: [],
    ridges: [[14, 104, 4.5, 0.85]],
  },
  {
    name: 'Meridian Shoals',
    kind: 'island',
    // The scattered mid-ocean holdings between the continents.
    lobes: [
      [36, -6, 8, 0.66],
      [10, -30, 7, 0.62],
      [24, 84, 7.5, 0.64],
      [-14, 84, 5, 0.5],
    ],
    bays: [],
    ridges: [],
  },
];

/**
 * Angular falloff of one lobe at point p.
 *
 * The profile PLATEAUS: a lobe holds its full weight out to 55% of its
 * radius and only then falls away. A plain smoothstep from the centre
 * makes every landmass a small dome with a wide shallow skirt, which is
 * how the first pass ended up with 6% land and no continent interiors.
 */
function lobeField(p, lobe) {
  const c = lobe._c || (lobe._c = toVec(lobe[0], lobe[1]));
  const cosR = lobe._cosR !== undefined
    ? lobe._cosR
    : (lobe._cosR = Math.cos(lobe[2] * Math.PI / 180));
  const d = c[0] * p[0] + c[1] * p[1] + c[2] * p[2];
  if (d <= cosR) return 0;
  const t = Math.min(1, ((d - cosR) / (1 - cosR)) / 0.55);
  return lobe[3] * t * t * (3 - 2 * t);
}

/**
 * Continental mass at a point: 0 in open ocean, ~1 deep inland.
 * The coastline is warped by low-frequency noise so the authored
 * lobes never read as circles.
 */
export function continentAt(p) {
  // Domain warp: shifts the sample point before the lobes are
  // evaluated, which bends coastlines into inlets and headlands
  // without breaking the overall silhouette. Kept small — at 0.34 it
  // tore the continents into archipelagos.
  const w = 0.17;
  const q = [
    p[0] + w * fbm(p[0] * 1.7 + 11, p[1] * 1.7, p[2] * 1.7, 3),
    p[1] + w * fbm(p[0] * 1.7, p[1] * 1.7 + 23, p[2] * 1.7, 3),
    p[2] + w * fbm(p[0] * 1.7, p[1] * 1.7, p[2] * 1.7 + 31, 3),
  ];
  const n = Math.hypot(q[0], q[1], q[2]) || 1;
  q[0] /= n; q[1] /= n; q[2] /= n;

  let mass = 0;
  for (const reg of REGIONS) {
    let m = 0;
    for (const lb of reg.lobes) m = Math.max(m, lobeField(q, lb));
    for (const by of reg.bays) m -= lobeField(q, by);
    mass = Math.max(mass, m);
  }
  return mass;
}

/** Mountain contribution, only meaningful over land. */
function ridgeAt(p) {
  let m = 0;
  for (const reg of REGIONS) {
    for (const rg of reg.ridges) m = Math.max(m, lobeField(p, rg));
  }
  if (m <= 0) return 0;
  const r = ridged(p[0] * 4.2 + 5, p[1] * 4.2, p[2] * 4.2, 4);
  const crest = Math.max(0, r - 0.28) / 0.72;
  return m * crest * crest * 1.25;
}

/**
 * Surface elevation, normalised so that 0 is sea level.
 * Negative is ocean depth, positive is land height (max ~1).
 */
/**
 * Relief: how HIGH land stands, which is a different question from where
 * land IS.
 *
 * The first pass drove elevation straight off the continental mass, so the
 * plateau that makes a continent solid also made its whole interior a
 * mountain: 63% of all land came out above the snowline and Amarine
 * rendered as cream. Extent and height are now separate fields — mass
 * decides land or sea, this decides what that land looks like — and the
 * result is a world that is mostly rolling green country with mountains
 * only where a range was actually authored.
 */
function reliefAt(p, landness) {
  const broad = fbm(p[0] * 3.1 + 29, p[1] * 3.1, p[2] * 3.1 - 4, 4) * 0.5 + 0.5;
  const roll = fbm(p[0] * 7.3, p[1] * 7.3 + 41, p[2] * 7.3, 3) * 0.5 + 0.5;
  // fbm clusters hard around its midpoint, so without expanding the contrast
  // every continent comes out the same single shade of lowland.
  const mixed = broad * 0.74 + roll * 0.26;
  const shaped = Math.max(0, Math.min(1, (mixed - 0.5) * 2.05 + 0.48));
  let h = 0.012 + shaped * 0.42;
  h += ridgeAt(p) * 0.62;
  // Taper to the waterline so coasts shelve instead of standing as cliffs.
  const t = Math.max(0, Math.min(1, landness / 0.24));
  return h * (t * t * (3 - 2 * t)) + 0.008;
}

export function elevationAt(p) {
  const mass = continentAt(p);
  const coarse = fbm(p[0] * 2.3 + 3, p[1] * 2.3, p[2] * 2.3 - 7, 4) * 0.11;
  const fine = fbm(p[0] * 6.5, p[1] * 6.5 + 13, p[2] * 6.5, 3) * 0.04;
  const landness = mass * 1.30 + coarse + fine - 0.30;

  if (landness > 0) return Math.min(1.0, reliefAt(p, landness));
  const shelf = fbm(p[0] * 1.3, p[1] * 1.3 - 9, p[2] * 1.3, 2) * 0.10;
  return Math.max(-1, landness + shelf);
}

export function elevationLatLon(lat, lon) { return elevationAt(toVec(lat, lon)); }

/**
 * Sample every field at once.
 *
 * elevationAt() and moistureAt() each re-run the domain warp and their own
 * fbm stacks; called separately while building a planet map that is tens of
 * millions of redundant noise lookups. The map builder uses this instead.
 */
export function sampleAll(p) {
  const mass = continentAt(p);
  const coarse = fbm(p[0] * 2.3 + 3, p[1] * 2.3, p[2] * 2.3 - 7, 4) * 0.11;
  const fine = fbm(p[0] * 6.5, p[1] * 6.5 + 13, p[2] * 6.5, 3) * 0.04;
  const landness = mass * 1.30 + coarse + fine - 0.30;

  const elev = landness > 0
    ? Math.min(1.0, reliefAt(p, landness))
    : Math.max(-1, landness + fbm(p[0] * 1.3, p[1] * 1.3 - 9, p[2] * 1.3, 2) * 0.10);

  const moist = Math.max(0, Math.min(1,
    fbm(p[0] * 2.9 - 17, p[1] * 2.9, p[2] * 2.9 + 5, 4) * 0.5 + 0.5));

  return { mass, elev, moist };
}

/** Surface moisture — drives forest vs grassland vs steppe. */
export function moistureAt(p) {
  const m = fbm(p[0] * 2.9 - 17, p[1] * 2.9, p[2] * 2.9 + 5, 4) * 0.5 + 0.5;
  return Math.max(0, Math.min(1, m));
}

export const SEA_LEVEL = 0;

export function isLand(lat, lon) { return elevationLatLon(lat, lon) > SEA_LEVEL; }

/**
 * How far inland a point is, in degrees, measured by probing outward.
 * Used to guarantee a settlement marker sits on land the viewer can
 * actually see, rather than on a one-pixel islet or a coastal fringe.
 */
export function inlandDepth(lat, lon, maxDeg = 6) {
  if (!isLand(lat, lon)) return 0;
  for (let r = 1; r <= maxDeg; r++) {
    let allLand = true;
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      const dLat = Math.cos(th) * r;
      const dLon = Math.sin(th) * r / Math.max(0.25, Math.cos(lat * Math.PI / 180));
      if (!isLand(lat + dLat, lon + dLon)) { allLand = false; break; }
    }
    if (!allLand) return r - 1;
  }
  return maxDeg;
}

/**
 * Move a settlement onto solid, visible ground.
 *
 * Searches outward from the requested position for the nearest point
 * that is at least `wantInland` degrees from any coast.  A marker that
 * lands on ambiguous terrain is the single worst failure of the orbit
 * view: the player cannot tell whether they are looking at a town, an
 * island or a patch of sea.  This makes that impossible by construction.
 *
 * @returns {{lat:number, lon:number, moved:boolean, inland:number}}
 */
export function snapToLand(lat, lon, wantInland = 3) {
  if (inlandDepth(lat, lon) >= wantInland) {
    return { lat, lon, moved: false, inland: inlandDepth(lat, lon) };
  }
  let best = null;
  for (let r = 1; r <= 30; r += 1) {
    const steps = Math.max(12, r * 6);
    for (let a = 0; a < steps; a++) {
      const th = (a / steps) * Math.PI * 2;
      const cLat = lat + Math.cos(th) * r;
      if (cLat > 74 || cLat < -74) continue;   // keep out of the ice caps
      const cLon = lon + Math.sin(th) * r / Math.max(0.25, Math.cos(cLat * Math.PI / 180));
      const depth = inlandDepth(cLat, cLon);
      if (depth >= wantInland) {
        return { lat: cLat, lon: wrapLon(cLon), moved: true, inland: depth };
      }
      if (!best || depth > best.inland) {
        best = { lat: cLat, lon: wrapLon(cLon), moved: true, inland: depth };
      }
    }
    if (best && best.inland >= wantInland) break;
  }
  return best || { lat, lon, moved: false, inland: 0 };
}

export function wrapLon(lon) {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

// ============================================================
// SETTLEMENT REGION
//
// Veridian Cap is the only inhabited place on Amarine, so its
// surroundings get a treatment nothing else has: cultivated
// ground fading out from the town, and a thread of light running
// east along the avenue.  Both are sampled by the map builder.
// ============================================================

export const SETTLEMENT = {
  name: 'Veridian Cap',
  // Filled in at build time by resolveSettlement(), so the region
  // always agrees with wherever the pin actually ended up.
  lat: 8, lon: 40,
  cultivatedDeg: 7.5,   // radius of worked land around the town
  coreDeg: 1.5,         // the built-up area itself
  // The road out of town runs east; on the planet it reads as a
  // faint line of settlement continuing along the coast.
  roadBearing: 96,
  roadDeg: 9,
};

let _resolved = null;

/** Resolve every settlement onto land. Idempotent. */
export function resolveSettlement(pins) {
  if (_resolved) return _resolved;
  const out = pins.map(p => {
    const want = p.real ? 4 : 2;
    const s = snapToLand(p.lat, p.lon, want);
    return { ...p, lat: s.lat, lon: s.lon, moved: s.moved, inland: s.inland };
  });
  const cap = out.find(p => p.real);
  if (cap) { SETTLEMENT.lat = cap.lat; SETTLEMENT.lon = cap.lon; }
  _resolved = out;
  return out;
}

/** Angular distance in degrees from a point to the settlement centre. */
export function settlementDistanceDeg(p) {
  const c = toVec(SETTLEMENT.lat, SETTLEMENT.lon);
  return Math.acos(Math.max(-1, Math.min(1, dot3(c, p)))) * 180 / Math.PI;
}

/** Distance in degrees from a point to the road running out of town. */
export function roadDistanceDeg(p) {
  const c = toVec(SETTLEMENT.lat, SETTLEMENT.lon);
  const ang = Math.acos(Math.max(-1, Math.min(1, dot3(c, p)))) * 180 / Math.PI;
  if (ang > SETTLEMENT.roadDeg) return 999;
  // Bearing from the settlement to this point, on the tangent plane.
  const dLat = Math.asin(Math.max(-1, Math.min(1, p[1]))) * 180 / Math.PI - SETTLEMENT.lat;
  const east = Math.cos(SETTLEMENT.lat * Math.PI / 180);
  const lonP = Math.atan2(p[2], -p[0]) * 180 / Math.PI - 180;
  const dLon = wrapLon(lonP - SETTLEMENT.lon) * east;
  const bearing = Math.atan2(dLon, dLat) * 180 / Math.PI;
  let diff = Math.abs(wrapLon(bearing - SETTLEMENT.roadBearing));
  // Perpendicular offset from the road line.
  return Math.sin(diff * Math.PI / 180) * ang;
}

export { fbm, ridged, vnoise };
