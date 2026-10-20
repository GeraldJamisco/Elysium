// ============================================================
// REFERENCE DISTRICT — Phase 8
//
// Phase 3 placed Veridian Cap's buildings, Phase 5 gave them
// architecture, Phase 7 gave the planet a settlement grammar.  What no
// phase gave them was a RELATIONSHIP to each other.
//
// `buildingRegistry` describes each building as geometry — a centre, a
// width, a depth, a family and an entrance edge — and nothing in the
// world knows that two buildings share a frontage, that a block has an
// inside as well as an outside, or that the ground behind a house
// belongs to that house.  The result is legible from Eagle and hollow
// from Walk: the block interiors are one undifferentiated lawn that you
// can see straight across, and every building turns a blank back to it.
//
// This module adds the missing layer.  It derives, from what is already
// there, a model of:
//
//   BUILDING   identity, the street it addresses, which side is its
//              front, where its door is in world space, who its
//              neighbours are, and what it is for
//   BLOCK      its frontages, its interior, and how the interior is
//              divided into private, shared and service ground
//   SPACE      every open area classified as public / shared / private /
//              service, so the ground treatment can express which is which
//   LINK       the pedestrian connections that actually exist
//
// It then builds the small amount of geometry the model implies —
// plot boundaries, garden and courtyard ground, the passage into each
// block, and the Hall's forecourt and its crossing to the green.
//
// NOTHING MOVES.  Not one building changes position, footprint, height
// or entrance.  The model is derived from the town as placed, and the
// geometry added is ground surface, hedging and paving.  No collision
// body is removed or weakened; the only bodies added are hedges, which
// are solid because a hedge is.
// ============================================================

import * as THREE from 'three';
import { TOWN } from '../config.js';
import { blockData, surface } from './layout.js';
import { buildingRegistry } from './buildings.js';
import { collisionRegistry } from './collision.js';
import { slab, part } from './architecture.js';

// ---- Street identity, taken from nav/locator.js so the model and the
// ---- HUD can never disagree about what a street is called.
const NS_NAMES = ['Fernway', 'Lantern Row'];
const EW_NAMES = ['Cinder Walk', 'Harvest Walk'];

const QUARTERS = {
  '0,0': 'Southwest Quarter', '1,0': 'South Quarter', '2,0': 'Southeast Quarter',
  '0,1': 'West Quarter', '1,1': 'The Green', '2,1': 'East Quarter',
  '0,2': 'Northwest Quarter', '1,2': 'North Quarter', '2,2': 'Northeast Quarter',
};
// Short codes for building ids.  VC-NE-03 is readable in a log in a way
// that VC-22-03 is not.
const BLOCK_CODE = {
  '0,0': 'SW', '1,0': 'S', '2,0': 'SE',
  '0,1': 'W', '1,1': 'G', '2,1': 'E',
  '0,2': 'NW', '1,2': 'N', '2,2': 'NE',
};

const SETBACK = TOWN.setback;          // 3.5
const PLINTH = 0.7;                    // plinth overhang, from buildings.js
const Y_GROUND = 0.026;                // just above the block lawn at 0.022
const Y_PATH = 0.030;

// Minimum clear width a person needs: player radius 0.4, doubled, plus
// enough margin that walking it does not feel like squeezing.
const CLEAR = 1.6;

export const district = {
  id: 'VC',
  name: 'Veridian Cap',
  blocks: [],
  buildings: [],
  spaces: [],
  links: [],
};

// Ground the planting pass must keep off: paths and thresholds.  These
// are NOT collision bodies — a reserved strip is walkable by definition,
// and registering it as solid would be exactly the kind of hidden body
// that makes a route look connected and feel blocked.
const _reserved = [];
export function reserveGround(x, z, r) { _reserved.push({ x, z, r }); }
export function groundReserved(x, z, r = 0) {
  for (let i = 0; i < _reserved.length; i++) {
    const g = _reserved[i];
    if (Math.hypot(x - g.x, z - g.z) < g.r + r) return true;
  }
  return false;
}

