import { ARCH, TOWN } from '../config.js';
import { blockData } from './layout.js';
import { collisionRegistry } from './collision.js';
import { buildBuilding } from './facades.js';
import { LOUNGE_INTERIOR } from './interiors.js';

// ============================================================
// BUILDINGS — Phase 3 placement, Phase 5 architecture
//
// PLACEMENT (unchanged from Phase 3):
//   Each non-park block places buildings along its road-facing
//   edges with a consistent 3.5-unit setback from the block
//   boundary.  Corner reservation first, then edge sub-spans.
//   Footprints are checked for overlap before they are accepted.
//
// ARCHITECTURE (Phase 5):
//   Footprints and entrance edges are taken exactly as placement
//   produced them and handed to facades.js, which realises the
//   building in the settlement's architectural language.  Only
//   the HEIGHT changes: it is snapped to a whole number of floors
//   so storey lines land at believable human dimensions.
//
// DETERMINISM (Phase 5):
//   Placement used Math.random(), so every reload produced a
//   different town and a different collision-body count.  It now
//   runs off a seeded stream, which makes the settlement stable
//   across reloads and makes the acceptance counts reproducible.
// ============================================================

const CORNER_INSET = 4.5;   // corner zone reserve (from block corner along each edge)
const SETBACK = TOWN.setback;

