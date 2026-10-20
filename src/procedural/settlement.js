// ============================================================
// SETTLEMENT FIELD — Phase 7 visual sanitation
//
// Phase 7 shipped a single density ring centred on Veridian Cap:
// urban inside 200 m, suburban to 600, rural to 1500, nothing after.
// From Eagle that reads as one blob with confetti scattered around it,
// because every point at the same radius is equally developed and
// nothing anywhere else on the planet is developed at all.
//
// This module replaces the ring with a CATALOGUE OF SETTLEMENTS.
// Development is no longer a function of "distance from origin" but of
// "distance from the nearest place people actually settled", and
// settlements come in sizes.  That single change is what produces the
// readings the brief asks for from altitude:
//
//   where people live    — the settlement cores
//   where the city ends  — the intensity falloff, ragged rather than circular
//   where countryside is — the land between settlements, which is most of it
//   why density changes  — proximity to a centre, not an arbitrary radius
//
// Everything downstream (roads, parcels, buildings, land cover) reads
// the field defined here, so the whole world agrees about where the
// civilization is.
// ============================================================

import { PROC } from '../config.js';
import { noise2, fbm2, hash2 } from './seed.js';

// ---- Settlement tiers ------------------------------------------------
//
// coreR   radius of the dense centre — continuous frontage, civic uses
// edgeR   radius at which development has faded to countryside
// floors  storeys at the core; the skyline of the place
// spokes  arterials radiating from the centre
// rings   orbital roads (none below a town)
// blockM  target block size, which sets the street grain
//
// The jump between tiers is deliberately large.  A hamlet beside a city
// must not look like a small city; it must look like a hamlet.
export const TIER = [
  { id: 0, label: 'hamlet',          coreR:  34, edgeR:  120, floors:  2, spokes: 2, rings: 0, blockM: 58 },
  { id: 1, label: 'village',         coreR:  52, edgeR:  230, floors:  3, spokes: 3, rings: 0, blockM: 62 },
  { id: 2, label: 'town',            coreR:  82, edgeR:  400, floors:  5, spokes: 4, rings: 1, blockM: 66 },
  { id: 3, label: 'large town',      coreR: 120, edgeR:  640, floors:  8, spokes: 5, rings: 1, blockM: 70 },
  { id: 4, label: 'city',            coreR: 175, edgeR:  980, floors: 14, spokes: 6, rings: 2, blockM: 74 },
  { id: 5, label: 'regional centre', coreR: 240, edgeR: 1380, floors: 21, spokes: 7, rings: 2, blockM: 78 },
];

// Core identity: what sits at the middle of the place.  Used by the
// building layer so each settlement has its own centre instead of every
// core being an interchangeable cluster of taller boxes.
const CORE_KINDS = ['green', 'civic-square', 'market-street', 'water', 'interchange', 'park'];

let _settlements = null;
let _byKey = null;          // spatial bucket -> settlements, for fast field queries
const BUCKET = 512;         // settlement lookup bucket size, metres

/**
 * The authored settlement.  Veridian Cap is the reference: a large town
 * whose dense core is the hand-built town itself, so procedural growth
 * reads as that town's suburbs rather than as a separate development
 * that happens to abut it.
 */
const VERIDIAN_CAP = {
  id: 'veridian-cap',
  name: 'Veridian Cap',
  x: 0, z: 0,
  tier: 3,
  core: 'green',
  authored: true,          // the core is built by city/*, not by us
  authoredR: 92,           // radial keep-out, used for coarse tests

  // The town is a 152 x 140 rectangle of blocks, not a disc.  A radial
  // keep-out of 92 m reaches 85 m at the north and south block edges but
  // only clears 76 m at the east and west ones, so it covered ground
  // outside the town on two sides and left the corners exposed on the
  // others.  That mismatch silently deleted the first segment of every
  // arterial leaving the perimeter collector on the north and south
  // sides — which is why the settlement stayed in disconnected pieces
  // after the perimeter was built.  The box is the real footprint.
  authoredBox: { minX: -76, maxX: 76, minZ: -70, maxZ: 70 },

  // GATEWAYS: where the authored town hands over to the regional network.
  //
  // Regional roads are routed between settlement CENTRES, and Veridian
  // Cap's centre is the middle of The Green — so every trunk road to
  // every neighbouring settlement was being drawn straight across the
  // park, through Founders' Plaza and under the settlement marker.  It
  // was invisible while procedural roads sat at y=0.012, beneath the
  // authored park surfaces; raising them to y=0.050 in the Phase 7
  // z-fighting fix lifted them on top and made a carriageway appear
  // across the green.
  //
  // A town does not connect to the world through its park.  It connects
  // through its road: the authored avenue, which already runs east from
  // the settlement edge to (276, 0).  Regional roads attach there.
  gateways: [[276, 0]],
};