// Deterministic stream, same shape as the other city modules.
let _s = 0;
function rr() {
  _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ============================================================
// GEOMETRY OF THE STREET NETWORK
// ============================================================

const { blocksX, blocksZ, blockW, blockD, roadW, sidewalkW } = TOWN;
const edgeW = roadW + sidewalkW * 2;
const totalX = blocksX * blockW + (blocksX - 1) * edgeW;
const totalZ = blocksZ * blockD + (blocksZ - 1) * edgeW;

const NS_ROADS = [];
for (let x = 0; x < blocksX - 1; x++) {
  NS_ROADS.push(-totalX / 2 + (x + 1) * blockW + x * edgeW + roadW / 2 + sidewalkW);
}
const EW_ROADS = [];
for (let z = 0; z < blocksZ - 1; z++) {
  EW_ROADS.push(-totalZ / 2 + (z + 1) * blockD + z * edgeW + roadW / 2 + sidewalkW);
}

/**
 * The street an edge of a block addresses, and the world coordinate of
 * the near footway edge — the line a front path has to reach for the
 * building to be connected to the network.
 */
function streetFor(blk, edge) {
  if (edge === 'west' && blk.x > 0) {
    return { name: NS_NAMES[blk.x - 1], axis: 'ns', centre: NS_ROADS[blk.x - 1], kerb: blk.minX };
  }
  if (edge === 'east' && blk.x < blocksX - 1) {
    return { name: NS_NAMES[blk.x], axis: 'ns', centre: NS_ROADS[blk.x], kerb: blk.maxX };
  }
  if (edge === 'south' && blk.z > 0) {
    return { name: EW_NAMES[blk.z - 1], axis: 'ew', centre: EW_ROADS[blk.z - 1], kerb: blk.minZ };
  }
  if (edge === 'north' && blk.z < blocksZ - 1) {
    return { name: EW_NAMES[blk.z], axis: 'ew', centre: EW_ROADS[blk.z], kerb: blk.maxZ };
  }
  return null;
}

/** Outward unit normal of a block edge. */
const EDGE_N = {
  west: [-1, 0], east: [1, 0], south: [0, -1], north: [0, 1],
};

// ============================================================
// THE MODEL
// ============================================================

/**
 * Derive the district model and build the geometry it implies.
 * Called after buildBuildings() and before buildStreetKit(), so the
 * planting pass can see the reserved ground.
 */
export function buildDistrict() {
  _s = 0x0D157;
  district.blocks.length = 0;
  district.buildings.length = 0;
  district.spaces.length = 0;
  district.links.length = 0;
  _reserved.length = 0;

  // ---- 1. Attach every building to its block and its street ----
  const byBlock = new Map();
  blockData.forEach(blk => byBlock.set(blk.x + ',' + blk.z, { blk, buildings: [] }));

  buildingRegistry.forEach(b => {
    const key = blockKeyAt(b.cx, b.cz);
    const entry = byBlock.get(key);
    if (!entry) return;
    entry.buildings.push(b);
  });

  // ---- 2. Build the per-building record ----
  for (const [key, entry] of byBlock) {
    const { blk, buildings } = entry;
    const code = BLOCK_CODE[key];
    const blockRec = {
      id: `${district.id}-${code}`,
      quarter: QUARTERS[key],
      x: blk.x, z: blk.z,
      minX: blk.minX, maxX: blk.maxX, minZ: blk.minZ, maxZ: blk.maxZ,
      park: !!blk.park,
      buildings: [],
      frontages: {},
      interior: null,
      passage: null,
    };
    district.blocks.push(blockRec);
    if (blk.park) continue;

    // Order along each frontage so "neighbour" means the building you
    // would actually pass walking down the street.
    const onEdge = { west: [], east: [], south: [], north: [] };

    buildings.forEach((b, i) => {
      const edge = b.entrance;
      const st = streetFor(blk, edge);
      const [nx, nz] = EDGE_N[edge] || [0, 0];

      // Front face centre, then the door: the facade's threshold sits on
      // the face, and its approach paving runs out toward the footway.
      const halfAlongNormal = (edge === 'west' || edge === 'east') ? b.w / 2 : b.d / 2;
      const faceX = b.cx + nx * halfAlongNormal;
      const faceZ = b.cz + nz * halfAlongNormal;

      const rec = {
        id: null,                       // assigned once the edge is sorted
        tag: `b@${b.cx.toFixed(1)},${b.cz.toFixed(1)}`,
        block: blockRec.id,
        quarter: blockRec.quarter,
        family: b.family,
        corner: !!b.corner,
        cx: b.cx, cz: b.cz, w: b.w, d: b.d, height: b.height,

        frontage: st ? {
          street: st.name, side: edge, setback: SETBACK,
          kerb: st.kerb,
        } : { street: null, side: edge, setback: SETBACK, kerb: null },

        entrance: {
          x: faceX, z: faceZ,
          dx: nx, dz: nz,                // the way a person faces leaving it
        },

        connections: {
          frontPath: null,               // filled by the path pass
          footway: st ? st.name : null,
          neighbours: [],
          greenSpace: null,
          civicSpace: null,
          serviceAccess: null,
        },

        spatialRole: {
          front: edge,
          rear: opposite(edge),
          sides: (edge === 'west' || edge === 'east') ? ['south', 'north'] : ['west', 'east'],
        },

        purpose: purposeOf(b),
        _b: b,
      };

      if (onEdge[edge]) onEdge[edge].push(rec);
      district.buildings.push(rec);
      blockRec.buildings.push(rec);
    });

    // ---- 3. Frontage order, ids and neighbour links ----
    let n = 0;
    for (const edge of ['south', 'east', 'north', 'west']) {
      const list = onEdge[edge];
      if (!list || !list.length) continue;
      const along = (edge === 'west' || edge === 'east') ? 'cz' : 'cx';
      list.sort((a, b2) => a[along] - b2[along]);
      blockRec.frontages[edge] = {
        street: list[0].frontage.street,
        buildings: list.map(r => r.id),
      };
      list.forEach((rec, i) => {
        rec.id = `${district.id}-${code}-${String(++n).padStart(2, '0')}`;
        if (i > 0) rec.connections.neighbours.push({ rel: 'along-frontage', of: list[i - 1] });
        if (i < list.length - 1) rec.connections.neighbours.push({ rel: 'along-frontage', of: list[i + 1] });
      });
      blockRec.frontages[edge].buildings = list.map(r => r.id);
    }
    // Any building the sort missed (no street edge) still needs an id.
    blockRec.buildings.forEach(r => {
      if (!r.id) r.id = `${district.id}-${code}-${String(++n).padStart(2, '0')}`;
    });

    // Write the identity back onto the registry entry.  The registry is
    // what every existing consumer already reads — the QA harnesses, the
    // navigation layer, the interior binding — so extending it in place
    // is the integration point rather than asking them all to learn
    // about a second parallel model.
    blockRec.buildings.forEach(r => {
      r._b.id = r.id;
      r._b.block = r.block;
      r._b.quarter = r.quarter;
      r._b.street = r.frontage.street;
      r._b.purpose = r.purpose;
    });
  }

  // Neighbour records hold objects while sorting; reduce them to ids now
  // that every building has one.
  district.buildings.forEach(r => {
    r.connections.neighbours = r.connections.neighbours.map(nb => ({ rel: nb.rel, id: nb.of.id }));
  });

  // ---- 3b. Keep the door approach clear ----
  //
  // furnishFootway plants a lamp or a 1.5 m tree pit every seven metres
  // along every footway, and it has never known where the doors are.  On
  // four of the thirty-one buildings a street tree stands squarely on the
  // entrance axis, so the approach the facade builds — landing, steps,
  // paving running out to the kerb — arrives at a trunk.  Reserving the
  // corridor from each door to the kerb is what makes the entrance
  // sequence the brief asks for actually hold on every building rather
  // than on most of them.
  district.buildings.forEach(rec => {
    const kerb = rec.frontage.kerb;
    if (kerb === null) return;
    const { x, z, dx, dz } = rec.entrance;
    const reach = Math.abs(dx ? kerb - x : kerb - z) + sidewalkW + 1.0;
    const steps = Math.max(2, Math.ceil(reach / 1.2));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * reach;
      // A tight corridor.  At 2.1 m this cleared the doors and stripped
      // about sixty street trees off the footways with them, which is a
      // worse street than the one it fixed.  1.2 m keeps a 1.5 m tree pit
      // off the door axis and leaves the trees between the doors alone.
      reserveGround(x + dx * t, z + dz * t, 1.2);
    }
  });

  // ---- 4. Block interiors ----
  district.blocks.forEach(blockRec => {
    if (blockRec.park) return;
    deriveInterior(blockRec);
  });

  // ---- 5. Geometry ----
  district.blocks.forEach(blockRec => {
    if (blockRec.park) return;
    buildBlockInterior(blockRec);
  });
  buildHallRelationship();

  return district;
}