// ---- Deterministic placement stream ----
let _seed = 0;
function srand() {
  _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ARCH type (which sets the footprint envelope) to architectural family.
const FAMILY_OF = {
  villa: 'residence',
  arcade: 'commercial',
  terrace: 'landmark',
};

// The four block edges that face the central green.  A civic building on
// each of these is what gives the park a front door rather than a back.
const PARK_FRONTS = {
  '1,0': 'north',
  '1,2': 'south',
  '0,1': 'east',
  '2,1': 'west',
};

/**
 * Every building realised this run: footprint, family, entrance edge and
 * final height.  Exported for visual QA (it is how the capture harness aims
 * a camera at a real entrance) and for later phases that need to address a
 * specific building.
 */
export const buildingRegistry = [];

/**
 * Worldbuilding runs in two passes.
 *
 *   PLAN   reserves every footprint exactly as the Phase 3 grammar does —
 *          corners first, then edge spans, overlap-checked per block.
 *   BUILD  realises them.
 *
 * They are separate because the civic buildings can only be chosen once the
 * whole town is planned: a community hall is whichever plot ended up closest
 * to the park axis on a park-facing frontage, and on two of the four
 * frontages the corner plots leave no room for a mid-edge one, so there is
 * no way to know in advance which plot it will be.
 */
export function buildBuildings() {
  _seed = 0x5EED;
  buildingRegistry.length = 0;

  const plans = [];

  blockData.forEach(blk => {
    if (blk.park) return;  // park block — no buildings

    const footprints = [];  // overlap registry per block

    // Determine edge directions that face a road
    const hasWest  = blk.x > 0;
    const hasEast  = blk.x < TOWN.blocksX - 1;
    const hasSouth = blk.z > 0;
    const hasNorth = blk.z < TOWN.blocksZ - 1;

    // Determine type mix for this block (same selection as Phase 3)
    const nearPark = Math.abs(blk.x - 1) + Math.abs(blk.z - 1);
    let types;
    if (blk.x === 2 && blk.z === 1) {
      types = ['terrace', 'terrace', 'villa'];
    } else if (nearPark <= 2) {
      types = ['villa', 'arcade', 'villa'];
    } else {
      types = ['villa', 'villa', 'arcade'];
    }

    // ---- 1. Corner reservations ----
    // A corner gets a building only if BOTH adjacent edges face a road.
    const corners = [
      { edgeX: hasWest, edgeZ: hasSouth, ax: 1, az: 1, ex: 'west', ez: 'south' },
      { edgeX: hasWest, edgeZ: hasNorth, ax: 1, az: -1, ex: 'west', ez: 'north' },
      { edgeX: hasEast, edgeZ: hasSouth, ax: -1, az: 1, ex: 'east', ez: 'south' },
      { edgeX: hasEast, edgeZ: hasNorth, ax: -1, az: -1, ex: 'east', ez: 'north' },
    ];

    corners.forEach(c => {
      if (!c.edgeX || !c.edgeZ) return;
      const spec = ARCH.arcade;
      const w = rand(spec.w);
      const d = rand(spec.d);
      const h = rand(spec.h);
      // Position the corner building at the intersection of two setback lines.
      const frontX = c.ax > 0 ? blk.minX + SETBACK : blk.maxX - SETBACK;
      const frontZ = c.az > 0 ? blk.minZ + SETBACK : blk.maxZ - SETBACK;
      const cx = frontX + (c.ax > 0 ? d / 2 : -d / 2);
      const cz = frontZ + (c.az > 0 ? d / 2 : -d / 2);
      if (!fit(cx, cz, w, d, blk, footprints)) return;
      footprints.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 });

      // Corners hold two street frontages at once, so they anchor the
      // crossing.  On the tall block at the head of the avenue they are
      // the settlement's landmarks; elsewhere they are mixed-use.
      plans.push({
        blk, cx, cz, w, d, h, corner: true,
        family: (blk.x === 2 && blk.z === 1) ? 'landmark' : 'commercial',
        fronts: [c.ex, c.ez],
        entrance: c.az > 0 ? 'south' : 'north',
      });
    });

    // ---- 2. Edge building spans ----
    // The park-facing edge is planned FIRST so it gets first claim on
    // whatever frontage the corners have left.
    const order = ['south', 'north', 'west', 'east'];
    const parkEdge = PARK_FRONTS[blk.x + ',' + blk.z];
    if (parkEdge) {
      order.splice(order.indexOf(parkEdge), 1);
      order.unshift(parkEdge);
    }
    const faces = { south: hasSouth, north: hasNorth, west: hasWest, east: hasEast };
    order.forEach(edge => {
      if (faces[edge]) planEdge(blk, types, edge, footprints, plans);
    });
  });

  assignCivic(plans);

  plans.forEach(pl => {
    // A building the player can walk into needs its entrance left open, so
    // the doorway is one object seen from both sides rather than a solid
    // plug of stone with a separate door drawn on each face.
    const tag = 'b@' + pl.cx.toFixed(1) + ',' + pl.cz.toFixed(1);
    const realH = buildBuilding({
      cx: pl.cx, cz: pl.cz, w: pl.w, d: pl.d, targetH: pl.h,
      family: pl.family, fronts: pl.fronts, entrance: pl.entrance,
      seed: hash(pl.cx, pl.cz),
      seeThrough: tag === LOUNGE_INTERIOR.buildingTag,
    });
    registerBuildingCollision(pl.cx, pl.cz, pl.w, pl.d, realH, pl.entrance);
    buildingRegistry.push({
      cx: pl.cx, cz: pl.cz, w: pl.w, d: pl.d,
      family: pl.family, entrance: pl.entrance, height: realH, corner: !!pl.corner,
    });
  });
}

/**
 * Give the central green four front doors.
 *
 * For each block that faces the park, take the planned building sitting
 * closest to that approach axis and make it the community hall for its
 * quarter — corner plot or mid-edge plot, whichever it turns out to be.
 * Four civic buildings looking at each other across the green is what turns
 * a block of grass into the settlement's centre.
 */
function assignCivic(plans) {
  for (const [key, edge] of Object.entries(PARK_FRONTS)) {
    const [bx, bz] = key.split(',').map(Number);
    const onFront = plans.filter(pl =>
      pl.blk.x === bx && pl.blk.z === bz && pl.fronts.includes(edge));
    if (!onFront.length) continue;
    // The approach axis runs through the middle of the park block.
    const acrossX = (edge === 'north' || edge === 'south');
    let best = onFront[0], bestDist = Infinity;
    for (const pl of onFront) {
      const dist = Math.abs(acrossX ? pl.cx : pl.cz);
      if (dist < bestDist) { bestDist = dist; best = pl; }
    }
    best.family = 'civic';
    best.entrance = edge;         // the hall must open onto the green
    if (!best.fronts.includes(edge)) best.fronts.push(edge);
  }
}

