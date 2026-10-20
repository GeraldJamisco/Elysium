// ============================================================
// REGIONAL ZONES — Phase 9A
//
// A name for ground that the world already understood numerically.
//
// Before this, everything about a place was carried by one number:
// developmentAt().intensity, plus relief as a second axis and the
// land-use field as a third.  That is enough to decide how dense to
// build, and it is NOT enough to make a region legible — from altitude
// the whole planet read as "more buildings here, fewer there", because
// density was the only thing that ever changed.
//
// This module does not replace any of that.  It derives a zone from the
// fields that already exist — the development field, the settlement
// catalogue, the landform and the land-use field — and attaches to each
// zone the things density cannot express: how buildings GROUP, how tall
// they TEND to be, what the vegetation and the open space are like, and
// what kind of road belongs there.
//
// Everything here is a pure function of position.  No state, no
// randomness that is not hash-derived, so two runs agree and a chunk
// built at LOD 3 describes the same place as the same chunk at LOD 0.
// ============================================================

import { developmentAt, BAND } from './settlement.js';
import { landformAt } from './terrain.js';
import { fbm2 } from './seed.js';
import { useField } from './parcels.js';

/**
 * The zones.
 *
 * `mass` fields are what the regional LOD reads: they describe the
 * SILHOUETTE of development, not its architecture.
 *
 *   cover      fraction of candidate cells that carry built mass
 *   foot       [min, max] footprint, metres
 *   floors     [min, max] storey tendency
 *   grain      spacing of the sampling lattice, metres — small grain
 *              reads as fine urban texture, large grain as scattered
 *   clump      0 = evenly spread, 1 = strongly clustered
 *
 * `build` is the DETAIL-LOD counterpart (Phase 9B).  It does not replace
 * the density field: the band rules in parcels.js still decide how much
 * gets built, and these multiply that result so a zone expresses itself
 * through things density cannot say —
 *
 *   footMul     footprint scale [width, depth]
 *   setbackMul  how far back from the kerb
 *   strideMul   plot spacing along a frontage
 *   fillMul     base occupancy, before clustering
 *   clump       0 = evenly spread, 1 = placement decided entirely by the
 *               cluster field, which is what turns an even sprinkle of
 *               houses into neighbourhoods and hamlets
 *   gapMul      gap between neighbours; small values hold a street line
 *   use         which family belongs here
 *
 * The descriptive fields (`veg`, `open`, `road`) are the zone's
 * character.  They are consulted by the regional pass and are there so
 * that a later detail pass has one place to agree with.
 */
export const ZONE = {
  URBAN_CORE: {
    id: 6, name: 'urban-core',
    mass: { cover: 0.78, foot: [14, 26], floors: [4, 9], grain: 22, clump: 0.25 },
    build: { footMul: [1.18, 1.28], setbackMul: 0.55, strideMul: 0.92, fillMul: 1.05, clump: 0.10, gapMul: 0.45, use: 'mixed' },
    setback: 'none — buildings hold the street line',
    veg: 'street trees only, in the footway',
    open: 'hard public space; squares, not grass',
    road: 'continuous frontage, short blocks',
    influence: 'settlement centre',
  },
  URBAN_EDGE: {
    id: 5, name: 'urban-edge',
    mass: { cover: 0.62, foot: [12, 20], floors: [2, 5], grain: 26, clump: 0.30 },
    build: { footMul: [1.02, 1.06], setbackMul: 0.90, strideMul: 1.00, fillMul: 1.00, clump: 0.28, gapMul: 0.85, use: 'mixed' },
    setback: 'shallow, consistent',
    veg: 'street trees, verges',
    open: 'amenity green between blocks',
    road: 'grid still legible, longer blocks',
    influence: 'settlement body',
  },
  SUBURBAN: {
    id: 4, name: 'suburban',
    mass: { cover: 0.40, foot: [10, 16], floors: [1, 3], grain: 34, clump: 0.45 },
    build: { footMul: [0.92, 0.88], setbackMul: 1.30, strideMul: 1.18, fillMul: 0.95, clump: 0.58, gapMul: 1.25, use: 'residential' },
    setback: 'deep, with a front garden',
    veg: 'garden planting, frequent trees',
    open: 'private gardens; green reads between houses',
    road: 'looser streets, culs-de-sac',
    influence: 'settlement edge',
  },
  RURAL_SETTLED: {
    id: 3, name: 'rural-settled',
    mass: { cover: 0.16, foot: [9, 15], floors: [1, 2], grain: 52, clump: 0.70 },
    build: { footMul: [0.96, 0.98], setbackMul: 1.55, strideMul: 1.65, fillMul: 0.78, clump: 0.82, gapMul: 1.55, use: 'residential' },
    setback: 'irregular; buildings sit where the plot allows',
    veg: 'hedges and stands of trees, not avenues',
    open: 'paddock and yard',
    road: 'lanes; development follows the road, not a grid',
    influence: 'fringe of a settlement, or a roadside hamlet',
  },
  AGRICULTURAL: {
    id: 2, name: 'agricultural',
    mass: { cover: 0.030, foot: [10, 22], floors: [1, 2], grain: 150, clump: 0.92 },
    build: { footMul: [1.00, 1.00], setbackMul: 1.60, strideMul: 2.00, fillMul: 0.12, clump: 0.95, gapMul: 1.8, use: 'farm' },
    setback: 'none; farm buildings group around a yard',
    veg: 'hedgerows on field boundaries, shelter belts',
    open: 'worked fields — crop and pasture',
    road: 'farm access off a lane',
    influence: 'managed land between settlements',
  },
  INDUSTRIAL: {
    id: 1, name: 'industrial',
    mass: { cover: 0.55, foot: [22, 40], floors: [1, 2], grain: 44, clump: 0.35 },
    build: { footMul: [2.05, 2.25], setbackMul: 1.00, strideMul: 1.85, fillMul: 0.90, clump: 0.35, gapMul: 0.80, use: 'industrial' },
    setback: 'yard to the road',
    veg: 'planted buffer to the boundary, little else',
    open: 'hardstanding and yard',
    road: 'arterial access, wide radii',
    influence: 'edge of a town of tier 2 or more',
  },
  HINTERLAND: {
    id: 0, name: 'hinterland',
    mass: { cover: 0.0, foot: [0, 0], floors: [0, 0], grain: 0, clump: 1 },
    build: { footMul: [1.00, 1.00], setbackMul: 1.00, strideMul: 1.00, fillMul: 0.00, clump: 1.00, gapMul: 1.0, use: 'none' },
    setback: 'n/a',
    veg: 'woodland on the tops, scrub below',
    open: 'unenclosed',
    road: 'roads pass through; nothing addresses them',
    influence: 'none',
  },
};