function opposite(edge) {
  return edge === 'west' ? 'east' : edge === 'east' ? 'west'
       : edge === 'south' ? 'north' : 'south';
}

/**
 * What a building is for.  Derived from the family the architecture
 * already assigned, so the model never disagrees with what was built.
 */
function purposeOf(b) {
  if (b.family === 'civic') return 'civic';
  if (b.family === 'landmark') return 'landmark';
  if (b.family === 'commercial') return b.corner ? 'corner-shop' : 'commercial';
  return 'residence';
}

function blockKeyAt(x, z) {
  for (const blk of blockData) {
    if (x >= blk.minX - 1 && x <= blk.maxX + 1 && z >= blk.minZ - 1 && z <= blk.maxZ + 1) {
      return blk.x + ',' + blk.z;
    }
  }
  return '';
}

// ============================================================
// BLOCK INTERIOR
//
// A block is not a lawn with buildings on it.  It is a ring of
// properties whose backs face each other across a shared middle.  The
// model that follows is the minimum that makes that readable:
//
//   PRIVATE GARDEN   the ground directly behind a building, as wide as
//                    its frontage, bounded from its neighbours
//   SHARED COURTYARD what is left in the middle, reached through one
//                    passage from the street
//   SERVICE YARD     the same position behind a commercial or landmark
//                    building, but surfaced and open rather than planted
// ============================================================