/**
 * Reserve building plots along one road-facing block edge.
 *
 * Phase 3 placed each candidate at a fixed fraction of the edge span and
 * DROPPED it whenever it clashed with an already-reserved corner.  On the
 * four blocks that face the central green the two corner buildings span the
 * whole frontage, so every edge candidate there was silently discarded: the
 * settlement was building 15 of roughly 40 intended plots, and none of the
 * park frontages got a building at all.
 *
 * Placement now searches the edge for the nearest free slot instead of
 * giving up, narrowing the plot down to a minimum frontage before it
 * abandons one.  No existing footprint moves — corners are still reserved
 * first and are never displaced — the gaps between them simply get built.
 *
 * @param {object} blk       block metadata
 * @param {string[]} types   building type pool
 * @param {string} edge      'south'|'north'|'west'|'east'
 * @param {Array} footprints overlap registry (mutated in place)
 */
function planEdge(blk, types, edge, footprints, plans) {
  const isXEdge = (edge === 'west' || edge === 'east');

  // The edge RUNS along the axis it does not face: a north edge faces +Z and
  // runs along X.  Phase 3 read its span off the opposite axis, so on every
  // block whose X and Z origins differ the candidates were generated outside
  // the block entirely and rejected by fit().  That single inverted ternary
  // is why only 16 of 52 plots were ever built.
  const min = isXEdge ? blk.minZ : blk.minX;
  const max = isXEdge ? blk.maxZ : blk.maxX;

  // Usable span along the edge, excluding corner zones
  const usableMin = min + CORNER_INSET;
  const usableMax = max - CORNER_INSET;
  const span = usableMax - usableMin;
  if (span < 8) return; // too short for a building

  const count = Math.min(3, Math.max(2, Math.floor(span / 12)));
  const placed = [];

  for (let i = 0; i < count; i++) {
    const type = types[i % types.length];
    const spec = ARCH[type];
    // Frontage runs along the edge, depth runs into the block.
    const frontage = rand(spec.w);
    const depth = rand(spec.d);
    const h = rand(spec.h);

    const t = (i + 0.5) / count;
    const want = usableMin + t * span + (srand() - 0.5) * 1.5;

    const slot = findSlot(blk, edge, isXEdge, usableMin, usableMax, want,
                          frontage, depth, footprints);
    if (!slot) continue;

    footprints.push({
      minX: slot.cx - slot.w / 2, maxX: slot.cx + slot.w / 2,
      minZ: slot.cz - slot.d / 2, maxZ: slot.cz + slot.d / 2,
    });
    placed.push({ ...slot, h, type });
  }

  placed.forEach(pl => {
    plans.push({
      blk, cx: pl.cx, cz: pl.cz, w: pl.w, d: pl.d, h: pl.h,
      family: FAMILY_OF[pl.type], fronts: [edge], entrance: edge, corner: false,
    });
  });
}

const MIN_FRONTAGE = 8;

/**
 * Find the free plot nearest the preferred position along an edge,
 * shrinking the frontage if the full width will not fit.  Returns null
 * only when the edge really has no room left.
 */