/**
 * Which zone a point belongs to.
 *
 * The order of these tests is the whole content of the function:
 *
 *  - Relief wins first.  High ground is wooded and unbuilt whatever the
 *    development field says, which is the same rule landscape.js uses to
 *    colour it, so the zone and the ground colour never disagree.
 *  - Industry is tested BEFORE the urban bands, because an industrial
 *    patch is a kind of urban edge, not a separate density.  The test is
 *    the same expression parcels.js uses to choose the family, so the
 *    zone agrees with what actually gets built there.
 *  - The settled bands then fall out of the development field.
 *  - Below the fringe, the farmness term decides between managed
 *    farmland and open hinterland.  It is the same term coverAt() uses,
 *    including its noise, so the agricultural zone matches the fields
 *    that are actually drawn rather than forming a ring around it.
 */
export function zoneAt(x, z) {
  if (landformAt(x, z) > 21) return ZONE.HINTERLAND;

  const dev = developmentAt(x, z);
  const i = dev.intensity;
  const s = dev.settlement;

  if (i >= BAND.OUTER.min * 0.55 && i < BAND.INNER.min && s && s.tier >= 2 &&
      useField(x, z) < 0.34) {
    return ZONE.INDUSTRIAL;
  }

  if (i >= BAND.INNER.min) return ZONE.URBAN_CORE;
  if (i >= BAND.OUTER.min) return ZONE.URBAN_EDGE;
  if (i >= BAND.EDGE.min)  return ZONE.SUBURBAN;
  if (i >= BAND.RURAL.min) return ZONE.RURAL_SETTLED;

  // Same expression as landscape.js coverAt(), so "this is farmland" and
  // "this is drawn as a crop field" are one decision, not two.
  const farmness = 1 - Math.min(1, dev.r / 2400)
                 + (fbmFarm(x, z) - 0.5) * 0.7;
  return farmness > 0.34 ? ZONE.AGRICULTURAL : ZONE.HINTERLAND;
}

// Written once, so the agricultural boundary cannot drift apart from the
// one landscape.js draws.
function fbmFarm(x, z) {
  return fbm2(x * 0.0006 + 7.7, z * 0.0006 - 3.1, 2);
}

/**
 * Clustering field, Phase 9B.
 *
 * Placement used to be an independent coin toss per plot, so every zone
 * came out as an even sprinkle at its own density — which is why the
 * suburbs read as isolated objects rather than as neighbourhoods and the
 * countryside had no hamlets at all.  One low-frequency field, consulted
 * by every zone in proportion to its `clump`, gathers buildings into
 * groups and leaves the ground between them genuinely empty.
 *
 * Same shape as the regional mass cover term, so LOD 3 and the detail
 * pass agree about where a place is built up.
 */
export function clusterAt(x, z) {
  return fbm2(x * 0.0055 + 31.2, z * 0.0055 - 17.9, 2);
}

/** Zone lookup by id, for diagnostics. */
export function zoneById(id) {
  for (const k of Object.keys(ZONE)) if (ZONE[k].id === id) return ZONE[k];
  return null;
}