function deriveInterior(blockRec) {
  const { minX, maxX, minZ, maxZ } = blockRec;

  // How far the built edge reaches into the block on each side.
  const reach = { west: 0, east: 0, south: 0, north: 0 };
  blockRec.buildings.forEach(r => {
    const e = r.frontage.side;
    if (e === 'west') reach.west = Math.max(reach.west, (r.cx + r.w / 2) - minX);
    else if (e === 'east') reach.east = Math.max(reach.east, maxX - (r.cx - r.w / 2));
    else if (e === 'south') reach.south = Math.max(reach.south, (r.cz + r.d / 2) - minZ);
    else if (e === 'north') reach.north = Math.max(reach.north, maxZ - (r.cz - r.d / 2));
  });

  // The courtyard is what the backs leave, less a garden depth and the
  // plinth overhang.
  const GARDEN = 5.0;
  const core = {
    minX: minX + (reach.west ? reach.west + PLINTH + GARDEN : 2),
    maxX: maxX - (reach.east ? reach.east + PLINTH + GARDEN : 2),
    minZ: minZ + (reach.south ? reach.south + PLINTH + GARDEN : 2),
    maxZ: maxZ - (reach.north ? reach.north + PLINTH + GARDEN : 2),
  };
  const cw = core.maxX - core.minX;
  const cd = core.maxZ - core.minZ;

  blockRec.interior = {
    reach,
    gardenDepth: GARDEN,
    // A courtyard has to be big enough to stand in and see across, or it
    // is just the gap between two gardens and should stay grass.
    courtyard: (cw >= 9 && cd >= 9) ? core : null,
    cw, cd,
  };

  // The way in.  One per block: a close between two buildings, taken at
  // the widest gap on whichever frontage has one wide enough to walk.
  blockRec.passage = findPassage(blockRec);
}