/**
 * Build the settlement catalogue.  Deterministic from the global seed.
 *
 * Sites are drawn on a jittered lattice so they never line up, then
 * filtered by a minimum separation that scales with tier — a city pushes
 * its neighbours further away than a hamlet does, which is what creates
 * "one large place surrounded by small ones" rather than an even
 * sprinkle of equal towns.
 */
export function buildSettlements(seed = PROC.procSeed) {
  if (_settlements) return _settlements;

  const list = [VERIDIAN_CAP];

  const reach = PROC.settlementReach;
  const cell = PROC.settlementCell;
  const n = Math.ceil(reach / cell);

  const candidates = [];
  for (let iz = -n; iz <= n; iz++) {
    for (let ix = -n; ix <= n; ix++) {
      if (ix === 0 && iz === 0) continue;   // Veridian Cap's cell

      // Jitter each lattice point by most of a cell so the catalogue
      // never betrays the lattice it was drawn on.
      const jx = (hash2(ix * 7 + 13, iz * 31 + 5) - 0.5) * cell * 0.80;
      const jz = (hash2(iz * 11 + 3, ix * 17 + 29) - 0.5) * cell * 0.80;
      const x = ix * cell + jx;
      const z = iz * cell + jz;
      const dist = Math.hypot(x, z);
      if (dist > reach) continue;

      // Not every lattice cell is settled.  Land that stays empty is the
      // point: the planet should read as mostly unoccupied.
      if (hash2(ix * 101 + 7, iz * 211 + 19) > PROC.settlementOccupancy) continue;

      // Habitability.  terrain.js derives its relief from the inverse of
      // this same expression, so settlements land in the basins and the
      // hills take the ground nobody wanted.  It is inlined rather than
      // imported because terrain.js imports this module for its
      // development field, and the cycle is not worth the tidiness.
      const hab = fbm2(x * 0.00042 + 91.3, z * 0.00042 - 12.7, 3);

      candidates.push({ ix, iz, x, z, dist, hab, roll: hash2(ix * 53 + 71, iz * 97 + 41) });
    }
  }

  // Most habitable first, so the good ground claims its separation
  // before the marginal sites fill in around it.
  candidates.sort((a, b) => (b.hab - a.hab) || (a.dist - b.dist));

  for (const c of candidates) {
    const tier = pickTier(c);
    const t = TIER[tier];

    // Minimum separation: a settlement needs room for its own edge plus
    // a belt of countryside, and must not be swallowed by a bigger
    // neighbour's outskirts.
    let ok = true;
    for (const s of list) {
      const ts = TIER[s.tier];
      const need = (t.edgeR + ts.edgeR) * 0.92 + PROC.countrysideBelt;
      if (Math.hypot(s.x - c.x, s.z - c.z) < need) { ok = false; break; }
    }
    if (!ok) continue;

    list.push({
      id: 's' + c.ix + '_' + c.iz,
      name: settlementName(c.ix, c.iz),
      x: c.x, z: c.z,
      tier,
      core: CORE_KINDS[Math.floor(hash2(c.ix * 13 + 2, c.iz * 29 + 6) * CORE_KINDS.length) % CORE_KINDS.length],
      authored: false,
      authoredR: 0,
    });
  }

  // Bake per-settlement derived data once.
  for (const s of list) {
    const t = TIER[s.tier];
    s.coreR = t.coreR;
    s.edgeR = t.edgeR;
    s.floors = t.floors;
    s.blockM = t.blockM;
    s.spokes = t.spokes;
    s.rings = t.rings;
    s.label = t.label;
    const qx = Math.round(s.x) | 0, qz = Math.round(s.z) | 0;
    s.seed = (PROC.procSeed ^ Math.imul(qx, 0x9E3779B9) ^ Math.imul(qz, 0x85EBCA6B)) >>> 0;
    // Each settlement's street grain has its own base angle, so no two
    // places share an orientation and the world never reads as one grid.
    s.grain = hash2(qx, qz) * Math.PI;
    // Growth lobes: the place is longer along one axis than the other,
    // the way a real town grows along a valley or a road.
    s.lobeAngle = hash2(qz, qx) * Math.PI * 2;
    s.lobeStrength = 0.16 + hash2(qx + 7, qz - 3) * 0.26;
  }

  _settlements = list;
  _byKey = new Map();
  for (const s of list) {
    const bx = Math.floor(s.x / BUCKET), bz = Math.floor(s.z / BUCKET);
    const span = Math.ceil((s.edgeR * 1.4) / BUCKET) + 1;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const k = (bx + dx) + ',' + (bz + dz);
        let arr = _byKey.get(k);
        if (!arr) { arr = []; _byKey.set(k, arr); }
        arr.push(s);
      }
    }
  }
  return _settlements;
}