function findSlot(blk, edge, isXEdge, usableMin, usableMax, want, wAlong, dInto, footprints) {
  const place = (along, w) => {
    const d = dInto;
    let cx, cz;
    if (edge === 'south')      { cx = along; cz = blk.minZ + SETBACK + d / 2; }
    else if (edge === 'north') { cx = along; cz = blk.maxZ - SETBACK - d / 2; }
    else if (edge === 'west')  { cz = along; cx = blk.minX + SETBACK + d / 2; }
    else                       { cz = along; cx = blk.maxX - SETBACK - d / 2; }
    const fw = isXEdge ? d : w;
    const fd = isXEdge ? w : d;
    return fit(cx, cz, fw, fd, blk, footprints) ? { cx, cz, w: fw, d: fd } : null;
  };

  const reach = Math.ceil((usableMax - usableMin) / 2);
  for (let w = wAlong; w >= MIN_FRONTAGE; w -= 1.5) {
    // Walk outward from the preferred position in 1 m steps.
    for (let off = 0; off <= reach; off += 1) {
      for (const s of (off === 0 ? [0] : [-1, 1])) {
        const along = want + s * off;
        if (along - w / 2 < usableMin - 0.5 || along + w / 2 > usableMax + 0.5) continue;
        const hit = place(along, w);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function rand([lo, hi]) { return lo + srand() * (hi - lo); }

/** Stable per-building seed from its footprint centre. */
function hash(cx, cz) {
  return Math.abs(Math.floor(cx * 733 + cz * 1597)) + 17;
}

/**
 * Check if a footprint fits inside a block and doesn't overlap existing ones.
 */
function fit(cx, cz, w, d, blk, footprints) {
  const minX = cx - w / 2;
  const maxX = cx + w / 2;
  const minZ = cz - d / 2;
  const maxZ = cz + d / 2;
  // Inside block boundaries (with 0.2m tolerance for rounding)
  if (minX < blk.minX - 0.2) return false;
  if (maxX > blk.maxX + 0.2) return false;
  if (minZ < blk.minZ - 0.2) return false;
  if (maxZ > blk.maxZ + 0.2) return false;
  // No overlap with existing footprints (1m minimum gap)
  for (const fp of footprints) {
    if (minX < fp.maxX + 1 && maxX > fp.minX - 1 &&
        minZ < fp.maxZ + 1 && maxZ > fp.minZ - 1) {
      return false;
    }
  }
  return true;
}

// ============================================================
// BUILDING COLLISION REGISTRATION (Phase 4 — unchanged)
// ============================================================

/**
 * Register a building's solid geometry in the collision registry.
 *
 * Registers 3 bodies per building:
 *   1. Body (above plinth): the visible building box
 *   2-3. Plinth split left/right of the entrance doorway
 *
 * The plinth extends 0.7 m beyond the body on all 4 sides.  The
 * entrance gap prevents the plinth from blocking access to the door.
 */
function registerBuildingCollision(cx, cz, w, d, h, entranceEdge) {
  const PLINTH_OVERHANG = 0.7;
  const halfGap = TOWN.entranceWidth / 2;   // 0.6

  // ---- Body (above plinth, y 0.5 → 0.5+h) ----
  collisionRegistry.registerBody({
    minX: cx - w / 2, maxX: cx + w / 2,
    minY: 0.5, maxY: 0.5 + h,
    minZ: cz - d / 2, maxZ: cz + d / 2,
    type: 'building',
    tag: `b@${cx.toFixed(1)},${cz.toFixed(1)}`,
  });

  // ---- Plinth base (y 0 → 0.5), split for entrance gap ----
  const pMinX = cx - w / 2 - PLINTH_OVERHANG;
  const pMaxX = cx + w / 2 + PLINTH_OVERHANG;
  const pMinZ = cz - d / 2 - PLINTH_OVERHANG;
  const pMaxZ = cz + d / 2 + PLINTH_OVERHANG;

  const addPlinth = (mnx, mxx, mnz, mxz) => {
    collisionRegistry.registerBody({
      minX: mnx, maxX: mxx, minY: 0, maxY: 0.5,
      minZ: mnz, maxZ: mxz, type: 'building',
      tag: `b@${cx.toFixed(1)},${cz.toFixed(1)}/p`,
    });
  };

  if (entranceEdge === 'south' || entranceEdge === 'north') {
    // Gap along X axis, centered at cx
    addPlinth(pMinX, cx - halfGap, pMinZ, pMaxZ);
    addPlinth(cx + halfGap, pMaxX, pMinZ, pMaxZ);
  } else if (entranceEdge === 'west' || entranceEdge === 'east') {
    // Gap along Z axis, centered at cz
    addPlinth(pMinX, pMaxX, pMinZ, cz - halfGap);
    addPlinth(pMinX, pMaxX, cz + halfGap, pMaxZ);
  } else {
    // No entrance — monolithic plinth (shouldn't normally happen)
    addPlinth(pMinX, pMaxX, pMinZ, pMaxZ);
  }
}