/**
 * Find the widest walkable gap between neighbouring buildings on any
 * frontage.  Measured between PLINTHS, not between footprints — the
 * plinth is what a person actually collides with, and the two differ by
 * 1.4 m, which is the whole width of a passage.
 */
function findPassage(blockRec) {
  let best = null;

  for (const edge of ['south', 'north', 'west', 'east']) {
    const list = blockRec.buildings
      .filter(r => r.frontage.side === edge && r.frontage.kerb !== null)
      .sort((a, b) => (edge === 'west' || edge === 'east') ? a.cz - b.cz : a.cx - b.cx);
    if (list.length < 2) continue;

    const alongZ = (edge === 'west' || edge === 'east');
    const lo = alongZ ? blockRec.minZ : blockRec.minX;
    const hi = alongZ ? blockRec.maxZ : blockRec.maxX;

    // Gaps between neighbouring buildings, and — the fallback that
    // matters — the gaps at each end of the frontage.  Five of the eight
    // blocks have their buildings bunched together and no usable gap
    // between any pair, but almost all of them have an open stretch
    // between the last building and the block corner.  Without this the
    // majority of blocks had a courtyard with no way into it.
    const edges = [];
    edges.push({ from: lo, to: (alongZ ? list[0].cz - list[0].d / 2 : list[0].cx - list[0].w / 2) - PLINTH });
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      edges.push({
        from: (alongZ ? a.cz + a.d / 2 : a.cx + a.w / 2) + PLINTH,
        to: (alongZ ? b.cz - b.d / 2 : b.cx - b.w / 2) - PLINTH,
      });
    }
    const last = list[list.length - 1];
    edges.push({ from: (alongZ ? last.cz + last.d / 2 : last.cx + last.w / 2) + PLINTH, to: hi });

    for (const g of edges) {
      const gap = g.to - g.from;
      if (gap < CLEAR + 0.4) continue;
      // Keep the close off the very corner, where it would collide with
      // the crossing and the corner footway.
      const at = Math.min(hi - 2.5, Math.max(lo + 2.5, (g.from + g.to) / 2));
      if (!best || gap > best.gap) {
        best = { edge, gap: Math.min(gap, 6), at, alongZ, kerb: list[0].frontage.kerb };
      }
    }
  }
  return best;
}

// ============================================================
// BLOCK INTERIOR GEOMETRY
// ============================================================

const COL = {
  gardenA: '#84a463',
  gardenB: '#8cab6b',
  courtyard: '#87a86c',
  gravel: '#a9a291',
  paving: '#bdb7a7',
  hedge: '#6b9a52',
  hedgeDeep: '#5d8a46',
};