export function clearSettlements() { _settlements = null; _byKey = null; }

export function allSettlements() { return _settlements || buildSettlements(); }

/**
 * True inside an authored settlement's own footprint, where the city
 * modules own the ground.  Uses the real rectangle when one is given.
 */
export function insideAuthoredTown(x, z, margin = 0) {
  const list = allSettlements();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s.authored) continue;
    const b = s.authoredBox;
    if (b) {
      if (x > b.minX - margin && x < b.maxX + margin &&
          z > b.minZ - margin && z < b.maxZ + margin) return true;
    } else if (Math.hypot(x - s.x, z - s.z) < s.authoredR + margin) {
      return true;
    }
  }
  return false;
}

/**
 * The reservation covering a point, if any.
 *
 * Reserved land is ground the settlement has set aside for a purpose it
 * has not built yet.  Every system that would otherwise consume land —
 * parcels, street grids, farm cover — asks here first, so the
 * reservation survives regeneration instead of being quietly developed.
 */
export function reservationAt(x, z, margin = 0) {
  const list = PROC.reservations || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (x > r.minX - margin && x < r.maxX + margin &&
        z > r.minZ - margin && z < r.maxZ + margin) return r;
  }
  return null;
}

export function settlementById(id) {
  return allSettlements().find(s => s.id === id) || null;
}

/** Settlements whose influence can reach this point. */
function nearby(wx, wz) {
  if (!_byKey) buildSettlements();
  return _byKey.get(Math.floor(wx / BUCKET) + ',' + Math.floor(wz / BUCKET)) || [];
}

// ---- Development bands ----------------------------------------------
//
// The brief asks for a legible gradient rather than CITY -> EMPTY GREEN.
// These are the steps of that gradient, and every downstream system keys
// off them: street spacing, parcel width, setback, storey count, how
// much of a block stays garden.
export const BAND = {
  CORE:    { id: 6, name: 'core',        min: 0.80 },
  INNER:   { id: 5, name: 'inner',       min: 0.58 },
  OUTER:   { id: 4, name: 'outer',       min: 0.38 },
  EDGE:    { id: 3, name: 'edge',        min: 0.21 },
  FRINGE:  { id: 2, name: 'fringe',      min: 0.10 },
  RURAL:   { id: 1, name: 'rural',       min: 0.035 },
  COUNTRY: { id: 0, name: 'countryside', min: 0 },
};
const BAND_ORDER = [BAND.CORE, BAND.INNER, BAND.OUTER, BAND.EDGE, BAND.FRINGE, BAND.RURAL, BAND.COUNTRY];

export function bandFor(intensity) {
  for (const b of BAND_ORDER) if (intensity >= b.min) return b;
  return BAND.COUNTRY;
}

/**
 * Development intensity at a world position, in [0,1].
 *
 * The falloff has three parts:
 *
 *   plateau  inside coreR the settlement is fully built
 *   decay    a convex falloff to the edge — most of the drop happens
 *            early, so the built-up part has a defined limit and the
 *            tail is a long thin scatter of farms rather than a blur
 *   texture  noise on the radius at two scales, so the outline is ragged
 *            at neighbourhood scale and lobed at settlement scale.  This
 *            is what stops the edge reading as a circle.
 *
 * @returns {{ intensity, band, settlement, r, u }}
 *          r = distance to that settlement's centre, u = normalised radius
 */