function buildBlockInterior(blockRec) {
  const it = blockRec.interior;
  if (!it) return;

  // ---- Private gardens and service yards, one per building ----
  blockRec.buildings.forEach(rec => {
    const edge = rec.frontage.side;
    if (!EDGE_N[edge]) return;
    const [nx, nz] = EDGE_N[edge];

    // Rear face of the plinth, and how deep the plot runs back.
    const halfDepth = (edge === 'west' || edge === 'east') ? rec.w / 2 : rec.d / 2;
    const rearX = rec.cx - nx * (halfDepth + PLINTH);
    const rearZ = rec.cz - nz * (halfDepth + PLINTH);
    const depth = it.gardenDepth;

    // Width across the plot: the building's own frontage, so gardens
    // line up with the buildings they belong to.
    const acrossW = (edge === 'west' || edge === 'east') ? rec.d : rec.w;

    const midX = rearX - nx * depth / 2;
    const midZ = rearZ - nz * depth / 2;
    const sizeX = (edge === 'west' || edge === 'east') ? depth : acrossW;
    const sizeZ = (edge === 'west' || edge === 'east') ? acrossW : depth;

    const service = rec.purpose === 'commercial' || rec.purpose === 'corner-shop' ||
                    rec.purpose === 'landmark';

    if (service) {
      // A yard: surfaced, open, no planting.  This is what is actually
      // behind a shop, and it reads as back-of-house at a glance.
      surface('parkPath', sizeX, sizeZ, midX, Y_GROUND, midZ);
      rec.connections.serviceAccess = 'rear yard';
      district.spaces.push({
        kind: 'service', owner: rec.id, x: midX, z: midZ, w: sizeX, d: sizeZ,
      });
    } else {
      // A garden: grass a shade apart from the block lawn, so the
      // boundary between what is yours and what is everyone's is visible.
      const g = new THREE.PlaneGeometry(sizeX, sizeZ);
      g.rotateX(-Math.PI / 2);
      g.translate(midX, Y_GROUND, midZ);
      part(g, 'foliage', (rr() > 0.5 ? COL.gardenA : COL.gardenB), { jitter: 0.04 });
      rec.connections.greenSpace = 'private garden';
      district.spaces.push({
        kind: 'private-garden', owner: rec.id, x: midX, z: midZ, w: sizeX, d: sizeZ,
      });

      // Side boundaries between neighbours.  A hedge is solid, and that
      // is correct: you cannot walk through your neighbour's hedge.
      for (const s of [-1, 1]) {
        const bx = midX + (edge === 'west' || edge === 'east' ? 0 : s * acrossW / 2);
        const bz = midZ + (edge === 'west' || edge === 'east' ? s * acrossW / 2 : 0);
        const lenX = (edge === 'west' || edge === 'east') ? depth : 0.5;
        const lenZ = (edge === 'west' || edge === 'east') ? 0.5 : depth;
        hedge(bx, bz, lenX, lenZ, 0.85);
      }
      // Rear boundary, with a gate gap onto the shared ground.
      const rx = rearX - nx * depth;
      const rz = rearZ - nz * depth;
      rearHedgeWithGate(rx, rz, edge, acrossW);
    }
  });

  // ---- Shared courtyard ----
  const court = it.courtyard;
  if (court) {
    const cx = (court.minX + court.maxX) / 2;
    const cz = (court.minZ + court.maxZ) / 2;
    const w = court.maxX - court.minX;
    const d = court.maxZ - court.minZ;

    surface('grass', w, d, cx, Y_GROUND - 0.001, cz);
    district.spaces.push({ kind: 'shared-courtyard', owner: blockRec.id, x: cx, z: cz, w, d });

    // A path across it, aligned to the long axis, so the courtyard is a
    // route between the gardens and not just a clearing.
    const longX = w >= d;
    const runLen = (longX ? w : d) * 0.9;
    surface('parkPath', longX ? runLen : 2.2, longX ? 2.2 : runLen, cx, Y_PATH, cz);

    // Reserve the PATH, not the courtyard.  Reserving the whole area
    // stopped citykit planting the block interiors at all, which left
    // every courtyard a bare lawn — worse than before this phase touched
    // it.  The trees belong here; only the walking line has to stay clear.
    const steps = Math.ceil(runLen / 2);
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps - 0.5) * runLen;
      reserveGround(cx + (longX ? t : 0), cz + (longX ? 0 : t), 1.9);
    }

    district.links.push({ from: blockRec.id, to: 'courtyard', kind: 'shared-open-space' });
  }

  // ---- The close: street to courtyard ----
  const p = blockRec.passage;
  if (p) {
    const [nx, nz] = EDGE_N[p.edge];
    // From the footway edge, inward to the courtyard (or to the gardens).
    const target = court
      ? (p.alongZ ? Math.abs(((court.minX + court.maxX) / 2) - p.kerb)
                  : Math.abs(((court.minZ + court.maxZ) / 2) - p.kerb))
      : it.reach[p.edge] + PLINTH + it.gardenDepth;
    const len = Math.max(4, target);
    const width = Math.min(p.gap - 0.6, 3.0);

    const midX = p.alongZ ? p.kerb - nx * len / 2 : p.at;
    const midZ = p.alongZ ? p.at : p.kerb - nz * len / 2;
    surface('parkPath', p.alongZ ? len : width, p.alongZ ? width : len, midX, Y_PATH, midZ);

    // Keep the planting pass out of the close, or the one way into the
    // block ends up with a street tree standing in it.
    const steps = Math.ceil(len / 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      reserveGround(
        p.alongZ ? p.kerb - nx * len * t : p.at,
        p.alongZ ? p.at : p.kerb - nz * len * t,
        width / 2 + 0.8
      );
    }

    blockRec.passageBuilt = { x: midX, z: midZ, len, width };
    district.links.push({ from: blockRec.frontages[p.edge]?.street || p.edge, to: blockRec.id, kind: 'close' });
  }
}

/**
 * A clipped hedge, with matching collision.
 *
 * A plain box reads as an extruded ribbon, which is what a boundary made
 * of bare slabs looked like from the footway.  The prism carries the
 * mass and a run of lobes breaks its top, the same technique citykit
 * uses for the park's hedging, so the two read as the same kind of thing.
 */
function hedge(x, z, sizeX, sizeZ, h) {
  const sx = Math.max(0.5, sizeX), sz = Math.max(0.5, sizeZ);
  slab('foliage', COL.hedge, sx, h * 0.86, sz, x, h * 0.43, z,
       { jitter: 0.05, gradeY: [0, h * 1.5] });

  const along = Math.max(sx, sz);
  const n = Math.max(2, Math.round(along / 0.75));
  for (let i = 0; i <= n; i++) {
    const t = i / n - 0.5;
    const lx = x + (sx > sz ? t * sx : 0);
    const lz = z + (sz >= sx ? t * sz : 0);
    const lh = h * (0.95 + rr() * 0.14);
    const g = new THREE.SphereGeometry(1, 5, 3);
    g.scale(0.42, lh * 0.30, 0.42);
    g.translate(lx, lh * 0.80, lz);
    part(g, 'foliage', rr() > 0.5 ? COL.hedge : COL.hedgeDeep, { jitter: 0.06, gradeY: [0, lh * 1.5] });
  }

  collisionRegistry.registerBody({
    minX: x - sx / 2, maxX: x + sx / 2,
    minY: 0, maxY: h,
    minZ: z - sz / 2, maxZ: z + sz / 2,
    type: 'hedge', tag: `hedge@${x.toFixed(1)},${z.toFixed(1)}`,
  });
}

/**
 * The rear boundary of a garden, broken by a gate.
 *
 * The gap is real: it is how a resident reaches the shared ground, and
 * it is wide enough to walk.  A hedge drawn as one unbroken run would
 * make every garden a sealed box, which is both wrong and the kind of
 * thing that looks fine from Eagle and traps you on foot.
 */
function rearHedgeWithGate(x, z, edge, acrossW) {
  const alongZ = (edge === 'west' || edge === 'east');
  const gate = 1.9;
  const runLen = (acrossW - gate) / 2;
  if (runLen < 0.6) return;
  const off = gate / 2 + runLen / 2;

  for (const s of [-1, 1]) {
    const hx = x + (alongZ ? 0 : s * off);
    const hz = z + (alongZ ? s * off : 0);
    hedge(hx, hz, alongZ ? 0.5 : runLen, alongZ ? runLen : 0.5, 0.85);
  }
  reserveGround(x, z, gate / 2 + 0.6);
}