export function developmentAt(wx, wz) {
  const cands = nearby(wx, wz);
  let best = 0, bestS = null, bestR = 0, bestU = 1;

  for (let i = 0; i < cands.length; i++) {
    const s = cands[i];
    const dx = wx - s.x, dz = wz - s.z;
    const r = Math.hypot(dx, dz);
    if (r > s.edgeR * 1.4) continue;

    // Lobe: stretch the settlement along its growth axis.
    const a = Math.atan2(dz, dx);
    const lobe = 1 + Math.cos((a - s.lobeAngle) * 2) * s.lobeStrength;

    // Ragged outline, two scales.
    const coarse = fbm2(wx * 0.0016 + (s.seed % 97), wz * 0.0016 - (s.seed % 53), 2) - 0.5;
    const fine = noise2(wx * 0.0085 + 3.1, wz * 0.0085 - 7.7) - 0.5;
    const wobble = 1 + coarse * 0.40 + fine * 0.16;

    const coreR = s.coreR * lobe;
    const edgeR = s.edgeR * lobe * wobble;
    if (r >= edgeR) continue;

    let I;
    if (r <= coreR) {
      I = 1;
    } else {
      const t = (r - coreR) / Math.max(1, edgeR - coreR);
      I = Math.pow(1 - t, 2.1);   // convex: defined built edge, long thin tail
    }
    if (I > best) { best = I; bestS = s; bestR = r; bestU = r / Math.max(1, edgeR); }
  }

  return { intensity: best, band: bandFor(best), settlement: bestS, r: bestR, u: bestU };
}

/** Intensity-only query, for hot loops that do not need the rest. */
export function intensityAt(wx, wz) { return developmentAt(wx, wz).intensity; }

/**
 * Nearest settlement centre regardless of whether the point lies inside
 * its development field — the road layer needs this, because roads have
 * to reach places from well outside their edge.
 */
export function nearestSettlement(wx, wz) {
  const list = allSettlements();
  let best = null, bd = Infinity;
  for (const s of list) {
    const d = Math.hypot(wx - s.x, wz - s.z);
    if (d < bd) { bd = d; best = s; }
  }
  return { settlement: best, dist: bd };
}

// ---- helpers ---------------------------------------------------------

/**
 * Tier for a candidate site.  Small places dominate: a planet where every
 * settlement is a city is exactly the "generic city simulator" the brief
 * rules out.  Distance from Veridian Cap biases upward slightly, so the
 * immediate surroundings of the first landing stay villages and hamlets
 * and the larger places sit further out.
 */
function pickTier(c) {
  // Distance from the first landing shifts the distribution upward
  // without compressing it — scaling the roll instead of offsetting it
  // would put the top tiers out of reach of every site on the planet.
  const far = Math.min(1, c.dist / PROC.settlementReach);
  const roll = Math.min(0.999, c.roll + far * 0.18);
  if (roll < 0.34) return 0;    // hamlet
  if (roll < 0.62) return 1;    // village
  if (roll < 0.81) return 2;    // town
  if (roll < 0.93) return 3;    // large town
  if (roll < 0.985) return 4;   // city
  return 5;                     // regional centre
}

// Name fragments in Veridian Cap's register: plain, temperate, colonial.
const NAME_A = ['Ald', 'Bren', 'Cald', 'Dun', 'Elm', 'Fen', 'Gale', 'Hart', 'Ives', 'Kelt',
                'Lin', 'Mor', 'Nare', 'Oak', 'Pell', 'Quar', 'Rush', 'Sel', 'Thorn', 'Vale', 'Wend'];
const NAME_B = ['bury', 'combe', 'ford', 'garth', 'hollow', 'mere', 'reach', 'ridge', 'stead',
                'thwaite', 'water', 'wick', 'fold', 'crest', 'march'];

function settlementName(ix, iz) {
  const a = NAME_A[Math.floor(hash2(ix * 3 + 11, iz * 7 + 23) * NAME_A.length) % NAME_A.length];
  const b = NAME_B[Math.floor(hash2(iz * 5 + 17, ix * 13 + 31) * NAME_B.length) % NAME_B.length];
  return a + b;
}