// ============================================================
// THE COMMUNITY HALL AND THE GREEN
//
// The Hall already has a doorway, a landing, steps and an approach
// running out to the footway — Phase 5 built all of that, and from the
// street it reads well.  What it does not have is a relationship to the
// green it faces.  The Hall's axis is z = -8.5; the park's western
// approach path is on the block's centre line at z = 0; and the only
// crossings are at the intersections, seventeen metres away.  So the
// settlement's civic building and the settlement's park face each other
// across a road with nothing joining them.
//
// This adds the three missing pieces: a forecourt on the Hall's side, a
// crossing on the Hall's own axis, and a path from the far kerb into the
// green to meet the ring walk.
// ============================================================

function buildHallRelationship() {
  const hall = district.buildings.find(r => r.purpose === 'civic' && r.frontage.side === 'east');
  if (!hall) return;

  const axisZ = hall.cz;
  const kerbW = hall.frontage.kerb;                 // block edge / near footway
  const roadCentre = NS_ROADS[0];
  const farKerb = roadCentre + roadW / 2 + sidewalkW;   // far footway outer edge
  const parkEdge = farKerb;                          // the green starts here

  // ---- Forecourt on the Hall's side ----
  // From the building's approach paving out to the kerb, wider than the
  // approach, so the Hall gets a place to stand in front of it.
  const fcDepth = kerbW - (hall.cx + hall.w / 2);
  if (fcDepth > 1) {
    const fcX = (hall.cx + hall.w / 2) + fcDepth / 2;
    surface('paving', fcDepth, 9.0, fcX, 0.36, axisZ);
    reserveGround(fcX, axisZ, 5.0);
    district.spaces.push({ kind: 'civic-plaza', owner: hall.id, x: fcX, z: axisZ, w: fcDepth, d: 9.0 });
    hall.connections.civicSpace = 'forecourt';
  }

  // ---- Crossing on the Hall's axis ----
  // Ladder bars across the carriageway, plus tactile squares on both
  // footways, matching how layout.js draws the crossings at the
  // intersections so this one does not read as a different kind of thing.
  const bars = 6, pitch = roadW * 0.86 / bars;
  for (let i = 0; i < bars; i++) {
    const o = -roadW * 0.43 + (i + 0.5) * pitch;
    surface('marking', 2.6, 0.42, roadCentre + o, 0.042, axisZ);
  }
  surface('marking', 1.1, 1.1, kerbW + 1.25, 0.372, axisZ);
  surface('marking', 1.1, 1.1, farKerb - 1.25, 0.372, axisZ);
  reserveGround(kerbW + 1.25, axisZ, 2.2);
  reserveGround(farKerb - 1.25, axisZ, 2.2);

  // ---- Into the green ----
  // A path from the far kerb to the park's ring walk, on the Hall's axis.
  const parkBlk = blockData.find(b => b.park);
  if (parkBlk) {
    const ringR = 9.6;                     // from citykit.buildPark
    const reachX = parkBlk.park.x - ringR * Math.cos(Math.asin(
      Math.max(-1, Math.min(1, (axisZ - parkBlk.park.z) / ringR))));
    const endX = Number.isFinite(reachX) ? reachX : parkBlk.park.x - ringR;
    const len = endX - parkEdge;
    if (len > 2) {
      surface('parkPath', len, 2.4, parkEdge + len / 2, 0.028, axisZ);
      reserveGround(parkEdge + len / 2, axisZ, Math.max(3, len / 2));
      district.links.push({ from: hall.id, to: 'The Green', kind: 'civic-approach' });
      hall.connections.greenSpace = 'The Green';
    }
  }
}

// ============================================================
// QA SUPPORT
// ============================================================

/** Flat summary for diagnostics — see diag-civic.cjs / diag-buildings.cjs. */
export function districtSummary() {
  return {
    buildings: district.buildings.length,
    blocks: district.blocks.filter(b => !b.park).length,
    spaces: district.spaces.reduce((a, s) => { a[s.kind] = (a[s.kind] || 0) + 1; return a; }, {}),
    links: district.links.length,
    passages: district.blocks.filter(b => b.passage).length,
    courtyards: district.blocks.filter(b => b.interior && b.interior.courtyard).length,
  };
}
